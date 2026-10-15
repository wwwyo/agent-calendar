import type { GoogleGenAI } from "@google/genai";
import type { CalendarAdapter, CalendarEvent } from "./calendar/adapter";
import type { Config, Workspace } from "./config";
import { computeSchedule, isAllowedCreator, NOT_JUDGED, type FireItem } from "./domain/schedule";
import { buildTask, runAgent } from "./agent/agent";
import { judgeEvent, needsJudge } from "./dispatch/judge";
import {
  CLOUD_AGENTS,
  JUDGE_PER_TICK,
  SANDBOX_GRACE_MS,
  SANDBOX_TIMEOUT_MS,
  type CloudAgent,
  type CloudLauncher,
  type DispatchChoices,
  type StoredEvent,
} from "./dispatch/types";
import { log } from "./log";
import type { CalendarRole, Run, Schedule, Store } from "./store/store";

// cloud: 無ければ cloud の回は failed で記録する（ローカル確認など sandbox の job がない環境）
// revokeRun: deadlineAt を過ぎた cloud の回を閉じたときに、その回の sandbox token を失効させる
export type Deps = {
  cfg: Config;
  store: Store;
  calendar: CalendarAdapter;
  ai: GoogleGenAI;
  cloud?: CloudLauncher;
  revokeRun?: (ws: string, runId: string) => Promise<void>;
  now?: () => number;
};

// automation の回はこの先まで発火予定に載せる
const HORIZON = 48 * 60 * 60 * 1000;
// 予定が変わらなくても、この間隔で発火予定を計算し直す（horizon を進めるため）
const RECOMPUTE_EVERY = 60 * 60 * 1000;
// 1回の tick で実行する発火の上限。残りは次の tick に回す
const FIRES_PER_TICK = 4;
// runner が止まっていた間の automation の回は、この時間より古ければ実行しない
const CATCH_UP_LIMIT = 6 * 60 * 60 * 1000;
// local worker がこの時間たっても受け取らない queued は skipped にする（worker 側の 6 時間ルールより少し長く待つ）
const LOCAL_UNCLAIMED_MS = 7 * 60 * 60 * 1000;
// 1 tick で後始末を見る Run の上限
const OPEN_RUNS_PER_TICK = 50;

export const DEMO_EXPIRES_TAG = "agentCalendarDemoExpiresAt";

function roles(ws: Workspace): CalendarRole[] {
  return ws.calendars.main ? ["automation", "records", "main"] : ["automation", "records"];
}

// 差分を取り込み、変わった予定があれば true
async function sync(deps: Deps, ws: Workspace, role: CalendarRole): Promise<boolean> {
  const token = await deps.store.getSyncToken(ws.id, role);
  const changes = await deps.calendar.listChanges(ws.calendars[role]!, token);
  const now = (deps.now ?? Date.now)();
  const upserts: CalendarEvent[] = [];
  const deletes: string[] = [];
  for (const e of changes.events) {
    // 消された予定は捨てる。繰り返し予定の消された回は、親の展開から外すために残す
    if (e.status === "cancelled" && !e.recurringEventId) deletes.push(e.id);
    else if (isPastSingle(e, now)) deletes.push(e.id);
    else upserts.push(e);
  }
  if (token && changes.events.length === 0 && !changes.full) return false;
  // 差分を書いた後、計算し直す前に落ちても、次の tick で計算し直させる
  const schedule = await deps.store.getSchedule(ws.id);
  if (schedule && !schedule.stale) await deps.store.saveSchedule(ws.id, { ...schedule, stale: true });
  await deps.store.applyChanges(ws.id, role, { upserts, deletes, reset: changes.full, syncToken: changes.nextSyncToken });
  log("info", "calendar synced", { workspace: ws.id, role, upserts: upserts.length, deletes: deletes.length, full: changes.full });
  return true;
}

// 終わった単発の予定は発火に関わらないので持たない
function isPastSingle(e: CalendarEvent, now: number): boolean {
  if (e.recurrence || e.recurringEventId || !e.end) return false;
  const end = "date" in e.end ? Date.parse(`${e.end.date}T00:00:00Z`) + 24 * 60 * 60 * 1000 : Date.parse(e.end.dateTime);
  return end < now - 24 * 60 * 60 * 1000;
}

