import { readFileSync } from "node:fs";
import type { Workspace } from "../config";
import { scriptJson } from "../http";
import { DEMO_NOTES_MAX, DEMO_PROMPT_MAX, TITLE_MAX } from "./demo";

export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// design.css は design.md の css block の写し。design.md を正本にして再生成する
const DESIGN = readFileSync(new URL("./design.css", import.meta.url), "utf8");

const FONTS = "https://fonts.googleapis.com/css2?family=Inter+Tight:wght@400;500&family=Geist+Mono:wght@400;500&display=swap";

const HOUR_PX = 40;

const PAGE = `
*{box-sizing:border-box}
[hidden]{display:none!important}
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
.kv{display:grid;grid-template-columns:auto 1fr;gap:var(--space-1) var(--space-4);margin:0 0 var(--space-3)}
.kv dt{font-size:var(--text-sm);color:var(--muted-foreground)}
.kv dd{margin:0}
.approval{padding:var(--space-3) 0;border-top:1px solid var(--border)}.approval:first-of-type{border-top:0}
.cal-bar{display:flex;flex-wrap:wrap;gap:var(--space-2);align-items:center;margin-bottom:var(--space-4)}
.cal-bar h2{margin:0 var(--space-2) 0 0}
.cal-bar #add-open{margin-left:auto}
.cal-bar .nav{height:32px;padding:0 var(--space-3)}
.legend{display:flex;gap:var(--space-3);font-size:var(--text-xs);color:var(--muted-foreground)}
.legend span{padding-left:var(--space-2)}
.cal{overflow-x:auto}
.cal-inner{min-width:720px}
.cal-row{display:grid;grid-template-columns:3.5em repeat(7,minmax(0,1fr))}
.cal-head span{padding:var(--space-2);font-size:var(--text-sm);color:var(--muted-foreground)}
.cal-head .is-today{color:var(--primary-deep);font-weight:500}
.cal-allday{border-top:1px solid var(--border);border-bottom:1px solid var(--border)}
.cal-label{font-size:var(--text-xs);color:var(--muted-foreground);padding:var(--space-2) 0}
.cal-cell{min-height:36px;padding:2px;border-left:1px solid var(--border);display:flex;flex-direction:column;gap:2px;cursor:pointer}
.cal-body{height:560px;overflow-y:auto}
.cal-sticky{position:sticky;top:0;z-index:2;background:var(--background)}
.cal-grid{position:relative}
.cal-hours{position:relative}
.cal-hours span{position:absolute;left:0;padding-top:2px;font-family:var(--font-mono);font-size:var(--text-xs);color:var(--muted-foreground)}
.cal-days{grid-column:2 / span 7;display:grid;grid-template-columns:repeat(7,minmax(0,1fr));background:repeating-linear-gradient(var(--border) 0 1px,transparent 1px ${HOUR_PX}px)}
.cal-col{position:relative;border-left:1px solid var(--border);cursor:pointer}
.ev{display:block;width:100%;text-align:left;font:inherit;font-size:var(--text-xs);line-height:1.3;color:var(--foreground);background:var(--secondary);border:1px solid var(--border-strong);border-radius:var(--radius-sm);padding:2px var(--space-1);cursor:pointer;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.ev:hover{border-color:var(--primary-deep)}
.ev.timed{position:absolute;width:auto}
.ev-automation{border-left:3px solid var(--primary)}
.ev-records{border-left:3px solid var(--foreground)}
.ev-prep{border-style:dashed}
.legend .ev-automation,.legend .ev-records{border-top:0;border-right:0;border-bottom:0}
.legend .ev-prep{border:1px dashed var(--border-strong);padding:0 var(--space-2)}
.ev-session{display:flex;gap:var(--space-3);align-items:baseline;padding:var(--space-2) 0;border-top:1px solid var(--border);color:var(--foreground);text-decoration:none}
.ev-session:hover span:last-child{color:var(--primary-deep)}
.now{position:absolute;left:0;right:0;height:0;border-top:2px solid var(--primary);pointer-events:none}
.dialog{width:min(560px,calc(100vw - 32px));max-height:calc(100vh - 32px);padding:var(--space-6);color:var(--foreground);background:var(--background);border:1px solid var(--border-strong);border-radius:var(--radius)}
.dialog::backdrop{background:color-mix(in srgb,var(--background) 70%,transparent)}
.dialog h2{margin:0 0 var(--space-3);font-size:var(--text-lg)}
.dialog h3{margin:var(--space-5) 0 var(--space-2);font-size:var(--text-md)}
.dialog-head{display:flex;flex-wrap:wrap;gap:var(--space-3);align-items:baseline;justify-content:space-between}
.tabs{display:flex;gap:var(--space-1)}
.tab{font:inherit;font-size:var(--text-sm);color:var(--muted-foreground);background:transparent;border:1px solid var(--border);border-radius:var(--radius-pill);padding:var(--space-1) var(--space-3);cursor:pointer}
.tab[aria-selected="true"]{color:var(--foreground);background:var(--secondary);border-color:var(--border-strong)}
@media(max-width:620px){.frame > *{padding:var(--space-5)}.slab{padding:var(--space-6) var(--space-5)}.slab h1{font-size:var(--text-xl)}.session{grid-template-columns:1fr}}
`;

