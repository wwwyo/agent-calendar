import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OUTPUT_MAX, STALE_AFTER_MS, type LocalConfig, type LocalWorkerState } from "../dispatch/types";
import { buildArgv, parseLocalConfig } from "./config";
import { workerIdFor } from "./main";
import { shellQuote, terminalHandle } from "./orca";
import type { RunPatch, TerminalLauncher, WorkerRun, WorkerStore } from "./ports";
import { execRun, Spool } from "./spool";
import { RESTART_REASON, STALE_REASON, Worker } from "./worker";

const NOW = Date.parse("2026-10-15T09:00:00Z");

const TOML = `
gcp_project = "agent-calendar-wwwyo"
service_account = "local-worker@agent-calendar-wwwyo.iam.gserviceaccount.com"
workspaces = ["me"]

[targets.agent-calendar]
repo = "~/src/github.com/wwwyo/agent-calendar"

[agents.codex]
command = ["codex", "exec", "{prompt}"]
timeout_minutes = 5

[agents.claude]
command = ["claude", "-p", "{prompt}"]
`;

class FakeStore implements WorkerStore {
  runs = new Map<string, WorkerRun & RunPatch>();
  states = new Map<string, LocalWorkerState>();
  async getState(ws: string) {
    return this.states.get(ws);
  }
  async saveState(ws: string, s: LocalWorkerState) {
    this.states.set(ws, structuredClone(s));
  }
  async listQueued(_ws: string) {
    return [...this.runs.values()].filter((r) => r.executor === "local" && r.status === "queued").map((r) => ({ ...r }));
  }
  async listRunning(_ws: string, workerId: string) {
    return [...this.runs.values()].filter((r) => r.workerId === workerId && r.status === "running").map((r) => ({ ...r }));
  }
  async updateRun(_ws: string, id: string, fn: (r: WorkerRun) => RunPatch | undefined) {
    const run = this.runs.get(id);
    if (!run) return undefined;
    const patch = fn({ ...run });
    if (!patch) return undefined;
    this.runs.set(id, { ...run, ...patch });
    return { run, patch };
  }
}

// open されたら、terminal の中で exec-run が走った後の状態を spool に作る
class FakeLauncher implements TerminalLauncher {
  opened: { repo: string; title: string; command: string }[] = [];
  closed: string[] = [];
  constructor(private spool: Spool, private result?: { exitCode: number; stdout: string; stderr: string } | Error) {}
  async open(input: { repo: string; title: string; command: string }) {
    if (this.result instanceof Error) throw this.result;
    this.opened.push(input);
    const runId = input.title.split(" ").at(-1)!;
    if (this.result) {
      const dir = this.spool.dir(runId);
      await Bun.write(join(dir, "stdout.log"), this.result.stdout);
      await Bun.write(join(dir, "stderr.log"), this.result.stderr);
      await this.spool.writeExitCode(runId, this.result.exitCode);
    }
    return { handle: `term_${this.opened.length}` };
  }
  async close(handle: string) {
    this.closed.push(handle);
  }
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "worker-test-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function queued(id: string, over: Partial<WorkerRun> = {}): WorkerRun {
  return {
    id,
    status: "queued",
    executor: "local",
    agent: "codex",
    target: "agent-calendar",
    input: "依存の更新を確かめて",
    scheduledAt: new Date(NOW - 60_000).toISOString(),
    ...over,
  };
}

function setup(opts: { result?: { exitCode: number; stdout: string; stderr: string } | Error; config?: LocalConfig } = {}) {
  const config = opts.config ?? parseLocalConfig(TOML, "/home/me");
  const store = new FakeStore();
  const spool = new Spool(root);
  const launcher = new FakeLauncher(spool, opts.result);
  let now = NOW;
  const worker = new Worker({
    config,
    workerId: "local:mac",
    store,
    launcher,
    spool,
    execCommand: (runId) => `exec worker exec-run ${runId}`,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  });
  return { worker, store, launcher, spool, advance: (ms: number) => (now += ms) };
}

describe("config", () => {
  test("TOML を読み、既定値と ~ の展開を入れる", () => {
    const c = parseLocalConfig(TOML, "/home/me");
    expect(c.poll_seconds).toBe(30);
    expect(c.agents.claude!.timeout_minutes).toBe(60);
    expect(c.agents.codex!.timeout_minutes).toBe(5);
    expect(c.targets["agent-calendar"]!.repo).toBe("/home/me/src/github.com/wwwyo/agent-calendar");
  });

  test("知らない欄・不正な名前は拒む", () => {
    expect(() => parseLocalConfig(TOML + `\nshell = "zsh"\n`)).toThrow();
    expect(() => parseLocalConfig(TOML.replace("[agents.claude]", "[agents.Claude]"))).toThrow();
  });

  test("{prompt} と一致する要素だけを丸ごと置き換える", () => {
    expect(buildArgv(["codex", "exec", "{prompt}", "--x={prompt}"], "a; $(rm -rf ~)")).toEqual(["codex", "exec", "a; $(rm -rf ~)", "--x={prompt}"]);
  });
});

