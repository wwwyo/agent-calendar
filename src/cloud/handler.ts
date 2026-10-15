import type { AuthClient } from "google-auth-library";
import { bearer } from "../auth";
import { OUTPUT_MAX, SANDBOX_PATHS, SandboxResultSchema, type RunAccess } from "../dispatch/types";
import { log } from "../log";
import { hashSandboxToken, type SandboxTokens, type TokenCheck } from "./tokens";

// /sandbox/llm の body の上限
export const LLM_BODY_MAX = 256 * 1024;
// /sandbox/result の body の上限（output は OUTPUT_MAX 文字。多バイト文字と reason の分を見込む）
export const RESULT_BODY_MAX = OUTPUT_MAX * 4 + 16 * 1024;

// Vertex AI の generateContent だけを抜いたもの。model は呼ぶ側では選ばせない。テストでは fake を使う
export interface VertexApi {
  generateContent(request: Record<string, unknown>): Promise<{ status: number; body: string }>;
}

export class VertexRestApi implements VertexApi {
  constructor(
    private opts: { project: string; location: string; model: string; auth: AuthClient },
    private fetchFn: typeof fetch = fetch,
  ) {}

  async generateContent(request: Record<string, unknown>) {
    const { project, location, model, auth } = this.opts;
    const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`;
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${await bearer(auth)}`, "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    return { status: res.status, body: await res.text() };
  }
}

class Rejected extends Error {}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// 通す part。fileData（gs:// など）は runner の権限で読ませることになるので落とさず拒む
const PART_KEYS = new Set(["text", "inlineData", "thought", "thoughtSignature"]);
// 通す generationConfig。model を切り替える routingConfig・費用が増える candidateCount は通さない
const GENERATION_KEYS = new Set([
  "temperature",
  "topP",
  "topK",
  "maxOutputTokens",
  "stopSequences",
  "presencePenalty",
  "frequencyPenalty",
  "seed",
  "responseMimeType",
  "responseSchema",
  "responseJsonSchema",
  "thinkingConfig",
]);

// sandbox から来た generateContent の request を、runner が許す形に作り直す。
// model は URL で runner が決め、tools は googleSearch だけを残す。知らない key は落とす
export function sanitizeLlmRequest(body: unknown): Record<string, unknown> {
  if (!isObject(body)) throw new Rejected("body は object にする");
  if (!Array.isArray(body.contents) || body.contents.length === 0) throw new Rejected("contents が要る");
  const contents = body.contents.map((c) => {
    if (!isObject(c) || !Array.isArray(c.parts)) throw new Rejected("contents[].parts が要る");
    const parts = c.parts.map((p) => {
      if (!isObject(p) || Object.keys(p).some((k) => !PART_KEYS.has(k))) throw new Rejected("text・inlineData 以外の part は使えない");
      return p;
    });
    return { ...(c.role === "user" || c.role === "model" ? { role: c.role } : {}), parts };
  });
  const out: Record<string, unknown> = { contents };
  if (isObject(body.systemInstruction) && Array.isArray(body.systemInstruction.parts)) {
    const parts = body.systemInstruction.parts.filter((p) => isObject(p) && typeof p.text === "string").map((p) => ({ text: (p as { text: string }).text }));
    if (parts.length > 0) out.systemInstruction = { parts };
  }
  if (isObject(body.generationConfig)) {
    out.generationConfig = Object.fromEntries(Object.entries(body.generationConfig).filter(([k]) => GENERATION_KEYS.has(k)));
  }
  if (Array.isArray(body.safetySettings)) out.safetySettings = body.safetySettings;
  if (Array.isArray(body.tools)) {
    const tools = body.tools.filter((t) => isObject(t) && isObject(t.googleSearch)).map((t) => ({ googleSearch: (t as { googleSearch: unknown }).googleSearch }));
    if (tools.length > 0) out.tools = tools;
  }
  return out;
}

