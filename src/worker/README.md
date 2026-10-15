# local worker

本人の Mac に常駐し、`executor == "local"` の Run（queued）を受け取って、Orca の terminal で agent を起こす。取り決めの正本は [docs/prd/agent-dispatch/dd.md](../../docs/prd/agent-dispatch/dd.md) の「local worker」。

## 設定

`~/.config/agent-calendar/local.toml`（repo には置かない。形は `src/dispatch/types.ts` の `LocalConfigSchema`）。

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

- `command` は argv。`"{prompt}"` と一致する要素だけを prompt で丸ごと置き換え、shell は通さない
- target の `repo` は Orca に登録しておく（`orca terminal create --worktree path:<repo>` で開くため）
- agent・target を足す・消すと、次の heartbeat で `workspaces/{ws}/state/local` の名前が変わる。runner の判定はこの名前から選ぶ

## 認証

gcloud の ADC から `service_account` を impersonate する。鍵ファイルは置かない。

```bash
gcloud auth application-default login
# 自分のアカウントに local-worker@ の roles/iam.serviceAccountTokenCreator が要る
```

## 起動

```bash
bun run worker                              # 手元で試す（Ctrl-C で止める）
./deploy/launchd/install.sh                 # launchd に常駐させる（入れ直しも同じ）
launchctl bootout gui/$(id -u)/dev.wwwyo.agent-calendar.worker   # 止める
tail -f ~/Library/Logs/agent-calendar-worker.log
```

`install.sh` は実行した checkout の `src/worker/main.ts` を plist に書く。作業用の worktree ではなく、main の checkout から実行する。

## 動き

1. 起動時と `poll_seconds` ごとに `state/local` に名前と `seenAt` を書く（agent の実行中も続ける）
2. 起動時、自分の `workerId`（`local:<hostname>`）で running のまま残った Run を failed「worker が再起動した」にする
3. queued を `scheduledAt` の古い順に 1 件ずつ、transaction で取る
   - `scheduledAt` が 6 時間より古い → skipped
   - agent・target が設定にない → failed
   - それ以外 → running（`deadlineAt = 開始 + timeout_minutes`）
4. `~/.local/state/agent-calendar/runs/<runId>/job.json` に argv と prompt を書き、`orca terminal create` で `exec <bun> src/worker/main.ts exec-run <runId>` を起こす。prompt は terminal の command に載せない
5. `exec-run` が agent を起こし、`stdout.log`・`stderr.log` と terminal の両方に流し、最後に `exit_code` を書く
6. worker は `exit_code` を待ち、stdout の末尾 16,000 文字を `output` に書く。exit code が 0 でなければ failed（理由は exit code と stderr の末尾）。`timeout_minutes` を過ぎたら terminal を閉じて failed

spool は消さないので、失敗の調べ物に使える。
