import { readFileSync } from "node:fs";
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

// design.css は design.md の css block の写し。design.md を正本にして再生成する
const DESIGN = readFileSync(new URL("./design.css", import.meta.url), "utf8");

const FONTS = "https://fonts.googleapis.com/css2?family=Inter+Tight:wght@400;500&family=Geist+Mono:wght@400;500&display=swap";

const PAGE = `
*{box-sizing:border-box}
body{font-family:var(--font-sans);font-size:var(--text-base);line-height:var(--line-height-body);letter-spacing:var(--letter-spacing-body);line-break:strict;overflow-wrap:break-word}
a{color:var(--primary-deep)}
main{max-width:calc(var(--max-width) + 16px);margin:0 auto;padding:var(--space-2) var(--space-2) var(--space-8)}
.slab h1{margin:0;font-size:var(--text-2xl)}
.slab p{margin:0;max-width:40em;font-size:var(--text-lg);line-height:1.5}
.slab .ws{font-family:var(--font-mono);font-size:var(--text-sm);opacity:.75}
.content{max-width:var(--max-width);margin:0 auto}
.content > *{margin-top:var(--space-7)}
.content > .flash{margin-top:var(--space-5)}
.flash{padding:var(--space-3) var(--space-4);border:1px solid var(--border-strong);border-radius:var(--radius);background:var(--secondary)}
.cols-3,.cols-2{grid-template-columns:1fr}
@media(min-width:900px){.cols-3{grid-template-columns:repeat(3,1fr)}.cols-2{grid-template-columns:1.2fr 1fr}.cols-2.even{grid-template-columns:1fr 1fr}}
.frame h2{margin:0 0 var(--space-4);font-size:var(--text-lg);display:flex;flex-wrap:wrap;gap:var(--space-2);align-items:baseline}
.frame h2 small{color:var(--muted-foreground);font-weight:400;font-size:var(--text-xs);letter-spacing:var(--letter-spacing-body)}
.frame h2 a{margin-left:auto;font-size:var(--text-sm);font-weight:400}
.frame h3{margin:0 0 var(--space-2);font-size:var(--text-md)}
.how h3{margin-bottom:var(--space-1)}.how p{margin:0;font-size:var(--text-sm);color:var(--muted-foreground)}
.label{display:block;font-size:var(--text-xs);color:var(--muted-foreground);margin:var(--space-5) 0 var(--space-1)}
.row{border-top:1px solid var(--border);padding:var(--space-3) 0}.row:first-of-type{border-top:0;padding-top:0}
summary{cursor:pointer;list-style:none;display:flex;flex-wrap:wrap;gap:var(--space-2);align-items:baseline}summary::-webkit-details-marker{display:none}
summary::before{content:"+";font-family:var(--font-mono);color:var(--muted-foreground);width:1ch}details[open]>summary::before{content:"\\2212"}
details .body{padding:var(--space-2) 0 0 calc(1ch + var(--space-2))}
.meta{font-family:var(--font-mono);font-size:var(--text-xs);color:var(--faint)}
.actions{display:flex;gap:var(--space-2);margin-top:var(--space-3);flex-wrap:wrap}
form.inline{display:inline}
.nowrap{white-space:nowrap}
textarea.input{min-height:88px;resize:vertical}
.foot{display:flex;flex-wrap:wrap;gap:var(--space-4);align-items:center;font-family:var(--font-mono);font-size:var(--text-xs);color:var(--muted-foreground)}
.foot .dot{width:8px;height:8px;border-radius:var(--radius-pill);background:var(--success);display:inline-block;margin-right:var(--space-2)}
@media(max-width:620px){.frame > *{padding:var(--space-5)}.slab{padding:var(--space-6) var(--space-5)}.slab h1{font-size:var(--text-xl)}}
`;

function scheduleRows(items: FireItem[], tz: string): string {
  if (items.length === 0) return `<p class="text-muted">発火予定はまだない。下のフォームから予定を足すと、1分以内にここに出る。</p>`;
  return `<table class="table"><tr><th>発火</th><th>種類</th><th>予定</th><th>状態</th></tr>${items
    .slice(0, 15)
    .map(
      (i) => `<tr><td class="mono nowrap">${esc(when(i.fireAt, tz))}</td><td><span class="chip">${i.kind === "automation" ? "定期の仕事" : `準備 ${i.prepDays}日前`}</span></td><td>${esc(i.title)}${
        i.kind === "prep" ? `<div class="text-muted">締切 ${esc(when(i.occurrenceStart, tz))}</div>` : ""
      }</td><td>${i.blocked ? `<span class="status-bad">発火しない</span><div class="text-muted">${esc(i.blocked)}</div>` : i.late ? `<span class="status-warn">遅れて登録</span>` : `<span class="status-ok">待機</span>`}</td></tr>`,
    )
    .join("")}</table>`;
}

