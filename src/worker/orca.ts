import type { TerminalLauncher } from "./ports";

// `orca terminal create` で Orca の terminal に起こす。人が Orca から様子を見られる
export class OrcaLauncher implements TerminalLauncher {
  constructor(private bin = "orca") {}

  async open(input: { repo: string; title: string; command: string }) {
    const out = await this.run(["terminal", "create", "--worktree", `path:${input.repo}`, "--title", input.title, "--command", input.command, "--json"]);
    const handle = terminalHandle(JSON.parse(out));
    if (!handle) throw new Error(`orca terminal create が handle を返さなかった: ${out.slice(0, 500)}`);
    return { handle };
  }

  async close(handle: string) {
    await this.run(["terminal", "close", "--terminal", handle, "--tab", "--json"]);
  }

  private async run(args: string[]) {
    const proc = Bun.spawn([this.bin, ...args], { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new Error(`orca ${args.slice(0, 2).join(" ")} が失敗した（exit ${code}）: ${err.trim().slice(-500)}`);
    return out;
  }
}

// --json の形は版で揺れるので、result・terminal の入れ子を順に見る
export function terminalHandle(json: unknown): string | undefined {
  const obj = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : undefined);
  for (const o of [obj(json), obj(obj(json)?.result)]) {
    const h = obj(o?.terminal)?.handle ?? o?.handle;
    if (typeof h === "string" && h) return h;
  }
  return undefined;
}

// --command は terminal の shell に打ち込まれるので、各語を single quote で囲む
export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}
