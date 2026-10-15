# 提出フォーム用の説明文（下書き）

第5回 Agentic AI Hackathon（Zenn）への提出用。提出はユーザーが行う。

- デプロイ URL: https://agent-calendar-785713600547.asia-northeast1.run.app
- リポジトリ: https://github.com/wwwyo/agent-calendar
- 構成図: [docs/architecture.png](../architecture.png)
- dashboard の画面: [docs/dashboard.png](../dashboard.png)

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
2. 起動用カレンダーに予定を置き、notes に頼みたい仕事を自然言語で書くと、Gemini が実行先・agent・agent に渡す prompt を判定して発火前に dashboard に出し、その時刻に agent が仕事をする。既定の実行先は Cloud Run Job の使い捨て sandbox で、本人の Mac の local worker（Codex・Claude Code など）にも振り分けられる
3. agent はカレンダーに直接書けない。予定の追加は承認待ちに入り、人が dashboard で承認したときだけ書かれる

人は新しい画面を覚えなくてよい。いつもの Google Calendar で予定を足し・動かし・消せば、agent の動きが変わる。

## 特徴

- **カレンダーを読むだけで自律的に動く**: Cloud Scheduler が1分ごとに差分（syncToken）を取り、発火予定を計算する。LLM を呼ぶのは、起動用の予定が足された・変わったときの判定と、発火したときだけなので、変化のない tick は安い。何か月先の締切も、いつ足された予定も取りこぼさないよう、日付の範囲で切らずに未来の予定を全件持つ
- **制御された振る舞い**: 記録用カレンダーは「事実」、起動用カレンダーは「命令」と役割を分けた。命令として判定にかけるのは起動用カレンダーの予定だけで、さらに作成者が allowlist にある場合に限る。判定の出力は code で選択肢と照らし（存在しない agent・許されていない実行先・長すぎる prompt）、合わないものは発火させず理由を予定に出す
- **prompt injection 対策**: 記録用カレンダーの title・notes は信頼しないデータとして囲んで渡す。準備の agent が使える tool は allowlist（読み取りと「提案」だけ）で、副作用はすべて承認待ちを経る。agent は起動用カレンダーに書けないので、自分の起動を増やせない
- **権限を持たない sandbox**: 定期の仕事は実行ごとに Cloud Run Job の execution を起こして動かす。job の service account は role を持たず、カレンダーにも共有しない。LLM は runner の proxy（`/sandbox/llm`）越しに、実行ごとの使い捨て token・回数上限・model 固定・tool は Google 検索の grounding だけで呼ぶ
- **observability**: dashboard の週表示のカレンダーで、予定ごとの判定結果（実行先・agent・prompt）、準備の開始、各回のセッションを確かめられる。セッションには入力・tool 呼び出し・出力・token 使用量・承認待ちが出る。Cloud Logging に構造化ログを出す
- **security**: 鍵も API key も持たない。Cloud Run に付けた service account で Calendar API と Vertex AI を呼ぶ。`/tick` は Cloud Scheduler の OIDC token だけを受け付ける。local worker は gcloud の ADC から service account を impersonate し、鍵ファイルを置かない
- **運用性・コスト**: Cloud Run（最小0インスタンス）+ Firestore + Scheduler だけの構成。同じ回を2度実行しないよう Firestore の create で予約し、tick の重なりは lease で防ぐ。1時間あたりの実行回数に上限を持つ
- **拡張性**: カレンダーの読み書きは adapter 越しで、カレンダーの組（workspace）は設定で増やせる。local worker の agent・作業場所は Mac 側の設定ファイルで足せ、runner を変えずに判定の選択肢に載る

## 審査員の試し方

デプロイ URL を開き、カレンダーの上の「予定を追加」から

1. 「締切」のタブで、期日を2週間後・準備を30日前のまま「記録用カレンダーに追加」 → 遅れて登録として1〜2分で準備が始まり、セッションに入力・tool 呼び出し・出力と提案（承認待ち）が出る
2. セッションの提案で「承認して追加」を押すと、記録用カレンダーに予定が入り、週表示のカレンダーにも出る
3. 「定期の仕事」のタブで、notes に仕事を自然言語で書き、開始を数分後にして「起動用カレンダーに追加」 → 1分ほどで予定に判定結果（実行先・agent・prompt）が出て、開始時刻に cloud の sandbox で agent が動き、結果がセッションに残る

デモの組は public なので local の実行は無効にしてある（判定で local を指定すると、発火しない理由として出る）。

誰でも書けるので、IP ごとと全体の1時間あたりの回数、文字数に上限がある。フォームで足した予定は6時間後に自動で消える。

## 使った技術

Cloud Run（service と Job）、Cloud Scheduler、Firestore、Vertex AI（Gemini 2.5 Flash。function calling・structured output・Google 検索の grounding）、Google Calendar API、Bun + TypeScript、Orca（local worker が agent を起こす terminal）