async function recompute(deps: Deps, ws: Workspace, prev: Schedule | undefined, now: number): Promise<Schedule> {
  const [automation, records] = await Promise.all([deps.store.listEvents(ws.id, "automation"), deps.store.listEvents(ws.id, "records")]);
  // 初回は今から先だけを見る。過去の回をまとめて発火させない
  const from = prev ? Math.max(Date.parse(prev.watermark), now - CATCH_UP_LIMIT) : now;
  const items = computeSchedule({ workspace: ws, automation, records, from, now, horizon: HORIZON });
  const due = items.filter((i) => Date.parse(i.fireAt) <= now).map((i) => i.key);
  const fired = await deps.store.firedKeys(ws.id, due);
  const retries = automation.flatMap((e) => (e.dispatch?.retryAt && isAllowedCreator(e, ws) ? [e.dispatch.retryAt] : [])).sort();
  return {
    items: items.filter((i) => !fired.has(i.key)),
    computedAt: new Date(now).toISOString(),
    watermark: prev?.watermark ?? new Date(now).toISOString(),
    ...(retries[0] ? { judgeRetryAt: retries[0] } : {}),
  };
}

async function dispatchChoices(deps: Deps, ws: Workspace): Promise<DispatchChoices> {
  const local = ws.allowLocal ? await deps.store.getLocalWorkerState(ws.id) : undefined;
  return { cloudAgents: CLOUD_AGENTS, ...(local ? { local: { agents: local.agents, targets: local.targets } } : {}) };
}

// 足された・変わった起動用の予定を判定する。作成者が allowlist にない予定は判定にかけない
async function judgePending(deps: Deps, ws: Workspace, now: number): Promise<{ judged: number; remaining: boolean }> {
  const events = await deps.store.listEvents(ws.id, "automation");
  const pending = events.filter((e) => e.status !== "cancelled" && isAllowedCreator(e, ws) && needsJudge(e, now));
  if (pending.length === 0) return { judged: 0, remaining: false };
  const choices = await dispatchChoices(deps, ws);
  const batch = pending.slice(0, JUDGE_PER_TICK);
  // 並べて呼ぶ。直列だと 1 件数秒ずつ tick が延び、同じ tick の発火が遅れる
  await Promise.all(batch.map((e) => judgeOne(deps, ws, e, choices, now)));
  return { judged: batch.length, remaining: pending.length > batch.length };
}

async function judgeOne(deps: Deps, ws: Workspace, e: StoredEvent, choices: DispatchChoices, now: number) {
  const dispatch = await judgeEvent({ ai: deps.ai, model: deps.cfg.GEMINI_MODEL, event: e, choices, allowLocal: ws.allowLocal, now });
  await deps.store.saveDispatch(ws.id, e.id, dispatch);
  log(dispatch.status === "ready" ? "info" : "warn", "event judged", {
    workspace: ws.id,
    eventId: e.id,
    status: dispatch.status,
    ...(dispatch.status === "ready" ? { executor: dispatch.executor, agent: dispatch.agent, target: dispatch.target } : { reason: dispatch.reason }),
  });
}

async function fire(deps: Deps, ws: Workspace, item: FireItem, now: number): Promise<Run | undefined> {
  // 発火済みの印は、同じ回をもう計算しなくなるまで残す（準備は締切の後まで）
  const expireAt = new Date(Math.max(Date.parse(item.fireAt), Date.parse(item.occurrenceStart)) + 7 * 24 * 60 * 60 * 1000);
  if (!(await deps.store.claimFire(ws.id, item.key, expireAt))) return undefined;
  const base: Run = {
    id: crypto.randomUUID(),
    fireKey: item.key,
    kind: item.kind,
    title: item.title,
    eventId: item.eventId,
    scheduledAt: item.fireAt,
    // tick の開始ではなく発火した時刻。同じ tick の判定にかかった時間を所要時間に含めない
    startedAt: new Date((deps.now ?? Date.now)()).toISOString(),
    status: "skipped",
    late: item.late,
    toolCalls: [],
  };
  if (item.blocked) {
    const run = { ...base, reason: item.blocked, finishedAt: base.startedAt };
    await deps.store.saveRun(ws.id, run);
    log("warn", "fire blocked", { workspace: ws.id, key: item.key, reason: item.blocked });
    return run;
  }
  const since = new Date(now - 60 * 60 * 1000).toISOString();
  if ((await deps.store.countRunsSince(ws.id, since)) >= deps.cfg.RUN_LIMIT_PER_HOUR) {
    const run = { ...base, reason: `1時間あたりの実行上限（${deps.cfg.RUN_LIMIT_PER_HOUR}回）に達したため実行しなかった`, finishedAt: base.startedAt };
    await deps.store.saveRun(ws.id, run);
    log("warn", "run limit reached", { workspace: ws.id, key: item.key });
    return run;
  }
  if (item.kind === "automation") return dispatchRun(deps, ws, item, base, now);
  const records = await deps.store.listEvents(ws.id, "records");
  const event = records.find((e) => e.id === item.eventId);
  const task = buildTask(item, event, ws.timeZone, now);
  await deps.store.saveRun(ws.id, { ...base, status: "running", model: deps.cfg.GEMINI_MODEL, input: task.input });
  const run = await runAgent({
    ai: deps.ai,
    model: deps.cfg.GEMINI_MODEL,
    run: base,
    task,
    ctx: { workspace: ws, store: deps.store, runId: base.id, now },
    onProgress: (r) => deps.store.saveRun(ws.id, r),
  });
  await deps.store.saveRun(ws.id, run);
  log(run.status === "failed" ? "error" : "info", "run finished", {
    workspace: ws.id,
    runId: run.id,
    key: item.key,
    status: run.status,
    reason: run.reason,
    toolCalls: run.toolCalls.map((t) => t.name),
    usage: run.usage,
  });
  return run;
}

