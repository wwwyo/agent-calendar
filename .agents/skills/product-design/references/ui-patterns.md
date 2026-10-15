# UI patterns（Implement / Review）

見た目の出発点は Cloudglare flavor（design.md の Notes）だが、flavor に合わせること自体は目的ではない。下の「表現すべきもの」が正本で、以降の規則はそのための手段。flavor 由来の規則が必要な表現を妨げるなら、規則の方を変える（design.md の値なら design.md、使い分けならこの reference）。

## 表現すべきもの

- 状態の区別: 発火予定（待機 / 遅れて登録 / 発火しない）と実行（成功 / 失敗 / 実行中 / 中断 / 実行せず）を、一覧で一目に見分けられる
- 人の判断待ち: 承認待ちの件数と、承認・却下の操作が first view の近くにある
- 機械の出力と説明の区別: agent への入力・tool の呼び出し・出力を、人向けの説明と取り違えない
- 信頼の境界: notes など agent に信頼しないデータとして渡る入力は、そう分かる
- 予定と実行のつながり: カレンダーの予定から、その回のセッションへ辿れる。仕組みは文章で説明せず、カレンダー上の見え方（起動用・記録用・準備の開始の区別）で示す。文章の説明は README と提出文に置く

## 構図

- 紫の `.slab` は1画面に1枚、header だけに使う。高さは中身なり。flavor の「≥760px でほぼ空」は採らない — 毎日開く画面の first view を潰すため
- slab の上に badge・浮いた pill・overlay を重ねない。中身は slab の中に並べる
- slab 以外の section はすべて `.frame`（1px の rule で区切った cell の集まり）+ `.tick`（四隅の中空 tick）で組む。cell に角丸・影・隙間を付けない
- 並べる section は別 frame にせず、同じ frame の cell として butt させる（例: 発火予定 | 承認待ち）。列は `cols-2` / `cols-3` で、900px 未満で1列に落とす
- frame 同士の間は `--space-7`（56px）。frame の中は密に、外は空ける
- frame の cell には `min-width:0; overflow-x:auto` が要る（design.md の `.frame > *` に入っている）。外すと nowrap の表が狭い幅で cell を押し出す

## 色

- 彩度のある色は既定で `--primary` 系（紫）だけ。warning も今は `--primary-deep` で表している。状態の区別が足りないと分かったら hue を足してよい（design.md の Tokens に足し、ここに理由を書く）
- 状態は `.status-ok` / `.status-bad` / `.status-warn` の文字色だけで示す。状態ごとに面を塗らない
- gradient は slab の core と glow だけ。他の面・ボタンに gradient を使わない
- 文字は `--foreground` / `--muted-foreground`。`--faint` は hash など読まなくてよい値だけに使い、run id・model・tokens・所要時間のように点検で読む値には使わない（contrast が足りない）
- slab 上の文字に opacity を掛けない。紫の上で contrast が落ちる

## 文字

- 見出しは `.text-heading`（weight 500・`palt`）。600 / 700 にしない。太字は「行の主語」（承認待ちの操作名など）の `<b>` だけ
- mono（`.mono` / `.code`）は機械の出力専用: agent に渡す prompt、tool の引数と結果、agent の出力、run id、tokens、発火時刻の表。説明文・label・状態名に mono を使わない
- 日時の列は `nowrap` で1行に保つ

## 操作

- button は pill。`.btn-primary` は「書き込みが起きる主操作」（承認して追加・カレンダーに書く）だけ、却下・消すは `.btn-outline`。1つのまとまりに primary は1つ
- form は label を input の上に置き、`for` / `id` で結ぶ
- 予定の追加・削除はカレンダーの枠と予定を押して開くモーダル（`<dialog>`）で行う。別のフォーム欄を画面に常設しない
- hover で動かさない（浮かせない・拡大しない）。変えるのは色・背景・border だけ、200ms `--ease`
- scroll で出現・fade させない

## 背景

- `.page-guides`（gutter の点）を body 直下に1つ置く。内容カラムの外にだけ出る
- 区切りに装飾が要るときは hairline か `.dashed-rule`。アイコンや絵で飾らない
