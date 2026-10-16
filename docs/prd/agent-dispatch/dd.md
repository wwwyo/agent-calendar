# 自然言語で実行先と agent を選ぶ — 設計

要件は [prd.md](./prd.md)。既存の runner は [calendar-runner/dd.md](../calendar-runner/dd.md)。ここには runner・local worker・cloud sandbox の境界の取り決めだけを置く。型の正本は `src/dispatch/types.ts`。

## 全体

```
tick: 取得 → 判定（変わった起動用の予定だけ）→ 発火予定の計算 → 発火
  発火 ─ cloud → runner が Run を running で書き、Cloud Run Job を起こす → job が /sandbox/result に結果を返す
       └ local → runner が Run を queued で書く → worker が transaction で running にして agent を起こし、結果を書く
準備（記録用）→ 今まで通り runner 内の Gemini と読み取り tool
```

## payload の廃止

- YAML front matter（`parsePayload`・`formatPayload`）をやめ、起動用の予定の notes を自然言語のまま判定にかける。`yaml` 依存も外す
- `FireItem.payload` は `dispatch`（判定結果）に置き換える。デモ用フォームは prompt をそのまま notes に書く
- 起動用の予定で runner 内の Gemini と tool を動かす経路はなくす。**判定は tool を選ばない**。cloud の回はすべて sandbox の agent で動かす
  - sandbox はカレンダー・Firestore への権限を持たないので、`list_deadlines` などを sandbox に渡す道はない。渡すには runner が sandbox 向けの読み取り API を開く必要があり、「sandbox は権限を持たない」を崩す
  - 代わりに失うもの: 起動用の予定から「締切を確認して提案して」と頼む使い方。これは記録用の準備（「準備: N日前」）で代える。デモのフォームの既定の prompt も、カレンダーを読まない仕事に変える
- tool の allowlist（`src/agent/tools.ts`）は準備の固定の組（`list_deadlines`・`list_schedule`・`propose_event`）だけに使う。`list_recent_runs` は使い道がなくなるので消す

## 判定

### いつ判定するか

- tick の取得の後、発火予定の計算の前に、起動用の予定（単発・繰り返しの親・変更された回）のうち次のものを判定する
  - 作成者が `allowedCreators` にある（ない予定は判定にかけず、今まで通り blocked）
  - `cancelled` でない
  - `dispatch` がない、`dispatch.eventUpdated !== event.updated`、または `dispatch.retryAt` を過ぎた
- 1 tick・1 組で `JUDGE_PER_TICK`（5）件まで。残りがあれば発火予定の `stale` を残し、次の tick で続ける
- 予定が変わると `applyChanges` が events の doc を上書きして `dispatch` が消えるので、変わった予定は自然に判定し直しになる。syncToken の失効（410）で全件を取り直すと、全件を判定し直す（まれなので許す）
- 前の計算（`state/schedule.computedAt`）から `RECOMPUTE_EVERY`（1時間）たった tick でも判定を試みる。`state/schedule` はデプロイをまたいで残るので、この機能より前から保存されている `dispatch` のない起動用の予定は、予定が変わるまで「変わった」tick が来ない。その移行路。1時間ごとの再計算が判定にかけるのは `needsJudge` を通る予定だけ（未判定のほか、`eventUpdated` が古い・`retryAt` を過ぎたものも含む）で、判定済みで変わっていない予定に LLM は呼ばない
- local worker の設定（agent・target の名前）が変わっても判定し直さない。消えた名前は worker が実行時に弾く（下記）

これで calendar-runner の「1分ごとの取得では LLM を呼ばない」を、「変化のない tick では LLM を呼ばない」に緩める。LLM を呼ぶのは、発火（準備）と、起動用の予定が足された・変わったときの判定、それに1時間ごとの再計算でまだ判定のない予定を拾うときだけ。公開の組で判定を増やせるのはデモ用フォームだけで、その数はフォームの上限（IP ごと・組全体）で抑える。

### 入力と出力

- model は runner と同じ `GEMINI_MODEL`。`responseSchema` で `JudgmentOutputSchema`（`executor`・`agent`・`target`・`prompt`・`blockedReason`、どれも nullable）を返させる
- system instruction に選択肢（`DispatchChoices`）を渡す: cloud の agent（`CLOUD_AGENTS`）と、local を許す組なら worker が登録した agent・target。title と notes（先頭 `JUDGE_NOTES_MAX` 文字）を渡す。notes は allowlist の作成者が書いた指示なので `<untrusted>` では囲まない
- prompt は、実行先や agent の指定を取り除いた作業の指示として書かせる

