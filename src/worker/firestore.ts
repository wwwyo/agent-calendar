import { Firestore } from "@google-cloud/firestore";
import { GoogleAuth, Impersonated } from "google-auth-library";
import type { LocalWorkerState } from "../dispatch/types";
import type { RunPatch, WorkerRun, WorkerStore } from "./ports";

const SCOPES = ["https://www.googleapis.com/auth/cloud-platform"];

// gcloud の ADC（`gcloud auth application-default login`）から service account を借りる。鍵ファイルは置かない
export async function impersonatedFirestore(projectId: string, serviceAccount: string): Promise<Firestore> {
  // 期限が近づくと Impersonated が token を取り直す
  const authClient = new Impersonated({
    sourceClient: await new GoogleAuth({ scopes: SCOPES }).getClient(),
    targetPrincipal: serviceAccount,
    targetScopes: SCOPES,
    lifetime: 3600,
  });
  return new Firestore({ projectId, preferRest: true, ignoreUndefinedProperties: true, authClient });
}

// workspaces/{ws}/runs と workspaces/{ws}/state/local（dd.md の取り決め）
export class FirestoreWorkerStore implements WorkerStore {
  constructor(private db: Firestore) {}

  private ws(ws: string) {
    return this.db.collection("workspaces").doc(ws);
  }

  async getState(ws: string) {
    const snap = await this.ws(ws).collection("state").doc("local").get();
    return snap.exists ? (snap.data() as LocalWorkerState) : undefined;
  }

  async saveState(ws: string, state: LocalWorkerState) {
    await this.ws(ws).collection("state").doc("local").set(state);
  }

  async listQueued(ws: string) {
    const snap = await this.ws(ws).collection("runs").where("executor", "==", "local").where("status", "==", "queued").get();
    return snap.docs.map((d) => d.data() as WorkerRun);
  }

  async listRunning(ws: string, workerId: string) {
    const snap = await this.ws(ws).collection("runs").where("workerId", "==", workerId).where("status", "==", "running").get();
    return snap.docs.map((d) => d.data() as WorkerRun);
  }

  async updateRun(ws: string, id: string, fn: (run: WorkerRun) => RunPatch | undefined) {
    const ref = this.ws(ws).collection("runs").doc(id);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return undefined;
      const run = snap.data() as WorkerRun;
      const patch = fn(run);
      if (!patch) return undefined;
      tx.update(ref, patch);
      return { run, patch };
    });
  }
}
