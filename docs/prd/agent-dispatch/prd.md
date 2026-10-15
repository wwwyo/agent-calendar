---
status: ready
---

# 自然言語で実行先と agent を選ぶ（agent-dispatch）

## Problem

起動用カレンダーの予定で起こせるのは、cloud の Gemini と読み取り系の tool だけである。手元の repo で codex に作業させる、といった本来任せたい定期の仕事は、カレンダーから起こせない。そのため、Orca automation など vendor ごとの設定に残ったままになる。payload は YAML front matter で書く必要があり、カレンダーに人が書くものとして不自然である。

## 導出

Story の Core action「agent に任せる定期の仕事をカレンダーに繰り返し予定として置く」を、起こす先まで広げる。[calendar-runner](../calendar-runner/prd.md) が Non-Goals に置いた「local の agent を起こすこと」を、この PRD で扱う。

## Overview

人は起動用カレンダーの予定の notes に、「codex で agent-calendar の依存の更新を確かめて。local で」のように自然言語で書く。runner は予定を取り込んだときに、どこで（cloud / local）、どの agent で、どの作業場所（target）で動かすかを判定し、dashboard に出す。人は、発火する前に判定結果を確かめられる。時刻が来ると、local の回は自分の Mac で、cloud の回は使い捨ての sandbox で、毎回新しいセッションの agent が起動する。結果は今と同じ実行記録に残る。

### Goals

- 定期の仕事を、起こす先の agent や場所を問わず、カレンダーの予定 1 件で置ける
- 何がどこで動くかを、発火の前に人が確かめられる
- 特定の agent や vendor に依存しない。agent を差し替えても、カレンダーの書き方は変わらない
- 人はカレンダーに自然言語だけを書く。構造化された書式を覚えなくてよい

### Non-Goals

- 1 つの常駐セッションに発火を流し込む方式（Claude Code channels など）。発火ごとに新しいセッションを起動する
- 判定結果に、任意のコマンド・パス・スクリプトを含めること
- 記録用カレンダーの予定（準備）の実行先を変えること。準備は今まで通り cloud の Gemini で動かす
- demo の組から local を起こすこと

## Glossary

| 用語 | 意味 |
|---|---|
| 実行先（executor） | 発火した回を動かす場所。`cloud`（使い捨ての sandbox）か `local`（本人の Mac） |
| agent 種別 | 起動する agent の名前（codex、claude など）。実際の起動方法は実行先の側の設定にあり、カレンダーには名前しか書かない |
| target | agent を動かす作業場所の名前（repo など）。実際のパスは実行先の側の設定にある |
| 判定 | LLM が、起動用の予定の自然言語から実行先・agent 種別・target・prompt を決めること。結果は決められた選択肢の中からしか選ばない |
| local worker | 本人の Mac に常駐し、local の回を受け取って agent を起動するもの |

## Domain Model

```
起動用の予定（自然言語）
  └ 取り込んだとき、予定が変わったときだけ判定する
       ├ 判定できた → 実行先・agent 種別・target・prompt（dashboard に出す）
       └ 判定できない・選択肢にない → blocked（理由つき。推測で補わない）
発火
  ├ cloud → 実行ごとに使い捨ての sandbox で agent を起動する
  └ local → local worker が受け取り、本人の Mac で agent を起動する
```

- 判定は**便利にするための仕組みで、守りではない**。起動された agent は prompt に沿って何でもするので、安全は次の 2 つで保つ
  - **入口**：判定にかけるのは、起動用カレンダーの予定のうち作成者が allowlist にあるものだけ。記録用の予定は判定にかけない
  - **実行環境**：cloud は sandbox で隔離する。local は本人が手で起動するのと同じとみなし、各 agent の普段の設定のまま動かす
- 実行先が書かれていなければ cloud にする。local は明示的に書いたときだけ
- 人がカレンダーに書くのは自然言語だけで、YAML などの構造化された書式は使わない。構造が必要なものは、取り込むときに LLM が判定して作る。デモ用フォームも自然言語で書く
- local の実行を許す組は、非公開であり、作成者の allowlist に service account（デモ用フォームの書き手）を含まない。この 2 点を満たさない設定では runner が起動しない
- cloud の sandbox は、カレンダー・Firestore への権限を持たない。agent の API key も持たない
- 起動方法（コマンド）と作業場所（パス）は実行先の側の設定にだけあり、カレンダーと判定結果には名前しか載らない

## Acceptance Criteria

- 人が起動用カレンダーに「codex で ◯◯ して。local で」と書くと、dashboard に判定結果（local・codex・target・prompt）が発火の前に出る。時刻が来ると本人の Mac で codex が起動し、出力が実行記録に残る
- 実行先を書かない、または cloud と書いた予定は、sandbox の中で agent が起動し、出力が実行記録に残る。その agent はカレンダー・Firestore に書けず、API key を読み出せない
- 判定できない予定と、設定にない agent・target を名指しした予定は発火せず、dashboard でその理由が分かる
- 記録用カレンダーの notes に「local の codex で ◯◯ して」と書いても、local でも cloud の sandbox でも agent は起動しない
- 公開の組、または allowlist に service account を含む組で local の実行を有効にすると、runner は起動を拒む
- agent を差し替えるとき（codex から claude へ、など）は、実行先の側の設定を変えるだけで済み、runner の変更は要らない

## Non-Functional Requirements

- [calendar-runner](../calendar-runner/prd.md) の「1 分ごとの取得では LLM を呼ばない」を緩める。LLM を呼ぶのは、発火したときと、起動用の予定が足された・変わったときの判定だけにする。変化のない tick では呼ばない
- 秘密は repo にも sandbox にも置かない

## 決めたこと

- cloud の agent には repo を渡さない。まずは調べ物・文章の作成など、repo を触らない仕事に限る
- cloud の sandbox は、実行ごとの Cloud Run Job で作る
- Mac が寝ていた間の local の回は、cloud と同じく 6 時間より古ければ実行せず、捨てたことを記録に残す
- local worker は、権限を絞った service account を借りて Firestore を直接読み書きする。本人の Mac で動くので、予定の写しが読めることは許容する
- local で同時に動かす agent は 1 つ

## Success Metrics

- 作者が Orca automation の定期実行を 1 本以上、起動用カレンダーの自然言語の予定に移し、local の agent で取りこぼしなく動かせる