const CLIENT = `
const esc=(s)=>String(s??"").replace(/[&<>"']/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
const when=(iso)=>iso?new Date(iso).toLocaleString("ja-JP",{timeZone:TZ,month:"numeric",day:"numeric",weekday:"short",hour:"2-digit",minute:"2-digit",second:"2-digit"}):"";
// deadlineAt（無ければ開始から10分。Cloud Run の timeout は5分）を過ぎても running なら、実行中に落ちた
const STALE=10*60*1000;
const running=(r)=>r.status==="running"&&Date.now()<(r.deadlineAt?Date.parse(r.deadlineAt):Date.parse(r.startedAt)+STALE);
const status=(r)=>r.status==="succeeded"?'<span class="status-ok">成功</span>':r.status==="failed"?'<span class="status-bad">失敗</span>':r.status==="skipped"?'<span class="status-warn">実行せず</span>':r.status==="queued"?'<span class="status-warn">待機中</span>':running(r)?'<span class="status-warn">実行中</span>':'<span class="status-bad">中断</span>';
const kind=(r)=>r.kind==="automation"?"定期の仕事":"準備";
// 判定の結果（実行先・agent・target・prompt）。カレンダーの予定とセッションで同じ形に出す
const EXEC={cloud:"cloud（使い捨ての sandbox）",local:"local（本人の Mac）"};
const judgment=(d)=>'<dl class="kv"><dt>実行先</dt><dd>'+esc(EXEC[d.executor]??d.executor)+'</dd><dt>agent</dt><dd>'+esc(d.agent)+'</dd>'+(d.target?'<dt>target</dt><dd>'+esc(d.target)+'</dd>':"")+'</dl>'+(d.prompt?'<span class="label">agent に渡す prompt</span><pre class="code">'+esc(d.prompt)+'</pre>':"");
// 実行先と agent（判定で回した回だけ）
const where=(r)=>r.executor?[r.executor,r.agent,r.target].filter(Boolean).join(" · "):"";
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
<script>const WS=${scriptJson(ws.id)};const TZ=${scriptJson(ws.timeZone)};${CLIENT}${script}</script></body></html>`;
}