describe("heartbeat", () => {
  test("名前と seenAt を書き、名前が変わったときだけ namesUpdatedAt を進める", async () => {
    const { worker, store, advance } = setup();
    await worker.heartbeat();
    const first = store.states.get("me")!;
    expect(first).toEqual({ workerId: "local:mac", agents: ["claude", "codex"], targets: ["agent-calendar"], namesUpdatedAt: new Date(NOW).toISOString(), seenAt: new Date(NOW).toISOString() });

    advance(30_000);
    await worker.heartbeat();
    expect(store.states.get("me")!.namesUpdatedAt).toBe(first.namesUpdatedAt);
    expect(store.states.get("me")!.seenAt).toBe(new Date(NOW + 30_000).toISOString());
  });

  test("再起動しても、保存済みと同じ名前なら namesUpdatedAt を保つ", async () => {
    const { worker, store } = setup();
    store.states.set("me", { workerId: "local:mac", agents: ["codex", "claude"], targets: ["agent-calendar"], namesUpdatedAt: "2026-01-01T00:00:00.000Z", seenAt: "2026-01-01T00:00:00.000Z" });
    await worker.heartbeat();
    expect(store.states.get("me")!.namesUpdatedAt).toBe("2026-01-01T00:00:00.000Z");

    const other = setup();
    other.store.states.set("me", { workerId: "local:mac", agents: ["codex"], targets: [], namesUpdatedAt: "2026-01-01T00:00:00.000Z", seenAt: "2026-01-01T00:00:00.000Z" });
    await other.worker.heartbeat();
    expect(other.store.states.get("me")!.namesUpdatedAt).toBe(new Date(NOW).toISOString());
  });
});

describe("pollOnce", () => {
  test("queued を取り、terminal で起こし、exit 0 なら succeeded と stdout の末尾を書く", async () => {
    const { worker, store, launcher, spool } = setup({ result: { exitCode: 0, stdout: "x".repeat(OUTPUT_MAX + 10) + "END", stderr: "" } });
    store.runs.set("r1", queued("r1"));
    await worker.pollOnce();

    expect(launcher.opened).toEqual([{ repo: "/home/me/src/github.com/wwwyo/agent-calendar", title: "agent-calendar r1", command: "exec worker exec-run r1" }]);
    const job = await spool.readJob("r1");
    expect(job).toEqual({ runId: "r1", command: ["codex", "exec", "{prompt}"], prompt: "依存の更新を確かめて", cwd: "/home/me/src/github.com/wwwyo/agent-calendar" });
    const run = store.runs.get("r1")!;
    expect(run.status).toBe("succeeded");
    expect(run.workerId).toBe("local:mac");
    expect(run.startedAt).toBe(new Date(NOW).toISOString());
    expect(run.deadlineAt).toBe(new Date(NOW + 5 * 60_000).toISOString());
    expect(run.output!.length).toBe(OUTPUT_MAX);
    expect(run.output!.endsWith("END")).toBe(true);
  });

  test("exit code が 0 でなければ failed にし、理由に exit code と stderr の末尾を残す", async () => {
    const { worker, store } = setup({ result: { exitCode: 3, stdout: "partial", stderr: "boom" } });
    store.runs.set("r1", queued("r1"));
    await worker.pollOnce();
    const run = store.runs.get("r1")!;
    expect(run.status).toBe("failed");
    expect(run.reason).toBe("exit code 3: boom");
    expect(run.output).toBe("partial");
  });

  test("6時間より古い queued は実行せず skipped にする", async () => {
    const { worker, store, launcher } = setup({ result: { exitCode: 0, stdout: "", stderr: "" } });
    store.runs.set("old", queued("old", { scheduledAt: new Date(NOW - STALE_AFTER_MS - 1).toISOString() }));
    await worker.pollOnce();
    expect(launcher.opened).toHaveLength(0);
    expect(store.runs.get("old")!.status).toBe("skipped");
    expect(store.runs.get("old")!.reason).toBe(STALE_REASON);
  });

  test("設定にない agent・target は failed にする", async () => {
    const { worker, store, launcher } = setup({ result: { exitCode: 0, stdout: "", stderr: "" } });
    store.runs.set("a", queued("a", { agent: "gone" }));
    store.runs.set("t", queued("t", { target: "gone" }));
    await worker.pollOnce();
    expect(launcher.opened).toHaveLength(0);
    expect(store.runs.get("a")).toMatchObject({ status: "failed", reason: "agent「gone」が local worker の設定にない" });
    expect(store.runs.get("t")).toMatchObject({ status: "failed", reason: "target「gone」が local worker の設定にない" });
  });

  test("scheduledAt の古い順に処理し、cloud の回と queued でない回には触らない", async () => {
    const { worker, store, launcher } = setup({ result: { exitCode: 0, stdout: "", stderr: "" } });
    store.runs.set("b", queued("b", { scheduledAt: new Date(NOW - 1000).toISOString() }));
    store.runs.set("a", queued("a", { scheduledAt: new Date(NOW - 2000).toISOString() }));
    store.runs.set("c", queued("c", { executor: "cloud" }));
    store.runs.set("d", queued("d", { status: "running", workerId: "local:other" }));
    await worker.pollOnce();
    expect(launcher.opened.map((o) => o.title)).toEqual(["agent-calendar a", "agent-calendar b"]);
    expect(store.runs.get("c")!.status).toBe("queued");
    expect(store.runs.get("d")!.workerId).toBe("local:other");
  });

  test("取り合いで先に取られた回は起こさない", async () => {
    const { worker, store, launcher } = setup({ result: { exitCode: 0, stdout: "", stderr: "" } });
    store.runs.set("r1", queued("r1"));
    const list = store.listQueued.bind(store);
    store.listQueued = async (ws: string) => {
      const runs = await list(ws);
      // 一覧を取った後、tick が skipped にした
      store.runs.set("r1", { ...store.runs.get("r1")!, status: "skipped" });
      return runs;
    };
    await worker.pollOnce();
    expect(launcher.opened).toHaveLength(0);
    expect(store.runs.get("r1")!.status).toBe("skipped");
  });

  test("timeout_minutes を過ぎたら terminal を閉じて failed にする", async () => {
    const { worker, store, launcher } = setup();
    store.runs.set("r1", queued("r1"));
    await worker.pollOnce();
    expect(launcher.closed).toEqual(["term_1"]);
    expect(store.runs.get("r1")).toMatchObject({ status: "failed", reason: "timeout_minutes（5分）を過ぎたので止めた" });
  });

  test("terminal を起こせなければ failed にする", async () => {
    const { worker, store } = setup({ result: new Error("orca が動いていない") });
    store.runs.set("r1", queued("r1"));
    await worker.pollOnce();
    expect(store.runs.get("r1")).toMatchObject({ status: "failed", reason: "agent を起動できなかった: orca が動いていない" });
  });
});

