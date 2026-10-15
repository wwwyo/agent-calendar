# agent-calendar

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

締切と予定を Google Calendar に書いておくだけで、agent が準備と定期の仕事を自分で始める。

agent の定期実行は、今は vendor ごとの設定（cron・routines・automation）に散らばっていて、人間の予定と並べて見られない。agent-calendar は Google Calendar を入力にして、

- 起動用カレンダーの予定（繰り返し予定・notes に prompt）の時刻に agent を起こす
- 記録用カレンダーの締切に「準備: 30日前」と書いておけば、その日に agent が準備を始める

を Google Cloud 上で動かす。設定は Google Calendar の画面で予定を足すだけ。

## デモ

https://agent-calendar-785713600547.asia-northeast1.run.app

ログインなしで見られる。週表示のカレンダーの時間の枠を押すとデモ用の起動用カレンダーに定期の仕事を、終日の枠を押すと記録用カレンダーに「準備: N日前」付きの締切を書ける。開始時刻に発火し、セッション（入力・tool 呼び出し・出力）と承認待ちが dashboard に出る。足した予定はカレンダーから消せ、一定時間後に自動でも消える。

![構成図](docs/architecture.png)

## 使い方

- **定期の仕事**: 起動用カレンダーに予定を置き、notes の先頭に payload を書く。作成者が allowlist にある予定だけが開始時刻に発火する

  ```
  ---
  prompt: 記録用カレンダーの締切を確認して、今週やることを3つに絞って
  ---
  ```

- **締切の準備**: 記録用カレンダーの締切の notes に `準備: 30日前` と書く。期日の30日前に agent が準備を始める。書いた時点でその日を過ぎていれば即時に始める
- **承認**: agent はカレンダーに直接書けない。予定の追加は承認待ちに入り、dashboard で承認したときだけ記録用カレンダーに書かれる

要件は [docs/prd/calendar-runner/prd.md](docs/prd/calendar-runner/prd.md)、設計は [dd.md](docs/prd/calendar-runner/dd.md)。

## 動かし方

```bash
mise install
bun install
bun test
bun run typecheck
bun run dev            # 実カレンダーと Vertex AI につなぎ、状態はメモリに持つ（STORE=firestore で Firestore）
curl -X POST localhost:8080/tick
```

`bun run dev` は gcloud で runner の service account を借りる（`roles/iam.serviceAccountTokenCreator` が要る）。

## Deploy

```bash
./deploy/deploy.sh     # Cloud Run（source deploy）と Cloud Scheduler（1分ごとの /tick）
```

カレンダーの組は `deploy/workspaces.demo.json`（`WORKSPACES_FILE` で差し替え）。service account にカレンダーを共有して使う。

## License

Licensed under the [MIT license](LICENSE).
