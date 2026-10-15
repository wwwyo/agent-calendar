// local worker の入口。
//   bun run src/worker/main.ts            常駐（launchd から起こす）
//   bun run src/worker/main.ts exec-run <runId>   Orca の terminal の中で 1 回分の agent を動かす
import { hostname } from "node:os";
import { loadLocalConfig } from "./config";
import { FirestoreWorkerStore, impersonatedFirestore } from "./firestore";
import { OrcaLauncher, shellQuote } from "./orca";
import { execRun, Spool } from "./spool";
import { Worker } from "./worker";

function log(msg: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ time: new Date().toISOString(), msg, ...fields }));
}

// 再起動しても同じ値になる（起動時の後始末で自分の running を見つけるため）
export function workerIdFor(host: string): string {
  return `local:${host.replace(/\.local$/, "").toLowerCase()}`;
}

async function serve() {
  const config = await loadLocalConfig();
  const store = new FirestoreWorkerStore(await impersonatedFirestore(config.gcp_project, config.service_account));
  const self = [process.execPath, Bun.main];
  const worker = new Worker({
    config,
    workerId: workerIdFor(hostname()),
    store,
    launcher: new OrcaLauncher(),
    spool: new Spool(),
    execCommand: (runId) => `exec ${[...self, "exec-run", runId].map(shellQuote).join(" ")}`,
    log,
  });
  const intervalMs = config.poll_seconds * 1000;

  // agent が長く動いている間も seenAt を進めるため、heartbeat は処理と別に回す
  const beat = async () => worker.heartbeat().catch((e) => log("heartbeat failed", { error: (e as Error).message }));
  await beat();
  setInterval(beat, intervalMs);
  await worker.recover();
  log("worker started", { workspaces: config.workspaces, agents: Object.keys(config.agents), targets: Object.keys(config.targets) });

  for (;;) {
    await worker.pollOnce().catch((e) => log("poll failed", { error: (e as Error).message }));
    await Bun.sleep(intervalMs);
  }
}

if (import.meta.main) {
  const [cmd, runId] = process.argv.slice(2);
  if (cmd === "exec-run") {
    if (!runId) {
      console.error("usage: main.ts exec-run <runId>");
      process.exit(2);
    }
    process.exit(await execRun(new Spool(), runId));
  } else if (cmd === undefined) {
    await serve();
  } else {
    console.error(`unknown command: ${cmd}`);
    process.exit(2);
  }
}
