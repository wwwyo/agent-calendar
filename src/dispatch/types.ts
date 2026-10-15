// agent-dispatch の境界の型。runner（判定・発火）、local worker、cloud sandbox がここだけを共有する。
// 取り決めの説明は docs/prd/agent-dispatch/dd.md
import { z } from "zod";
import type { CalendarEvent } from "../calendar/adapter";
import type { Run } from "../store/store";

// ---- 名前 ----

export const EXECUTORS = ["cloud", "local"] as const;
export type Executor = (typeof EXECUTORS)[number];

// agent 種別・target の名前。カレンダーと判定結果には名前しか載せない（コマンドやパスは載せない）
export const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const NameSchema = z.string().regex(NAME_PATTERN);

// cloud の sandbox で起こせる agent。job の image が持つものと揃える
export const CLOUD_AGENTS = ["gemini"] as const;
export type CloudAgent = (typeof CLOUD_AGENTS)[number];

// ---- 判定 ----

// 判定にかける notes の上限。超えた分は渡さない
export const JUDGE_NOTES_MAX = 2000;
// agent に渡す prompt の上限
export const DISPATCH_PROMPT_MAX = 1000;
// LLM の呼び出しに失敗した判定を、やり直すまでの間隔
export const JUDGE_RETRY_MS = 10 * 60 * 1000;
// 1 tick・1 組で判定する予定の数の上限。残りは次の tick に回す
export const JUDGE_PER_TICK = 5;

// 判定のときに LLM に見せる選択肢。local が undefined の組では local を選べない
export type DispatchChoices = {
  cloudAgents: readonly string[];
  local?: { agents: readonly string[]; targets: readonly string[] };
};

// LLM の出力（responseSchema に渡す形）。名前が選択肢にあるかは、受け取った後に code で確かめる
export const JudgmentOutputSchema = z
  .object({
    // 書かれていなければ null（code が cloud にする）
    executor: z.enum(EXECUTORS).nullable(),
    agent: z.string().nullable(),
    target: z.string().nullable(),
    // agent に渡す作業の指示。実行先・agent の指定は取り除く
    prompt: z.string().nullable(),
    // 判定できないとき、その理由。推測で埋めない
    blockedReason: z.string().nullable(),
  })
  .strict();
export type JudgmentOutput = z.infer<typeof JudgmentOutputSchema>;

const ReadySchema = z
  .object({
    status: z.literal("ready"),
    executor: z.enum(EXECUTORS),
    agent: NameSchema,
    // local では必須、cloud では持たない
    target: NameSchema.optional(),
    prompt: z.string().trim().min(1).max(DISPATCH_PROMPT_MAX),
  })
  .strict();

const BlockedSchema = z
  .object({
    status: z.literal("blocked"),
    reason: z.string().min(1),
  })
  .strict();

export const DispatchSchema = z.discriminatedUnion("status", [ReadySchema, BlockedSchema]);
export type Dispatch = z.infer<typeof DispatchSchema>;
export type ReadyDispatch = z.infer<typeof ReadySchema>;

// events の doc に `dispatch` として保存する形
export const JudgedDispatchSchema = z.intersection(
  DispatchSchema,
  z.object({
    // 判定した予定の updated。予定の updated と違えば判定し直す
    eventUpdated: z.string(),
    judgedAt: z.string(),
    model: z.string(),
    // LLM の呼び出しに失敗した blocked。この時刻を過ぎたら判定し直す
    retryAt: z.string().optional(),
  }),
);
export type JudgedDispatch = z.infer<typeof JudgedDispatchSchema>;

// Store.listEvents("automation") が返す形
export type StoredEvent = CalendarEvent & { dispatch?: JudgedDispatch };

// ---- 実行の記録（Run の拡張） ----

// 6時間より古い回は実行せず skipped にする（cloud・local 共通）
export const STALE_AFTER_MS = 6 * 60 * 60 * 1000;
// 実行記録に残す出力の上限（末尾を残す）
export const OUTPUT_MAX = 16_000;

export type RunDispatchFields = {
  // 無ければ runner 内の Gemini（準備と、この機能より前の記録）
  executor?: Executor;
  agent?: string;
  target?: string;
  // local: 受け取った worker
  workerId?: string;
  // これを過ぎても running なら中断とみなす
  deadlineAt?: string;
  // cloud: Cloud Run Job の execution 名
  execution?: string;
};