describe("recover", () => {
  test("自分の workerId で running のまま残った Run だけを failed にする", async () => {
    const { worker, store } = setup();
    store.runs.set("mine", queued("mine", { status: "running", workerId: "local:mac" }));
    store.runs.set("other", queued("other", { status: "running", workerId: "local:other" }));
    await worker.recover();
    expect(store.runs.get("mine")).toMatchObject({ status: "failed", reason: RESTART_REASON });
    expect(store.runs.get("other")!.status).toBe("running");
  });
});

describe("exec-run", () => {
  test("shell を通さずに起こし、stdout・stderr・exit code を spool に書く", async () => {
    const spool = new Spool(root);
    const prompt = "a; echo injected $(whoami)";
    await spool.writeJob({ runId: "r1", command: ["sh", "-c", 'printf %s "$0"; echo err >&2; exit 3', "{prompt}"], prompt, cwd: root });
    const echoed: string[] = [];
    const dec = new TextDecoder();
    const code = await execRun(spool, "r1", { stdout: (s) => echoed.push(dec.decode(s)), stderr: () => {} });
    expect(code).toBe(3);
    expect(await spool.readResult("r1")).toEqual({ exitCode: 3, stdout: prompt, stderr: "err\n" });
    expect(echoed.join("")).toBe(prompt);
  });

  test("コマンドが無ければ exit 127 を書く", async () => {
    const spool = new Spool(root);
    await spool.writeJob({ runId: "r1", command: ["definitely-not-a-command-xyz"], prompt: "", cwd: root });
    const code = await execRun(spool, "r1", { stdout: () => {}, stderr: () => {} });
    expect(code).toBe(127);
    expect((await spool.readResult("r1"))!.exitCode).toBe(127);
  });

  test("runId に shell の文字を許さない", () => {
    expect(() => new Spool(root).dir("a;b")).toThrow();
    expect(() => new Spool(root).dir("../x")).toThrow();
  });
});

describe("orca", () => {
  test("terminal create の JSON から handle を取る", () => {
    expect(terminalHandle({ result: { terminal: { handle: "term_1" } } })).toBe("term_1");
    expect(terminalHandle({ terminal: { handle: "term_2" } })).toBe("term_2");
    expect(terminalHandle({ handle: "term_3" })).toBe("term_3");
    expect(terminalHandle({ ok: true })).toBeUndefined();
  });

  test("shellQuote は single quote を閉じて逃がす", () => {
    expect(shellQuote("/a b/it's")).toBe(`'/a b/it'\\''s'`);
  });

  test("workerId はホスト名から決まる", () => {
    expect(workerIdFor("Yuitos-MacBook.local")).toBe("local:yuitos-macbook");
  });
});
