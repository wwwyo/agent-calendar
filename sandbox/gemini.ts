// sandbox の `gemini` agent。runner の /sandbox/llm 越しに Gemini を呼び、答えを stdout に書く。
// API key も Vertex AI の権限も持たない。tool は Google 検索の grounding だけ（runner も他を落とす）
import { SANDBOX_ENV, SANDBOX_PATHS } from "./contract";

const SYSTEM = [
  "あなたはカレンダーの予定から起こされた agent です。依頼された作業をして、結果を日本語で簡潔に書いてください。",
  "必要なら Google 検索で調べ、根拠にした情報の出典を書いてください。",
  "あなたはカレンダー・ファイル・repo に触れません。できないことは、できないと書いてください。",
].join("\n");

// proxy が混んだときに取り直す間隔
const RETRY_DELAYS_MS = [2000, 6000];

type Candidate = { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string };

export async function runGemini(
  prompt: string,
  o: { runnerUrl: string; token: string; fetchFn?: typeof fetch; delays?: number[] },
): Promise<string> {
  const fetchFn = o.fetchFn ?? fetch;
  const delays = o.delays ?? RETRY_DELAYS_MS;
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    tools: [{ googleSearch: {} }],
  });
  for (let i = 0; ; i++) {
    const res = await fetchFn(new URL(SANDBOX_PATHS.llm, o.runnerUrl), {
      method: "POST",
      headers: { Authorization: `Bearer ${o.token}`, "Content-Type": "application/json" },
      body,
    });
    if ((res.status === 429 || res.status >= 500) && i < delays.length) {
      await Bun.sleep(delays[i]!);
      continue;
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`/sandbox/llm が ${res.status} を返した: ${text.slice(0, 500)}`);
    const data = JSON.parse(text) as { candidates?: Candidate[] };
    const c = data.candidates?.[0];
    const answer = (c?.content?.parts ?? [])
      .filter((p) => !p.thought && typeof p.text === "string")
      .map((p) => p.text)
      .join("")
      .trim();
    if (!answer) throw new Error(`Gemini が答えを返さなかった（finishReason: ${c?.finishReason ?? "なし"}）`);
    return answer;
  }
}

if (import.meta.main) {
  const env = process.env;
  const prompt = env[SANDBOX_ENV.prompt];
  const runnerUrl = env[SANDBOX_ENV.runnerUrl];
  const token = env[SANDBOX_ENV.token];
  if (!prompt || !runnerUrl || !token) {
    console.error(`${SANDBOX_ENV.prompt}・${SANDBOX_ENV.runnerUrl}・${SANDBOX_ENV.token} が要る`);
    process.exit(2);
  }
  try {
    console.log(await runGemini(prompt, { runnerUrl, token }));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
