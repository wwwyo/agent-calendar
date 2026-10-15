// sandbox/（job の image）の中身。runner の取り決めと揃っていることもここで確かめる
import { describe, expect, test } from "bun:test";
import * as contract from "../../sandbox/contract";
import { AGENTS, main, spawnAgent, toResult, type Spawner } from "../../sandbox/entrypoint";
import { runGemini, withSources } from "../../sandbox/gemini";
import { CLOUD_AGENTS, OUTPUT_MAX, SANDBOX_ENV, SANDBOX_PATHS, SANDBOX_TIMEOUT_MS } from "../dispatch/types";

const ENV = { RUN_ID: "r1", AGENT: "gemini", PROMPT: "調べて", RUNNER_URL: "https://runner.example", SANDBOX_TOKEN: "tok", PATH: "/usr/bin" };

function recordFetch(responses: Response[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: URL | string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return responses.shift() ?? new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

describe("取り決め", () => {
  test("sandbox/contract.ts は src/dispatch/types.ts と同じ値", () => {
    expect(contract.SANDBOX_ENV).toEqual(SANDBOX_ENV);
    expect(contract.SANDBOX_PATHS).toEqual(SANDBOX_PATHS);
    expect(contract.OUTPUT_MAX).toBe(OUTPUT_MAX);
    expect(contract.SANDBOX_TIMEOUT_MS).toBe(SANDBOX_TIMEOUT_MS);
  });

  test("image の agent は CLOUD_AGENTS と揃う", () => {
    expect(Object.keys(AGENTS).sort()).toEqual([...CLOUD_AGENTS].sort());
  });
});

describe("entrypoint", () => {
  test("agent を起こし、stdout の末尾を /sandbox/result に返す", async () => {
    let seen: { argv: string[]; env: Record<string, string> } | undefined;
    const spawn: Spawner = async (argv, env) => {
      seen = { argv, env };
      return { exitCode: 0, stdout: "x".repeat(OUTPUT_MAX + 10), stderr: "", timedOut: false };
    };
    const { calls, fetchFn } = recordFetch([]);
    expect(await main(ENV, { spawn, fetchFn })).toBe(0);
    expect(seen!.argv).toEqual(AGENTS.gemini!);
    // agent には proxy に要るものだけを渡す
    expect(Object.keys(seen!.env).sort()).toEqual(["HOME", "PATH", "PROMPT", "RUNNER_URL", "SANDBOX_TOKEN"]);
    expect(calls[0]!.url).toBe("https://runner.example/sandbox/result");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body).toEqual({ status: "succeeded", output: "x".repeat(OUTPUT_MAX) });
  });

  test("知らない agent は起こさず failed を返す", async () => {
    const { calls, fetchFn } = recordFetch([]);
    const spawn: Spawner = async () => {
      throw new Error("呼ばれない");
    };
    expect(await main({ ...ENV, AGENT: "codex" }, { spawn, fetchFn })).toBe(1);
    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({ status: "failed", reason: "この image に agent「codex」はない" });
  });

  test("runner が 5xx なら送り直し、4xx ならやめる", async () => {
    const spawn: Spawner = async () => ({ exitCode: 0, stdout: "ok", stderr: "", timedOut: false });
    const a = recordFetch([new Response("", { status: 503 }), new Response("{}", { status: 200 })]);
    expect(await main(ENV, { spawn, fetchFn: a.fetchFn, delays: [0, 0] })).toBe(0);
    expect(a.calls).toHaveLength(2);
    const b = recordFetch([new Response("", { status: 409 })]);
    expect(await main(ENV, { spawn, fetchFn: b.fetchFn, delays: [0, 0] })).toBe(3);
    expect(b.calls).toHaveLength(1);
  });

  test("toResult: exit code と stderr の末尾を reason にする", () => {
    expect(toResult({ exitCode: 1, stdout: "o", stderr: "boom\n", timedOut: false })).toEqual({ status: "failed", output: "o", reason: "exit code 1: boom" });
    expect(toResult({ exitCode: null, stdout: "", stderr: "", timedOut: true }).reason).toContain("終わらなかった");
  });

  test("spawnAgent: 時間を過ぎたら止める", async () => {
    const r = await spawnAgent(["bun", "-e", "await Bun.sleep(5000)"], { PATH: process.env.PATH ?? "" }, 200);
    expect(r.timedOut).toBe(true);
    const ok = await spawnAgent(["bun", "-e", "console.log(process.env.PROMPT)"], { PATH: process.env.PATH ?? "", PROMPT: "hi" }, 10_000);
    expect(ok).toMatchObject({ exitCode: 0, stdout: "hi\n", timedOut: false });
  });
});

describe("gemini agent", () => {
  test("proxy に googleSearch だけを付けて呼び、思考を除いた text を返す", async () => {
    const { calls, fetchFn } = recordFetch([
      Response.json({ candidates: [{ content: { parts: [{ text: "考え中", thought: true }, { text: "答え" }] } }] }),
    ]);
    expect(await runGemini("調べて", { runnerUrl: "https://runner.example", token: "tok", fetchFn })).toBe("答え");
    expect(calls[0]!.url).toBe("https://runner.example/sandbox/llm");
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.tools).toEqual([{ googleSearch: {} }]);
    expect(body.contents).toEqual([{ role: "user", parts: [{ text: "調べて" }] }]);
    expect(body.model).toBeUndefined();
  });

  test("429 は取り直し、上限の後は throw", async () => {
    const a = recordFetch([new Response("", { status: 429 }), Response.json({ candidates: [{ content: { parts: [{ text: "ok" }] } }] })]);
    expect(await runGemini("p", { runnerUrl: "https://r", token: "t", fetchFn: a.fetchFn, delays: [0] })).toBe("ok");
    const b = recordFetch([new Response("used up", { status: 429 }), new Response("used up", { status: 429 })]);
    await expect(runGemini("p", { runnerUrl: "https://r", token: "t", fetchFn: b.fetchFn, delays: [0] })).rejects.toThrow("429");
  });

  test("grounding の出典を重複なく、上限までの行で答えの後ろに足す", () => {
    const web = (n: number) => ({ web: { uri: `https://s/${n}`, title: `site${n}.example` } });
    const out = withSources("答え", { groundingMetadata: { groundingChunks: [web(1), web(1), { web: {} }, web(2), web(3), web(4), web(5), web(6)] } });
    expect(out).toBe(["答え", "", "出典:", ...[1, 2, 3, 4, 5].map((n) => `- site${n}.example: https://s/${n}`)].join("\n"));
    expect(withSources("答え", {})).toBe("答え");
  });

  test("答えがなければ throw", async () => {
    const { fetchFn } = recordFetch([Response.json({ candidates: [{ finishReason: "SAFETY" }] })]);
    await expect(runGemini("p", { runnerUrl: "https://r", token: "t", fetchFn })).rejects.toThrow("SAFETY");
  });
});
