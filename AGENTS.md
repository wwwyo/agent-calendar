# agent-calendar

## Story

人が、自分の予定と締切を Google Calendar に書いておくと、agent がそれに合わせて準備と定期の仕事を自分で始める。

Core actions:
- 締切・手続きの期日をカレンダーに書く（必要なら notes に「準備: 30日前」）— 期日が決まるたび
- agent に任せる定期の仕事をカレンダーに繰り返し予定として置く — 仕事を足すとき
- agent の実行記録と、承認待ちの操作を確かめる — 毎日

## ディレクトリ構造

```
agent-calendar/
├── src/                  Cloud Run で動く runner（取得・発火・agent 実行・dashboard）
└── docs/prd/<topic>/{prd|dd}.md
```

`docs/` は共有文書として Git で管理する。topic は機能ごとのディレクトリ名で、prd.md は要件、dd.md は必要な場合の設計書。置き場の規約は prd skill を参照する。

## 構想上の前提

- カレンダーは3種類に分ける: 本人の予定（メイン）、締切・手続きの期日（記録用）、agent の定期実行（起動用）。記録用には起動の指示を書かない。起動の正本は起動用カレンダー
- 発火の検出は範囲で切らない。未来の予定は全件持ち、差分は syncToken で取る
- カレンダーの notes は信頼しない入力として扱う（prompt injection 対策）。payload を解釈するのは起動用カレンダーの予定だけ
- 背景と却下した案は wwwyo/me の `ideas/agent-calendar.md`

## セットアップ

ツールは mise で管理している。

```bash
mise install   # mise.toml に従ってツールをインストール
bun install
```

```bash
bun test               # テスト
bun run typecheck      # 型検査
bun run dev            # ローカル起動（実カレンダー・Vertex AI。service account を gcloud で借りる）
./deploy/deploy.sh     # Cloud Run と Cloud Scheduler へ反映
```

- 設計の正本は `docs/prd/calendar-runner/dd.md`
- Vertex AI は `gemini-2.5-flash`（us-central1）。2026-10-15 時点で global と asia-northeast1、新しいモデルは 404 だった

## 技術スタック

- Bun + TypeScript
- Google Cloud: Cloud Run（runner と dashboard）、Cloud Scheduler（定期の取得）、Firestore（syncToken・発火済みの記録・実行記録）
- Google Calendar API（service account に共有したカレンダーを読む）
- Vertex AI の Gemini（agent の実行。service account で認証）

## Skills

- PR の自動レビューは Pullfrog。設定の正本は `.github/pullfrog.config.sh`（初回レビュー自動・追加コミットも再レビュー・手動依頼は `@pullfrog`）
- Cloud Run の deploy・設定は `.agents/skills/cloud-run-basics/`、ADK で agent を書くときは `.agents/skills/google-agents-cli-adk-code/` を読む（取得元は google/skills・google/agents-cli。版は `.agents/skillctrl/lock.json` の skillFolderHash。Claude 用は `.claude/skills/` の相対 symlink）
- 学び・ハマりどころ・過去の失敗は `.agents/skills/<topic>/` を参照
