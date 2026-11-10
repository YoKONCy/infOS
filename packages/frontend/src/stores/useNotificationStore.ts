import { t as __t } from '../i18n/index'
/**
 * useNotificationStore — 全局通知系统
 *
 * 对接 ErrorSeverity 三级映射：
 * - SILENT → 仅记日志
 * - TOAST → 非阻断弹出
 * - MODAL → 阻断对话框
 */

import { defineStore } from 'pinia'
import { ref } from 'vue'
import { getApiBaseUrl } from '../api/transport'
import { translateDiagnostic } from '@infos/shared/i18n'
import { stripIpcErrorPrefix } from '../utils/ipcErrorMessage'

export type NotificationType = 'info' | 'success' | 'warning' | 'error'
export type NotificationSeverity = 'silent' | 'toast' | 'modal'

export interface Notification {
  onPresented?: () => void
  id: number
  type: NotificationType
  severity: NotificationSeverity
  title?: string
  message: string
  /** 自动关闭延迟 (ms)，0 = 不自动关闭 */
  duration: number
  /** 创建时间 */
  createdAt: number
}

let nextId = 0

/** Toast 通知选项 */
export interface ToastOptions {
  onPresented?: () => void
  type?: NotificationType
  title?: string
  duration?: number
}

export const useNotificationStore = defineStore('notification', () => {
  // ── 状态 ──
  /** Toast 通知队列 */
  const toasts = ref<Notification[]>([])
  const nativeOverlayActive = ref(false)

  /** 模态通知 (一次只显示一个) */
  const modal = ref<Notification | null>(null)
  const queuedToasts: Notification[] = []
  const toastTimers = new Map<number, ReturnType<typeof setTimeout>>()

  function presentToast(notification: Notification) {
    const { onPresented, ...visible } = notification
    toasts.value.push(visible)
    onPresented?.()
    if (notification.duration > 0)
      toastTimers.set(
        notification.id,
        setTimeout(() => removeToast(notification.id), notification.duration),
      )
  }

  // ── 动作 ──

  /** 显示 Toast 通知 */
  function toast(
    message: string,
    typeOrOpts: NotificationType | ToastOptions = 'info',
    duration = 4000,
  ) {
    message = translateDiagnostic(stripIpcErrorPrefix(message))
    const opts: ToastOptions =
      typeof typeOrOpts === 'string' ? { type: typeOrOpts, duration } : typeOrOpts

    const notification: Notification = {
      id: nextId++,
      type: opts.type ?? 'info',
      severity: 'toast',
      title: opts.title,
      message,
      duration: opts.duration ?? duration,
      createdAt: Date.now(),
      onPresented: opts.onPresented,
    }
    // 展示后再开始计时，避免堆叠时内容被压扁或排队通知提前过期。
    if (toasts.value.length >= 3) queuedToasts.push(notification)
    else presentToast(notification)
  }

  /** 已展示的远程通知 ID，避免重连补发导致重复弹出。 */
  const remoteNotificationIds = new Set<string>()
  const pendingRemoteIds = new Set<string>()
  let remoteStorageKey = ''

  /** 跨刷新保存已展示记录，服务端回执暂时失败时也不会反复弹出。 */
  function loadRemoteReceipts() {
    const key = `infos:notification-receipts:v1:${getApiBaseUrl()}`
    if (key !== remoteStorageKey) {
      remoteStorageKey = key
      remoteNotificationIds.clear()
      pendingRemoteIds.clear()
      try {
        const saved: unknown = JSON.parse(localStorage.getItem(key) ?? '[]')
        if (Array.isArray(saved))
          for (const value of saved.slice(-2000))
            if (typeof value === 'string') remoteNotificationIds.add(value)
      } catch {
        /* 本地缓存不可用时仍通过服务端回执去重。 */
      }
    }
  }
  function wasRemotePresented(id: string): boolean {
    loadRemoteReceipts()
    return Boolean(id && remoteNotificationIds.has(id))
  }
  function rememberRemote(id: string): boolean {
    if (!id) return true
    loadRemoteReceipts()
    if (remoteNotificationIds.has(id)) return false
    remoteNotificationIds.add(id)
    if (remoteNotificationIds.size > 2000)
      remoteNotificationIds.delete(remoteNotificationIds.values().next().value!)
    try {
      localStorage.setItem(remoteStorageKey, JSON.stringify([...remoteNotificationIds]))
    } catch {
      /* 缓存失败不影响通知展示。 */
    }
    return true
  }

  /** 远程通知只按稳定 notificationId 展示一次；本地反馈 Toast 不进入远程协议。 */
  function toastRemote(id: string, message: string, options: ToastOptions = {}) {
    if (wasRemotePresented(id) || (id && pendingRemoteIds.has(id))) return
    if (id) pendingRemoteIds.add(id)
    toast(message, {
      ...options,
      onPresented: () => {
        rememberRemote(id)
        pendingRemoteIds.delete(id)
        options.onPresented?.()
      },
    })
  }

  /** 显示模态通知（阻断） */
  function showModal(message: string, title?: string, type: NotificationType = 'error') {
    message = translateDiagnostic(stripIpcErrorPrefix(message))
    modal.value = {
      id: nextId++,
      type,
      severity: 'modal',
      title,
      message,
      duration: 0,
      createdAt: Date.now(),
    }
  }

  /** 关闭模态 */
  function closeModal() {
    modal.value = null
  }

  /** 移除 Toast */
  function removeToast(id: number) {
    const timer = toastTimers.get(id)
    if (timer) clearTimeout(timer)
    toastTimers.delete(id)
    const removed = toasts.value.some((toast) => toast.id === id)
    toasts.value = toasts.value.filter((t) => t.id !== id)
    if (removed) {
      const next = queuedToasts.shift()
      if (next) presentToast(next)
    }
  }

  /** 按错误码自动分级显示 */
  function notifyByCode(code: string, message: string) {
    const severity = ERROR_UI_MAP[code] ?? 'toast'

    if (severity === 'silent') {
      // 静默错误仅记日志，不显示 UI
      return
    }

    if (severity === 'modal') {
      showModal(message, __t('ui.useNotificationStore', '错误: {0}', [code]), 'error')
      return
    }

    toast(message, 'error')
  }

  return {
    toasts,
    nativeOverlayActive,
    modal,
    toast,
    toastRemote,
    rememberRemote,
    wasRemotePresented,
    showModal,
    closeModal,
    removeToast,
    notifyByCode,
  }
})

/** 错误码 → UI 严重性映射 */
const ERROR_UI_MAP: Record<string, NotificationSeverity> = {
  VALIDATION_ERROR: 'toast',
  LLM_ERROR: 'toast',
  RATE_LIMITED: 'toast',
  UNAUTHORIZED: 'modal',
  DB_ERROR: 'modal',
  INTERNAL_ERROR: 'toast',
  NOT_FOUND: 'toast',
  TOOL_ERROR: 'toast',
}
