# agent-calendar

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

締切と予定を Google Calendar に書いておくだけで、agent が準備と定期の仕事を自分で始める。

agent の定期実行は、今は vendor ごとの設定（cron・routines・automation）に散らばっていて、人間の予定と並べて見られない。agent-calendar は Google Calendar を入力にして、

- 起動用カレンダーの予定（繰り返し予定・notes に prompt）の時刻に agent を起こす
- 記録用カレンダーの締切に「準備: 30日前」と書いておけば、その日に agent が準備を始める

を Google Cloud 上で動かす。設定は Google Calendar の画面で予定を足すだけ。

> 開発中。動かし方は実装に合わせて追記する。

## License

Licensed under the [MIT license](LICENSE).
