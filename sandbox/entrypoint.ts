// Cloud Run Job（agent-sandbox）の entrypoint。override の env から agent を起こし、stdout の末尾を runner の /sandbox/result に返す。
// stdout・stderr はそのまま Cloud Logging にも流す
import { OUTPUT_MAX, REASON_MAX, SANDBOX_ENV, SANDBOX_PATHS, SANDBOX_TIMEOUT_MS, type SandboxResult } from "./contract";

// image に入っている agent。CLOUD_AGENTS（src/dispatch/types.ts）と揃える。prompt は argv でなく env で渡す
export const AGENTS: Record<string, string[]> = {
  gemini: ["bun", "run", `${import.meta.dir}/gemini.ts`],
};

// job の timeout より前に止めて、failed を返す時間を残す
const AGENT_TIMEOUT_MS = SANDBOX_TIMEOUT_MS - 60 * 1000;
const POST_DELAYS_MS = [2000, 6000, 15000];

export type AgentExit = { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean };
export type Spawner = (argv: string[], env: Record<string, string>, timeoutMs: number) => Promise<AgentExit>;

const tail = (s: string, n: number) => (s.length > n ? s.slice(-n) : s);

async function pump(stream: ReadableStream<Uint8Array>, sink: NodeJS.WriteStream): Promise<string> {
  const decoder = new TextDecoder();
  let out = "";
  for await (const chunk of stream) {
    sink.write(chunk);
    // 長い出力でもメモリを食わないよう、末尾だけを持つ
    out = tail(out + decoder.decode(chunk, { stream: true }), OUTPUT_MAX * 2);
  }
  return out + decoder.decode();
}

export const spawnAgent: Spawner = async (argv, env, timeoutMs) => {
  const proc = Bun.spawn(argv, { env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, timeoutMs);
  const [stdout, stderr] = await Promise.all([pump(proc.stdout, process.stdout), pump(proc.stderr, process.stderr)]);
  const exitCode = await proc.exited;
  clearTimeout(timer);
  return { exitCode, stdout, stderr, timedOut };
};

export function toResult(exit: AgentExit): SandboxResult {
  const output = tail(exit.stdout, OUTPUT_MAX);
  if (exit.exitCode === 0 && !exit.timedOut) return { status: "succeeded", output };
  const head = exit.timedOut ? `agent が ${AGENT_TIMEOUT_MS / 60000} 分で終わらなかった` : `exit code ${exit.exitCode}`;
  const stderr = exit.stderr.trim();
  return { status: "failed", output, reason: tail(stderr ? `${head}: ${stderr}` : head, REASON_MAX) };
}

export async function main(
  env: Record<string, string | undefined>,
  o: { spawn?: Spawner; fetchFn?: typeof fetch; delays?: number[]; timeoutMs?: number } = {},
): Promise<number> {
  const runnerUrl = env[SANDBOX_ENV.runnerUrl];
  const token = env[SANDBOX_ENV.token];
  if (!runnerUrl || !token) {
    // 結果を返す先がないので、ログに残して終える
    console.error(`${SANDBOX_ENV.runnerUrl} と ${SANDBOX_ENV.token} が要る`);
    return 2;
  }
  const agent = env[SANDBOX_ENV.agent] ?? "";
  const prompt = env[SANDBOX_ENV.prompt] ?? "";
  const argv = AGENTS[agent];
  let result: SandboxResult;
  if (!argv) result = { status: "failed", output: "", reason: `この image に agent「${agent}」はない` };
  else if (!prompt.trim()) result = { status: "failed", output: "", reason: `${SANDBOX_ENV.prompt} が空` };
  else {
    // agent に渡すのは proxy を呼ぶのに要るものだけ
    const childEnv = { PATH: env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: env.HOME ?? "/tmp", [SANDBOX_ENV.prompt]: prompt, [SANDBOX_ENV.runnerUrl]: runnerUrl, [SANDBOX_ENV.token]: token };
    result = toResult(await (o.spawn ?? spawnAgent)(argv, childEnv, o.timeoutMs ?? AGENT_TIMEOUT_MS));
  }
  return postResult(result, runnerUrl, token, o.fetchFn ?? fetch, o.delays ?? POST_DELAYS_MS);
}

async function postResult(result: SandboxResult, runnerUrl: string, token: string, fetchFn: typeof fetch, delays: number[]): Promise<number> {
  for (let i = 0; ; i++) {
    try {
      const res = await fetchFn(new URL(SANDBOX_PATHS.result, runnerUrl), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(result),
      });
      if (res.ok) return result.status === "succeeded" ? 0 : 1;
      // 4xx は送り直しても変わらない（token の失効・受け取り済み）
      if (res.status < 500 || i >= delays.length) {
        console.error(`/sandbox/result が ${res.status} を返した: ${(await res.text()).slice(0, 500)}`);
        return 3;
      }
    } catch (e) {
      if (i >= delays.length) {
        console.error(`/sandbox/result に送れなかった: ${(e as Error).message}`);
        return 3;
      }
    }
    await Bun.sleep(delays[i]!);
  }
}

if (import.meta.main) process.exit(await main(process.env));
