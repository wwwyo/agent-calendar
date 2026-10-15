import { Firestore, type DocumentReference } from "@google-cloud/firestore";
import type { AuthClient } from "google-auth-library";
import type { CalendarEvent } from "../calendar/adapter";
import { LocalWorkerStateSchema, type JudgedDispatch, type StoredEvent } from "../dispatch/types";
import { expireAfterDays, hourBucket, RETENTION, type Approval, type CalendarRole, type Run, type Schedule, type Store } from "./store";

// Firestore の doc id に使えない文字（/）を避ける
const docId = (s: string) => encodeURIComponent(s);

// workspaces/{ws}/{calendars,events,fires,runs,approvals,state} に置く
export class FirestoreStore implements Store {
  private db: Firestore;

  constructor(projectId: string, authClient?: AuthClient) {
    // REST transport（gRPC を Bun で読み込まない）。ローカルでは借りた token の client を渡す
    this.db = new Firestore({ projectId, preferRest: true, ignoreUndefinedProperties: true, ...(authClient ? { authClient } : {}) });
  }

  private ws(ws: string) {
    return this.db.collection("workspaces").doc(ws);
  }

  async getSyncToken(ws: string, role: CalendarRole) {
    const snap = await this.ws(ws).collection("calendars").doc(role).get();
    return snap.get("syncToken") as string | undefined;
  }

  async applyChanges(ws: string, role: CalendarRole, c: { upserts: CalendarEvent[]; deletes: string[]; reset: boolean; syncToken: string }) {
    const events = this.ws(ws).collection("events");
    // 全件を取り直したときは、新しい予定を書いてから、含まれない古い予定を消す（途中で落ちても空にならない）
    const keep = new Set(c.upserts.map((e) => docId(`${role}:${e.id}`)));
    const stale = c.reset ? (await events.where("role", "==", role).select().get()).docs.filter((d) => !keep.has(d.id)) : [];
    await this.writeAll([
      ...c.deletes.map((id) => (b: FirebaseFirestore.WriteBatch) => b.delete(events.doc(docId(`${role}:${id}`)))),
      ...c.upserts.map((e) => (b: FirebaseFirestore.WriteBatch) => b.set(events.doc(docId(`${role}:${e.id}`)), { role, event: e })),
    ]);
    await this.writeAll(stale.map((d) => (b: FirebaseFirestore.WriteBatch) => b.delete(d.ref)));
    // 予定を書き終えてから syncToken を進める。途中で落ちても次の tick で同じ差分を取り直す
    await this.ws(ws).collection("calendars").doc(role).set({ syncToken: c.syncToken, syncedAt: new Date().toISOString() });
  }

  private async writeAll(ops: ((b: FirebaseFirestore.WriteBatch) => void)[]) {
    for (let i = 0; i < ops.length; i += 400) {
      const batch = this.db.batch();
      for (const op of ops.slice(i, i + 400)) op(batch);
      await batch.commit();
    }
  }

  async listEvents(ws: string, role: CalendarRole) {
    const snap = await this.ws(ws).collection("events").where("role", "==", role).get();
    return snap.docs.map((d) => {
      const dispatch = d.get("dispatch") as JudgedDispatch | undefined;
      return { ...(d.get("event") as CalendarEvent), ...(dispatch ? { dispatch } : {}) } as StoredEvent;
    });
  }

  async saveDispatch(ws: string, eventId: string, dispatch: JudgedDispatch) {
    try {
      await this.ws(ws).collection("events").doc(docId(`automation:${eventId}`)).update({ dispatch });
    } catch (e) {
      // NOT_FOUND: 判定している間に予定が消えた
      if ((e as { code?: number }).code === 5) return;
      throw e;
    }
  }

  async getLocalWorkerState(ws: string) {
    const snap = await this.ws(ws).collection("state").doc("local").get();
    const parsed = LocalWorkerStateSchema.safeParse(snap.data());
    return parsed.success ? parsed.data : undefined;
  }

  async getSchedule(ws: string) {
    const snap = await this.ws(ws).collection("state").doc("schedule").get();
    return snap.exists ? (snap.data() as Schedule) : undefined;
  }

  async saveSchedule(ws: string, s: Schedule) {
    await this.ws(ws).collection("state").doc("schedule").set(s);
  }

