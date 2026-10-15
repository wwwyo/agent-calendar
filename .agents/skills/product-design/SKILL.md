---
name: product-design
description: "この repo の dashboard（src/web/）で UI を足す・直す・レビューする・利用者が読む文言を決めるときに参照する。視覚値は repo root の design.md、使い分けと禁止事項はこの skill の references。"
---

# Product Design

agent-calendar の UI 判断のルーター。このファイル自身は知見を持たない。視覚値（色・字・余白・基盤 component のクラス）は repo root の `design.md` を読む。

| やること | 読む reference |
| --- | --- |
| section・部品を足す / 組む（Implement） | [references/ui-patterns.md](references/ui-patterns.md) |
| 実装を規約に照らす（Review） | [references/ui-patterns.md](references/ui-patterns.md) |
| 見出し・説明・空状態・ボタン名を決める（Copy） | [references/copy.md](references/copy.md) |
| 見た目を揃える | `/design.md`（クラス名と custom property を使う。値を直書きしない） |

未確立: Shape（domain-context。ドメイン概念は repo の AGENTS.md の Story と `docs/prd/` を読む）、Harden（IME・a11y・対応ブラウザ）。推測で埋めず、evidence が出たら reference を足す。

## 検証

```bash
python3 ~/.agents/skills/design-md/tools/design-md-check.py design.md   # error 0
bun test src/web                                                         # design.css と design.md の同期
```

`page-check.py` の `external-resource`（Google Fonts）は design.md で採用済みのため無視してよい。

## 関連 skill

- design-md — design.md の値・format・check の正本
