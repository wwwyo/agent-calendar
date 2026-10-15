import { describe, expect, test } from "bun:test";
import { SANDBOX_ENV, SANDBOX_GRACE_MS, SANDBOX_LLM_CALLS_MAX, SANDBOX_TIMEOUT_MS, type RunAccess } from "../dispatch/types";
import type { Run } from "../store/store";
import { createSandboxHandler, LLM_BODY_MAX, sanitizeLlmRequest, type VertexApi } from "./handler";
import { CloudRunJobsApi, SandboxLauncher, type JobsApi } from "./launcher";
import { hashSandboxToken, MemorySandboxTokens } from "./tokens";

const NOW = Date.parse("2026-10-15T00:00:00Z");

class FakeJobs implements JobsApi {
  calls: Record<string, string>[] = [];
  fail = false;
  async run(env: Record<string, string>) {
    if (this.fail) throw new Error("jobs.run 失敗");
    this.calls.push(env);
    return { execution: `projects/p/locations/us-central1/jobs/agent-sandbox/executions/e${this.calls.length}` };
  }
}

class FakeVertex implements VertexApi {
  requests: Record<string, unknown>[] = [];
  async generateContent(request: Record<string, unknown>) {
    this.requests.push(request);
    return { status: 200, body: JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }) };
  }
}

class FakeRuns implements RunAccess {
  runs = new Map<string, Run>();
  async getRun(ws: string, id: string) {
    return this.runs.get(`${ws}/${id}`);
  }
  async saveRun(ws: string, run: Run) {
    this.runs.set(`${ws}/${run.id}`, run);
  }
}

function runningRun(id: string): Run {
  return { id, fireKey: `k-${id}`, kind: "automation", title: "t", eventId: "e", scheduledAt: new Date(NOW).toISOString(), startedAt: new Date(NOW).toISOString(), status: "running", executor: "cloud", agent: "gemini", toolCalls: [] };
}

function setup() {
  let now = NOW;
  const jobs = new FakeJobs();
  const tokens = new MemorySandboxTokens();
  const vertex = new FakeVertex();
  const runs = new FakeRuns();
  const launcher = new SandboxLauncher({ jobs, tokens, runnerUrl: "https://runner.example", now: () => now });
  const handle = createSandboxHandler({ runs, tokens, vertex, now: () => now });
  return { jobs, tokens, vertex, runs, launcher, handle, advance: (ms: number) => (now += ms) };
}

async function launch(s: ReturnType<typeof setup>, runId = "r1") {
  await s.runs.saveRun("me", runningRun(runId));
  const started = await s.launcher.start({ workspace: "me", runId, agent: "gemini", prompt: "天気を調べて" });
  return { ...started, token: s.jobs.calls.at(-1)![SANDBOX_ENV.token]! };
}

const llmReq = (token: string, body: unknown = { contents: [{ role: "user", parts: [{ text: "hi" }] }] }) =>
  new Request("https://runner.example/sandbox/llm", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });

const resultReq = (token: string, body: unknown = { status: "succeeded", output: "done" }) =>
  new Request("https://runner.example/sandbox/result", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });

describe("SandboxLauncher", () => {
  test("token を env で渡し、保存するのは sha256 だけ", async () => {
    const s = setup();
    const { execution, deadlineAt, token } = await launch(s);
    const env = s.jobs.calls[0]!;
    expect(env).toEqual({ RUN_ID: "r1", AGENT: "gemini", PROMPT: "天気を調べて", RUNNER_URL: "https://runner.example", SANDBOX_TOKEN: token });
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(execution).toEndWith("/executions/e1");
    expect(deadlineAt).toBe(new Date(NOW + SANDBOX_TIMEOUT_MS + SANDBOX_GRACE_MS).toISOString());
    expect([...s.tokens.docs.keys()]).toEqual([hashSandboxToken(token)]);
    expect(s.tokens.docs.get(hashSandboxToken(token))).toEqual({ workspace: "me", runId: "r1", expireAt: new Date(deadlineAt), llmCalls: 0, done: false });
  });

  test("実行ごとに別の token", async () => {
    const s = setup();
    const a = await launch(s, "r1");
    const b = await launch(s, "r2");
    expect(a.token).not.toBe(b.token);
  });

  test("job を起こせなければ token を失効させて throw", async () => {
    const s = setup();
    s.jobs.fail = true;
    await expect(s.launcher.start({ workspace: "me", runId: "r1", agent: "gemini", prompt: "p" })).rejects.toThrow("jobs.run 失敗");
    expect([...s.tokens.docs.values()].every((d) => d.done)).toBe(true);
  });
});