// Content-Length を信じず、上限を超えたところで読むのをやめる
async function readLimited(req: Request, max: number): Promise<string> {
  const declared = Number(req.headers.get("content-length"));
  if (declared > max) throw new TooLarge();
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new TooLarge();
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

class TooLarge extends Error {}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function tokenOf(req: Request): string | undefined {
  const m = /^Bearer ([A-Za-z0-9_-]{16,128})$/.exec(req.headers.get("authorization") ?? "");
  return m?.[1];
}

function denied(r: Exclude<TokenCheck, { ok: true }>): Response {
  if (r.reason === "exhausted") return json(429, { error: "この実行で LLM を呼べる回数を使い切った" });
  if (r.reason === "done") return json(409, { error: "この実行の結果は受け取り済み" });
  return json(401, { error: "token が無効か期限切れ" });
}

export type SandboxHandlerDeps = { runs: RunAccess; tokens: SandboxTokens; vertex: VertexApi; now?: () => number };
export type SandboxHandler = (req: Request) => Promise<Response | undefined>;

// /sandbox/* の受け口。それ以外の path には undefined を返し、server.ts の他の route に回す
export function createSandboxHandler(deps: SandboxHandlerDeps): SandboxHandler {
  const now = () => deps.now?.() ?? Date.now();

  async function llm(req: Request, token: string): Promise<Response> {
    let request: Record<string, unknown>;
    try {
      request = sanitizeLlmRequest(JSON.parse(await readLimited(req, LLM_BODY_MAX)));
    } catch (e) {
      if (e instanceof TooLarge) return json(413, { error: `body は ${LLM_BODY_MAX} byte まで` });
      return json(400, { error: e instanceof Rejected ? e.message : "body が JSON でない" });
    }
    const r = await deps.tokens.useLlmCall(hashSandboxToken(token), now());
    if (!r.ok) return denied(r);
    const res = await deps.vertex.generateContent(request);
    if (res.status >= 400) log("warn", "sandbox llm failed", { workspace: r.doc.workspace, runId: r.doc.runId, status: res.status });
    return new Response(res.body, { status: res.status, headers: { "Content-Type": "application/json" } });
  }

  async function result(req: Request, token: string): Promise<Response> {
    let parsed;
    try {
      parsed = SandboxResultSchema.safeParse(JSON.parse(await readLimited(req, RESULT_BODY_MAX)));
    } catch (e) {
      if (e instanceof TooLarge) return json(413, { error: `body は ${RESULT_BODY_MAX} byte まで` });
      return json(400, { error: "body が JSON でない" });
    }
    if (!parsed.success) return json(400, { error: "body が SandboxResult の形でない" });
    const at = now();
    const r = await deps.tokens.finish(hashSandboxToken(token), at);
    if (!r.ok) return denied(r);
    const { workspace, runId } = r.doc;
    const run = await deps.runs.getRun(workspace, runId);
    // tick が期限切れで failed にした後などは捨てる
    if (!run || run.status !== "running" || run.executor !== "cloud") {
      log("warn", "sandbox result discarded", { workspace, runId, status: run?.status });
      return json(409, { error: "この Run は結果を受け取れる状態でない" });
    }
    const { status, output, reason } = parsed.data;
    // getRun の後に tick が期限切れで閉じても上書きしないよう、running のときだけ書く
    const saved = await deps.runs.updateRunIf(workspace, runId, "running", { status, output, ...(reason ? { reason } : {}), finishedAt: new Date(at).toISOString() });
    if (!saved) {
      log("warn", "sandbox result discarded", { workspace, runId, status: "closed while saving" });
      return json(409, { error: "この Run は結果を受け取れる状態でない" });
    }
    log("info", "sandbox result saved", { workspace, runId, status });
    return json(200, { ok: true });
  }

  return async (req) => {
    const path = new URL(req.url).pathname;
    if (path !== SANDBOX_PATHS.llm && path !== SANDBOX_PATHS.result) return undefined;
    if (req.method !== "POST") return json(405, { error: "POST だけ受ける" });
    const token = tokenOf(req);
    if (!token) return json(401, { error: "token が無効か期限切れ" });
    return path === SANDBOX_PATHS.llm ? llm(req, token) : result(req, token);
  };
}