  async claimFire(ws: string, key: string, expireAt: Date) {
    try {
      await this.ws(ws).collection("fires").doc(docId(key)).create({ key, claimedAt: new Date().toISOString(), expireAt });
      return true;
    } catch (e) {
      // ALREADY_EXISTS
      if ((e as { code?: number }).code === 6) return false;
      throw e;
    }
  }

  async firedKeys(ws: string, keys: string[]) {
    if (keys.length === 0) return new Set<string>();
    const refs = keys.map((k) => this.ws(ws).collection("fires").doc(docId(k)));
    const snaps = await this.db.getAll(...refs);
    return new Set(snaps.filter((s) => s.exists).map((s) => s.get("key") as string));
  }

  async saveRun(ws: string, run: Run) {
    await this.ws(ws).collection("runs").doc(run.id).set({ ...run, expireAt: expireAfterDays(run.startedAt, RETENTION.runs) });
  }

  async listRuns(ws: string, limit: number) {
    const snap = await this.ws(ws).collection("runs").orderBy("startedAt", "desc").limit(limit).get();
    return snap.docs.map((d) => d.data() as Run);
  }

  async getRun(ws: string, id: string) {
    const snap = await this.ws(ws).collection("runs").doc(docId(id)).get();
    return snap.exists ? (snap.data() as Run) : undefined;
  }

  async updateRunIf(ws: string, id: string, expected: Run["status"], patch: Partial<Run>) {
    const ref = this.ws(ws).collection("runs").doc(docId(id));
    return this.db.runTransaction(async (tx) => {
      const r = (await tx.get(ref)).data() as Run | undefined;
      if (!r || r.status !== expected) return undefined;
      const next: Run = { ...r, ...patch };
      tx.update(ref, patch);
      return next;
    });
  }

  async listOpenRuns(ws: string, limit: number) {
    const snap = await this.ws(ws).collection("runs").where("status", "in", ["queued", "running"]).limit(limit).get();
    return snap.docs.map((d) => d.data() as Run);
  }

  async countRunsSince(ws: string, since: string) {
    const snap = await this.ws(ws).collection("runs").where("startedAt", ">=", since).select("status").get();
    return snap.docs.filter((d) => d.get("status") !== "skipped").length;
  }

  async saveApproval(ws: string, a: Approval) {
    await this.ws(ws).collection("approvals").doc(a.id).set({ ...a, expireAt: expireAfterDays(a.createdAt, RETENTION.approvals) });
  }

  async getApproval(ws: string, id: string) {
    const snap = await this.ws(ws).collection("approvals").doc(id).get();
    return snap.exists ? (snap.data() as Approval) : undefined;
  }

  async listApprovals(ws: string, limit: number) {
    const snap = await this.ws(ws).collection("approvals").orderBy("createdAt", "desc").limit(limit).get();
    return snap.docs.map((d) => d.data() as Approval);
  }

  async decideApproval(ws: string, id: string, status: "approved" | "rejected") {
    const ref = this.ws(ws).collection("approvals").doc(id) as DocumentReference<Approval>;
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const a = snap.data();
      if (!a || a.status !== "pending") return undefined;
      const next: Approval = { ...a, status, decidedAt: new Date().toISOString() };
      tx.set(ref, next);
      return next;
    });
  }

  async hitRateLimit(bucket: string, limit: number, now: number) {
    const ref = this.db.collection("ratelimits").doc(docId(`${bucket}:${hourBucket(now)}`));
    return this.db.runTransaction(async (tx) => {
      const n = ((await tx.get(ref)).get("count") as number | undefined) ?? 0;
      if (n >= limit) return false;
      tx.set(ref, { count: n + 1, bucket, hour: hourBucket(now), expireAt: new Date(now + 2 * 60 * 60 * 1000) });
      return true;
    });
  }

  async acquireLease(name: string, owner: string, ttlMs: number, now: number) {
    const ref = this.db.collection("leases").doc(name);
    return this.db.runTransaction(async (tx) => {
      const until = (await tx.get(ref)).get("until") as number | undefined;
      if (until && until > now) return false;
      tx.set(ref, { until: now + ttlMs, owner });
      return true;
    });
  }

  async releaseLease(name: string, owner: string) {
    const ref = this.db.collection("leases").doc(name);
    await this.db.runTransaction(async (tx) => {
      if ((await tx.get(ref)).get("owner") === owner) tx.delete(ref);
    });
  }
}
