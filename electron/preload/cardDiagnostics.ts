/** 仅显示文本，不执行错误内容；脚本异常与未处理的 Promise 都有可见说明。 */
export interface CardDiagnosticLabels {
  error: string
  dismiss: string
  retry: string
  unbound: string
  failed: string
}
let labels: CardDiagnosticLabels | undefined
let pending = ''
let render: (() => void) | undefined

export function showCardError(reason: unknown): void {
  const message = reason instanceof Error ? reason.message : String(reason)
  pending = message.includes('HOME_CARD_UNBOUND') ? 'HOME_CARD_UNBOUND' : message.slice(0, 1200)
  render?.()
}

window.addEventListener('error', (event) => showCardError(event.message || 'HOME_CARD_ERROR'))
window.addEventListener('unhandledrejection', (event) => showCardError(event.reason))

export function installCardDiagnostics(
  root: ShadowRoot,
  retry: () => void,
): (value: CardDiagnosticLabels) => void {
  const panel = document.createElement('section')
  panel.setAttribute('role', 'alert')
  panel.style.cssText =
    'position:fixed;top:32px;left:8px;right:8px;max-height:65vh;overflow:auto;padding:12px;box-sizing:border-box;border:1px solid #ae819d;border-radius:8px;background:#302833;color:#fff;font:12px/1.5 system-ui;-webkit-app-region:no-drag;box-shadow:0 4px 20px #0005'
  const heading = document.createElement('strong'),
    detail = document.createElement('pre')
  detail.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;margin:8px 0'
  const reload = document.createElement('button'),
    dismiss = document.createElement('button')
  for (const button of [reload, dismiss])
    button.style.cssText =
      'display:inline-block;width:auto;height:auto;font:inherit;border:1px solid #ffffff55;background:#ffffff18;color:white;padding:5px 8px;border-radius:5px;margin-right:6px;cursor:pointer'
  reload.addEventListener('click', (event) => {
    if (event.isTrusted) retry()
  })
  dismiss.addEventListener('click', () => {
    pending = ''
    panel.hidden = true
  })
  panel.append(heading, detail, reload, dismiss)
  root.append(panel)
  render = () => {
    panel.hidden = !pending || !labels
    if (!labels) return
    heading.textContent = labels.error
    detail.textContent =
      pending === 'HOME_CARD_UNBOUND'
        ? labels.unbound
        : /HOME_|DESKTOP_CARD_/.test(pending)
          ? labels.failed
          : pending
    reload.textContent = labels.retry
    dismiss.textContent = labels.dismiss
  }
  render()
  return (value) => {
    labels = value
    render?.()
  }
}
