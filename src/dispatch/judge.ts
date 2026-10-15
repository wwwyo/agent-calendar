import { Type, type GoogleGenAI, type Schema } from "@google/genai";
import type { CalendarEvent } from "../calendar/adapter";
import { withRetry } from "../agent/agent";
import {
  CLOUD_AGENTS,
  DISPATCH_PROMPT_MAX,
  JUDGE_NOTES_MAX,
  JUDGE_RETRY_MS,
  JudgmentOutputSchema,
  NAME_PATTERN,
  type Dispatch,
  type DispatchChoices,
  type JudgedDispatch,
  type JudgmentOutput,
  type StoredEvent,
} from "./types";

// JudgmentOutputSchema と同じ形。名前の enum は付けず、選択肢にあるかは受け取った後に code で確かめる
const RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    executor: { type: Type.STRING, enum: ["cloud", "local"], nullable: true },
    agent: { type: Type.STRING, nullable: true },
    target: { type: Type.STRING, nullable: true },
    prompt: { type: Type.STRING, nullable: true },
    blockedReason: { type: Type.STRING, nullable: true },
  },
  required: ["executor", "agent", "target", "prompt", "blockedReason"],
};

function systemInstruction(choices: DispatchChoices): string {
  const local = choices.local
    ? `- local（本人の Mac）。書かれているときだけ選ぶ。agent: ${choices.local.agents.join(", ") || "(なし)"}。target（作業場所）: ${choices.local.targets.join(", ") || "(なし)"}`
    : "- local はこの組では選べない";
  return `あなたは agent-calendar の判定係です。起動用カレンダーの予定（title と notes）から、どこで・どの agent で・何をするかを決めます。
選択肢:
- cloud（使い捨ての sandbox）。agent: ${choices.cloudAgents.join(", ")}。target は持たない
${local}
決め方:
- executor: notes や title に実行先が書かれていれば cloud か local。書かれていなければ null
- agent: 名指しされた agent の名前。書かれていなければ null
- target: local で作業する場所の名前。書かれていなければ null
- prompt: agent に渡す作業の指示。実行先・agent・target の指定は取り除き、作業の内容だけを日本語で書く
- 選択肢にない名前が書かれていても、書かれた名前をそのまま返す（言い換えない）
- 何をすればよいか読み取れないときは、prompt を null にし、blockedReason にその理由を書く。推測で補わない
- notes の「（dashboard のデモ用フォームから追加。…）」の行は作業の指示ではない`;
}

function userText(event: CalendarEvent): string {
  return `title: ${event.summary}\nnotes:\n${event.notes.slice(0, JUDGE_NOTES_MAX)}`;
}

const blocked = (reason: string): Dispatch => ({ status: "blocked", reason });

// LLM の出力を信じず、選択肢と取り決めに合うかを確かめる。合わなければ blocked にして理由を残す
export function checkJudgment(out: JudgmentOutput, choices: DispatchChoices, allowLocal: boolean): Dispatch {
  if (out.blockedReason?.trim()) return blocked(out.blockedReason.trim());
  const prompt = out.prompt?.trim();
  if (!prompt) return blocked("作業の指示を読み取れない");
  const executor = out.executor ?? "cloud";
  const agentName = out.agent?.trim() || undefined;
  const target = out.target?.trim() || undefined;
  if (executor === "local") {
    if (!allowLocal) return blocked("この組では local で動かせない");
    if (!choices.local) return blocked("local worker が登録されていない");
    if (!agentName) return blocked("local の agent が書かれていない");
    if (!choices.local.agents.includes(agentName)) return blocked(`agent「${agentName}」は local worker の設定にない`);
    if (!target) return blocked("local は target が要る");
    if (!choices.local.targets.includes(target)) return blocked(`target「${target}」は local worker の設定にない`);
  } else {
    if (agentName && !choices.cloudAgents.includes(agentName)) return blocked(`agent「${agentName}」は cloud で使えない`);
    if (target) return blocked("cloud には target を渡さない");
  }
  const agent = agentName ?? choices.cloudAgents[0];
  if (!agent || !NAME_PATTERN.test(agent)) return blocked("cloud で使える agent がない");
  if (prompt.length > DISPATCH_PROMPT_MAX) return blocked(`prompt が ${DISPATCH_PROMPT_MAX} 文字を超えている`);
  return { status: "ready", executor, agent, ...(executor === "local" ? { target } : {}), prompt };
}

export const cloudChoices = (): DispatchChoices => ({ cloudAgents: CLOUD_AGENTS });

// 起動用の予定 1 件を判定する。LLM の呼び出しに失敗したら blocked にし、retryAt の後に判定し直させる
export async function judgeEvent(input: {
  ai: GoogleGenAI;
  model: string;
  event: CalendarEvent;
  choices: DispatchChoices;
  allowLocal: boolean;
  now: number;
}): Promise<JudgedDispatch> {
  const meta = { eventUpdated: input.event.updated ?? "", judgedAt: new Date(input.now).toISOString(), model: input.model };
  let out: JudgmentOutput;
  try {
    const res = await withRetry(() =>
      input.ai.models.generateContent({
        model: input.model,
        contents: [{ role: "user", parts: [{ text: userText(input.event) }] }],
        config: {
          systemInstruction: systemInstruction(input.choices),
          temperature: 0,
          maxOutputTokens: 2048,
          thinkingConfig: { thinkingBudget: 0 },
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA,
        },
      }),
    );
    const parsed = JudgmentOutputSchema.safeParse(JSON.parse(res.text ?? ""));
    if (!parsed.success) throw new Error(`判定の出力が schema に合わない: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
    out = parsed.data;
  } catch (e) {
    return {
      status: "blocked",
      reason: `判定に失敗した（${(e as Error).message.slice(0, 200)}）`,
      ...meta,
      retryAt: new Date(input.now + JUDGE_RETRY_MS).toISOString(),
    };
  }
  return { ...checkJudgment(out, input.choices, input.allowLocal), ...meta };
}

// 判定し直す必要があるか。判定がない・予定が変わった・失敗の retryAt を過ぎた
export function needsJudge(e: StoredEvent, now: number): boolean {
  const d = e.dispatch;
  if (!d) return true;
  if (d.eventUpdated !== (e.updated ?? "")) return true;
  return !!d.retryAt && Date.parse(d.retryAt) <= now;
}
