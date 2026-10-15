import type { CalendarEvent, EventTime } from "../calendar/adapter";
import type { FireItem } from "../domain/schedule";
import type { RunDispatchFields } from "../dispatch/types";

export type CalendarRole = "automation" | "records" | "main";

export type Schedule = {
  items: FireItem[];
  computedAt: string;
  // automation の回はここより後のものを発火させる。tick ごとに進める
  watermark: string;
  // 予定の差分を取り込んだが、まだ計算し直していない
  stale?: boolean;
};

export type ToolCallRecord = { name: string; args: unknown; result: unknown };

export type Run = RunDispatchFields & {
  id: string;
  fireKey: string;
  kind: FireItem["kind"];
  title: string;
  eventId: string;
  scheduledAt: string;
  startedAt: string;
  finishedAt?: string;
  // queued: local worker が受け取るのを待っている。running のまま deadlineAt（無ければ10分）を過ぎたものは、実行中に落ちた
  status: "queued" | "running" | "succeeded" | "failed" | "skipped";
  // skipped・failed の理由
  reason?: string;
  late?: boolean;
  model?: string;
  input?: string;
  toolCalls: ToolCallRecord[];
  output?: string;
  usage?: { promptTokens?: number; outputTokens?: number; totalTokens?: number };
};

export type Approval = {
  id: string;
  runId: string;
  status: "pending" | "approved" | "rejected" | "failed";
  createdAt: string;
  decidedAt?: string;
  operation: { type: "create_event"; summary: string; notes: string; start: EventTime; end: EventTime };
  // 承認して作った予定
  createdEventId?: string;
  error?: string;
};

export interface Store {
  getSyncToken(ws: string, role: CalendarRole): Promise<string | undefined>;
  // 差分を反映して syncToken を進める。reset なら先に保存済みの予定を消す
  applyChanges(ws: string, role: CalendarRole, changes: { upserts: CalendarEvent[]; deletes: string[]; reset: boolean; syncToken: string }): Promise<void>;
  listEvents(ws: string, role: CalendarRole): Promise<CalendarEvent[]>;

  getSchedule(ws: string): Promise<Schedule | undefined>;
  saveSchedule(ws: string, schedule: Schedule): Promise<void>;

  // 同じ発火を1度だけ実行するための予約。既に予約済みなら false
  claimFire(ws: string, key: string, expireAt: Date): Promise<boolean>;
  firedKeys(ws: string, keys: string[]): Promise<Set<string>>;

  saveRun(ws: string, run: Run): Promise<void>;
  listRuns(ws: string, limit: number): Promise<Run[]>;
  countRunsSince(ws: string, since: string): Promise<number>;

  saveApproval(ws: string, approval: Approval): Promise<void>;
  getApproval(ws: string, id: string): Promise<Approval | undefined>;
  listApprovals(ws: string, limit: number): Promise<Approval[]>;
  // pending のときだけ決定を書く。既に決まっていれば false
  decideApproval(ws: string, id: string, status: "approved" | "rejected"): Promise<Approval | undefined>;

  // 1時間ごとの数を数え、上限を超えたら false
  hitRateLimit(bucket: string, limit: number, now: number): Promise<boolean>;

  // tick の重なりを避けるための lease
  acquireLease(name: string, owner: string, ttlMs: number, now: number): Promise<boolean>;
  // 取った本人のときだけ解放する
  releaseLease(name: string, owner: string): Promise<void>;
}

// Firestore の TTL ポリシー（expireAt）で消すまでの期間
export const RETENTION = { runs: 30, approvals: 30 } as const;

export function expireAfterDays(from: string | number, days: number): Date {
  return new Date(new Date(from).getTime() + days * 24 * 60 * 60 * 1000);
}

export function hourBucket(now: number): string {
  return new Date(now).toISOString().slice(0, 13);
}
