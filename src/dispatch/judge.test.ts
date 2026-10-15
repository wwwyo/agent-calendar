import { describe, expect, test } from "bun:test";
import type { GoogleGenAI } from "@google/genai";
import { checkJudgment, judgeEvent, needsJudge } from "./judge";
import type { DispatchChoices, JudgmentOutput, StoredEvent } from "./types";

const choices: DispatchChoices = { cloudAgents: ["gemini"], local: { agents: ["codex", "claude"], targets: ["agent-calendar"] } };
const out = (p: Partial<JudgmentOutput>): JudgmentOutput => ({ executor: null, agent: null, target: null, prompt: "依存の更新を確かめて", blockedReason: null, ...p });
const reason = (o: Partial<JudgmentOutput>, c = choices, allowLocal = true) => {
  const d = checkJudgment(out(o), c, allowLocal);
  return d.status === "blocked" ? d.reason : d;
};

describe("checkJudgment", () => {
  test("実行先が書かれていなければ cloud の最初の agent にする", () => {
    expect(checkJudgment(out({}), choices, true)).toEqual({ status: "ready", executor: "cloud", agent: "gemini", prompt: "依存の更新を確かめて" });
  });
  test("local は agent と target が選択肢にあるときだけ ready", () => {
    expect(checkJudgment(out({ executor: "local", agent: "codex", target: "agent-calendar" }), choices, true)).toEqual({
      status: "ready",
      executor: "local",
      agent: "codex",
      target: "agent-calendar",
      prompt: "依存の更新を確かめて",
    });
  });
  test("取り決めに合わない出力は理由つきで blocked", () => {
    expect(reason({ blockedReason: "何をするか書かれていない" })).toBe("何をするか書かれていない");
    expect(reason({ prompt: " " })).toBe("作業の指示を読み取れない");
    expect(reason({ executor: "local", agent: "codex", target: "agent-calendar" }, choices, false)).toBe("この組では local で動かせない");
    expect(reason({ executor: "local", agent: "codex", target: "agent-calendar" }, { cloudAgents: ["gemini"] })).toBe("local worker が登録されていない");
    expect(reason({ executor: "local", target: "agent-calendar" })).toBe("local の agent が書かれていない");
    expect(reason({ executor: "local", agent: "cursor", target: "agent-calendar" })).toBe("agent「cursor」は local worker の設定にない");
    expect(reason({ executor: "local", agent: "codex" })).toBe("local は target が要る");
    expect(reason({ executor: "local", agent: "codex", target: "../etc" })).toBe("target「../etc」は local worker の設定にない");
    expect(reason({ agent: "codex" })).toBe("agent「codex」は cloud で使えない");
    expect(reason({ target: "agent-calendar" })).toBe("cloud には target を渡さない");
    expect(reason({ prompt: "x".repeat(1001) })).toBe("prompt が 1000 文字を超えている");
  });
});

const event: StoredEvent = { id: "e1", status: "confirmed", summary: "依存の更新", notes: "codex で。local で", updated: "u1", tags: {} };
const now = Date.parse("2026-10-15T12:00:00+09:00");

function fakeAi(reply: () => Promise<{ text?: string }>, seen: unknown[] = []): GoogleGenAI {
  return { models: { generateContent: async (req: unknown) => (seen.push(req), reply()) } } as unknown as GoogleGenAI;
}

describe("judgeEvent", () => {
  test("responseSchema で JSON を返させ、code で確かめた結果に予定の updated を付ける", async () => {
    const seen: { config: { responseSchema: unknown; systemInstruction: string } }[] = [];
    const ai = fakeAi(async () => ({ text: JSON.stringify(out({ executor: "local", agent: "codex", target: "agent-calendar" })) }), seen);
    const d = await judgeEvent({ ai, model: "m", event, choices, allowLocal: true, now });
    expect(d).toMatchObject({ status: "ready", executor: "local", agent: "codex", target: "agent-calendar", eventUpdated: "u1", model: "m" });
    expect(d.retryAt).toBeUndefined();
    expect(seen[0]!.config.responseSchema).toBeDefined();
    expect(seen[0]!.config.systemInstruction).toContain("codex, claude");
  });
  test("呼び出しの失敗と schema に合わない出力は blocked にし、retryAt の後に判定し直す", async () => {
    for (const reply of [async () => Promise.reject(new Error("boom")), async () => ({ text: '{"executor":"mac"}' }), async () => ({ text: "not json" })]) {
      const d = await judgeEvent({ ai: fakeAi(reply), model: "m", event, choices, allowLocal: true, now });
      expect(d.status).toBe("blocked");
      expect(d.retryAt).toBe("2026-10-15T03:10:00.000Z");
      expect(needsJudge({ ...event, dispatch: d }, now)).toBe(false);
      expect(needsJudge({ ...event, dispatch: d }, Date.parse(d.retryAt!))).toBe(true);
    }
  });
  test("判定がない・予定が変わったときだけ判定し直す", () => {
    const d = { status: "blocked" as const, reason: "x", eventUpdated: "u1", judgedAt: "", model: "m" };
    expect(needsJudge(event, now)).toBe(true);
    expect(needsJudge({ ...event, dispatch: d }, now)).toBe(false);
    expect(needsJudge({ ...event, updated: "u2", dispatch: d }, now)).toBe(true);
  });
});
