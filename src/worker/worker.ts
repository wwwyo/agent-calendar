import { OUTPUT_MAX, STALE_AFTER_MS, type LocalConfig, type LocalWorkerState } from "../dispatch/types";
import type { RunPatch, TerminalLauncher, WorkerRun, WorkerStore } from "./ports";
import { RUN_ID_PATTERN, type Spool } from "./spool";

export const STALE_REASON = "Mac が止まっていた間の回なので実行しなかった";
export const RESTART_REASON = "worker が再起動した";
const REASON_MAX = 2000;
// exit_code のファイルを見に行く間隔
const WAIT_POLL_MS = 2000;

export type WorkerDeps = {
  config: LocalConfig;
  workerId: string;
  store: WorkerStore;
  launcher: TerminalLauncher;
  spool: Spool;
  // terminal で打つ `exec <worker> exec-run <runId>` を作る
  execCommand: (runId: string) => string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
};

export class Worker {
  private now: () => number;
  private sleep: (ms: number) => Promise<void>;
  private log: NonNullable<WorkerDeps["log"]>;
  // 組ごとに最後に書いた名前の一覧と namesUpdatedAt
  private names = new Map<string, { key: string; at: string }>();

  constructor(private d: WorkerDeps) {
    this.now = d.now ?? Date.now;
    this.sleep = d.sleep ?? ((ms) => Bun.sleep(ms));
    this.log = d.log ?? (() => {});
  }

  private iso(ms = this.now()) {
    return new Date(ms).toISOString();
  }

  // state/local に agent・target の名前と seenAt を書く。名前が変わったときだけ namesUpdatedAt を進める
  async heartbeat() {
    const agents = Object.keys(this.d.config.agents).sort();
    const targets = Object.keys(this.d.config.targets).sort();
    const key = JSON.stringify([agents, targets]);
    const now = this.iso();
    for (const ws of this.d.config.workspaces) {
      let prev = this.names.get(ws);
      if (!prev) {
        const saved = await this.d.store.getState(ws);
        if (saved) prev = { key: JSON.stringify([[...saved.agents].sort(), [...saved.targets].sort()]), at: saved.namesUpdatedAt };
      }
      const at = prev?.key === key ? prev.at : now;
      const state: LocalWorkerState = { workerId: this.d.workerId, agents, targets, namesUpdatedAt: at, seenAt: now };
      await this.d.store.saveState(ws, state);
      this.names.set(ws, { key, at });
    }
  }

  // 起動時: 自分の workerId で running のまま残った Run を failed にする
  async recover() {
    for (const ws of this.d.config.workspaces) {
      for (const run of await this.d.store.listRunning(ws, this.d.workerId)) {
        await this.d.store.updateRun(ws, run.id, (r) =>
          r.status === "running" && r.workerId === this.d.workerId ? { status: "failed", finishedAt: this.iso(), reason: RESTART_REASON } : undefined,
        );
        this.log("recovered", { ws, runId: run.id });
      }
    }
  }

  // 組ごとに queued を scheduledAt の古い順に 1 件ずつ処理する。同時に動かす agent は 1 つ
  async pollOnce() {
    for (const ws of this.d.config.workspaces) {
      const queued = (await this.d.store.listQueued(ws)).sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
      for (const run of queued) await this.process(ws, run.id);
    }
  }

  // queued → running を transaction で取り、agent を起こして結果を書き戻す。取れなければ何もしない
  async process(ws: string, runId: string) {
    const claimed = await this.d.store.updateRun(ws, runId, (r) => this.claim(r));
    if (!claimed) return;
    const { run, patch } = claimed;
    if (patch.status !== "running") {
      this.log("not run", { ws, runId, status: patch.status, reason: patch.reason });
      return;
    }
    const agent = this.d.config.agents[run.agent!]!;
    const repo = this.d.config.targets[run.target!]!.repo;
    const finish = (p: RunPatch) =>
      this.d.store.updateRun(ws, runId, (r) => (r.status === "running" && r.workerId === this.d.workerId ? { finishedAt: this.iso(), ...p } : undefined));

    let handle: string;
    try {
      await this.d.spool.writeJob({ runId, command: agent.command, prompt: run.input!, cwd: repo });
      ({ handle } = await this.d.launcher.open({ repo, title: `agent-calendar ${runId}`, command: this.d.execCommand(runId) }));
    } catch (e) {
      await finish({ status: "failed", reason: clip(`agent を起動できなかった: ${(e as Error).message}`, REASON_MAX) });
      this.log("launch failed", { ws, runId, error: (e as Error).message });
      return;
    }
    this.log("started", { ws, runId, agent: run.agent, target: run.target, handle });

    const deadline = Date.parse(patch.deadlineAt!);
    let result = await this.d.spool.readResult(runId);
    while (!result && this.now() < deadline) {
      await this.sleep(Math.min(WAIT_POLL_MS, Math.max(0, deadline - this.now())));
      result = await this.d.spool.readResult(runId);
    }
    if (!result) {
      await this.d.launcher.close(handle).catch((e) => this.log("close failed", { runId, error: (e as Error).message }));
      await finish({ status: "failed", reason: `timeout_minutes（${agent.timeout_minutes}分）を過ぎたので止めた` });
      this.log("timeout", { ws, runId });
      return;
    }
    const output = tail(result.stdout, OUTPUT_MAX);
    await finish(
      result.exitCode === 0
        ? { status: "succeeded", output }
        : { status: "failed", output, reason: tail(`exit code ${result.exitCode}: ${tail(result.stderr, REASON_MAX)}`, REASON_MAX) },
    );
    this.log("finished", { ws, runId, exitCode: result.exitCode });
  }

  // transaction の中で呼ぶ。queued のときだけ、skipped・failed・running のどれにするかを決める
  private claim(r: WorkerRun): RunPatch | undefined {
    if (r.status !== "queued" || r.executor !== "local") return undefined;
    const now = this.now();
    const done = (status: "skipped" | "failed", reason: string): RunPatch => ({ status, reason, finishedAt: this.iso(now) });
    if (now - Date.parse(r.scheduledAt) > STALE_AFTER_MS) return done("skipped", STALE_REASON);
    if (!RUN_ID_PATTERN.test(r.id)) return done("failed", `runId が worker の受け付ける形でない: ${r.id}`);
    // 判定の後に設定から消えた名前
    const agent = r.agent ? this.d.config.agents[r.agent] : undefined;
    if (!agent) return done("failed", `agent「${r.agent ?? ""}」が local worker の設定にない`);
    if (!r.target || !this.d.config.targets[r.target]) return done("failed", `target「${r.target ?? ""}」が local worker の設定にない`);
    if (!r.input?.trim()) return done("failed", "prompt がない");
    return {
      status: "running",
      workerId: this.d.workerId,
      startedAt: this.iso(now),
      deadlineAt: this.iso(now + agent.timeout_minutes * 60 * 1000),
    };
  }
}

export function tail(s: string, max: number): string {
  return s.length > max ? s.slice(s.length - max) : s;
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}
