import { parse as parseYaml } from "yaml";
import { z } from "zod";

// agent が使える tool の allowlist。読み取りか、承認待ちに入れるだけのものに限る
export const TOOL_NAMES = ["list_deadlines", "list_schedule", "list_recent_runs", "propose_event"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export const PROMPT_MAX = 1000;

const PayloadSchema = z
  .object({
    prompt: z.string().trim().min(1).max(PROMPT_MAX),
    tools: z.array(z.enum(TOOL_NAMES)).optional(),
  })
  .strict();

export type Payload = z.infer<typeof PayloadSchema>;

export type PayloadResult = { ok: true; payload: Payload } | { ok: false; reason: string };

// 起動用カレンダーの notes の先頭にある YAML front matter を payload として読む。
// 書式に合わないものは推測で補わず、理由を返して発火させない
export function parsePayload(notes: string): PayloadResult {
  const lines = notes.split("\n");
  let i = 0;
  while (i < lines.length && lines[i]!.trim() === "") i++;
  if (lines[i]?.trim() !== "---") return { ok: false, reason: "notes の先頭が --- で始まっていない" };
  const close = lines.findIndex((l, j) => j > i && l.trim() === "---");
  if (close < 0) return { ok: false, reason: "payload の終わりの --- がない" };
  let raw: unknown;
  try {
    raw = parseYaml(lines.slice(i + 1, close).join("\n"));
  } catch (e) {
    return { ok: false, reason: `YAML として読めない: ${(e as Error).message.split("\n")[0]}` };
  }
  const parsed = PayloadSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: `payload の項目が不正: ${parsed.error.issues.map((x) => `${x.path.join(".") || "(root)"} ${x.message}`).join("; ")}` };
  }
  return { ok: true, payload: parsed.data };
}

export function formatPayload(p: Payload): string {
  const body = [`prompt: ${JSON.stringify(p.prompt)}`];
  if (p.tools) body.push(`tools: [${p.tools.join(", ")}]`);
  return ["---", ...body, "---"].join("\n");
}

export const PREP_DAYS_MAX = 365;

// 記録用カレンダーの notes の「準備: N日前」。命令ではなく、手続きに要る期間という事実として読む
export function parsePrepDays(notes: string): number | undefined {
  const m = notes.match(/^\s*準備\s*[:：]\s*(\d{1,3})\s*日前\s*$/m);
  if (!m) return undefined;
  const n = Number(m[1]);
  return n <= PREP_DAYS_MAX ? n : undefined;
}

// agent が提案した予定に「準備: N日前」が紛れると、承認後にまた準備が発火する。書き込む前に外す
export function stripPrepLines(notes: string): string {
  return notes
    .split("\n")
    .filter((l) => !/^\s*準備\s*[:：]/.test(l))
    .join("\n");
}
