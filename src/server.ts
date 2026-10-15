import { GoogleGenAI } from "@google/genai";
import { OAuth2Client } from "google-auth-library";
import { createAuthClient } from "./auth";
import { createCloudSandbox } from "./cloud";
import { ServiceAccountCalendar } from "./calendar/service-account";
import { loadConfig, type Workspace } from "./config";
import { isSameOrigin, readLimited, TooLarge, WindowLimiter } from "./http";
import { log } from "./log";
import { DEMO_EXPIRES_TAG, tick, type Deps } from "./runner";
import { FirestoreStore } from "./store/firestore";
import { MemoryStore } from "./store/memory";
import type { Store } from "./store/store";
import { calendarItems, weekRange } from "./web/calendar";
import { renderSessionPage, renderSessionsPage } from "./web/dashboard";
import { AutomationForm, automationEvent, DeadlineForm, deadlineEvent } from "./web/demo";

const cfg = loadConfig();
const auth = await createAuthClient(cfg.GOOGLE_ACCESS_TOKEN);
const store: Store = cfg.STORE === "memory" ? new MemoryStore() : new FirestoreStore(cfg.GCP_PROJECT, cfg.GOOGLE_ACCESS_TOKEN ? auth : undefined);
const calendar = new ServiceAccountCalendar(auth);
const ai = new GoogleGenAI({
  vertexai: true,
  project: cfg.GCP_PROJECT,
  location: cfg.VERTEX_LOCATION,
  ...(cfg.GOOGLE_ACCESS_TOKEN ? { googleAuthOptions: { authClient: auth as never } } : {}),
});
// SANDBOX_JOB と RUNNER_URL が無い環境（ローカル確認など）では cloud の回を failed で記録し、/sandbox/* は 404 を返す
const sandbox =
  cfg.SANDBOX_JOB && cfg.RUNNER_URL
    ? createCloudSandbox({
        project: cfg.GCP_PROJECT,
        vertexLocation: cfg.VERTEX_LOCATION,
        model: cfg.GEMINI_MODEL,
        sandboxJob: cfg.SANDBOX_JOB,
        runnerUrl: cfg.RUNNER_URL,
        auth,
        runs: store,
        store: cfg.STORE,
        ...(cfg.GOOGLE_ACCESS_TOKEN ? { firestoreAuth: auth } : {}),
      })
    : undefined;
const handleSandbox = async (req: Request): Promise<Response | undefined> => sandbox?.handleSandbox(req);
const deps: Deps = { cfg, store, calendar, ai, cloud: sandbox?.launcher, revokeRun: sandbox?.revokeRun };
const oidc = new OAuth2Client();

async function verifyTick(req: Request): Promise<boolean> {
  if (cfg.TICK_AUTH === "none") return true;
  const token = req.headers.get("authorization")?.replace(/^Bearer /, "");
  if (!token) return false;
  try {
    const ticket = await oidc.verifyIdToken({ idToken: token, audience: cfg.TICK_AUDIENCE! });
    const p = ticket.getPayload();
    return !!p?.email_verified && p.email === cfg.TICK_INVOKER_EMAIL;
  } catch {
    return false;
  }
}

function publicWorkspace(id: string): Workspace | undefined {
  return cfg.workspaces.find((w) => w.id === id && w.visibility === "public");
}

function clientIp(req: Request, server: Bun.Server<unknown>): string {
  // Cloud Run は X-Forwarded-For の末尾に接続元を足す
  const xff = req.headers.get("x-forwarded-for")?.split(",").map((s) => s.trim()).filter(Boolean);
  return xff?.at(-1) ?? server.requestIP(req)?.address ?? "unknown";
}

// 誰でも書ける操作の上限。IP ごとと全体の両方を数える
async function allowWrite(req: Request, server: Bun.Server<unknown>, ws: Workspace): Promise<boolean> {
  const now = Date.now();
  const ip = clientIp(req, server);
  return (await store.hitRateLimit(`${ws.id}:ip:${ip}`, cfg.DEMO_LIMIT_PER_IP, now)) && (await store.hitRateLimit(`${ws.id}:global`, cfg.DEMO_LIMIT_GLOBAL, now));
}