const isCloudAgent = (a: string): a is CloudAgent => (CLOUD_AGENTS as readonly string[]).includes(a);

// 起動用の回を判定結果の実行先に回す。cloud は sandbox の job を起こし、local は worker が受け取るのを待つ
async function dispatchRun(deps: Deps, ws: Workspace, item: FireItem, base: Run, now: number): Promise<Run> {
  const d = item.dispatch;
  const finished = (status: Run["status"], reason: string): Run => ({ ...base, status, reason, finishedAt: base.startedAt });
  if (!d) {
    const run = finished("skipped", NOT_JUDGED);
    await deps.store.saveRun(ws.id, run);
    return run;
  }
  const fields = { executor: d.executor, agent: d.agent, ...(d.target ? { target: d.target } : {}), input: d.prompt };
  if (d.executor === "local") {
    const run: Run = { ...base, ...fields, status: "queued" };
    await deps.store.saveRun(ws.id, run);
    log("info", "run queued", { workspace: ws.id, runId: run.id, key: item.key, agent: d.agent, target: d.target });
    return run;
  }
  if (!deps.cloud || !isCloudAgent(d.agent)) {
    const run = { ...finished("failed", deps.cloud ? `agent「${d.agent}」は cloud で使えない` : "cloud の sandbox が設定されていない"), ...fields };
    await deps.store.saveRun(ws.id, run);
    log("error", "cloud run not started", { workspace: ws.id, runId: run.id, reason: run.reason });
    return run;
  }
  // 結果は job から /sandbox/result で返る。running を先に書いてから起こす
  const running: Run = { ...base, ...fields, status: "running", deadlineAt: new Date(now + SANDBOX_TIMEOUT_MS + SANDBOX_GRACE_MS).toISOString() };
  await deps.store.saveRun(ws.id, running);
  try {
    const started = await deps.cloud.start({ workspace: ws.id, runId: base.id, agent: d.agent, prompt: d.prompt });
    log("info", "cloud run started", { workspace: ws.id, runId: base.id, execution: started.execution });
    // 起こしている間に結果が返っていれば上書きしない
    return (await deps.store.updateRunIf(ws.id, base.id, "running", started)) ?? running;
  } catch (e) {
    const reason = `sandbox を起こせなかった: ${(e as Error).message.slice(0, 300)}`;
    log("error", "cloud run not started", { workspace: ws.id, runId: base.id, reason });
    return (await deps.store.updateRunIf(ws.id, base.id, "running", { status: "failed", reason, finishedAt: new Date((deps.now ?? Date.now)()).toISOString() })) ?? running;
  }
}

// 結果が返らない cloud の回と、worker が受け取らない local の回を閉じる
async function sweepRuns(deps: Deps, ws: Workspace, now: number): Promise<number> {
  const at = new Date(now).toISOString();
  let n = 0;
  for (const r of await deps.store.listOpenRuns(ws.id, OPEN_RUNS_PER_TICK)) {
    let done: Run | undefined;
    if (r.executor === "cloud" && r.status === "running" && r.deadlineAt && Date.parse(r.deadlineAt) < now) {
      // token は deadlineAt と同じ時刻に切れ、running でない Run への結果は捨てられる
      done = await deps.store.updateRunIf(ws.id, r.id, "running", { status: "failed", reason: "sandbox から結果が返らなかった", finishedAt: at });
      if (done) await revoke(deps, ws, r.id);
    } else if (r.executor === "local" && r.status === "queued" && now - Date.parse(r.scheduledAt) > LOCAL_UNCLAIMED_MS) {
      done = await deps.store.updateRunIf(ws.id, r.id, "queued", { status: "skipped", reason: "local worker が受け取らなかった", finishedAt: at });
    }
    if (done) {
      n++;
      log("warn", "run closed", { workspace: ws.id, runId: r.id, status: done.status, reason: done.reason });
    }
  }
  return n;
}

