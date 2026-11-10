/**
 * useDetachedPanels — 桌面外壳：已摘出页面的状态与摘出 / 聚焦 / 合回
 *
 * 功能页可以摘成独立的桌面面板窗口（仅 Electron）。已摘出列表由主进程维护并广播，
 * 主窗口与每个面板窗口各自持有一份只读副本。浏览器与非 Electron 环境下全部操作不可用。
 *
 * 本模块不依赖 useMainNav，导航状态由 useMainNav 反向读取，避免循环引用。
 *
 * @see .docs/P03_DESKTOP_SHELL.md 阶段 1
 * @module packages/frontend/src/composables/shell/useDetachedPanels
 */

import { computed, ref } from 'vue'
import {
  DESKTOP_SHELL_CHANNELS,
  isDetachablePage,
  type DetachedPanelPatch,
  type DetachedPanelState,
} from '@infos/shared'
import { invoke, isElectron, isToastOverlay, listen } from '../../utils/ipcAdapter'

const PANEL_ROUTE = /^#\/panel\/([\w-]+)/

const panels = ref<DetachedPanelState[]>([])
let started = false

/** 当前窗口是否为桌面面板窗口；是则返回其页面 ID。 */
export function currentPanelPage(): string | undefined {
  if (typeof location === 'undefined') return undefined
  return PANEL_ROUTE.exec(location.hash)?.[1]
}

/** 摘出功能只在 Electron 主应用窗口中提供。 */
function shellAvailable(): boolean {
  return isElectron() && !isToastOverlay() && window.electron?.embedded !== true
}

function readState(value: unknown): DetachedPanelState | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  if (!isDetachablePage(item.pageId)) return null
  return {
    pageId: item.pageId,
    alwaysOnTop: item.alwaysOnTop === true,
    opacity: typeof item.opacity === 'number' ? item.opacity : 1,
  }
}

/** 接受主进程返回的数组或广播的 `{ panels }`。 */
function applyStates(value: unknown): void {
  const list = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as { panels?: unknown }).panels)
      ? (value as { panels: unknown[] }).panels
      : null
  if (!list) return
  panels.value = list.flatMap((item) => {
    const state = readState(item)
    return state ? [state] : []
  })
}

async function refresh(): Promise<void> {
  if (!shellAvailable()) return
  applyStates(await invoke(DESKTOP_SHELL_CHANNELS.panels))
}

function start(): void {
  if (started || !shellAvailable()) return
  started = true
  void listen(DESKTOP_SHELL_CHANNELS.changed, applyStates)
  void refresh().catch(() => {
    // 旧版宿主没有该通道时保持空列表。
  })
}

/** 已摘出页面 ID 集合。 */
export const detachedPageIds = computed(() => new Set<string>(panels.value.map((p) => p.pageId)))

/** 在主窗口中请求某个页面时，已摘出则改为聚焦面板。 */
async function focus(pageId: string): Promise<void> {
  await invoke(DESKTOP_SHELL_CHANNELS.focus, pageId)
}

/**
 * 导航请求改道：
 * - 面板窗口中请求其他页面 → 交给主进程（已摘出则聚焦面板，否则在主窗口打开）；
 * - 主窗口中请求已摘出的页面 → 聚焦对应面板。
 * 返回 true 表示请求已处理，调用方不再在本窗口切页。
 */
export function redirectTabRequest(pageId: string): boolean {
  if (!shellAvailable()) return false
  const own = currentPanelPage()
  if (own) {
    if (pageId !== own) void focus(pageId).catch(() => {})
    return true
  }
  if (!detachedPageIds.value.has(pageId)) return false
  void focus(pageId).catch(() => {})
  return true
}

export function useDetachedPanels() {
  start()
  const enabled = shellAvailable()

  /** 该页面能否在当前窗口（主窗口）中摘出。 */
  function canDetach(pageId: string): boolean {
    return enabled && !currentPanelPage() && isDetachablePage(pageId)
  }

  function isDetached(pageId: string): boolean {
    return detachedPageIds.value.has(pageId)
  }

  function panel(pageId: string): DetachedPanelState | undefined {
    return panels.value.find((item) => item.pageId === pageId)
  }

  async function detach(pageId: string): Promise<void> {
    applyStates(await invoke(DESKTOP_SHELL_CHANNELS.detach, { pageId }))
  }

  async function attach(pageId: string): Promise<void> {
    applyStates(await invoke(DESKTOP_SHELL_CHANNELS.attach, { pageId }))
  }

  async function close(pageId: string): Promise<void> {
    applyStates(await invoke(DESKTOP_SHELL_CHANNELS.close, { pageId }))
  }

  async function set(pageId: string, patch: DetachedPanelPatch): Promise<void> {
    applyStates(await invoke(DESKTOP_SHELL_CHANNELS.set, { pageId, ...patch }))
  }

  /** 恢复默认布局；返回因有未保存修改而保持打开的面板数量。 */
  async function reset(): Promise<number> {
    const result = (await invoke(DESKTOP_SHELL_CHANNELS.reset)) as { remaining?: unknown } | null
    await refresh()
    return typeof result?.remaining === 'number' ? result.remaining : 0
  }

  return {
    enabled,
    panels,
    detachedPageIds,
    canDetach,
    isDetached,
    panel,
    detach,
    focus,
    attach,
    close,
    set,
    reset,
    refresh,
  }
}
