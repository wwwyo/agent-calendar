import type { CalendarEvent, EventTime } from "../calendar/adapter";
import type { Workspace } from "../config";
import type { FireItem } from "../domain/schedule";
import { DEMO_EXPIRES_TAG } from "../runner";
import type { Approval, Run, Schedule } from "../store/store";
import { DEMO_NOTES_MAX, DEMO_PROMPT_MAX, TITLE_MAX } from "./demo";

export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function when(iso: string | undefined, tz: string): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("ja-JP", { timeZone: tz, month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" });
}

function timeLabel(t: EventTime, tz: string): string {
  return "date" in t ? t.date : when(t.dateTime, tz);
}

const STYLE = `
:root{--bg:#f7f6f2;--panel:#fff;--ink:#1d1d1b;--muted:#6b6a64;--line:#e4e2da;--accent:#1f6f5c;--accent-ink:#fff;--warn:#a5521b;--bad:#a8323e;--ok:#1f6f5c;--chip:#efede6;--code:#f2f1ec}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#151614;--panel:#1d1f1c;--ink:#ecebe6;--muted:#a3a29b;--line:#30322e;--accent:#5fbf9f;--accent-ink:#0d1a15;--warn:#e19a62;--bad:#ef7d88;--ok:#5fbf9f;--chip:#262925;--code:#232521}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif}
main{max-width:1080px;margin:0 auto;padding:24px 16px 64px}
header h1{font-size:24px;margin:0 0 4px}header p{margin:0;color:var(--muted)}
.grid{display:grid;grid-template-columns:1fr;gap:16px;margin-top:20px}@media(min-width:900px){.grid{grid-template-columns:1.2fr 1fr}}
section{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px 18px}
h2{font-size:16px;margin:0 0 12px;display:flex;gap:8px;align-items:baseline}h2 small{color:var(--muted);font-weight:400;font-size:12px}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{text-align:left;padding:6px 4px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:500;font-size:12px}
.chip{display:inline-block;padding:0 8px;border-radius:999px;background:var(--chip);font-size:12px;white-space:nowrap}
.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}.muted{color:var(--muted)}
details{border-top:1px solid var(--line);padding:8px 0}details:first-of-type{border-top:0}summary{cursor:pointer;list-style:none}summary::-webkit-details-marker{display:none}
pre{background:var(--code);padding:10px;border-radius:8px;white-space:pre-wrap;word-break:break-word;font-size:12.5px;margin:6px 0}
form.inline{display:inline}button{font:inherit;border:1px solid var(--line);background:var(--panel);color:var(--ink);border-radius:8px;padding:4px 12px;cursor:pointer}
button.primary{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}
label{display:block;font-size:13px;color:var(--muted);margin-top:8px}input,select,textarea{font:inherit;width:100%;padding:6px 8px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)}textarea{min-height:72px}
.forms{display:grid;grid-template-columns:1fr;gap:16px}@media(min-width:700px){.forms{grid-template-columns:1fr 1fr}}
.flash{margin-top:16px;padding:10px 14px;border-radius:10px;background:var(--chip)}
.how{display:grid;grid-template-columns:1fr;gap:8px;margin-top:16px}@media(min-width:700px){.how{grid-template-columns:repeat(3,1fr)}}
.how div{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px 14px;font-size:14px}.how b{display:block}
.approval{border-top:1px solid var(--line);padding:10px 0}.approval:first-child{border-top:0}
`;

function scheduleRows(items: FireItem[], tz: string): string {
  if (items.length === 0) return `<p class="muted">発火予定はまだない。下のフォームから予定を足すと、1分以内にここに出る。</p>`;
  return `<table><tr><th>発火</th><th>種類</th><th>予定</th><th>状態</th></tr>${items
    .slice(0, 15)
    .map(
      (i) => `<tr><td>${esc(when(i.fireAt, tz))}</td><td><span class="chip">${i.kind === "automation" ? "定期の仕事" : `準備 ${i.prepDays}日前`}</span></td><td>${esc(i.title)}${
        i.kind === "prep" ? `<div class="muted">締切 ${esc(when(i.occurrenceStart, tz))}</div>` : ""
      }</td><td>${i.blocked ? `<span class="bad">発火しない</span><div class="muted">${esc(i.blocked)}</div>` : i.late ? `<span class="warn">遅れて登録</span>` : `<span class="ok">待機</span>`}</td></tr>`,
    )
    .join("")}</table>`;
}

function runStatus(r: Run): string {
  if (r.status === "succeeded") return `<span class="ok">成功</span>`;
  if (r.status === "failed") return `<span class="bad">失敗</span>`;
  if (r.status === "running") return `<span class="warn">実行中</span>`;
  return `<span class="warn">実行せず</span>`;
}

function runList(runs: Run[], tz: string): string {
  if (runs.length === 0) return `<p class="muted">まだ実行していない。</p>`;
  return runs
    .map((r) => {
      const ms = r.finishedAt ? Date.parse(r.finishedAt) - Date.parse(r.startedAt) : 0;
      return `<details><summary>${runStatus(r)} <span class="chip">${r.kind === "automation" ? "定期" : "準備"}</span> ${esc(r.title)} <span class="muted">· ${esc(when(r.startedAt, tz))}${r.late ? " · 遅れて登録" : ""}${
        r.toolCalls.length ? ` · tool ${r.toolCalls.length}回` : ""
      }</span></summary>
${r.reason ? `<p class="${r.status === "failed" ? "bad" : "warn"}">${esc(r.reason)}</p>` : ""}
${r.input ? `<div class="muted">入力</div><pre>${esc(r.input)}</pre>` : ""}
${r.toolCalls.map((t) => `<div class="muted">tool: ${esc(t.name)}</div><pre>${esc(JSON.stringify(t.args))}\n→ ${esc(JSON.stringify(t.result, null, 1).slice(0, 1500))}</pre>`).join("")}
${r.output ? `<div class="muted">出力</div><pre>${esc(r.output)}</pre>` : ""}
<div class="muted">${esc(r.model ?? "")}${r.usage ? ` · tokens ${r.usage.totalTokens}` : ""}${ms ? ` · ${(ms / 1000).toFixed(1)}秒` : ""} · run ${esc(r.id.slice(0, 8))}</div>
</details>`;
    })
    .join("");
}

function approvalList(ws: Workspace, approvals: Approval[], tz: string): string {
  if (approvals.length === 0) return `<p class="muted">承認待ちはない。agent が予定の追加を提案するとここに入る。</p>`;
  return approvals
    .map((a) => {
      const op = a.operation;
      const actions =
        a.status === "pending"
          ? `<form class="inline" method="post" action="/w/${esc(ws.id)}/approvals/${esc(a.id)}/approve"><button class="primary">承認して追加</button></form>
<form class="inline" method="post" action="/w/${esc(ws.id)}/approvals/${esc(a.id)}/reject"><button>却下</button></form>`
          : `<span class="chip">${{ approved: "承認済み", rejected: "却下", failed: "失敗", pending: "" }[a.status]}</span>${a.error ? ` <span class="bad">${esc(a.error)}</span>` : ""}`;
      return `<div class="approval"><div><b>記録用カレンダーに予定を追加</b> <span class="muted">· ${esc(when(a.createdAt, tz))}</span></div>
<div>${esc(op.summary)} <span class="muted">(${esc(timeLabel(op.start, tz))})</span></div>${op.notes ? `<pre>${esc(op.notes)}</pre>` : ""}<div>${actions}</div></div>`;
    })
    .join("");
}

function demoEvents(ws: Workspace, events: { role: "automation" | "records"; e: CalendarEvent }[], tz: string): string {
  if (events.length === 0) return `<p class="muted">デモで足した予定はない。</p>`;
  return `<table>${events
    .map(
      ({ role, e }) => `<tr><td>${role === "automation" ? "起動用" : "記録用"}</td><td>${esc(e.summary)}<div class="muted">${e.start ? esc(timeLabel(e.start, tz)) : ""}${e.recurrence ? " · 繰り返し" : ""} · ${esc(when(e.tags[DEMO_EXPIRES_TAG], tz))} に自動で消える</div></td><td><form class="inline" method="post" action="/w/${esc(ws.id)}/demo/events/${role}/${esc(e.id)}/delete"><button>消す</button></form></td></tr>`,
    )
    .join("")}</table>`;
}

function forms(ws: Workspace, today: string): string {
  return `<div class="forms">
<form method="post" action="/w/${esc(ws.id)}/demo/automation">
<b>定期の仕事を置く（起動用カレンダー）</b>
<label>タイトル<input name="title" maxlength="${TITLE_MAX}" required value="今週の締切の確認"></label>
<label>開始<select name="startsIn"><option value="1">1分後</option><option value="3" selected>3分後</option><option value="5">5分後</option><option value="10">10分後</option><option value="30">30分後</option></select></label>
<label>繰り返し<select name="repeat"><option value="none">なし</option><option value="daily3">毎日3回</option><option value="weekly3">毎週3回</option></select></label>
<label>agent への指示（payload の prompt、${DEMO_PROMPT_MAX}文字まで）<textarea name="prompt" maxlength="${DEMO_PROMPT_MAX}" required>記録用カレンダーの締切を確認して、今週やることを3つに絞って。足りない準備の予定があれば提案して。</textarea></label>
<p><button class="primary">起動用カレンダーに書く</button></p>
</form>
<form method="post" action="/w/${esc(ws.id)}/demo/deadline">
<b>締切を書く（記録用カレンダー）</b>
<label>タイトル<input name="title" maxlength="${TITLE_MAX}" required value="パスポート更新の期限"></label>
<label>期日<input type="date" name="date" min="${today}" required></label>
<label>準備: N日前<input type="number" name="prepDays" min="0" max="365" value="30" required></label>
<label>notes（${DEMO_NOTES_MAX}文字まで。agent には信頼しないデータとして渡る）<textarea name="notes" maxlength="${DEMO_NOTES_MAX}">申請書・写真・旧パスポートが要る。</textarea></label>
<p><button class="primary">記録用カレンダーに書く</button></p>
</form></div>
<p class="muted">期日まで N 日を切っていれば「遅れて登録」として1分以内に準備が始まる。誰でも書けるので、IP ごとと全体の1時間あたりの回数に上限がある。足した予定は一定時間後に自動で消える。</p>`;
}

export function renderWorkspace(input: {
  ws: Workspace;
  schedule?: Schedule;
  runs: Run[];
  approvals: Approval[];
  demoEvents: { role: "automation" | "records"; e: CalendarEvent }[];
  flash?: string;
  today: string;
  workspaces: Workspace[];
}): string {
  const { ws } = input;
  const tz = ws.timeZone;
  const pending = input.approvals.filter((a) => a.status === "pending");
  const decided = input.approvals.filter((a) => a.status !== "pending").slice(0, 5);
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>agent-calendar</title><style>${STYLE}</style></head><body><main>
<header><h1>agent-calendar <span class="muted" style="font-size:15px">· ${esc(ws.label)}</span></h1>
<p>予定と締切を Google Calendar に書いておくと、agent（Gemini）がそれに合わせて準備と定期の仕事を自分で始める。副作用のある操作は承認待ちに入る。</p></header>
${input.flash ? `<div class="flash">${esc(input.flash)}</div>` : ""}
<div class="how"><div><b>起動用カレンダー</b>繰り返し予定の notes 先頭に payload（prompt）を書く。作成者が allowlist にある予定だけが開始時刻に発火する。</div>
<div><b>記録用カレンダー</b>締切の notes に「準備: N日前」と書くと、期日の N 日前に準備が始まる。notes は信頼しないデータとして渡す。</div>
<div><b>承認待ち</b>agent はカレンダーに直接書けない。予定の追加は提案になり、人が承認したときだけ書かれる。</div></div>
<div class="grid">
<section><h2>次の発火予定 <small>Cloud Scheduler が1分ごとに差分を取る（LLM は呼ばない）</small></h2>${scheduleRows(input.schedule?.items ?? [], tz)}</section>
<section><h2>承認待ち <small>${pending.length}件</small></h2>${approvalList(ws, pending, tz)}${decided.length ? `<h2 style="margin-top:16px">決定済み</h2>${approvalList(ws, decided, tz)}` : ""}</section>
</div>
<section style="margin-top:16px"><h2>実行記録 <small>入力・tool 呼び出し・出力</small> <a href="" style="margin-left:auto;font-size:13px">更新</a></h2>${runList(input.runs, tz)}</section>
<section style="margin-top:16px"><h2>試す <small>runner の service account がデモカレンダーに書く</small></h2>${forms(ws, input.today)}<h2 style="margin-top:12px">デモで足した予定</h2>${demoEvents(ws, input.demoEvents, tz)}</section>
<p class="muted" style="margin-top:24px">Cloud Run + Cloud Scheduler + Firestore + Vertex AI (Gemini) · <a href="https://github.com/wwwyo/agent-calendar">GitHub</a></p>
</main></body></html>`;
}