// 公開の GET（画面と JSON）の IP ごとの上限。dashboard の polling（数秒ごと）を数枚開いても届かない数にする
const reads = new WindowLimiter(cfg.READ_LIMIT_PER_IP_PER_MIN, 60 * 1000);
const tooMany = () => new Response("too many requests", { status: 429, headers: { "Retry-After": "60" } });

// URL の id は形を確かめてから使う。run・承認は UUID、予定は Calendar API の id（英数字と _）
const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;
const EVENT_ID = /^[A-Za-z0-9_]{1,1024}$/;

// 公開の組を引き、GET の上限を数える。返すのは組か、そのまま返す Response
function readable(req: Request, server: Bun.Server<unknown>, id: string): Workspace | Response {
  const ws = publicWorkspace(id);
  if (!ws) return new Response("not found", { status: 404 });
  if (!reads.hit(clientIp(req, server), Date.now())) return tooMany();
  return ws;
}

// 書き込みの入口。他 origin からの POST を断り、body を読む前に上限を数える
async function guardWrite(req: Request, server: Bun.Server<unknown>, ws: Workspace): Promise<Response | undefined> {
  if (!isSameOrigin(req)) return new Response("forbidden", { status: 403 });
  if (!(await allowWrite(req, server, ws))) return back(ws, LIMITED);
  return undefined;
}

const back = (ws: Workspace, flash: string, path = "") =>
  new Response(null, { status: 303, headers: { Location: `/w/${ws.id}${path}?flash=${encodeURIComponent(flash)}` } });

class WriteFailed extends Error {
  constructor(readonly ws: Workspace, message: string) {
    super(message);
  }
}

async function write<T>(ws: Workspace, f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    log("error", "calendar write failed", { workspace: ws.id, error: (e as Error).message });
    throw new WriteFailed(ws, "カレンダーへの書き込みに失敗した。");
  }
}

const LIMITED = "1時間あたりの回数の上限に達した。しばらくしてから試してください。";

const html = (body: string) => new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });

// 一覧とカレンダーは全員が数秒ごとに読むので、Firestore の読み取りを instance ごとに数秒まとめる
const SNAPSHOT_CACHE_MS = 2500;
const snapshots = new Map<string, { at: number; body: Promise<Snapshot> }>();
type Snapshot = Awaited<ReturnType<typeof readSnapshot>>;

async function readSnapshot(ws: Workspace) {
  const [runs, approvals, automation, records] = await Promise.all([
    store.listRuns(ws.id, 30),
    store.listApprovals(ws.id, 50),
    store.listEvents(ws.id, "automation"),
    store.listEvents(ws.id, "records"),
  ]);
  return { runs, approvals, automation, records };
}

function snapshot(ws: Workspace): Promise<Snapshot> {
  const hit = snapshots.get(ws.id);
  if (hit && Date.now() - hit.at < SNAPSHOT_CACHE_MS) return hit.body;
  const body = readSnapshot(ws);
  snapshots.set(ws.id, { at: Date.now(), body });
  body.catch(() => snapshots.delete(ws.id));
  return body;
}

async function sessionsJson(ws: Workspace) {
  const { runs, approvals } = await snapshot(ws);
  const pending = new Map<string, number>();
  for (const a of approvals) if (a.status === "pending") pending.set(a.runId, (pending.get(a.runId) ?? 0) + 1);
  return {
    sessions: runs.map((r) => ({
      id: r.id,
      title: r.title,
      kind: r.kind,
      status: r.status,
      executor: r.executor,
      agent: r.agent,
      target: r.target,
      deadlineAt: r.deadlineAt,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      late: r.late,
      toolCalls: r.toolCalls.length,
      pendingApprovals: pending.get(r.id) ?? 0,
    })),
  };
}

// デモ用フォームの body の上限。prompt 500 文字が全部 3 byte の文字でも percent-encoding で 4.5KB に収まる
const FORM_BODY_MAX = 8 * 1024;

