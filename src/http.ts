// HTTP の入口で使う小さな部品。dashboard（src/server.ts）と sandbox の受け口（src/cloud/）が共有する

export class TooLarge extends Error {}

// Content-Length を信じず、上限を超えたところで読むのをやめる
export async function readLimited(req: Request, max: number): Promise<string> {
  const declared = Number(req.headers.get("content-length"));
  if (declared > max) throw new TooLarge();
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new TooLarge();
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

// inline の <script> に埋める JSON。</script> や <!-- で抜けられないよう < > & と、JS の改行になる U+2028/2029 を escape する
export function scriptJson(v: unknown): string {
  return JSON.stringify(v).replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

// 書き込みの POST は自 origin のページからだけ受ける（CSRF 対策）。
// Sec-Fetch-Site があればそれを、無ければ Origin の host を Host と比べる。どちらも無いものは受けない
export function isSameOrigin(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site) return site === "same-origin";
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (!origin || !host || origin === "null") return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

// instance のメモリで数える固定窓の上限。Firestore に書くほどでない読み取り（公開 API の GET）に使う。
// instance ごとに数えるので、全体ではおおよそ max-instances 倍まで通る
export class WindowLimiter {
  private counts = new Map<string, number>();
  private windowStart = 0;

  constructor(
    private limit: number,
    private windowMs: number,
  ) {}

  hit(key: string, now: number): boolean {
    if (now - this.windowStart >= this.windowMs) {
      this.counts.clear();
      this.windowStart = now;
    }
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);
    return n <= this.limit;
  }
}