// token は期限でも切れるので、失効に失敗しても tick は止めない
async function revoke(deps: Deps, ws: Workspace, runId: string) {
  try {
    await deps.revokeRun?.(ws.id, runId);
  } catch (e) {
    log("error", "sandbox token revoke failed", { workspace: ws.id, runId, error: (e as Error).message });
  }
}

// デモ用フォームで足した予定は、期限が来たらカレンダーから消す
async function cleanupDemoEvents(deps: Deps, ws: Workspace, now: number): Promise<number> {
  let n = 0;
  for (const role of ["automation", "records"] as const) {
    for (const e of await deps.store.listEvents(ws.id, role)) {
      const exp = e.tags[DEMO_EXPIRES_TAG];
      if (exp && Date.parse(exp) < now && !e.recurringEventId) {
        await deps.calendar.deleteEvent(ws.calendars[role], e.id);
        n++;
      }
    }
  }
  return n;
}

export type TickResult = { workspace: string; changed: boolean; judged: number; fired: number; due: number; closed: number; cleaned: number };

export async function tickWorkspace(deps: Deps, ws: Workspace): Promise<TickResult> {
  const now = (deps.now ?? Date.now)();
  let changed = false;
  for (const role of roles(ws)) changed = (await sync(deps, ws, role)) || changed;

  let schedule = await deps.store.getSchedule(ws.id);
  // 変化のない tick では LLM を呼ばない。判定の残り（stale）・失敗のやり直し（judgeRetryAt）・1時間ごとの計算し直し
  // （この機能より前から保存されている、判定のない予定を拾う）のときだけ判定する
  const retryDue = !!schedule?.judgeRetryAt && Date.parse(schedule.judgeRetryAt) <= now;
  const recomputeDue = !schedule || !!schedule.stale || retryDue || now - Date.parse(schedule.computedAt) > RECOMPUTE_EVERY;
  const judging = changed || recomputeDue ? await judgePending(deps, ws, now) : { judged: 0, remaining: false };
  if (!schedule || changed || judging.judged > 0 || recomputeDue) {
    schedule = await recompute(deps, ws, schedule, now);
    await deps.store.saveSchedule(ws.id, schedule);
  }
  const due = schedule.items.filter((i) => Date.parse(i.fireAt) <= now);
  let fired = 0;
  const done = new Set<string>();
  for (const item of due.slice(0, FIRES_PER_TICK)) {
    if (await fire(deps, ws, item, now)) fired++;
    done.add(item.key);
  }
  await deps.store.saveSchedule(ws.id, {
    ...schedule,
    items: schedule.items.filter((i) => !done.has(i.key)),
    // 実行しきれなかった回が残っていれば、watermark はそこで止める
    watermark: new Date(due.length > FIRES_PER_TICK ? Date.parse(due[FIRES_PER_TICK]!.fireAt) - 1 : now).toISOString(),
    // 判定しきれなかった予定が残っていれば、次の tick で続ける
    stale: judging.remaining || undefined,
  });
  const closed = await sweepRuns(deps, ws, now);
  const cleaned = await cleanupDemoEvents(deps, ws, now);
  return { workspace: ws.id, changed, judged: judging.judged, fired, due: due.length, closed, cleaned };
}

export async function tick(deps: Deps): Promise<TickResult[] | "busy"> {
  const now = (deps.now ?? Date.now)();
  // 実行が1分を超えても次の tick と重ならないようにする
  const owner = crypto.randomUUID();
  if (!(await deps.store.acquireLease("tick", owner, 5 * 60 * 1000, now))) return "busy";
  try {
    const out: TickResult[] = [];
    for (const ws of deps.cfg.workspaces) {
      try {
        out.push(await tickWorkspace(deps, ws));
      } catch (e) {
        log("error", "tick failed", { workspace: ws.id, error: (e as Error).message });
      }
    }
    return out;
  } finally {
    await deps.store.releaseLease("tick", owner);
  }
}