### 受け取った後に code で確かめること

LLM の出力をそのまま信じない。次を満たさなければ `blocked` にし、理由を残す。

| 条件 | 結果 |
|---|---|
| `blockedReason` がある、または `prompt` がない | blocked（その理由） |
| `executor` が null | cloud とみなす |
| local だが組が local を許さない | blocked「この組では local で動かせない」 |
| local で worker の登録がない | blocked「local worker が登録されていない」 |
| agent が null | cloud なら `CLOUD_AGENTS[0]`。local なら blocked |
| agent・target が選択肢にない | blocked（名指しされた名前を出す） |
| cloud で target がある | blocked「cloud には target を渡さない」 |
| local で target がない | blocked「local は target が要る」 |
| prompt が `DISPATCH_PROMPT_MAX` を超える | blocked |

LLM の呼び出し自体の失敗（timeout・5xx・schema 不一致）は `blocked` で保存し、`retryAt = now + JUDGE_RETRY_MS` を付ける。毎 tick に呼び直さない。

### 保存の形

`workspaces/{ws}/events/{eventId}` の `dispatch` に `JudgedDispatch` を置く（判定結果 + `eventUpdated`・`judgedAt`・`model`・`retryAt?`）。`listEvents("automation")` は `StoredEvent`（`CalendarEvent & { dispatch? }`）を返す。発火予定の計算では:

- `dispatch` がない → blocked「判定がまだ済んでいない」
- `dispatch.status === "blocked"` → blocked（その理由）
- ready → `FireItem.dispatch` に載せ、dashboard の発火予定に実行先・agent・target・prompt を出す

## Run の拡張

`Run`（`src/store/store.ts`）に `RunDispatchFields` を足す: `executor?`・`agent?`・`target?`・`workerId?`・`deadlineAt?`・`execution?`。`executor` がない Run は runner 内の Gemini（準備と、この機能より前の記録）。`status` に `queued` を足す。

| 実行先 | runner が書く | その後 |
|---|---|---|
| cloud | `running`・`deadlineAt = 開始 + SANDBOX_TIMEOUT_MS + SANDBOX_GRACE_MS`・`execution` | `/sandbox/result` で succeeded / failed。`deadlineAt` を過ぎても running なら、tick が failed「sandbox から結果が返らなかった」にして token を失効させる |
| local | `queued`（`input` に prompt） | worker が transaction で queued → running（`workerId`・`startedAt`・`deadlineAt = 開始 + timeout_minutes`）→ succeeded / failed / skipped |

- `output` は agent の stdout の末尾 `OUTPUT_MAX`（16,000）文字。failed の `reason` は exit code と stderr の末尾
- 6 時間ルール: worker は `scheduledAt` が `STALE_AFTER_MS` より古い queued を実行せず、skipped「Mac が止まっていた間の回なので実行しなかった」にする。worker が来ないまま 7 時間たった queued は、tick が transaction で skipped「local worker が受け取らなかった」にする（worker と同じく、status が queued のときだけ書く）
- 実行回数の上限（`RUN_LIMIT_PER_HOUR`）は queued も数える
- dashboard の「中断」は `deadlineAt`（無ければ従来どおり開始から 10 分）で判断する

## local worker

### 設定

`~/.config/agent-calendar/local.toml`（`LocalConfigSchema`）。repo には置かない。

```toml
gcp_project = "agent-calendar-wwwyo"
service_account = "local-worker@agent-calendar-wwwyo.iam.gserviceaccount.com"
workspaces = ["me"]
poll_seconds = 30

[targets.agent-calendar]
repo = "~/src/github.com/wwwyo/agent-calendar"

[agents.codex]
command = ["codex", "exec", "{prompt}"]
timeout_minutes = 60

[agents.claude]
command = ["claude", "-p", "{prompt}"]
```

- `command` は argv の配列で、`"{prompt}"` と一致する要素を prompt で丸ごと置き換える。shell の文字列にはしない（prompt に `;` や `$()` があっても shell に解釈させない）
- agent を差し替えるときはここを変えるだけで、runner は変えない