function addDialog(ws: Workspace): string {
  return `<dialog id="add" class="dialog" aria-labelledby="add-h">
<div class="dialog-head"><h2 class="text-heading" id="add-h">予定を追加</h2><div class="tabs" role="tablist"><button type="button" class="tab" role="tab" data-tab="automation">定期の仕事</button><button type="button" class="tab" role="tab" data-tab="deadline">締切</button></div></div>
<form method="post" data-tab-panel="automation" data-base="/w/${esc(ws.id)}/demo/automation" action="/w/${esc(ws.id)}/demo/automation">
<label class="label" for="a-title">タイトル</label><input class="input" id="a-title" name="title" maxlength="${TITLE_MAX}" required value="AI ニュースのまとめ">
<label class="label" for="a-start">開始</label><input class="input" id="a-start" type="datetime-local" name="start" required>
<label class="label" for="a-repeat">繰り返し</label><select class="input" id="a-repeat" name="repeat"><option value="none">なし</option><option value="daily3">毎日3回</option><option value="weekly3">毎週3回</option></select>
<label class="label" for="a-prompt">notes</label><textarea class="input" id="a-prompt" name="prompt" maxlength="${DEMO_PROMPT_MAX}" required>今週の生成 AI のニュースを3つ調べて、要点を1行ずつまとめて。</textarea>
<div class="actions"><button class="btn btn-primary">起動用カレンダーに追加</button><button type="button" class="btn btn-outline" data-close>閉じる</button></div>
</form>
<form method="post" data-tab-panel="deadline" data-base="/w/${esc(ws.id)}/demo/deadline" action="/w/${esc(ws.id)}/demo/deadline" hidden>
<label class="label" for="d-title">タイトル</label><input class="input" id="d-title" name="title" maxlength="${TITLE_MAX}" required value="パスポート更新の期限">
<label class="label" for="d-date">期日</label><input class="input" id="d-date" type="date" name="date" required>
<label class="label" for="d-prep">準備: N日前</label><input class="input" id="d-prep" type="number" name="prepDays" min="0" max="365" value="30" required>
<label class="label" for="d-notes">notes（信頼しないデータとして渡る）</label><textarea class="input" id="d-notes" name="notes" maxlength="${DEMO_NOTES_MAX}">申請書・写真・旧パスポートが要る。</textarea>
<div class="actions"><button class="btn btn-primary">記録用カレンダーに追加</button><button type="button" class="btn btn-outline" data-close>閉じる</button></div>
</form>
</dialog>
<dialog id="ev" class="dialog" aria-labelledby="ev-h"><div id="ev-body"></div></dialog>`;
}

