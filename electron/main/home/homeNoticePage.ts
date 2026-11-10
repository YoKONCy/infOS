/**
 * 右下角通知窗口的页面（data: URL 加载）。只用 textContent 填充主进程给的文字，
 * CSP 禁止外部资源与网络请求；按钮只回传 {kind,id,choice}，由主进程核对。
 */

const STYLE = `
:root{color-scheme:light dark;--bg:#fbfaff;--fg:#1d1b26;--muted:#6b6880;--line:rgba(120,110,160,.28);--accent:#6d4fd8;--danger:#c23b3b}
@media (prefers-color-scheme:dark){:root{--bg:#211e2b;--fg:#f1eefb;--muted:#a8a3bd;--line:rgba(200,190,240,.18);--accent:#9c86f0;--danger:#ef6b6b}}
*{box-sizing:border-box}html,body{margin:0;background:transparent;font:13px/1.45 "Segoe UI","Microsoft YaHei UI",sans-serif;color:var(--fg);user-select:none;overflow:hidden}
#list{display:flex;flex-direction:column;gap:8px;padding:6px}
.card{background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:10px 12px;box-shadow:0 6px 18px rgba(0,0,0,.18)}
.title{font-weight:600;display:flex;justify-content:space-between;gap:8px}
.time{color:var(--muted);font-weight:400;font-size:11px;white-space:nowrap}
.line{color:var(--muted);font-size:12px;word-break:break-all}
.reason{font-size:12px;margin-top:4px}.reason::before{content:"· "}
.buttons{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
button{font:inherit;font-size:12px;border:1px solid var(--line);background:transparent;color:var(--fg);border-radius:6px;padding:3px 10px;cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
button.danger{color:var(--danger)}button:disabled{opacity:.5;cursor:default}
.error{color:var(--danger);font-size:12px;margin-top:6px}
.review{margin-top:6px;padding:6px;border:1px dashed var(--line);border-radius:6px}
.activity{cursor:pointer}.activity.failed .title{color:var(--danger)}
`

const SCRIPT = `
const list=document.getElementById('list');
let state={notices:[]};
function el(tag,cls,text){const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e}
function send(a){window.homeNotice.action(a)}
function left(at){const s=Math.max(0,Math.round((at-Date.now())/1000));return s>=60?Math.floor(s/60)+':'+String(s%60).padStart(2,'0'):s+'s'}
function confirmation(n){const c=el('div','card');const t=el('div','title');t.append(el('span','',n.title));const time=el('span','time',left(n.expiresAt));time.dataset.expires=n.expiresAt;t.append(time);c.append(t);
for(const l of n.lines)c.append(el('div','line',l));for(const r of n.reasons)c.append(el('div','reason',r));
if(n.review){const r=el('div','review');r.append(el('div','',n.review.title));for(const x of n.review.targets)r.append(el('div','line',x));const b=el('div','buttons');
const ok=el('button','primary',n.review.confirm);ok.disabled=n.busy;ok.onclick=()=>send({kind:'choose',id:n.id,choice:n.review.choice,confirm:true});
const back=el('button','',n.review.back);back.disabled=n.busy;back.onclick=()=>send({kind:'back',id:n.id});b.append(ok,back);r.append(b);c.append(r)}
else{const b=el('div','buttons');n.buttons.forEach((x,i)=>{const btn=el('button',x.danger?'danger':(i===0?'primary':''),x.label);btn.disabled=n.busy;btn.onclick=()=>send({kind:'choose',id:n.id,choice:x.choice});b.append(btn)});c.append(b)}
if(n.error)c.append(el('div','error',n.error));return c}
function activity(n){const c=el('div','card activity'+(n.failed?' failed':''));const t=el('div','title');t.append(el('span','',n.title));c.append(t);for(const l of n.lines)c.append(el('div','line',l));
c.onclick=(e)=>{if(e.target.tagName!=='BUTTON')send({kind:'toggle',id:n.id})};
if(n.expanded){for(const d of n.details)c.append(el('div','line',d));const b=el('div','buttons');if(n.undo){const u=el('button','primary',n.undo);u.disabled=n.busy;u.onclick=()=>send({kind:'undo',id:n.id});b.append(u)}
const o=el('button','',n.open);o.onclick=()=>send({kind:'open',id:n.id});const x=el('button','',n.close);x.onclick=()=>send({kind:'dismiss',id:n.id});b.append(o,x);c.append(b)}
if(n.error)c.append(el('div','error',n.error));return c}
function render(){list.replaceChildren(...state.notices.map(n=>n.kind==='confirmation'?confirmation(n):activity(n)));requestAnimationFrame(()=>window.homeNotice.resize(Math.ceil(list.getBoundingClientRect().height)))}
window.homeNotice.onState(s=>{state=s&&Array.isArray(s.notices)?s:{notices:[]};render()});
setInterval(()=>{for(const e of document.querySelectorAll('.time'))e.textContent=left(Number(e.dataset.expires))},1000);
document.addEventListener('mouseenter',()=>send({kind:'hover',hovered:true}));document.addEventListener('mouseleave',()=>send({kind:'hover',hovered:false}));
window.homeNotice.ready();
`

export function homeNoticePage(lang: string): string {
  const html = `<!doctype html><html lang="${lang.replace(/[^a-zA-Z-]/g, '')}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>${STYLE}</style></head><body><div id="list"></div><script>${SCRIPT}</script></body></html>`
  return `data:text/html;charset=utf-8;base64,${Buffer.from(html, 'utf8').toString('base64')}`
}