function runStatus(r: Run): string {
  if (r.status === "succeeded") return `<span class="status-ok">成功</span>`;
  if (r.status === "failed") return `<span class="status-bad">失敗</span>`;
  if (r.status === "running") {
    // Cloud Run の timeout（5分）を過ぎても running なら、実行中に process が落ちた
    return Date.now() - Date.parse(r.startedAt) > 10 * 60 * 1000 ? `<span class="status-bad">中断</span>` : `<span class="status-warn">実行中</span>`;
  }
  return `<span class="status-warn">実行せず</span>`;
}

function runList(runs: Run[], tz: string): string {
  if (runs.length === 0) return `<p class="text-muted">まだ実行していない。</p>`;
  return runs
    .map((r) => {
      const ms = r.finishedAt ? Date.parse(r.finishedAt) - Date.parse(r.startedAt) : 0;
      return `<details class="row"><summary>${runStatus(r)} <span class="chip">${r.kind === "automation" ? "定期" : "準備"}</span> ${esc(r.title)} <span class="text-muted">· ${esc(when(r.startedAt, tz))}${r.late ? " · 遅れて登録" : ""}${
        r.toolCalls.length ? ` · tool ${r.toolCalls.length}回` : ""
      }</span></summary><div class="body">
${r.reason ? `<p class="${r.status === "failed" ? "status-bad" : "status-warn"}">${esc(r.reason)}</p>` : ""}
${r.input ? `<span class="label">入力</span><pre class="code">${esc(r.input)}</pre>` : ""}
${r.toolCalls.map((t) => `<span class="label">tool: <span class="mono">${esc(t.name)}</span></span><pre class="code">${esc(JSON.stringify(t.args))}\n→ ${esc(JSON.stringify(t.result, null, 1).slice(0, 1500))}</pre>`).join("")}
${r.output ? `<span class="label">出力</span><pre class="code">${esc(r.output)}</pre>` : ""}
<div class="meta">${esc(r.model ?? "")}${r.usage ? ` · tokens ${r.usage.totalTokens}` : ""}${ms ? ` · ${(ms / 1000).toFixed(1)}s` : ""} · run ${esc(r.id.slice(0, 8))}</div>
</div></details>`;
    })
    .join("");
}

function approvalList(ws: Workspace, approvals: Approval[], tz: string): string {
  if (approvals.length === 0) return `<p class="text-muted">承認待ちはない。agent が予定の追加を提案するとここに入る。</p>`;
  return approvals
    .map((a) => {
      const op = a.operation;
      const actions =
        a.status === "pending"
          ? `<div class="actions"><form class="inline" method="post" action="/w/${esc(ws.id)}/approvals/${esc(a.id)}/approve"><button class="btn btn-primary">承認して追加</button></form>
<form class="inline" method="post" action="/w/${esc(ws.id)}/approvals/${esc(a.id)}/reject"><button class="btn btn-outline">却下</button></form></div>`
          : `<div><span class="chip">${{ approved: "承認済み", rejected: "却下", failed: "失敗", pending: "" }[a.status]}</span>${a.error ? ` <span class="status-bad">${esc(a.error)}</span>` : ""}</div>`;
      return `<div class="row"><div><b>記録用カレンダーに予定を追加</b> <span class="text-muted">· ${esc(when(a.createdAt, tz))}</span></div>
<div>${esc(op.summary)} <span class="text-muted">(${esc(timeLabel(op.start, tz))})</span></div>${op.notes ? `<pre class="code">${esc(op.notes)}</pre>` : ""}${actions}</div>`;
    })
    .join("");
}

function demoEvents(ws: Workspace, events: { role: "automation" | "records"; e: CalendarEvent }[], tz: string): string {
  if (events.length === 0) return `<p class="text-muted">デモで足した予定はない。</p>`;
  return `<table class="table">${events
    .map(
      ({ role, e }) => `<tr><td><span class="chip">${role === "automation" ? "起動用" : "記録用"}</span></td><td>${esc(e.summary)}<div class="text-muted">${e.start ? esc(timeLabel(e.start, tz)) : ""}${e.recurrence ? " · 繰り返し" : ""} · ${esc(when(e.tags[DEMO_EXPIRES_TAG], tz))} に自動で消える</div></td><td><form class="inline" method="post" action="/w/${esc(ws.id)}/demo/events/${role}/${esc(e.id)}/delete"><button class="btn btn-outline">消す</button></form></td></tr>`,
    )
    .join("")}</table>`;
}

