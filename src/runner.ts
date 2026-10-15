import type { GoogleGenAI } from "@google/genai";
import type { CalendarAdapter, CalendarEvent } from "./calendar/adapter";
import type { Config, Workspace } from "./config";
import { computeSchedule, type FireItem } from "./domain/schedule";
import { buildTask, runAgent } from "./agent/agent";
import { log } from "./log";
import type { CalendarRole, Run, Schedule, Store } from "./store/store";

export type Deps = { cfg: Config; store: Store; calendar: CalendarAdapter; ai: GoogleGenAI; now?: () => number };

// automation の回はこの先まで発火予定に載せる
const HORIZON = 48 * 60 * 60 * 1000;
// 予定が変わらなくても、この間隔で発火予定を計算し直す（horizon を進めるため）
const RECOMPUTE_EVERY = 60 * 60 * 1000;
// 1回の tick で実行する発火の上限。残りは次の tick に回す
const FIRES_PER_TICK = 4;
// runner が止まっていた間の automation の回は、この時間より古ければ実行しない
const CATCH_UP_LIMIT = 6 * 60 * 60 * 1000;

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
  return { items: items.filter((i) => !fired.has(i.key)), computedAt: new Date(now).toISOString(), watermark: prev?.watermark ?? new Date(now).toISOString() };
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
    startedAt: new Date(now).toISOString(),
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
  const records = item.kind === "prep" ? await deps.store.listEvents(ws.id, "records") : [];
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

export type TickResult = { workspace: string; changed: boolean; fired: number; due: number; cleaned: number };

export async function tickWorkspace(deps: Deps, ws: Workspace): Promise<TickResult> {
  const now = (deps.now ?? Date.now)();
  let changed = false;
  for (const role of roles(ws)) changed = (await sync(deps, ws, role)) || changed;

  let schedule = await deps.store.getSchedule(ws.id);
  if (changed || !schedule || schedule.stale || now - Date.parse(schedule.computedAt) > RECOMPUTE_EVERY) {
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
  });
  const cleaned = await cleanupDemoEvents(deps, ws, now);
  return { workspace: ws.id, changed, fired, due: due.length, cleaned };
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