describe("CloudRunJobsApi", () => {
  const auth = { getAccessToken: async () => ({ token: "sa-token" }) } as never;

  test("jobs.run に env の override・task 1・timeout を付け、execution 名を返す", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return Response.json({ name: "projects/p/locations/us-central1/operations/op1", metadata: { name: "projects/p/locations/us-central1/jobs/agent-sandbox/executions/x" } });
    }) as unknown as typeof fetch;
    const api = new CloudRunJobsApi("projects/p/locations/us-central1/jobs/agent-sandbox", auth, fetchFn);
    expect(await api.run({ RUN_ID: "r1" })).toEqual({ execution: "projects/p/locations/us-central1/jobs/agent-sandbox/executions/x" });
    expect(seen[0]!.url).toBe("https://run.googleapis.com/v2/projects/p/locations/us-central1/jobs/agent-sandbox:run");
    expect((seen[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer sa-token");
    expect(JSON.parse(seen[0]!.init.body as string)).toEqual({
      overrides: { containerOverrides: [{ env: [{ name: "RUN_ID", value: "r1" }] }], taskCount: 1, timeout: "900s" },
    });
  });

  test("失敗の応答は throw", async () => {
    const fetchFn = (async () => new Response("denied", { status: 403 })) as unknown as typeof fetch;
    const api = new CloudRunJobsApi("projects/p/locations/us-central1/jobs/agent-sandbox", auth, fetchFn);
    await expect(api.run({})).rejects.toThrow("403");
  });

  test("resource 名でない SANDBOX_JOB は弾く", () => {
    expect(() => new CloudRunJobsApi("agent-sandbox", auth)).toThrow();
  });
});

describe("sanitizeLlmRequest", () => {
  test("tools は googleSearch だけ残し、model・知らない key・routingConfig を落とす", () => {
    const out = sanitizeLlmRequest({
      model: "gemini-2.5-pro",
      cachedContent: "projects/x/cachedContents/y",
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      tools: [{ googleSearch: {} }, { functionDeclarations: [{ name: "rm" }] }, { codeExecution: {} }, { retrieval: {} }],
      toolConfig: { functionCallingConfig: { mode: "ANY" } },
      generationConfig: { temperature: 0.2, candidateCount: 8, routingConfig: { manualMode: { modelName: "gemini-2.5-pro" } } },
      systemInstruction: { parts: [{ text: "be nice" }, { fileData: { fileUri: "gs://x" } }] },
    });
    expect(out).toEqual({
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      tools: [{ googleSearch: {} }],
      generationConfig: { temperature: 0.2 },
      systemInstruction: { parts: [{ text: "be nice" }] },
    });
  });

  test("fileData の part は拒む（runner の権限で gs:// を読ませない）", () => {
    expect(() => sanitizeLlmRequest({ contents: [{ role: "user", parts: [{ fileData: { fileUri: "gs://b/o" } }] }] })).toThrow();
  });

  test("contents がなければ拒む", () => {
    expect(() => sanitizeLlmRequest({})).toThrow();
    expect(() => sanitizeLlmRequest([])).toThrow();
  });
});

