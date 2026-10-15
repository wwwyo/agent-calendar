import type { Executor, LocalWorkerState } from "../dispatch/types";

// worker が読み書きする `workspaces/{ws}/runs/{id}` の欄。runner の Run のうち worker が触るものだけ
export type WorkerRun = {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed" | "skipped";
  scheduledAt: string;
  executor?: Executor;
  agent?: string;
  target?: string;
  // local の回では prompt
  input?: string;
  workerId?: string;
  startedAt?: string;
  deadlineAt?: string;
};

export type RunPatch = Partial<{
  status: WorkerRun["status"];
  workerId: string;
  startedAt: string;
  deadlineAt: string;
  finishedAt: string;
  output: string;
  reason: string;
}>;

export interface WorkerStore {
  getState(ws: string): Promise<LocalWorkerState | undefined>;
  saveState(ws: string, state: LocalWorkerState): Promise<void>;
  // executor == "local" かつ status == "queued"（順序は問わない）
  listQueued(ws: string): Promise<WorkerRun[]>;
  // workerId が一致し status == "running"
  listRunning(ws: string, workerId: string): Promise<WorkerRun[]>;
  // transaction で読み、fn が patch を返したときだけ書く。書いたら読んだ値と patch を返す
  updateRun(ws: string, id: string, fn: (run: WorkerRun) => RunPatch | undefined): Promise<{ run: WorkerRun; patch: RunPatch } | undefined>;
}

// agent を見える場所（Orca の terminal）に起こす
export interface TerminalLauncher {
  open(input: { repo: string; title: string; command: string }): Promise<{ handle: string }>;
  close(handle: string): Promise<void>;
}