### 動き

- launchd（`~/Library/LaunchAgents/`）で常駐する。ログイン中だけ動けばよい
- 認証は gcloud の ADC から `service_account` を impersonate した token。鍵ファイルは置かない。`local-worker@` は `roles/datastore.user` だけ持つ。Firestore の IAM はパス単位で絞れないので DB 全体を読み書きできるが、本人の Mac で動くので許す（PRD の決めたこと）
- 起動時と `poll_seconds` ごとに、組ごとに次をする
  - `workspaces/{ws}/state/local`（`LocalWorkerState`）に agent・target の名前と `seenAt` を書く。名前が変わったときだけ `namesUpdatedAt` を進める
  - `runs` から `executor == "local"` かつ `status == "queued"` を取り、`scheduledAt` の古い順に 1 件ずつ処理する。同時に動かす agent は 1 つ
- 処理: transaction で status が queued なら running に変える（他の worker・tick と取り合っても 1 度だけ）。agent・target が設定にない（判定の後に消えた）なら failed にする
- 起動時、自分の `workerId` で running のまま残った Run は failed「worker が再起動した」にする

### agent の起動（orca CLI 経由）

`orca terminal create --worktree path:<repo> --title "agent-calendar <runId>" --command "exec <worker> exec-run <runId>"` で Orca の terminal に起こし、人が Orca から様子を見られるようにする。

- `--command` は shell に渡るので、prompt は入れない。terminal で動かすのは worker 自身の `exec-run <runId>` だけで、これが spool（`~/.local/state/agent-calendar/runs/<runId>/`）から prompt と argv を読み、shell を通さずに agent を起動し、stdout・stderr をファイルへ流しつつ terminal にも出し、exit code をファイルに書く
- worker 本体は exit code のファイルを待ち（`timeout_minutes` を過ぎたら terminal を閉じて failed）、出力の末尾を Run に書く。`orca terminal read` は描画の断片が混ざるので記録には使わない
- target の repo は Orca に登録されている必要がある。実行は target の作業ツリーで行い、実行ごとの worktree は作らない（未決を参照）

## cloud sandbox

### job

- 実行ごとに Cloud Run Job（`agent-sandbox`、us-central1）の execution を `jobs.run` の override で起こす。runner は起こすだけで待たない
- job の service account は `sandbox@`（role なし）。カレンダーにも共有しない。repo も渡さない
- 入力は override の環境変数（`SANDBOX_ENV`）: `RUN_ID`・`AGENT`・`PROMPT`・`RUNNER_URL`・`SANDBOX_TOKEN`。task は 1、retry は 0、timeout は `SANDBOX_TIMEOUT_MS`（15分）
- 出力: entrypoint が agent を起動して stdout の末尾を取り、`POST /sandbox/result`（`SandboxResult`）で返す。stdout は Cloud Logging にも残る
- runner の service account に要る権限: `agent-sandbox` job に対する `run.jobs.runWithOverrides`（job 単位の `roles/run.developer` か custom role）
- cloud で使える agent の初期値は `gemini` だけ（`CLOUD_AGENTS`）。image に入れた小さな agent が proxy 越しに Gemini を呼ぶ。Google 検索の grounding だけを tool として許す

### LLM への接続: runner の proxy と実行ごとの token

sandbox に API key も Vertex AI の権限も持たせず、runner の `POST /sandbox/llm` を通す。

- 発火時に runner が 256 bit の乱数 token を作り、`sandboxTokens/{sha256(token)}`（`SandboxTokenDoc`）に組・runId・期限（`SANDBOX_TIMEOUT_MS + SANDBOX_GRACE_MS`）・呼び出し回数を置いて、token そのものは env で job に渡す。`expireAt` の TTL ポリシーで消す
- `/sandbox/llm` は `Authorization: Bearer <token>` を検証し、body（Vertex AI の `generateContent` の request）を runner の service account で Vertex AI に流して、応答をそのまま返す。model は runner が `GEMINI_MODEL` に決め、tools は `googleSearch` 以外を落とす。1 token あたり `SANDBOX_LLM_CALLS_MAX`（20）回、body は 256KB まで
- `/sandbox/result` は同じ token で受け、Run を書いたら token を `done` にする。2度目以降と、running でない Run への結果は捨てる

