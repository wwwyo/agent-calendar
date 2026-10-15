// runner との取り決め。image を小さく保つため src/dispatch/types.ts を import せず写す。
// 値が揃っていることは src/cloud/sandbox.test.ts が確かめる
export const SANDBOX_ENV = {
  runId: "RUN_ID",
  agent: "AGENT",
  prompt: "PROMPT",
  runnerUrl: "RUNNER_URL",
  token: "SANDBOX_TOKEN",
} as const;

export const SANDBOX_PATHS = { llm: "/sandbox/llm", result: "/sandbox/result" } as const;

export const OUTPUT_MAX = 16_000;
export const REASON_MAX = 2000;
export const SANDBOX_TIMEOUT_MS = 15 * 60 * 1000;

export type SandboxResult = { status: "succeeded" | "failed"; output: string; reason?: string };
