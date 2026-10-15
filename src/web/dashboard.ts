import { readFileSync } from "node:fs";
import type { Workspace } from "../config";
import { DEMO_NOTES_MAX, DEMO_PROMPT_MAX, TITLE_MAX } from "./demo";

export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// design.css は design.md の css block の写し。design.md を正本にして再生成する
const DESIGN = readFileSync(new URL("./design.css", import.meta.url), "utf8");

const FONTS = "https://fonts.googleapis.com/css2?family=Inter+Tight:wght@400;500&family=Geist+Mono:wght@400;500&display=swap";

const PAGE = `
*{box-sizing:border-box}
body{font-family:var(--font-sans);font-size:var(--text-base);line-height:var(--line-height-body);letter-spacing:var(--letter-spacing-body);line-break:strict;overflow-wrap:break-word}
a{color:var(--primary-deep)}
main{max-width:calc(var(--max-width) + 16px);margin:0 auto;padding:var(--space-2) var(--space-2) var(--space-8)}
.slab h1{margin:0;font-size:var(--text-2xl)}
.slab .back{font-size:var(--text-sm)}
.slab a{color:var(--primary-foreground)}
.content{max-width:var(--max-width);margin:0 auto}
.content > *{margin-top:var(--space-7)}
.content > .flash{margin-top:var(--space-5)}
.flash{padding:var(--space-3) var(--space-4);border:1px solid var(--border-strong);border-radius:var(--radius);background:var(--secondary)}
.cols-2{grid-template-columns:1fr}
@media(min-width:900px){.cols-2{grid-template-columns:1fr 1fr}}
.frame h2{margin:0 0 var(--space-4);font-size:var(--text-lg);display:flex;flex-wrap:wrap;gap:var(--space-2);align-items:baseline}
.frame h3{margin:0 0 var(--space-2);font-size:var(--text-md)}
.label{display:block;font-size:var(--text-xs);color:var(--muted-foreground);margin:var(--space-5) 0 var(--space-1)}
.live{font-size:var(--text-xs);color:var(--muted-foreground);font-weight:400;margin-left:auto}
.live::before{content:"";display:inline-block;width:8px;height:8px;border-radius:var(--radius-pill);background:var(--success);margin-right:var(--space-2)}
.next{margin:0 0 var(--space-4);font-size:var(--text-sm);color:var(--muted-foreground)}
.session{display:grid;grid-template-columns:5.5em 1fr auto;gap:var(--space-3);align-items:baseline;padding:var(--space-3) 0;border-top:1px solid var(--border);color:var(--foreground);text-decoration:none}
.session:first-child{border-top:0;padding-top:0}
.session:hover .title{color:var(--primary-deep)}
.meta{font-family:var(--font-mono);font-size:var(--text-xs);color:var(--muted-foreground)}
.empty{margin:0;color:var(--muted-foreground)}
.actions{display:flex;gap:var(--space-2);margin-top:var(--space-3);flex-wrap:wrap;align-items:center}
form.inline{display:inline}
textarea.input{min-height:88px;resize:vertical}
.step{padding:var(--space-4) 0;border-top:1px solid var(--border)}.step:first-child{border-top:0;padding-top:0}
.step h3{display:flex;gap:var(--space-2);align-items:baseline}
.approval{padding:var(--space-3) 0;border-top:1px solid var(--border)}.approval:first-of-type{border-top:0}
.demo-row{display:flex;flex-wrap:wrap;gap:var(--space-2);align-items:center;font-size:var(--text-sm);padding:var(--space-2) 0;border-top:1px solid var(--border)}
@media(max-width:620px){.frame > *{padding:var(--space-5)}.slab{padding:var(--space-6) var(--space-5)}.slab h1{font-size:var(--text-xl)}.session{grid-template-columns:1fr}}
`;

const CLIENT = `
const esc=(s)=>String(s??"").replace(/[&<>"']/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
const when=(iso)=>iso?new Date(iso).toLocaleString("ja-JP",{timeZone:TZ,month:"numeric",day:"numeric",weekday:"short",hour:"2-digit",minute:"2-digit",second:"2-digit"}):"";
// Cloud Run の timeout（5分）を過ぎても running なら、実行中に process が落ちた
const STALE=10*60*1000;
const running=(r)=>r.status==="running"&&Date.now()-Date.parse(r.startedAt)<STALE;
const status=(r)=>r.status==="succeeded"?'<span class="status-ok">成功</span>':r.status==="failed"?'<span class="status-bad">失敗</span>':r.status==="skipped"?'<span class="status-warn">実行せず</span>':running(r)?'<span class="status-warn">実行中</span>':'<span class="status-bad">中断</span>';
const kind=(r)=>r.kind==="automation"?"定期の仕事":"準備";
const secs=(r)=>r.finishedAt?((Date.parse(r.finishedAt)-Date.parse(r.startedAt))/1000).toFixed(1)+"s":"";
// タブが見えている間だけ読みに行く。fn が false を返したら止める
function poll(fn,ms){let t,stop=false;const tick=async()=>{if(stop)return;if(!document.hidden){try{if(await fn()===false){stop=true;return}}catch(e){}}t=setTimeout(tick,ms)};tick();document.addEventListener("visibilitychange",()=>{if(!document.hidden&&!stop){clearTimeout(t);tick()}})}
`;