// フォームは urlencoded だけを受け、上限を超えたところで読むのをやめる
async function formOf(req: Request): Promise<Record<string, string> | Response> {
  if (!req.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) return new Response("unsupported media type", { status: 415 });
  try {
    return Object.fromEntries(new URLSearchParams(await readLimited(req, FORM_BODY_MAX)));
  } catch (e) {
    if (e instanceof TooLarge) return new Response("payload too large", { status: 413 });
    throw e;
  }
}

const server = Bun.serve({
  port: cfg.PORT,
  // 既定の10秒では、Gemini を待つ /tick の接続が切られる
  idleTimeout: 255,
  routes: {
    "/healthz": new Response("ok"),
    "/": () => {
      const ws = cfg.workspaces.find((w) => w.visibility === "public");
      return ws ? Response.redirect(`/w/${ws.id}`, 302) : new Response("agent-calendar", { status: 200 });
    },
    "/tick": {
      POST: async (req) => {
        if (!(await verifyTick(req))) return new Response("unauthorized", { status: 401 });
        const result = await tick(deps);
        log("info", "tick", { result });
        return Response.json(result);
      },
    },
    "/w/:ws": (req, srv) => {
      const ws = readable(req, srv, req.params.ws);
      if (ws instanceof Response) return ws;
      return html(renderSessionsPage(ws, new URL(req.url).searchParams.get("flash") ?? undefined));
    },
    "/w/:ws/sessions/:id": (req, srv) => {
      const ws = readable(req, srv, req.params.ws);
      if (ws instanceof Response) return ws;
      if (!RUN_ID.test(req.params.id)) return new Response("not found", { status: 404 });
      return html(renderSessionPage(ws, req.params.id, new URL(req.url).searchParams.get("flash") ?? undefined));
    },
    "/w/:ws/api/sessions": async (req, srv) => {
      const ws = readable(req, srv, req.params.ws);
      if (ws instanceof Response) return ws;
      return Response.json(await sessionsJson(ws), { headers: { "Cache-Control": "no-store" } });
    },
    "/w/:ws/api/calendar": async (req, srv) => {
      const ws = readable(req, srv, req.params.ws);
      if (ws instanceof Response) return ws;
      const now = Date.now();
      const range = weekRange(new URL(req.url).searchParams.get("start"), ws, now);
      if (!range) return new Response("bad request", { status: 400 });
      const { automation, records, runs } = await snapshot(ws);
      const items = calendarItems({ ws, automation, records, runs, from: range.from, to: range.to, now });
      return Response.json({ start: range.start, items }, { headers: { "Cache-Control": "no-store" } });
    },
    "/w/:ws/api/sessions/:id": async (req, srv) => {
      const ws = readable(req, srv, req.params.ws);
      if (ws instanceof Response) return ws;
      if (!RUN_ID.test(req.params.id)) return new Response("not found", { status: 404 });
      const [session, approvals] = await Promise.all([store.getRun(ws.id, req.params.id), store.listApprovals(ws.id, 50)]);
      if (!session) return new Response("not found", { status: 404 });
      return Response.json({ session, approvals: approvals.filter((a) => a.runId === session.id) }, { headers: { "Cache-Control": "no-store" } });
    },
    "/w/:ws/demo/automation": {
      POST: async (req, srv) => {
        const ws = publicWorkspace(req.params.ws);
        if (!ws) return new Response("not found", { status: 404 });
        const denied = await guardWrite(req, srv, ws);
        if (denied) return denied;
        const form = await formOf(req);
        if (form instanceof Response) return form;
        const f = AutomationForm.safeParse(form);
        if (!f.success) return back(ws, `入力が不正: ${f.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
        const ev = automationEvent(f.data, ws, Date.now(), cfg.DEMO_EVENT_TTL_HOURS);
        if (typeof ev === "string") return back(ws, ev);
        const e = await write(ws, () => calendar.insertEvent(ws.calendars.automation, ev));
        log("info", "demo event created", { workspace: ws.id, role: "automation", eventId: e.id });
        return back(ws, `「${f.data.title}」を追加した。`);
      },
    },
    "/w/:ws/demo/deadline": {
      POST: async (req, srv) => {
        const ws = publicWorkspace(req.params.ws);
        if (!ws) return new Response("not found", { status: 404 });
        const denied = await guardWrite(req, srv, ws);
        if (denied) return denied;
        const form = await formOf(req);
        if (form instanceof Response) return form;
        const f = DeadlineForm.safeParse(form);
        if (!f.success) return back(ws, `入力が不正: ${f.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
        const ev = deadlineEvent(f.data, ws, Date.now(), cfg.DEMO_EVENT_TTL_HOURS);
        if (typeof ev === "string") return back(ws, ev);
        const e = await write(ws, () => calendar.insertEvent(ws.calendars.records, ev));
        log("info", "demo event created", { workspace: ws.id, role: "records", eventId: e.id });
        return back(ws, `「${f.data.title}」を追加した。`);
      },
    },
    "/w/:ws/demo/events/:role/:id/delete": {
      POST: async (req, srv) => {
        const ws = publicWorkspace(req.params.ws);
        const role = req.params.role;
        if (!ws || (role !== "automation" && role !== "records") || !EVENT_ID.test(req.params.id)) return new Response("not found", { status: 404 });
        const denied = await guardWrite(req, srv, ws);
        if (denied) return denied;
        // デモ用フォームで足した予定だけを消せる
        const e = (await store.listEvents(ws.id, role)).find((x) => x.id === req.params.id);
        if (!e?.tags[DEMO_EXPIRES_TAG]) return back(ws, "デモで足した予定だけを消せる。");
        await write(ws, () => calendar.deleteEvent(ws.calendars[role], e.id));
        return back(ws, `「${e.summary}」を消した。`);
      },
    },
    "/w/:ws/approvals/:id/:decision": {
      POST: async (req, srv) => {
        const ws = publicWorkspace(req.params.ws);
        const decision = req.params.decision;
        if (!ws || (decision !== "approve" && decision !== "reject") || !RUN_ID.test(req.params.id)) return new Response("not found", { status: 404 });
        const denied = await guardWrite(req, srv, ws);
        if (denied) return denied;
        const a = await store.decideApproval(ws.id, req.params.id, decision === "approve" ? "approved" : "rejected");
        if (!a) return back(ws, "この承認待ちは既に決定済み。");
        const to = `/sessions/${encodeURIComponent(a.runId)}`;
        if (a.status === "rejected") return back(ws, "却下した。", to);
        try {
          const op = a.operation;
          const created = await calendar.insertEvent(ws.calendars.records, {
            summary: op.summary,
            notes: `${op.notes}\n\n（agent-calendar の提案を承認して追加。run ${a.runId.slice(0, 8)}）`,
            start: op.start,
            end: op.end,
            // public な組では、承認して足した予定もデモ用として期限で消す
            tags: { [DEMO_EXPIRES_TAG]: new Date(Date.now() + cfg.DEMO_EVENT_TTL_HOURS * 60 * 60 * 1000).toISOString() },
          });
          await store.saveApproval(ws.id, { ...a, createdEventId: created.id });
          return back(ws, `「${op.summary}」を追加した。`, to);
        } catch (e) {
          await store.saveApproval(ws.id, { ...a, status: "failed", error: (e as Error).message.slice(0, 300) });
          return back(ws, "カレンダーへの追加に失敗した。", to);
        }
      },
    },
  },
  // /sandbox/llm・/sandbox/result は sandbox の token で認証する（src/cloud/）
  fetch: async (req) => (await handleSandbox(req)) ?? new Response("not found", { status: 404 }),
  error: (e) => {
    if (e instanceof WriteFailed) return back(e.ws, e.message);
    log("error", "request failed", { error: e.message });
    return new Response("internal error", { status: 500 });
  },
});

log("info", "server started", { port: server.port, workspaces: cfg.workspaces.map((w) => w.id), store: cfg.STORE });
