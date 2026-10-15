# 提出フォーム用の説明文（下書き）

第5回 Agentic AI Hackathon（Zenn）への提出用。提出はユーザーが行う。

- デプロイ URL: https://agent-calendar-785713600547.asia-northeast1.run.app
- リポジトリ: https://github.com/wwwyo/agent-calendar
- 構成図: [docs/architecture.png](../architecture.png)

## プロジェクト名

agent-calendar — 予定と締切を書いておくと、agent が準備と定期の仕事を自分で始める

## 対象ユーザー

締切や手続きの期日（パスポート更新・確定申告・契約更新・申請の締切など）を Google Calendar で管理していて、その準備や定期の確認を AI agent に任せたい個人。agent の定期実行を複数のツールで回している開発者。

## 課題

- 締切はカレンダーに書いても、「何日前から何を準備するか」は人が覚えておくしかない。気づいた時には間に合わない
- agent に定期の仕事を任せる設定は、vendor ごとの cron・routines・automation に散らばっている。いつ何が動くのかを、人間の予定と並べて見られない
- agent を自動で動かすほど、勝手に予定を書き換えないか、カレンダーに紛れ込んだ文章に操られないかが不安になる

## 解決策

Google Calendar をそのまま agent の起動台帳にする。

1. 記録用カレンダーの締切の notes に「準備: 30日前」と1行書くと、期日の30日前に agent（Gemini）が準備を始め、段取りを考えて準備の予定を提案する。書いた時点でその日を過ぎていれば即時に始め、「遅れて登録」と伝える
2. 起動用カレンダーに繰り返し予定を置き、notes の先頭に prompt を書くと、その時刻に agent が定期の仕事をする
3. agent はカレンダーに直接書けない。予定の追加は承認待ちに入り、人が dashboard で承認したときだけ書かれる

人は新しい画面を覚えなくてよい。いつもの Google Calendar で予定を足し・動かし・消せば、agent の動きが変わる。

## 特徴

- **カレンダーを読むだけで自律的に動く**: Cloud Scheduler が1分ごとに差分（syncToken）を取り、発火予定を計算する。この部分は LLM を呼ばないので安い。何か月先の締切も、いつ足された予定も取りこぼさないよう、日付の範囲で切らずに未来の予定を全件持つ
- **制御された振る舞い**: 記録用カレンダーは「事実」、起動用カレンダーは「命令」と役割を分けた。命令として解釈するのは起動用カレンダーの予定だけで、さらに作成者が allowlist にある場合に限る。payload は書式を厳密に読み、読めないものは発火させず理由を残す
- **prompt injection 対策**: 記録用カレンダーの title・notes は信頼しないデータとして囲んで渡す。agent が使える tool は allowlist（読み取りと「提案」だけ）で、副作用はすべて承認待ちを経る。agent は起動用カレンダーに書けないので、自分の起動を増やせない
- **observability**: dashboard で、次の発火予定、各実行の入力・tool 呼び出し・出力・token 使用量、承認待ちを確かめられる。Cloud Logging に構造化ログを出す
- **security**: 鍵も API key も持たない。Cloud Run に付けた service account で Calendar API と Vertex AI を呼ぶ。`/tick` は Cloud Scheduler の OIDC token だけを受け付ける
- **運用性・コスト**: Cloud Run（最小0インスタンス）+ Firestore + Scheduler だけの構成。同じ回を2度実行しないよう Firestore の create で予約し、tick の重なりは lease で防ぐ。1時間あたりの実行回数に上限を持つ
- **拡張性**: カレンダーの読み書きは adapter 越しで、カレンダーの組（workspace）は設定で増やせる。OAuth の adapter や、Claude Code など別の agent を起こす口を後から足せる

## 審査員の試し方

デプロイ URL を開き、「試す」のフォームから

1. 「締切を書く」で、期日を2週間後・準備を30日前にして書く → 遅れて登録として1分以内に準備が始まり、実行記録と承認待ちが出る
2. 承認待ちの「承認して追加」を押すと、記録用カレンダーに予定が入る
3. 「定期の仕事を置く」で、開始を1分後にして書く → 開始時刻に発火する

誰でも書けるので、IP ごとと全体の1時間あたりの回数、文字数に上限がある。フォームで足した予定は6時間後に自動で消える。

## 使った技術

Cloud Run、Cloud Scheduler、Firestore、Vertex AI（Gemini 2.5 Flash, function calling）、Google Calendar API、Bun + TypeScript
