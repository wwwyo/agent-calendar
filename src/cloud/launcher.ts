import type { AuthClient } from "google-auth-library";
import { bearer } from "../auth";
import { SANDBOX_ENV, SANDBOX_TIMEOUT_MS, type CloudLauncher, type SandboxJobInput } from "../dispatch/types";
import { hashSandboxToken, newSandboxToken, sandboxDeadline, type SandboxTokens } from "./tokens";

// Cloud Run Admin API の jobs.run（override つき）だけを抜いたもの。テストでは fake を使う
export interface JobsApi {
  run(env: Record<string, string>): Promise<{ execution: string }>;
}

// SANDBOX_JOB は job の resource 名（projects/{p}/locations/{l}/jobs/{job}）
export const SANDBOX_JOB_PATTERN = /^projects\/[^/]+\/locations\/[^/]+\/jobs\/[^/]+$/;

export class CloudRunJobsApi implements JobsApi {
  constructor(
    private job: string,
    private auth: AuthClient,
    private fetchFn: typeof fetch = fetch,
  ) {
    if (!SANDBOX_JOB_PATTERN.test(job)) throw new Error(`SANDBOX_JOB は projects/{p}/locations/{l}/jobs/{job} の形にする: ${job}`);
  }

  async run(env: Record<string, string>) {
    const res = await this.fetchFn(`https://run.googleapis.com/v2/${this.job}:run`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await bearer(this.auth)}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        overrides: {
          containerOverrides: [{ env: Object.entries(env).map(([name, value]) => ({ name, value })) }],
          taskCount: 1,
          timeout: `${SANDBOX_TIMEOUT_MS / 1000}s`,
        },
      }),
    });
    if (!res.ok) throw new Error(`jobs.run が ${res.status} を返した: ${(await res.text()).slice(0, 500)}`);
    // 戻りは long-running operation。metadata が Execution で、その name が execution の resource 名
    const op = (await res.json()) as { name?: string; metadata?: { name?: string } };
    const execution = op.metadata?.name ?? op.name;
    if (!execution) throw new Error("jobs.run の応答に execution の名前がない");
    return { execution };
  }
}

// 発火した cloud の回を起こす。起こすだけで待たない（結果は /sandbox/result に返る）
export class SandboxLauncher implements CloudLauncher {
  constructor(
    private deps: { jobs: JobsApi; tokens: SandboxTokens; runnerUrl: string; now?: () => number },
  ) {}

  async start(input: SandboxJobInput) {
    const now = this.deps.now?.() ?? Date.now();
    const token = newSandboxToken();
    const hash = hashSandboxToken(token);
    const deadline = sandboxDeadline(now);
    await this.deps.tokens.create(hash, { workspace: input.workspace, runId: input.runId, expireAt: deadline, llmCalls: 0, done: false });
    try {
      const { execution } = await this.deps.jobs.run({
        [SANDBOX_ENV.runId]: input.runId,
        [SANDBOX_ENV.agent]: input.agent,
        [SANDBOX_ENV.prompt]: input.prompt,
        [SANDBOX_ENV.runnerUrl]: this.deps.runnerUrl,
        [SANDBOX_ENV.token]: token,
      });
      return { execution, deadlineAt: deadline.toISOString() };
    } catch (e) {
      // 起こせなかった token は使われないので、すぐ失効させる
      await this.deps.tokens.revokeRun(input.workspace, input.runId).catch(() => {});
      throw e;
    }
  }
}