選ばなかった案:

- sandbox の service account に `roles/aiplatform.user` を付ける: 鍵は要らないが、job の間は回数も model も絞れない Vertex AI の権限になり、「sandbox は権限を持たない」を崩す
- AI Gateway など外の gateway: provider の key を gateway に置くことになり、秘密と外部サービスが 1 つずつ増える

token は execution の設定（env）に残り、project の閲覧者には見えるが、1 回の実行の間だけ・proxy の回数上限つきなので許す。job は外のネットワークに出られる（調べ物のため）。持ち出せるのは prompt と、token が切れるまでの proxy の呼び出しだけ。

## 設定の検証

`WorkspaceSchema` に `allowLocal: boolean`（既定 false）を足す。`loadConfig` は次に違反すると throw する。

- `allowLocal: true` の組は `visibility: "private"` で、`allowedCreators` に `*.iam.gserviceaccount.com` を含まない
- 組の中で automation・records・main のカレンダー ID が互いに異なる（起動用が記録用を兼ねると、記録用の notes が判定にかかる）

runner の env に `SANDBOX_JOB`（job の名前）と `RUNNER_URL` を足す。

## 未決

- local の実行ごとに Orca の worktree を切るか。今は target の作業ツリーで直接動かすので、同じ repo で人が作業中だと衝突しうる
- cloud で codex・claude を動かすこと。proxy が OpenAI・Anthropic 互換の口を持つ必要があり、今は Vertex AI の `generateContent` だけ
- worker の設定変更で、blocked の判定を自動で判定し直すか（今は予定を触り直す）
- dashboard に local worker の生存（`seenAt`）を出す場所と文言
- sandbox の egress を runner と Google の API だけに絞るか。今の cloud の agent（`gemini`）は proxy を呼ぶだけで任意のコードを動かさないので、外に出られても持ち出せるのは prompt だけ。codex・claude など code を動かす agent を cloud に足すときに入れる。案: Compute Engine と Cloud DNS の API を有効にし、us-central1 に Private Google Access 付きの subnet を作り、job を Direct VPC egress（all-traffic）にする。NAT は置かず、egress の firewall で `199.36.153.8/30`（private.googleapis.com）の 443 以外を拒み、runner の host だけを private DNS zone でその VIP に向ける。費用は DNS zone の月 $0.2 程度。残る穴: VIP 越しに Host を変えれば他の `run.app`・`googleapis.com` にも届く。FQDN で絞るには Secure Web Proxy か Cloud NGFW Enterprise が要る

## 実装の分担

型の変更は `src/dispatch/types.ts` を正本にし、変えるときは 3 者に知らせる。

| 担当 | 触るファイル |
|---|---|
| A: runner | `src/runner.ts`・`src/runner.test.ts`・`src/config.ts`・`src/domain/schedule.ts`・`src/domain/payload.ts`（payload の削除）・`src/domain/domain.test.ts`・`src/agent/`・`src/store/`（`getRun`・`dispatch` の保存・queued の扱い）・`src/web/`・`src/server.ts`（C の handler をつなぐだけ）・`src/dispatch/judge.ts`（新設、判定と code の確かめ）・`package.json`（`yaml` を外す）・`deploy/workspaces.*.json` |
| B: local worker | `src/worker/`（新設。Firestore の読み書き・transaction・spool・`exec-run`・orca の呼び出し）・`deploy/launchd/`（新設、plist の雛形）・worker の README 節は `src/worker/README.md` |
| C: cloud sandbox | `src/cloud/`（新設。`CloudLauncher` の実装、`/sandbox/llm`・`/sandbox/result` の handler、`sandboxTokens`）・`sandbox/`（新設。job の Dockerfile・entrypoint・`gemini` agent）・`deploy/deploy.sh`（job・`sandbox@`・権限・TTL ポリシー） |

- A は `CloudLauncher` と `RunAccess` の型にだけ依存し、テストでは stub を使う。C は `src/cloud/` から `handleSandbox(req): Promise<Response | undefined>` を export し、A が `server.ts` でつなぐ
- B は runner のコードを import しない（`src/dispatch/types.ts` だけ）。Firestore のパス（`workspaces/{ws}/runs`・`workspaces/{ws}/state/local`）はこの文書の取り決めに従う