function forms(ws: Workspace, today: string): string {
  return `<form method="post" action="/w/${esc(ws.id)}/demo/automation">
<h3 class="text-heading">定期の仕事を置く <small class="text-muted">起動用カレンダー</small></h3>
<label class="label" for="a-title">タイトル</label><input class="input" id="a-title" name="title" maxlength="${TITLE_MAX}" required value="今週の締切の確認">
<label class="label" for="a-starts">開始</label><select class="input" id="a-starts" name="startsIn"><option value="1">1分後</option><option value="3" selected>3分後</option><option value="5">5分後</option><option value="10">10分後</option><option value="30">30分後</option></select>
<label class="label" for="a-repeat">繰り返し</label><select class="input" id="a-repeat" name="repeat"><option value="none">なし</option><option value="daily3">毎日3回</option><option value="weekly3">毎週3回</option></select>
<label class="label" for="a-prompt">agent への指示（payload の prompt、${DEMO_PROMPT_MAX}文字まで）</label><textarea class="input" id="a-prompt" name="prompt" maxlength="${DEMO_PROMPT_MAX}" required>記録用カレンダーの締切を確認して、今週やることを3つに絞って。足りない準備の予定があれば提案して。</textarea>
<div class="actions"><button class="btn btn-primary">起動用カレンダーに書く</button></div>
</form>
<form method="post" action="/w/${esc(ws.id)}/demo/deadline">
<h3 class="text-heading">締切を書く <small class="text-muted">記録用カレンダー</small></h3>
<label class="label" for="d-title">タイトル</label><input class="input" id="d-title" name="title" maxlength="${TITLE_MAX}" required value="パスポート更新の期限">
<label class="label" for="d-date">期日</label><input class="input" id="d-date" type="date" name="date" min="${today}" required>
<label class="label" for="d-prep">準備: N日前</label><input class="input" id="d-prep" type="number" name="prepDays" min="0" max="365" value="30" required>
<label class="label" for="d-notes">notes（${DEMO_NOTES_MAX}文字まで。agent には信頼しないデータとして渡る）</label><textarea class="input" id="d-notes" name="notes" maxlength="${DEMO_NOTES_MAX}">申請書・写真・旧パスポートが要る。</textarea>
<div class="actions"><button class="btn btn-primary">記録用カレンダーに書く</button></div>
</form>`;
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
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>agent-calendar</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="${FONTS}">
<style>${DESIGN}${PAGE}</style></head><body><div class="page-guides"></div><main>
<header class="slab"><span class="ws">workspace / ${esc(ws.label)}</span><h1 class="text-heading">agent-calendar</h1>
<p>予定と締切を Google Calendar に書いておくと、agent（Gemini）がそれに合わせて準備と定期の仕事を自分で始める。副作用のある操作は承認待ちに入る。</p></header>
<div class="content">
${input.flash ? `<div class="flash">${esc(input.flash)}</div>` : ""}
<div class="frame tick cols-3 how"><div><h3 class="text-heading">起動用カレンダー</h3><p>繰り返し予定の notes 先頭に payload（prompt）を書く。作成者が allowlist にある予定だけが開始時刻に発火する。</p></div>
<div><h3 class="text-heading">記録用カレンダー</h3><p>締切の notes に「準備: N日前」と書くと、期日の N 日前に準備が始まる。notes は信頼しないデータとして渡す。</p></div>
<div><h3 class="text-heading">承認待ち</h3><p>agent はカレンダーに直接書けない。予定の追加は提案になり、人が承認したときだけ書かれる。</p></div></div>
<div class="frame tick cols-2">
<section><h2 class="text-heading">次の発火予定 <small>Cloud Scheduler が1分ごとに差分を取る（LLM は呼ばない）</small></h2>${scheduleRows(input.schedule?.items ?? [], tz)}</section>
<section><h2 class="text-heading">承認待ち <small>${pending.length}件</small></h2>${approvalList(ws, pending.slice(0, 4), tz)}${pending.length > 4 ? `<p class="text-muted">ほか ${pending.length - 4} 件</p>` : ""}${decided.length ? `<h2 class="text-heading" style="margin-top:var(--space-6)">決定済み</h2>${approvalList(ws, decided.slice(0, 3), tz)}` : ""}</section>
</div>
<div class="frame tick"><section><h2 class="text-heading">実行記録 <small>入力・tool 呼び出し・出力</small> <a href="">更新</a></h2>${runList(input.runs, tz)}</section></div>
<div class="frame tick"><section><h2 class="text-heading">試す <small>runner の service account がデモカレンダーに書く</small></h2>
<p class="text-muted">期日まで N 日を切っていれば「遅れて登録」として1分以内に準備が始まる。誰でも書けるので、IP ごとと全体の1時間あたりの回数に上限がある。足した予定は一定時間後に自動で消える。</p></section>
<div class="frame cols-2 even" style="border:0;padding:0">${forms(ws, input.today)}</div>
<section><h2 class="text-heading">デモで足した予定</h2>${demoEvents(ws, input.demoEvents, tz)}</section></div>
<div class="dashed-rule"></div>
<p class="foot"><span><span class="dot"></span>Cloud Run + Cloud Scheduler + Firestore + Vertex AI (Gemini)</span><a href="https://github.com/wwwyo/agent-calendar">GitHub</a></p>
</div>
</main></body></html>`;
}
