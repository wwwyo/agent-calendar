import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { buildArgv } from "./config";

export const SPOOL_ROOT = join(homedir(), ".local/state/agent-calendar/runs");

// terminal の --command に載せる runId。shell に渡るので文字を絞る
export const RUN_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

const JobSchema = z
  .object({
    runId: z.string().regex(RUN_ID_PATTERN),
    command: z.array(z.string().min(1)).min(1),
    prompt: z.string(),
    cwd: z.string().min(1),
  })
  .strict();
export type Job = z.infer<typeof JobSchema>;

export type JobResult = { exitCode: number; stdout: string; stderr: string };

// worker 本体と exec-run が受け渡す場所。runs/<runId>/{job.json,stdout.log,stderr.log,exit_code}
export class Spool {
  constructor(readonly root = SPOOL_ROOT) {}

  dir(runId: string) {
    if (!RUN_ID_PATTERN.test(runId)) throw new Error(`runId が不正: ${runId}`);
    return join(this.root, runId);
  }

  async writeJob(job: Job) {
    const dir = this.dir(job.runId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(dir, "job.json"), JSON.stringify(JobSchema.parse(job)), { mode: 0o600 });
  }

  async readJob(runId: string): Promise<Job> {
    return JobSchema.parse(JSON.parse(await readFile(join(this.dir(runId), "job.json"), "utf8")));
  }

  // exit_code がまだ無ければ undefined
  async readResult(runId: string): Promise<JobResult | undefined> {
    const dir = this.dir(runId);
    const code = await readFile(join(dir, "exit_code"), "utf8").catch(() => undefined);
    if (code === undefined) return undefined;
    const read = (name: string) => readFile(join(dir, name), "utf8").catch(() => "");
    return { exitCode: Number(code.trim()), stdout: await read("stdout.log"), stderr: await read("stderr.log") };
  }

  // 書きかけを読まれないよう、一時ファイルに書いてから rename する
  async writeExitCode(runId: string, code: number) {
    const dir = this.dir(runId);
    await writeFile(join(dir, "exit_code.tmp"), String(code));
    await rename(join(dir, "exit_code.tmp"), join(dir, "exit_code"));
  }
}

// terminal の中で動く側。shell を通さずに agent を起こし、出力をファイルと terminal の両方に流して exit code を書く
export async function execRun(spool: Spool, runId: string, echo: { stdout: (s: Uint8Array) => void; stderr: (s: Uint8Array) => void } = defaultEcho): Promise<number> {
  const job = await spool.readJob(runId);
  const dir = spool.dir(runId);
  const out = Bun.file(join(dir, "stdout.log")).writer();
  const err = Bun.file(join(dir, "stderr.log")).writer();
  let code: number;
  try {
    const proc = Bun.spawn(buildArgv(job.command, job.prompt), { cwd: job.cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const pump = async (stream: ReadableStream<Uint8Array>, file: typeof out, write: (s: Uint8Array) => void) => {
      for await (const chunk of stream) {
        file.write(chunk);
        write(chunk);
      }
    };
    await Promise.all([pump(proc.stdout, out, echo.stdout), pump(proc.stderr, err, echo.stderr)]);
    code = await proc.exited;
  } catch (e) {
    // コマンドが見つからないなど、起動できなかった
    const msg = new TextEncoder().encode(`起動できなかった: ${(e as Error).message}\n`);
    err.write(msg);
    echo.stderr(msg);
    code = 127;
  }
  await out.end();
  await err.end();
  await spool.writeExitCode(runId, code);
  return code;
}

const defaultEcho = {
  stdout: (s: Uint8Array) => void process.stdout.write(s),
  stderr: (s: Uint8Array) => void process.stderr.write(s),
};
