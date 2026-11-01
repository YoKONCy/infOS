import { t as __t } from './i18n'
import { createApp, nextTick } from 'vue'
import type { SurfaceBridge } from './types'
import './styles/canvas.css'
import './styles/canvas-creation.css'
import './styles/canvas-polish.css'
import './styles/workflow.css'
import './styles/studio.css'

const bridge = (window as unknown as { electron?: SurfaceBridge }).electron
let mounted = false
let failed = false
function fail(error: unknown): void {
  console.error(__t('apps.pictoria.logs', 'Pictoria 界面运行失败：'), error)
  if (mounted || failed) return
  failed = true
  const message = error instanceof Error ? error.message : String(error)
  bridge?.send?.('desktop-tabs:surface-state', { error: message })
  // 等当前挂载栈结束，避免 Vue 随后的占位节点覆盖独立模式的错误界面。
  queueMicrotask(() => {
    const root = document.getElementById('app')
    if (!root) return
    const panel = document.createElement('section')
    panel.className = 'startup-error'
    panel.setAttribute('role', 'alert')
    const title = document.createElement('strong')
    title.textContent = 'Pictoria 暂时无法打开'
    const detail = document.createElement('p')
    detail.textContent = message
    const retry = document.createElement('button')
    retry.textContent = '重新打开'
    retry.onclick = () => window.location.reload()
    panel.append(title, detail, retry)
    root.replaceChildren(panel)
  })
}

async function start(): Promise<void> {
  try {
    // 动态加载使模块加载失败也能进入明确的错误反馈，避免只留下空根节点。
    const { default: App } = await import('./App.vue')
    const app = createApp(App)
    app.config.errorHandler = fail
    app.mount('#app')
    // 隐藏的原生视图可能暂停动画帧；就绪通知不依赖 requestAnimationFrame。
    await nextTick()
    if (failed) return
    mounted = true
    bridge?.send?.('desktop-tabs:surface-state', { ready: true })
  } catch (error) {
    fail(error)
  }
}
void start()