describe("/sandbox/llm", () => {
  test("token があれば Vertex AI に流して応答を返し、回数を数える", async () => {
    const s = setup();
    const { token } = await launch(s);
    const res = await s.handle(llmReq(token, { contents: [{ parts: [{ text: "hi" }] }], tools: [{ functionDeclarations: [] }] }));
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({ candidates: [{ content: { parts: [{ text: "ok" }] } }] });
    expect(s.vertex.requests).toEqual([{ contents: [{ parts: [{ text: "hi" }] }] }]);
    expect(s.tokens.docs.get(hashSandboxToken(token))!.llmCalls).toBe(1);
  });

  test("token がない・知らない token は 401", async () => {
    const s = setup();
    await launch(s);
    expect((await s.handle(new Request("https://r/sandbox/llm", { method: "POST", body: "{}" })))!.status).toBe(401);
    expect((await s.handle(llmReq("x".repeat(43))))!.status).toBe(401);
    expect(s.vertex.requests).toHaveLength(0);
  });

  test(`${SANDBOX_LLM_CALLS_MAX} 回を超えたら 429`, async () => {
    const s = setup();
    const { token } = await launch(s);
    for (let i = 0; i < SANDBOX_LLM_CALLS_MAX; i++) expect((await s.handle(llmReq(token)))!.status).toBe(200);
    expect((await s.handle(llmReq(token)))!.status).toBe(429);
    expect(s.vertex.requests).toHaveLength(SANDBOX_LLM_CALLS_MAX);
  });

  test("期限を過ぎた token は 401", async () => {
    const s = setup();
    const { token } = await launch(s);
    s.advance(SANDBOX_TIMEOUT_MS + SANDBOX_GRACE_MS);
    expect((await s.handle(llmReq(token)))!.status).toBe(401);
  });

  test("body が上限を超えたら 413（回数は進めない）", async () => {
    const s = setup();
    const { token } = await launch(s);
    const big = { contents: [{ parts: [{ text: "a".repeat(LLM_BODY_MAX) }] }] };
    expect((await s.handle(llmReq(token, big)))!.status).toBe(413);
    expect(s.tokens.docs.get(hashSandboxToken(token))!.llmCalls).toBe(0);
  });

  test("形の悪い body は 400", async () => {
    const s = setup();
    const { token } = await launch(s);
    const res = await s.handle(new Request("https://r/sandbox/llm", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: "not json" }));
    expect(res!.status).toBe(400);
  });

  test("結果を返した後の token では呼べない", async () => {
    const s = setup();
    const { token } = await launch(s);
    await s.handle(resultReq(token));
    expect((await s.handle(llmReq(token)))!.status).toBe(409);
  });
});

describe("/sandbox/result", () => {
  test("running の Run に結果を書き、token を done にする", async () => {
    const s = setup();
    const { token } = await launch(s);
    s.advance(60_000);
    const res = await s.handle(resultReq(token, { status: "failed", output: "out", reason: "exit code 1" }));
    expect(res!.status).toBe(200);
    const run = (await s.runs.getRun("me", "r1"))!;
    expect(run).toMatchObject({ status: "failed", output: "out", reason: "exit code 1", finishedAt: new Date(NOW + 60_000).toISOString() });
    expect(s.tokens.docs.get(hashSandboxToken(token))!.done).toBe(true);
  });

  test("2度目は捨てる", async () => {
    const s = setup();
    const { token } = await launch(s);
    expect((await s.handle(resultReq(token, { status: "succeeded", output: "first" })))!.status).toBe(200);
    expect((await s.handle(resultReq(token, { status: "failed", output: "second" })))!.status).toBe(409);
    expect((await s.runs.getRun("me", "r1"))!.output).toBe("first");
  });

  test("running でない Run への結果は捨てる", async () => {
    const s = setup();
    const { token } = await launch(s);
    await s.runs.saveRun("me", { ...runningRun("r1"), status: "failed", reason: "sandbox から結果が返らなかった" });
    expect((await s.handle(resultReq(token)))!.status).toBe(409);
    expect((await s.runs.getRun("me", "r1"))!.reason).toBe("sandbox から結果が返らなかった");
  });

  test("tick が失効させた token は受けない", async () => {
    const s = setup();
    const { token } = await launch(s);
    await s.tokens.revokeRun("me", "r1");
    expect((await s.handle(resultReq(token)))!.status).toBe(409);
    expect((await s.runs.getRun("me", "r1"))!.status).toBe("running");
  });

  test("SandboxResult の形でない body は 400 で、token は使わない", async () => {
    const s = setup();
    const { token } = await launch(s);
    expect((await s.handle(resultReq(token, { status: "succeeded", output: "x", extra: 1 })))!.status).toBe(400);
    expect(s.tokens.docs.get(hashSandboxToken(token))!.done).toBe(false);
  });
});

describe("handleSandbox の route", () => {
  test("/sandbox 以外は undefined、GET は 405", async () => {
    const s = setup();
    expect(await s.handle(new Request("https://r/tick", { method: "POST" }))).toBeUndefined();
    expect((await s.handle(new Request("https://r/sandbox/llm")))!.status).toBe(405);
  });
});
