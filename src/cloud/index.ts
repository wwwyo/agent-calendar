// cloud sandbox の入口。server.ts はここだけを import してつなぐ
import { Firestore } from "@google-cloud/firestore";
import type { AuthClient } from "google-auth-library";
import type { CloudLauncher, RunAccess } from "../dispatch/types";
import { createSandboxHandler, VertexRestApi, type SandboxHandler } from "./handler";
import { CloudRunJobsApi, SandboxLauncher } from "./launcher";
import { FirestoreSandboxTokens, MemorySandboxTokens, type SandboxTokens } from "./tokens";

export { createSandboxHandler, sanitizeLlmRequest, VertexRestApi, type SandboxHandler, type VertexApi } from "./handler";
export { CloudRunJobsApi, SANDBOX_JOB_PATTERN, SandboxLauncher, type JobsApi } from "./launcher";
export { FirestoreSandboxTokens, MemorySandboxTokens, type SandboxTokens } from "./tokens";

export type CloudSandboxOptions = {
  project: string;
  // Vertex AI の場所と model（runner の GEMINI_MODEL。sandbox には選ばせない）
  vertexLocation: string;
  model: string;
  // job の resource 名（projects/{p}/locations/{l}/jobs/agent-sandbox）
  sandboxJob: string;
  // job から見た runner の URL
  runnerUrl: string;
  auth: AuthClient;
  runs: RunAccess;
  store: "firestore" | "memory";
  // ローカルでは借りた token の client を Firestore に渡す
  firestoreAuth?: AuthClient;
};

export type CloudSandbox = {
  launcher: CloudLauncher;
  handleSandbox: SandboxHandler;
  // tick が running のまま deadlineAt を過ぎた cloud の Run を failed にしたときに呼ぶ
  revokeRun(ws: string, runId: string): Promise<void>;
};

export function createCloudSandbox(o: CloudSandboxOptions): CloudSandbox {
  const tokens: SandboxTokens =
    o.store === "memory"
      ? new MemorySandboxTokens()
      : new FirestoreSandboxTokens(new Firestore({ projectId: o.project, preferRest: true, ignoreUndefinedProperties: true, ...(o.firestoreAuth ? { authClient: o.firestoreAuth } : {}) }));
  const vertex = new VertexRestApi({ project: o.project, location: o.vertexLocation, model: o.model, auth: o.auth });
  return {
    launcher: new SandboxLauncher({ jobs: new CloudRunJobsApi(o.sandboxJob, o.auth), tokens, runnerUrl: o.runnerUrl }),
    handleSandbox: createSandboxHandler({ runs: o.runs, tokens, vertex }),
    revokeRun: (ws, runId) => tokens.revokeRun(ws, runId),
  };
}
