import { GoogleGenAI } from "@google/genai";
import { OAuth2Client } from "google-auth-library";
import { createAuthClient } from "./auth";
import { ServiceAccountCalendar } from "./calendar/service-account";
import { loadConfig, type Workspace } from "./config";
import { toWall } from "./domain/time";
import { log } from "./log";
import { DEMO_EXPIRES_TAG, tick, type Deps } from "./runner";
import { FirestoreStore } from "./store/firestore";
import { MemoryStore } from "./store/memory";
import type { Store } from "./store/store";
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
const deps: Deps = { cfg, store, calendar, ai };
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

const today = (ws: Workspace) => new Date(toWall(Date.now(), ws.timeZone)).toISOString().slice(0, 10);
const html = (body: string) => new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });

// 一覧は全員が数秒ごとに読むので、Firestore の読み取りを instance ごとに数秒まとめる
const SESSIONS_CACHE_MS = 2500;
const sessionsCache = new Map<string, { at: number; body: unknown }>();

async function sessionsJson(ws: Workspace) {
  const hit = sessionsCache.get(ws.id);
  if (hit && Date.now() - hit.at < SESSIONS_CACHE_MS) return hit.body;
  const [schedule, runs, approvals, automation, records] = await Promise.all([
    store.getSchedule(ws.id),
    store.listRuns(ws.id, 30),
    store.listApprovals(ws.id, 50),
    store.listEvents(ws.id, "automation"),
    store.listEvents(ws.id, "records"),
  ]);
  const pending = new Map<string, number>();
  for (const a of approvals) if (a.status === "pending") pending.set(a.runId, (pending.get(a.runId) ?? 0) + 1);
  const body = {
    next: (schedule?.items ?? []).slice(0, 3).map((i) => ({ fireAt: i.fireAt, title: i.title, blocked: i.blocked })),
    // デモ用フォームで足した予定（dashboard から消せる）
    demoEvents: [
      ...automation.map((e) => ({ role: "automation" as const, e })),
      ...records.map((e) => ({ role: "records" as const, e })),
    ]
      .filter(({ e }) => e.tags[DEMO_EXPIRES_TAG] && e.status !== "cancelled" && !e.recurringEventId)
      .map(({ role, e }) => ({ role, id: e.id, title: e.summary, expiresAt: e.tags[DEMO_EXPIRES_TAG] })),
    sessions: runs.map((r) => ({
      id: r.id,
      title: r.title,
      kind: r.kind,
      status: r.status,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      late: r.late,
      toolCalls: r.toolCalls.length,
      pendingApprovals: pending.get(r.id) ?? 0,
    })),
  };
  sessionsCache.set(ws.id, { at: Date.now(), body });
  return body;
}

async function formOf(req: Request): Promise<Record<string, string>> {
  const fd = await req.formData();
  return Object.fromEntries([...fd.entries()].map(([k, v]) => [k, typeof v === "string" ? v : ""]));
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
    "/w/:ws": (req) => {
      const ws = publicWorkspace(req.params.ws);
      if (!ws) return new Response("not found", { status: 404 });
      return html(renderSessionsPage(ws, today(ws), new URL(req.url).searchParams.get("flash") ?? undefined));
    },
    "/w/:ws/sessions/:id": (req) => {
      const ws = publicWorkspace(req.params.ws);
      if (!ws) return new Response("not found", { status: 404 });
      return html(renderSessionPage(ws, req.params.id, new URL(req.url).searchParams.get("flash") ?? undefined));
    },
    "/w/:ws/api/sessions": async (req) => {
      const ws = publicWorkspace(req.params.ws);
      if (!ws) return new Response("not found", { status: 404 });
      return Response.json(await sessionsJson(ws), { headers: { "Cache-Control": "no-store" } });
    },
    "/w/:ws/api/sessions/:id": async (req) => {
      const ws = publicWorkspace(req.params.ws);
      if (!ws) return new Response("not found", { status: 404 });
      const [session, approvals] = await Promise.all([store.getRun(ws.id, req.params.id), store.listApprovals(ws.id, 50)]);
      if (!session) return new Response("not found", { status: 404 });
      return Response.json({ session, approvals: approvals.filter((a) => a.runId === session.id) }, { headers: { "Cache-Control": "no-store" } });
    },
    "/w/:ws/demo/automation": {
      POST: async (req, srv) => {
        const ws = publicWorkspace(req.params.ws);
        if (!ws) return new Response("not found", { status: 404 });
        const f = AutomationForm.safeParse(await formOf(req));
        if (!f.success) return back(ws, `入力が不正: ${f.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
        if (!(await allowWrite(req, srv, ws))) return back(ws, LIMITED);
        const e = await write(ws, () => calendar.insertEvent(ws.calendars.automation, automationEvent(f.data, ws, Date.now(), cfg.DEMO_EVENT_TTL_HOURS)));
        log("info", "demo event created", { workspace: ws.id, role: "automation", eventId: e.id });
        return back(ws, `「${f.data.title}」を追加した。`);
      },
    },
    "/w/:ws/demo/deadline": {
      POST: async (req, srv) => {
        const ws = publicWorkspace(req.params.ws);
        if (!ws) return new Response("not found", { status: 404 });
        const f = DeadlineForm.safeParse(await formOf(req));
        if (!f.success) return back(ws, `入力が不正: ${f.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
        const ev = deadlineEvent(f.data, ws, Date.now(), cfg.DEMO_EVENT_TTL_HOURS);
        if (typeof ev === "string") return back(ws, ev);
        if (!(await allowWrite(req, srv, ws))) return back(ws, LIMITED);
        const e = await write(ws, () => calendar.insertEvent(ws.calendars.records, ev));
        log("info", "demo event created", { workspace: ws.id, role: "records", eventId: e.id });
        return back(ws, `「${f.data.title}」を追加した。`);
      },
    },
    "/w/:ws/demo/events/:role/:id/delete": {
      POST: async (req, srv) => {
        const ws = publicWorkspace(req.params.ws);
        const role = req.params.role;
        if (!ws || (role !== "automation" && role !== "records")) return new Response("not found", { status: 404 });
        // デモ用フォームで足した予定だけを消せる
        const e = (await store.listEvents(ws.id, role)).find((x) => x.id === req.params.id);
        if (!e?.tags[DEMO_EXPIRES_TAG]) return back(ws, "デモで足した予定だけを消せる。");
        if (!(await allowWrite(req, srv, ws))) return back(ws, LIMITED);
        await write(ws, () => calendar.deleteEvent(ws.calendars[role], e.id));
        return back(ws, `「${e.summary}」を消した。`);
      },
    },
    "/w/:ws/approvals/:id/:decision": {
      POST: async (req, srv) => {
        const ws = publicWorkspace(req.params.ws);
        const decision = req.params.decision;
        if (!ws || (decision !== "approve" && decision !== "reject")) return new Response("not found", { status: 404 });
        if (!(await allowWrite(req, srv, ws))) return back(ws, LIMITED);
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
  fetch: () => new Response("not found", { status: 404 }),
  error: (e) => {
    if (e instanceof WriteFailed) return back(e.ws, e.message);
    log("error", "request failed", { error: e.message });
    return new Response("internal error", { status: 500 });
  },
});

log("info", "server started", { port: server.port, workspaces: cfg.workspaces.map((w) => w.id), store: cfg.STORE });
