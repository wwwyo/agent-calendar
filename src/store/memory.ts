import type { CalendarEvent } from "../calendar/adapter";
import { hourBucket, type Approval, type CalendarRole, type Run, type Schedule, type Store } from "./store";

// ローカル確認とテスト用。process が落ちると消える
export class MemoryStore implements Store {
  private tokens = new Map<string, string>();
  private events = new Map<string, Map<string, CalendarEvent>>();
  private schedules = new Map<string, Schedule>();
  private fires = new Set<string>();
  private runs = new Map<string, Run>();
  private approvals = new Map<string, Approval>();
  private counters = new Map<string, number>();
  private leases = new Map<string, number>();

  async getSyncToken(ws: string, role: CalendarRole) {
    return this.tokens.get(`${ws}/${role}`);
  }

  async applyChanges(ws: string, role: CalendarRole, c: { upserts: CalendarEvent[]; deletes: string[]; reset: boolean; syncToken: string }) {
    const k = `${ws}/${role}`;
    const map = c.reset ? new Map<string, CalendarEvent>() : (this.events.get(k) ?? new Map());
    for (const id of c.deletes) map.delete(id);
    for (const e of c.upserts) map.set(e.id, e);
    this.events.set(k, map);
    this.tokens.set(k, c.syncToken);
  }

  async listEvents(ws: string, role: CalendarRole) {
    return [...(this.events.get(`${ws}/${role}`)?.values() ?? [])];
  }

  async getSchedule(ws: string) {
    return this.schedules.get(ws);
  }

  async saveSchedule(ws: string, s: Schedule) {
    this.schedules.set(ws, s);
  }

  async claimFire(ws: string, key: string) {
    const k = `${ws}/${key}`;
    if (this.fires.has(k)) return false;
    this.fires.add(k);
    return true;
  }

  async firedKeys(ws: string, keys: string[]) {
    return new Set(keys.filter((k) => this.fires.has(`${ws}/${k}`)));
  }

  async saveRun(ws: string, run: Run) {
    this.runs.set(`${ws}/${run.id}`, run);
  }

  private wsRuns(ws: string) {
    return [...this.runs.entries()].filter(([k]) => k.startsWith(`${ws}/`)).map(([, v]) => v);
  }

  async listRuns(ws: string, limit: number) {
    return this.wsRuns(ws)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, limit);
  }

  async countRunsSince(ws: string, since: string) {
    return this.wsRuns(ws).filter((r) => r.startedAt >= since && r.status !== "skipped").length;
  }

  async saveApproval(ws: string, a: Approval) {
    this.approvals.set(`${ws}/${a.id}`, a);
  }

  async getApproval(ws: string, id: string) {
    return this.approvals.get(`${ws}/${id}`);
  }

  async listApprovals(ws: string, limit: number) {
    return [...this.approvals.entries()]
      .filter(([k]) => k.startsWith(`${ws}/`))
      .map(([, v]) => v)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async decideApproval(ws: string, id: string, status: "approved" | "rejected") {
    const a = this.approvals.get(`${ws}/${id}`);
    if (!a || a.status !== "pending") return undefined;
    const next = { ...a, status, decidedAt: new Date().toISOString() };
    this.approvals.set(`${ws}/${id}`, next);
    return next;
  }

  async hitRateLimit(bucket: string, limit: number, now: number) {
    const k = `${bucket}/${hourBucket(now)}`;
    const n = (this.counters.get(k) ?? 0) + 1;
    if (n > limit) return false;
    this.counters.set(k, n);
    return true;
  }

  async acquireLease(name: string, ttlMs: number, now: number) {
    const until = this.leases.get(name);
    if (until && until > now) return false;
    this.leases.set(name, now + ttlMs);
    return true;
  }

  async releaseLease(name: string) {
    this.leases.delete(name);
  }
}