function shell(ws: Workspace, title: string, slab: string, content: string, script: string): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="${FONTS}">
<style>${DESIGN}${PAGE}</style></head><body><div class="page-guides"></div><main>
<header class="slab">${slab}</header>
<div class="content">${content}</div></main>
<script>const WS=${JSON.stringify(ws.id)};const TZ=${JSON.stringify(ws.timeZone)};${CLIENT}${script}</script></body></html>`;
}

function forms(ws: Workspace, today: string): string {
  return `<form method="post" action="/w/${esc(ws.id)}/demo/automation">
<h3 class="text-heading">定期の仕事</h3>
<label class="label" for="a-title">タイトル</label><input class="input" id="a-title" name="title" maxlength="${TITLE_MAX}" required value="今週の締切の確認">
<label class="label" for="a-starts">開始</label><select class="input" id="a-starts" name="startsIn"><option value="1" selected>1分後</option><option value="3">3分後</option><option value="5">5分後</option><option value="10">10分後</option><option value="30">30分後</option></select>
<label class="label" for="a-repeat">繰り返し</label><select class="input" id="a-repeat" name="repeat"><option value="none">なし</option><option value="daily3">毎日3回</option><option value="weekly3">毎週3回</option></select>
<label class="label" for="a-prompt">prompt</label><textarea class="input" id="a-prompt" name="prompt" maxlength="${DEMO_PROMPT_MAX}" required>記録用カレンダーの締切を確認して、今週やることを3つに絞って。足りない準備の予定があれば提案して。</textarea>
<div class="actions"><button class="btn btn-primary">追加</button></div>
</form>
<form method="post" action="/w/${esc(ws.id)}/demo/deadline">
<h3 class="text-heading">締切</h3>
<label class="label" for="d-title">タイトル</label><input class="input" id="d-title" name="title" maxlength="${TITLE_MAX}" required value="パスポート更新の期限">
<label class="label" for="d-date">期日</label><input class="input" id="d-date" type="date" name="date" min="${today}" required>
<label class="label" for="d-prep">準備: N日前</label><input class="input" id="d-prep" type="number" name="prepDays" min="0" max="365" value="30" required>
<label class="label" for="d-notes">notes</label><textarea class="input" id="d-notes" name="notes" maxlength="${DEMO_NOTES_MAX}">申請書・写真・旧パスポートが要る。</textarea>
<div class="actions"><button class="btn btn-primary">追加</button></div>
</form>`;
}

// セッション（agent の1回の実行）の一覧。数秒ごとに読み直す
export function renderSessionsPage(ws: Workspace, today: string, flash?: string): string {
  const slab = `<h1 class="text-heading">agent-calendar</h1>`;
  const content = `${flash ? `<div class="flash">${esc(flash)}</div>` : ""}
<div class="frame tick"><section><h2 class="text-heading">セッション<span class="live">live</span></h2>
<p class="next" id="next"></p><div id="list"><p class="empty">読み込み中。</p></div></section></div>
<div class="frame tick"><section><h2 class="text-heading">予定を追加</h2>
<div class="cols-2" style="display:grid;gap:var(--space-6)">${forms(ws, today)}</div>
<div id="demo" style="margin-top:var(--space-4)"></div></section></div>`;
  const script = `
