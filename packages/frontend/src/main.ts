import { t as __t } from './i18n/index'
/**
 * 前端应用入口
 *
 * 初始化顺序：样式 → Pinia → Router → 全局错误处理 → 挂载
 *
 * @module @infos/frontend
 */

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import { ApiError, ERROR_UI_MAP, ERROR_TITLE_MAP, ErrorSeverity } from './api'
import { useNotificationStore } from './stores'
import { logger } from './lib/logger'
import { uiSound } from './services/ui/uiSound'
import { isToastOverlay, listen } from './utils/ipcAdapter'

// 全局样式 (令牌 → Tailwind → 像素风组件)
import './assets/style.css'
import './assets/responsive-pages.css'
import './assets/workspace-layout.css'

if (isToastOverlay()) {
  document.documentElement.dataset.toastOverlay = ''
  void import('./views/NotificationOverlayView.vue').then(({ default: Overlay }) => {
    createApp(Overlay).use(createPinia()).mount('#app')
  })
} else {
  mountMainApp()
}

function mountMainApp(): void {
  const app = createApp(App)

  // ── 全局状态管理 ──
  const pinia = createPinia()
  app.use(pinia)

  // ── 路由 ──
  app.use(router)

  // ── 初始化通知 Store (Pinia 已挂载后可用) ──
  const notificationStore = useNotificationStore()

  // Web Audio API 需要由首次用户交互解锁，之后关键事件可在后台安全播放。
  const unlockAudio = () => {
    uiSound.unlock()
    window.removeEventListener('pointerdown', unlockAudio)
    window.removeEventListener('keydown', unlockAudio)
  }
  window.addEventListener('pointerdown', unlockAudio, { once: true })
  window.addEventListener('keydown', unlockAudio, { once: true })

  // 仅在开发环境下注入全局便于控制台测试，生产构建时会自动剥离这段代码
  if (import.meta.env.DEV) {
    // @ts-expect-error 开发环境暴露调试入口
    window.$toast = notificationStore.toast
  }

  // ── 全局错误处理 ──
  app.config.errorHandler = (err) => {
    if (err instanceof ApiError) {
      const severity = ERROR_UI_MAP[err.code] ?? ErrorSeverity.TOAST
      const title = ERROR_TITLE_MAP[err.code] ?? __t('ui.common', '错误')

      if (severity === ErrorSeverity.SILENT) {
        // 静默错误仅记日志
      } else if (severity === ErrorSeverity.MODAL) {
        notificationStore.showModal(err.message, title, 'error')
      } else {
        notificationStore.toast(err.message, { type: 'error', title })
      }
    } else {
      const message = err instanceof Error ? err.message : String(err)
      logger.error('VueErrorHandler', __t('logs.frontend.common', '未捕获的前端运行时异常'), err)
      notificationStore.toast(message || __t('ui.common', '发生未知错误'), {
        type: 'error',
        get title() {
          return __t('ui.common', '内部错误')
        },
      })
    }
  }

  // ── IPC 系统错误监听 (Electron 主进程推送) ──

  listen('system-error', (event: unknown) => {
    let msg = ''
    let title = __t('ui.common', '系统错误')

    if (typeof event === 'string') {
      msg = event
    } else if (typeof event === 'object' && event !== null) {
      const e = event as Record<string, unknown>
      msg = (e.payload ?? e.message ?? JSON.stringify(event)) as string
      if (e.title) title = e.title as string
      if (e.type === 'info' || e.type === 'warning') {
        // 非严重错误使用对应类型
        notificationStore.toast(msg, {
          type: e.type as 'info' | 'warning',
          title,
          duration: 6000,
        })
        return
      }
    } else {
      msg = String(event)
    }

    // 智能标题推断 (v1 还原)
    if (title === '系统错误') {
      if (msg.includes('Python')) title = 'Python 后端异常'
      else if (msg.includes('NapCat')) title = 'NapCat 异常'
      else if (msg.includes('WebView2')) title = 'WebView2 组件异常'
      else if (msg.includes('DLL')) title = '系统组件缺失'
    }

    notificationStore.toast(msg, { type: 'error', title, duration: 10000 })
  })

  app.mount('#app')
}
