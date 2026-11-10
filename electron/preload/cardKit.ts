/** 卡片可选组件样式；只作用于 infos-kit 命名空间，正文由角色编写。 */
export const CARD_KIT_STYLE = `
.infos-kit{--card-ink:#302d42;--card-muted:#77718a;--card-accent:#8174bd;--card-surface:rgba(250,248,255,.82);margin:0;padding:40px 16px 16px;box-sizing:border-box;font:14px/1.5 system-ui;color:var(--card-ink);background:var(--card-surface);min-height:100vh;color-scheme:light dark}
.infos-kit *{box-sizing:border-box}.infos-kit h1,.infos-kit h2,.infos-kit p{margin:0}.infos-kit h1{font-size:18px}.infos-kit h2{font-size:14px}.infos-kit small{color:var(--card-muted)}
.infos-kit .card-panel{padding:14px;border:1px solid #a79bbd40;border-radius:12px;background:#ffffff50}.infos-kit .card-stack{display:grid;gap:12px}.infos-kit .card-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.infos-kit .card-stat{font-size:28px;font-weight:700;letter-spacing:-1px;font-variant-numeric:tabular-nums}
.infos-kit .card-badge{padding:3px 8px;border-radius:20px;background:#8174bd22;color:var(--card-accent);font-size:11px}.infos-kit .card-button{border:0;border-radius:8px;padding:8px 12px;background:var(--card-accent);color:white;cursor:pointer;font:inherit;-webkit-app-region:no-drag;transition:transform .12s,filter .12s}.infos-kit .card-button:hover{filter:brightness(1.08)}.infos-kit .card-button:active{transform:scale(.97)}.infos-kit .card-button:disabled{opacity:.5;cursor:default}
.infos-kit input,.infos-kit textarea{border:1px solid #a79bbd60;border-radius:6px;padding:7px 9px;font:inherit;background:#ffffff66;color:inherit;-webkit-app-region:no-drag}.infos-kit progress{accent-color:var(--card-accent);width:100%;height:8px}.infos-kit :focus-visible{outline:2px solid var(--card-accent);outline-offset:3px}
@media(prefers-color-scheme:dark){.infos-kit{--card-ink:#f0eafb;--card-muted:#b3a8c7;--card-accent:#b4a1ef;--card-surface:rgba(37,33,48,.86)}.infos-kit .card-panel{background:#ffffff08}.infos-kit input,.infos-kit textarea{background:#ffffff10}}
@media(prefers-reduced-motion:reduce){.infos-kit *{transition:none!important;animation:none!important}}
`

export function installCardKit(): void {
  const style = document.createElement('style')
  style.textContent = CARD_KIT_STYLE
  document.documentElement.append(style)
}