// ---- local worker ----

// worker が組ごとに書く `workspaces/{ws}/state/local`。runner は判定の選択肢にこれを使う
export const LocalWorkerStateSchema = z
  .object({
    workerId: z.string().min(1),
    agents: z.array(NameSchema),
    targets: z.array(NameSchema),
    // 名前の一覧が変わった時刻
    namesUpdatedAt: z.string(),
    // 最後に Firestore を見に来た時刻（dashboard で worker が生きているかを出す）
    seenAt: z.string(),
  })
  .strict();
export type LocalWorkerState = z.infer<typeof LocalWorkerStateSchema>;

export const LOCAL_CONFIG_PATH = "~/.config/agent-calendar/local.toml";
export const PROMPT_PLACEHOLDER = "{prompt}";

// ~/.config/agent-calendar/local.toml を TOML として読んだ後の形
export const LocalConfigSchema = z
  .object({
    gcp_project: z.string().min(1),
    // 借りる service account（gcloud の ADC から impersonate する。鍵は置かない）
    service_account: z.email(),
    // この worker が受け取る組
    workspaces: z.array(z.string().regex(/^[a-z0-9-]{1,32}$/)).min(1),
    poll_seconds: z.number().int().min(10).max(600).default(30),
    targets: z.record(NameSchema, z.object({ repo: z.string().min(1) }).strict()),
    agents: z.record(
      NameSchema,
      z
        .object({
          // argv。"{prompt}" と一致する要素を prompt で置き換える（shell を通さない）
          command: z.array(z.string().min(1)).min(1),
          timeout_minutes: z.number().int().min(1).max(240).default(60),
        })
        .strict(),
    ),
  })
  .strict();
export type LocalConfig = z.infer<typeof LocalConfigSchema>;

// ---- cloud sandbox ----

// Cloud Run Job の execution に override で渡す環境変数の名前
export const SANDBOX_ENV = {
  runId: "RUN_ID",
  agent: "AGENT",
  prompt: "PROMPT",
  // runner の URL（LLM の proxy と結果の受け口）
  runnerUrl: "RUNNER_URL",
  // 実行ごとの短命 token
  token: "SANDBOX_TOKEN",
} as const;

// runner 側の受け口。どちらも `Authorization: Bearer <SANDBOX_TOKEN>`
export const SANDBOX_PATHS = {
  // body は Vertex AI の generateContent の request。model は runner が決める
  llm: "/sandbox/llm",
  // body は SandboxResult。受け取ったら token を失効させる
  result: "/sandbox/result",
} as const;

// job の task の timeout。token の有効期限と deadlineAt はこれに余裕を足す
export const SANDBOX_TIMEOUT_MS = 15 * 60 * 1000;
export const SANDBOX_GRACE_MS = 5 * 60 * 1000;
// 1 token で proxy を呼べる回数
export const SANDBOX_LLM_CALLS_MAX = 20;

export const SandboxResultSchema = z
  .object({
    status: z.enum(["succeeded", "failed"]),
    // agent の stdout の末尾
    output: z.string().max(OUTPUT_MAX),
    reason: z.string().max(2000).optional(),
  })
  .strict();
export type SandboxResult = z.infer<typeof SandboxResultSchema>;

// `sandboxTokens/{sha256(token)}`。token そのものは保存しない
export type SandboxTokenDoc = {
  workspace: string;
  runId: string;
  expireAt: Date;
  llmCalls: number;
  done: boolean;
};

export type SandboxJobInput = { workspace: string; runId: string; agent: CloudAgent; prompt: string };

// runner が cloud の回を起こすときに呼ぶ。実装は src/cloud/
export interface CloudLauncher {
  start(input: SandboxJobInput): Promise<{ execution: string; deadlineAt: string }>;
}

// cloud の結果を書き戻すのに runner の Store から要るもの
export interface RunAccess {
  getRun(ws: string, id: string): Promise<Run | undefined>;
  saveRun(ws: string, run: Run): Promise<void>;
  // status が expected のときだけ patch を当てる（transaction）。当てなければ undefined
  updateRunIf(ws: string, id: string, expected: Run["status"], patch: Partial<Run>): Promise<Run | undefined>;
}