poll(async()=>{
  const r=await fetch("/w/"+WS+"/api/sessions");if(!r.ok)return;const d=await r.json();
  document.getElementById("next").innerHTML=d.next.length?"次の発火: "+d.next.map((n)=>'<span class="mono">'+esc(when(n.fireAt))+'</span> '+esc(n.title)+(n.blocked?' <span class="status-bad">発火しない（'+esc(n.blocked)+'）</span>':"")).join(" · "):"";
  document.getElementById("demo").innerHTML=d.demoEvents.length?'<h3 class="text-heading">追加した予定</h3>'+d.demoEvents.map((e)=>'<div class="demo-row"><span class="chip">'+(e.role==="automation"?"起動用":"記録用")+'</span>'+esc(e.title)+'<span class="text-muted">'+esc(when(e.expiresAt))+' まで</span><form class="inline" method="post" action="/w/'+WS+'/demo/events/'+e.role+'/'+encodeURIComponent(e.id)+'/delete"><button class="btn btn-outline">消す</button></form></div>').join(""):"";
  document.getElementById("list").innerHTML=d.sessions.length?d.sessions.map((s)=>'<a class="session" href="/w/'+WS+'/sessions/'+encodeURIComponent(s.id)+'"><span>'+status(s)+'</span><span><span class="title">'+esc(s.title)+'</span><div class="meta"><span class="chip">'+kind(s)+'</span> '+esc(when(s.startedAt))+(s.late?" · 遅れて登録":"")+(s.toolCalls?" · tool "+s.toolCalls:"")+(s.pendingApprovals?' · <span class="status-warn">承認待ち '+s.pendingApprovals+'</span>':"")+'</div></span><span class="meta">'+esc(secs(s))+'</span></a>').join(""):'<p class="empty">セッションはまだない。予定を追加すると1分ほどでここに出る。</p>';
},3000);`;
  return shell(ws, "agent-calendar", slab, content, script);
}

// セッション詳細。実行中のあいだだけ実行ログを読み直す（承認・却下はページ遷移で反映する）
export function renderSessionPage(ws: Workspace, id: string, flash?: string): string {
  const slab = `<a class="back" href="/w/${esc(ws.id)}">← セッション一覧</a><h1 class="text-heading" id="title">読み込み中</h1>`;
  const content = `${flash ? `<div class="flash">${esc(flash)}</div>` : ""}
<div class="frame tick"><section><h2 class="text-heading"><span id="st"></span> <span class="meta" id="kind"></span></h2><div class="meta" id="meta"></div></section></div>
<div class="frame tick"><section><h2 class="text-heading">実行ログ</h2><div id="log"></div></section></div>
<div class="frame tick" id="approvals-frame" hidden><section><h2 class="text-heading">提案</h2><div id="approvals"></div></section></div>`;
  const script = `
const ID=${JSON.stringify(id)};
const block=(s)=>'<pre class="code">'+esc(s)+'</pre>';
poll(async()=>{
  const r=await fetch("/w/"+WS+"/api/sessions/"+encodeURIComponent(ID));
  if(r.status===404){document.getElementById("title").textContent="セッションが見つからない";return false}
  const {session:s,approvals}=await r.json();
  document.getElementById("title").textContent=s.title;
  document.getElementById("st").innerHTML=status(s);
  document.getElementById("kind").textContent=kind(s)+(s.late?" · 遅れて登録":"");
  document.getElementById("meta").textContent=[when(s.startedAt),s.model,s.usage?"tokens "+s.usage.totalTokens:"",secs(s),"run "+s.id.slice(0,8)].filter(Boolean).join(" · ");
  const steps=[];
  if(s.input)steps.push('<div class="step"><h3 class="text-heading">入力</h3>'+block(s.input)+'</div>');
  for(const t of s.toolCalls)steps.push('<div class="step"><h3 class="text-heading">tool <span class="mono">'+esc(t.name)+'</span></h3>'+block(JSON.stringify(t.args,null,1))+block("→ "+JSON.stringify(t.result,null,1))+'</div>');
  if(s.reason)steps.push('<div class="step"><h3 class="text-heading '+(s.status==="failed"?"status-bad":"status-warn")+'">'+(s.status==="failed"?"失敗":"実行しなかった理由")+'</h3><p>'+esc(s.reason)+'</p></div>');
  if(s.output)steps.push('<div class="step"><h3 class="text-heading">出力</h3>'+block(s.output)+'</div>');
  if(running(s))steps.push('<div class="step"><h3 class="text-heading status-warn">実行中</h3></div>');
  document.getElementById("log").innerHTML=steps.join("");
  document.getElementById("approvals-frame").hidden=!approvals.length;
  document.getElementById("approvals").innerHTML=approvals.map((a)=>'<div class="approval"><b>'+esc(a.operation.summary)+'</b> <span class="mono">'+esc(a.operation.start.date||when(a.operation.start.dateTime))+'</span>'+(a.operation.notes?'<p class="text-muted">'+esc(a.operation.notes)+'</p>':"")+'<div class="actions">'+(a.status==="pending"?'<form class="inline" method="post" action="/w/'+WS+'/approvals/'+encodeURIComponent(a.id)+'/approve"><button class="btn btn-primary">承認して追加</button></form><form class="inline" method="post" action="/w/'+WS+'/approvals/'+encodeURIComponent(a.id)+'/reject"><button class="btn btn-outline">却下</button></form>':'<span class="chip">'+({approved:"承認済み",rejected:"却下",failed:"失敗"})[a.status]+'</span>')+'</div></div>').join("");
  return running(s)?undefined:false;
},2000);`;
  return shell(ws, "agent-calendar · session", slab, content, script);
}
