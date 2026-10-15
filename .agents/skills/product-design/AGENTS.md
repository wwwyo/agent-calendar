# product-design skill の保守規約

- load order: SKILL.md（ルーター）→ やることに対応する reference → `/design.md`
- 置き場: 判断と rationale は `references/`、再利用できる視覚値と基盤 class は repo root の `design.md`、決定論で判定できるものは design-md skill の check。最も狭い場所に入れる
- evidence 源: 実装・レビュー中に見つけた逸脱（随時）と、PR の review コメント（Pullfrog・CodeRabbit・人間）
- 反映: reference / design.md / check のどれにするか、変更なしにするかは人間が決める。承認前に encode・commit しない。1回だけの失敗はルール化しない
- 未確立の領域（SKILL.md に列挙）は推測で埋めない
