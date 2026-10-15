import { z } from "zod";

// カレンダーの組（workspace）。起動用・記録用（・メイン）をまとめ、組をまたいで予定や記録を混ぜない
const WorkspaceSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{1,32}$/),
    label: z.string().min(1),
    // public: ログインなしで dashboard を見られ、デモ用のフォームから予定を足せる。private は dashboard に出さない（認証は未実装）
    visibility: z.enum(["public", "private"]),
    timeZone: z.string().default("Asia/Tokyo"),
    calendars: z
      .object({
        automation: z.string().min(1),
        records: z.string().min(1),
        main: z.string().min(1).optional(),
      })
      .strict(),
    // 起動用カレンダーの予定を発火させてよい作成者（creator / organizer）の email
    allowedCreators: z.array(z.email()).min(1),
    // 起動用の予定を local worker（本人の Mac）で動かしてよいか。private で、allowedCreators に service account を含まない組だけ
    allowLocal: z.boolean().default(false),
  })
  .strict();

export type Workspace = z.infer<typeof WorkspaceSchema>;

const EnvSchema = z.object({
  PORT: z.coerce.number().default(8080),
  GCP_PROJECT: z.string().min(1),
  VERTEX_LOCATION: z.string().default("us-central1"),
  GEMINI_MODEL: z.string().default("gemini-2.5-flash"),
  WORKSPACES: z.string().min(1),
  // memory はローカル確認とテスト用。Cloud Run では firestore
  STORE: z.enum(["firestore", "memory"]).default("firestore"),
  // /tick の認証。oidc は Cloud Scheduler の OIDC token を検証する。none はローカル専用
  TICK_AUTH: z.enum(["oidc", "none"]).default("oidc"),
  TICK_AUDIENCE: z.string().optional(),
  TICK_INVOKER_EMAIL: z.string().optional(),
  // ローカル確認用。gcloud で service account を借りた access token を渡す
  GOOGLE_ACCESS_TOKEN: z.string().optional(),
  // デモ用フォームと承認の上限（1時間あたり）
  DEMO_LIMIT_PER_IP: z.coerce.number().default(5),
  DEMO_LIMIT_GLOBAL: z.coerce.number().default(40),
  // agent の実行の上限（組ごと・1時間あたり）。超えた発火は実行せず記録だけ残す
  RUN_LIMIT_PER_HOUR: z.coerce.number().default(60),
  // デモ用フォームで足した予定を消すまでの時間
  DEMO_EVENT_TTL_HOURS: z.coerce.number().default(6),
  // cloud の回を動かす Cloud Run Job の名前と、job から結果を返す先（この runner の URL）。無ければ cloud の回は failed で記録する
  SANDBOX_JOB: z.string().min(1).optional(),
  RUNNER_URL: z.url().optional(),
});

export type Config = Omit<z.infer<typeof EnvSchema>, "WORKSPACES"> & { workspaces: Workspace[] };

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const { WORKSPACES, ...rest } = EnvSchema.parse(env);
  const workspaces = z.array(WorkspaceSchema).min(1).parse(JSON.parse(WORKSPACES));
  const ids = new Set(workspaces.map((w) => w.id));
  if (ids.size !== workspaces.length) throw new Error("WORKSPACES: id が重複している");
  if (rest.TICK_AUTH === "oidc" && (!rest.TICK_AUDIENCE || !rest.TICK_INVOKER_EMAIL)) {
    throw new Error("TICK_AUTH=oidc には TICK_AUDIENCE と TICK_INVOKER_EMAIL が要る");
  }
  for (const ws of workspaces) checkWorkspace(ws);
  return { ...rest, workspaces };
}

const SERVICE_ACCOUNT = /@[^@]+\.iam\.gserviceaccount\.com$/i;

// 守りの前提を崩す組では起動しない。local は本人が手で起こすのと同じとみなすので、他人やフォームが書ける組では許さない
function checkWorkspace(ws: Workspace) {
  if (ws.allowLocal) {
    if (ws.visibility !== "private") throw new Error(`WORKSPACES: ${ws.id} は allowLocal なので private にする`);
    const sa = ws.allowedCreators.filter((x) => SERVICE_ACCOUNT.test(x));
    if (sa.length) throw new Error(`WORKSPACES: ${ws.id} は allowLocal なので allowedCreators に service account（${sa.join(", ")}）を含めない`);
  }
  // 起動用が記録用を兼ねると、記録用の notes が判定にかかる
  const ids = Object.values(ws.calendars).filter((x): x is string => !!x);
  if (new Set(ids).size !== ids.length) throw new Error(`WORKSPACES: ${ws.id} の automation・records・main のカレンダー ID が重複している`);
}
