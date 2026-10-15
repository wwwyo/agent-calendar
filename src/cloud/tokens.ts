import { createHash, randomBytes } from "node:crypto";
import type { Firestore, Timestamp } from "@google-cloud/firestore";
import { SANDBOX_GRACE_MS, SANDBOX_LLM_CALLS_MAX, SANDBOX_TIMEOUT_MS, type SandboxTokenDoc } from "../dispatch/types";

// 実行ごとの短命 token。token そのものは job の env にだけ渡し、保存するのは sha256 だけ
export function newSandboxToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSandboxToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// token の有効期限。Run の deadlineAt と揃え、これを過ぎた結果は受け取らない
export function sandboxDeadline(now: number): Date {
  return new Date(now + SANDBOX_TIMEOUT_MS + SANDBOX_GRACE_MS);
}

export type TokenCheck = { ok: true; doc: SandboxTokenDoc } | { ok: false; reason: "unknown" | "expired" | "done" | "exhausted" };

// 使えるかを決める規則。Firestore とメモリの実装で同じものを使う
function check(doc: SandboxTokenDoc | undefined, now: number, use: "llm" | "result"): TokenCheck {
  if (!doc) return { ok: false, reason: "unknown" };
  if (doc.done) return { ok: false, reason: "done" };
  if (doc.expireAt.getTime() <= now) return { ok: false, reason: "expired" };
  if (use === "llm" && doc.llmCalls >= SANDBOX_LLM_CALLS_MAX) return { ok: false, reason: "exhausted" };
  return { ok: true, doc };
}

export interface SandboxTokens {
  create(hash: string, doc: SandboxTokenDoc): Promise<void>;
  // 使えるなら呼び出し回数を 1 つ進める（取り合っても上限を超えない）
  useLlmCall(hash: string, now: number): Promise<TokenCheck>;
  // 使えるなら done にする。結果を受け取れるのは 1 度だけ
  finish(hash: string, now: number): Promise<TokenCheck>;
  // tick が running のまま期限を過ぎた Run を failed にしたときに呼ぶ
  revokeRun(ws: string, runId: string): Promise<void>;
}

// `sandboxTokens/{sha256(token)}`。expireAt の TTL ポリシーで消す
export class FirestoreSandboxTokens implements SandboxTokens {
  constructor(private db: Firestore) {}

  private col() {
    return this.db.collection("sandboxTokens");
  }

  async create(hash: string, doc: SandboxTokenDoc) {
    await this.col().doc(hash).create(doc);
  }

  private update(hash: string, now: number, use: "llm" | "result") {
    const ref = this.col().doc(hash);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.data();
      const doc = data ? { ...(data as SandboxTokenDoc), expireAt: (data.expireAt as Timestamp).toDate() } : undefined;
      const r = check(doc, now, use);
      if (r.ok) tx.update(ref, use === "llm" ? { llmCalls: r.doc.llmCalls + 1 } : { done: true });
      return r;
    });
  }

  useLlmCall(hash: string, now: number) {
    return this.update(hash, now, "llm");
  }

  finish(hash: string, now: number) {
    return this.update(hash, now, "result");
  }

  async revokeRun(ws: string, runId: string) {
    const snap = await this.col().where("runId", "==", runId).where("workspace", "==", ws).get();
    await Promise.all(snap.docs.map((d) => d.ref.update({ done: true })));
  }
}

// ローカル確認とテスト用
export class MemorySandboxTokens implements SandboxTokens {
  docs = new Map<string, SandboxTokenDoc>();

  async create(hash: string, doc: SandboxTokenDoc) {
    if (this.docs.has(hash)) throw new Error("sandbox token が重複している");
    this.docs.set(hash, { ...doc });
  }

  async useLlmCall(hash: string, now: number) {
    const r = check(this.docs.get(hash), now, "llm");
    if (r.ok) r.doc.llmCalls += 1;
    return r;
  }

  async finish(hash: string, now: number) {
    const r = check(this.docs.get(hash), now, "result");
    if (r.ok) r.doc.done = true;
    return r;
  }

  async revokeRun(ws: string, runId: string) {
    for (const d of this.docs.values()) if (d.workspace === ws && d.runId === runId) d.done = true;
  }
}