// カレンダー（起動用・記録用の予定と準備の開始）とセッションの一覧。数秒ごとに読み直す
export function renderSessionsPage(ws: Workspace, flash?: string): string {
  const slab = `<h1 class="text-heading">agent-calendar</h1>`;
  const hours = Array.from({ length: 24 }, (_, h) => `<span style="top:${h * HOUR_PX}px">${h}:00</span>`).join("");
  const content = `${flash ? `<div class="flash">${esc(flash)}</div>` : ""}
<div class="frame tick"><section>
<div class="cal-bar"><h2 class="text-heading" id="cal-title">カレンダー</h2>
<button type="button" class="btn btn-outline nav" id="prev" aria-label="前の週">←</button><button type="button" class="btn btn-outline nav" id="today">今日</button><button type="button" class="btn btn-outline nav" id="next" aria-label="次の週">→</button>
<span class="legend"><span class="ev-automation">起動用</span><span class="ev-records">記録用</span><span class="ev-prep">準備の開始</span></span>
<button type="button" class="btn btn-primary" id="add-open">予定を追加</button></div>
<div class="cal"><div class="cal-inner">
<div class="cal-body" id="cal-body"><div class="cal-sticky"><div class="cal-row cal-head" id="cal-head"></div>
<div class="cal-row cal-allday" id="cal-allday"></div></div><div class="cal-row cal-grid" style="height:${24 * HOUR_PX}px"><div class="cal-hours">${hours}</div><div class="cal-days" id="cal-days"></div></div></div>
</div></div></section></div>
<div class="frame tick"><section><h2 class="text-heading">セッション<span class="live">live</span></h2>
<div id="list"><p class="empty">読み込み中。</p></div></section></div>
${addDialog(ws)}`;
  const script = `
const HOUR=${HOUR_PX};
const fmt=new Intl.DateTimeFormat("en-CA",{timeZone:TZ,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"});
// tz の壁時計での日付と、0時からの分
const wall=(t)=>{const p=Object.fromEntries(fmt.formatToParts(new Date(t)).map((x)=>[x.type,x.value]));return {date:p.year+"-"+p.month+"-"+p.day,min:+p.hour*60+ +p.minute,hm:p.hour+":"+p.minute}};
const addDays=(d,n)=>new Date(Date.parse(d+"T00:00:00Z")+n*864e5).toISOString().slice(0,10);
const monday=(d)=>addDays(d,-((new Date(d+"T00:00:00Z").getUTCDay()+6)%7));
const WD=["日","月","火","水","木","金","土"];
const dayLabel=(d)=>(+d.slice(5,7))+"/"+(+d.slice(8))+"("+WD[new Date(d+"T00:00:00Z").getUTCDay()]+")";
const ROLE={automation:"起動用カレンダー",records:"記録用カレンダー",prep:"準備の開始"};
const today=()=>wall(Date.now()).date;
let week=/^#\\d{4}-\\d{2}-\\d{2}$/.test(location.hash)?monday(location.hash.slice(1)):monday(today());
let items=[];

function skeleton(){
  const days=[0,1,2,3,4,5,6].map((i)=>addDays(week,i));const t=today();
  document.getElementById("cal-title").textContent=dayLabel(days[0])+" – "+dayLabel(days[6]);
  document.getElementById("cal-head").innerHTML='<span></span>'+days.map((d)=>'<span class="'+(d===t?"is-today":"")+'">'+dayLabel(d)+'</span>').join("");
  document.getElementById("cal-allday").innerHTML='<span class="cal-label">終日</span>'+days.map((d)=>'<div class="cal-cell" data-date="'+d+'"></div>').join("");
  document.getElementById("cal-days").innerHTML=days.map((d)=>'<div class="cal-col" data-date="'+d+'"></div>').join("");
}
function block(it,i){
  const s=it.sessions[0];
  return '<button type="button" class="ev ev-'+it.role+'" data-i="'+i+'">'+(it.date?"":'<span class="mono">'+wall(it.start).hm+'</span> ')+esc(it.title)+(it.blocked?' <span class="status-bad">発火しない</span>':it.judging&&!s?' <span class="status-warn">判定待ち</span>':s?" "+status(s):"")+'</button>';
}
function render(){
  const cells=Object.fromEntries([...document.querySelectorAll(".cal-cell,.cal-col")].map((e)=>[e.className.split(" ")[0]+e.dataset.date,{el:e,html:[]}]));
  const timed={};
  items.forEach((it,i)=>{
    if(it.date){const c=cells["cal-cell"+it.date];if(c)c.html.push(block(it,i));return}
    const w=wall(it.start);if(!cells["cal-col"+w.date])return;
    const top=w.min*HOUR/60;(timed[w.date]??=[]).push({i,it,top,bottom:top+Math.max(22,it.minutes*HOUR/60)});
  });
  // 重なる予定は横に並べる（重なりの塊ごとに列を割る）
  for(const [date,list] of Object.entries(timed)){
    let group=[],end=-1;
    const flush=()=>{const n=Math.max(...group.map((g)=>g.lane))+1;for(const g of group)cells["cal-col"+date].html.push(block(g.it,g.i).replace('class="ev ','style="top:'+g.top+'px;height:'+(g.bottom-g.top)+'px;left:calc('+(g.lane*100/n)+'% + 2px);width:calc('+(100/n)+'% - 4px)" class="ev timed '));group=[]};
    for(const g of list){
      if(g.top>=end&&group.length)flush();
      const lanes=group.filter((x)=>x.bottom>g.top).map((x)=>x.lane);let l=0;while(lanes.includes(l))l++;
      g.lane=l;group.push(g);end=Math.max(end,g.bottom);
    }
    if(group.length)flush();
  }
  const n=wall(Date.now());const nowCol=cells["cal-col"+n.date];
  if(nowCol)nowCol.html.push('<span class="now" style="top:'+(n.min*HOUR/60)+'px"></span>');
  for(const c of Object.values(cells))c.el.innerHTML=c.html.join("");
}
async function load(){
  const r=await fetch("/w/"+WS+"/api/calendar?start="+week);if(!r.ok)return;const d=await r.json();
  if(d.start!==week)return;items=d.items;render();
}
function go(w){week=w;history.replaceState(null,"","#"+week);skeleton();items=[];render();load()}
document.getElementById("prev").onclick=()=>go(addDays(week,-7));
document.getElementById("next").onclick=()=>go(addDays(week,7));
document.getElementById("today").onclick=()=>go(monday(today()));

// 追加: 時間の枠は定期の仕事、終日の枠は締切。過ぎた時刻は2分後に寄せる
const addDlg=document.getElementById("add");
function tab(name){for(const b of addDlg.querySelectorAll("[data-tab]"))b.setAttribute("aria-selected",String(b.dataset.tab===name));for(const f of addDlg.querySelectorAll("[data-tab-panel]"))f.hidden=f.dataset.tabPanel!==name}
for(const b of addDlg.querySelectorAll("[data-tab]"))b.onclick=()=>tab(b.dataset.tab);
for(const b of document.querySelectorAll("[data-close]"))b.onclick=()=>b.closest("dialog").close();
function openAdd(kind,date,min){
  const soon=wall(Date.now()+2*60*1000);
  let d=date??soon.date,m=min??soon.min;
  if(d<soon.date||(d===soon.date&&m<soon.min)){d=soon.date;m=soon.min}
  document.getElementById("a-start").value=d+"T"+String(Math.floor(m/60)).padStart(2,"0")+":"+String(m%60).padStart(2,"0");
  document.getElementById("d-date").value=(date&&date>=today())?date:addDays(today(),14);
  document.getElementById("d-date").min=today();
  tab(kind);addDlg.showModal();
}
// 追加した後は、その予定の週を開く（redirect は fragment を引き継ぐ）
for(const f of addDlg.querySelectorAll("form"))f.addEventListener("submit",()=>{const v=f.dataset.tabPanel==="automation"?document.getElementById("a-start").value.slice(0,10):document.getElementById("d-date").value;f.action=f.dataset.base+"#"+monday(v||today())});
document.getElementById("add-open").onclick=()=>openAdd("automation");
document.getElementById("cal-days").addEventListener("click",(e)=>{
  if(e.target.closest(".ev"))return;const col=e.target.closest(".cal-col");if(!col)return;
  const y=e.clientY-col.getBoundingClientRect().top;openAdd("automation",col.dataset.date,Math.max(0,Math.min(1425,Math.floor(y/HOUR*4)*15)));
});
document.getElementById("cal-allday").addEventListener("click",(e)=>{
  if(e.target.closest(".ev"))return;const c=e.target.closest(".cal-cell");if(c)openAdd("deadline",c.dataset.date);
});

// 予定: 中身・発火しない理由・セッション・削除
const evDlg=document.getElementById("ev");
document.querySelector(".cal").addEventListener("click",(e)=>{
  const b=e.target.closest(".ev");if(!b)return;const it=items[+b.dataset.i];if(!it)return;
  const role=it.role==="automation"?"automation":"records";
  const time=it.date?dayLabel(it.date)+" 終日":dayLabel(wall(it.start).date)+" "+wall(it.start).hm;
  document.getElementById("ev-body").innerHTML='<h2 class="text-heading" id="ev-h">'+esc(it.title)+'</h2>'
    +'<p class="meta"><span class="chip">'+ROLE[it.role]+'</span> '+esc(time)+(it.recurring?" · 繰り返し":"")+'</p>'
    +(it.blocked?'<p class="status-bad">発火しない（'+esc(it.blocked)+'）</p>':"")
    +(it.judging?'<h3 class="text-heading">判定</h3><p class="status-warn">判定待ち。1分ほどで実行先・agent・prompt がここに出る。</p>':it.dispatch?'<h3 class="text-heading">判定</h3>'+judgment(it.dispatch):"")
    +(it.sessions.length?'<h3 class="text-heading">セッション</h3>'+it.sessions.map((s)=>'<a class="ev-session" href="/w/'+WS+'/sessions/'+encodeURIComponent(s.id)+'">'+status(s)+'<span class="meta">'+esc(when(s.startedAt))+'</span><span>開く →</span></a>').join(""):"")
    +(it.notes?'<h3 class="text-heading">notes</h3><pre class="code">'+esc(it.notes)+'</pre>':"")
    +'<div class="actions">'+(it.deletable?'<form class="inline" method="post" action="/w/'+WS+'/demo/events/'+role+'/'+encodeURIComponent(it.id)+'/delete#'+week+'"><button class="btn btn-outline">'+(it.role==="prep"?"締切ごと消す":it.recurring?"繰り返しごと消す":"消す")+'</button></form>':'<span class="text-muted">デモで足した予定だけ消せる。</span>')
    +'<button type="button" class="btn btn-outline" data-close-ev>閉じる</button></div>';
  evDlg.querySelector("[data-close-ev]").onclick=()=>evDlg.close();
  evDlg.showModal();
});
for(const d of [addDlg,evDlg])d.addEventListener("click",(e)=>{if(e.target===d)d.close()});

skeleton();
document.getElementById("cal-body").scrollTop=Math.max(0,(Math.floor(wall(Date.now()).min/60)-2)*HOUR);
poll(async()=>{await load()},5000);
poll(async()=>{
  const r=await fetch("/w/"+WS+"/api/sessions");if(!r.ok)return;const d=await r.json();
  document.getElementById("list").innerHTML=d.sessions.length?d.sessions.map((s)=>'<a class="session" href="/w/'+WS+'/sessions/'+encodeURIComponent(s.id)+'"><span>'+status(s)+'</span><span><span class="title">'+esc(s.title)+'</span><div class="meta"><span class="chip">'+kind(s)+'</span> '+(where(s)?'<span class="chip">'+esc(where(s))+'</span> ':"")+esc(when(s.startedAt))+(s.late?" · 遅れて登録":"")+(s.toolCalls?" · tool "+s.toolCalls:"")+(s.pendingApprovals?' · <span class="status-warn">承認待ち '+s.pendingApprovals+'</span>':"")+'</div></span><span class="meta">'+esc(secs(s))+'</span></a>').join(""):'<p class="empty">セッションはまだない。カレンダーに予定を追加すると、1分ほどでここに出る。</p>';
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
const ID=${scriptJson(id)};
const block=(s)=>'<pre class="code">'+esc(s)+'</pre>';
poll(async()=>{
  const r=await fetch("/w/"+WS+"/api/sessions/"+encodeURIComponent(ID));
  if(r.status===404){document.getElementById("title").textContent="セッションが見つからない";return false}
  const {session:s,approvals}=await r.json();
  document.getElementById("title").textContent=s.title;
  document.getElementById("st").innerHTML=status(s);
  document.getElementById("kind").textContent=kind(s)+(s.late?" · 遅れて登録":"");
  document.getElementById("meta").textContent=[when(s.startedAt),where(s),s.execution?"execution "+s.execution.split("/").pop():"",s.workerId?"worker "+s.workerId:"",s.model,s.usage?"tokens "+s.usage.totalTokens:"",secs(s),"run "+s.id.slice(0,8)].filter(Boolean).join(" · ");
  const steps=[];
  if(s.executor)steps.push('<div class="step"><h3 class="text-heading">判定</h3>'+judgment({executor:s.executor,agent:s.agent,target:s.target,prompt:s.input})+'</div>');
  else if(s.input)steps.push('<div class="step"><h3 class="text-heading">入力</h3>'+block(s.input)+'</div>');
  for(const t of s.toolCalls)steps.push('<div class="step"><h3 class="text-heading">tool <span class="mono">'+esc(t.name)+'</span></h3>'+block(JSON.stringify(t.args,null,1))+block("→ "+JSON.stringify(t.result,null,1))+'</div>');
  if(s.reason)steps.push('<div class="step"><h3 class="text-heading '+(s.status==="failed"?"status-bad":"status-warn")+'">'+(s.status==="failed"?"失敗":"実行しなかった理由")+'</h3><p>'+esc(s.reason)+'</p></div>');
  if(s.output)steps.push('<div class="step"><h3 class="text-heading">出力</h3>'+block(s.output)+'</div>');
  if(running(s))steps.push('<div class="step"><h3 class="text-heading status-warn">実行中</h3>'+(s.executor==="cloud"?'<p>cloud の sandbox で agent が動いている。終わると出力がここに出る。</p>':"")+'</div>');
  if(s.status==="queued")steps.push('<div class="step"><h3 class="text-heading status-warn">待機中</h3><p>local worker が受け取るのを待っている。</p></div>');
  document.getElementById("log").innerHTML=steps.join("");
  document.getElementById("approvals-frame").hidden=!approvals.length;
  const at=(a)=>a.operation.start.date||a.operation.start.dateTime||"";
  document.getElementById("approvals").innerHTML=[...approvals].sort((a,b)=>at(a).localeCompare(at(b))).map((a)=>'<div class="approval"><b>'+esc(a.operation.summary)+'</b> <span class="mono">'+esc(a.operation.start.date||when(a.operation.start.dateTime))+'</span>'+(a.operation.notes?'<p class="text-muted">'+esc(a.operation.notes)+'</p>':"")+'<div class="actions">'+(a.status==="pending"?'<form class="inline" method="post" action="/w/'+WS+'/approvals/'+encodeURIComponent(a.id)+'/approve"><button class="btn btn-primary">承認して追加</button></form><form class="inline" method="post" action="/w/'+WS+'/approvals/'+encodeURIComponent(a.id)+'/reject"><button class="btn btn-outline">却下</button></form>':'<span class="chip">'+({approved:"承認済み",rejected:"却下",failed:"失敗"})[a.status]+'</span>')+'</div></div>').join("");
  return running(s)||s.status==="queued"?undefined:false;
},2000);`;
  return shell(ws, "agent-calendar · session", slab, content, script);
}
