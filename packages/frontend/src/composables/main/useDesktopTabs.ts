import { t as __t } from '../../i18n/index'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { DesktopTab, DesktopTabsState } from '@infos/shared'
import { invoke, isElectron, listen } from '../../utils/ipcAdapter'
import { useNotificationStore } from '../../stores'
import { resolveArcaUiUrl } from '../../applications/openArcaSurface'
import { resolvePictoriaUiUrl } from '../../applications/openPictoriaSurface'
import { ensureNapCatInstalled } from '../../applications/openNapCatSurface'
import { useAgentStore } from '../../stores/useAgentStore'

/** 桌面外壳只投影主进程状态，不另建应用和后台任务的权威状态。 */
export function useDesktopTabs(options: { openHomeSection?: (id: string) => Promise<void> } = {}) {
  const enabled = isElectron()
  const notification = useNotificationStore()
  const state = ref<DesktopTabsState>({
    revision: -1,
    activeTabId: 'home',
    tabs: [{ id: 'home', kind: 'home', title: 'infOS', icon: 'sparkle' }],
    applications: [],
  })
  const nativeMount = ref<HTMLElement | null>(null)
  const opening = ref(false)
  const openingApplication = ref<{ id: string; title: string } | null>(null)
  const addressFocus = ref(0)
  const queries = ref<Record<string, string>>({})
  const activeTab = computed<DesktopTab>(
    () =>
      state.value.tabs.find((tab) => tab.id === state.value.activeTabId) ?? state.value.tabs[0]!,
  )
  const isHome = computed(() => !enabled || activeTab.value.kind === 'home')
  let disposed = false
  let resizeObserver: ResizeObserver | undefined
  let modalObserver: MutationObserver | undefined
  let frame = 0
  let lastObscured: boolean | undefined
  let lastBounds = ''
  const modalSelector = '.p-dialog-overlay, .update-overlay, [role="dialog"][aria-modal="true"]'
  const modals = new Set<HTMLElement>()
  let boundsDirty = false
  const unlisteners: Array<() => void> = []

  function applyState(value: unknown): void {
    const incoming = value as DesktopTabsState | null
    if (!incoming || !Array.isArray(incoming.tabs) || incoming.revision < state.value.revision)
      return
    state.value = incoming
    const ids = new Set(incoming.tabs.map((tab) => tab.id))
    for (const id of Object.keys(queries.value)) if (!ids.has(id)) delete queries.value[id]
  }

  async function request(channel: string, args?: unknown): Promise<boolean> {
    if (!enabled || disposed) return false
    try {
      const value = await invoke(channel, args)
      if (!disposed) applyState(value)
      return true
    } catch (error) {
      if (!disposed)
        notification.toast(error instanceof Error ? error.message : String(error), 'error')
      return false
    }
  }

  function syncBounds(): void {
    const element = nativeMount.value
    if (!enabled || disposed || !element?.isConnected) return
    const bounds = element.getBoundingClientRect()
    if (bounds.width <= 1 || bounds.height <= 1) return
    const key = [bounds.left, bounds.top, bounds.width, bounds.height].map(Math.round).join(':')
    if (key === lastBounds) return
    lastBounds = key
    void invoke('desktop-tabs:set-bounds', {
      x: bounds.left,
      y: bounds.top,
      width: bounds.width,
      height: bounds.height,
    }).catch(() => {
      if (lastBounds === key) lastBounds = ''
    })
  }

  function syncObscured(): void {
    if (!enabled || disposed) return
    for (const modal of modals)
      if (!modal.isConnected || !modal.matches(modalSelector)) modals.delete(modal)
    const value = [...modals].some(
      (element) =>
        element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden',
    )
    if (value === lastObscured) return
    lastObscured = value
    void invoke('desktop-tabs:set-obscured', value).catch(() => {
      if (lastObscured === value) lastObscured = undefined
    })
  }

  function scheduleLayout(checkBounds = true): void {
    boundsDirty ||= checkBounds
    if (disposed || frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      if (boundsDirty) syncBounds()
      boundsDirty = false
      syncObscured()
    })
  }

  function observeModals(records: MutationRecord[]): void {
    let changed = false
    for (const record of records) {
      const target = record.target instanceof HTMLElement ? record.target : null
      if (record.type === 'attributes') {
        if (target?.matches(modalSelector)) {
          modals.add(target)
          changed = true
        } else if (target && [...modals].some((modal) => target.contains(modal))) changed = true
        continue
      }
      // 富文本内容不是外壳弹窗；流式生成的成百上千个元素无需触发布局检查。
      if (target?.closest('.chat-rich-text, .surface-thinking__live')) continue
      for (const node of record.addedNodes) {
        if (!(node instanceof HTMLElement)) continue
        if (node.matches(modalSelector)) {
          modals.add(node)
          changed = true
        }
        for (const modal of node.querySelectorAll<HTMLElement>(modalSelector)) {
          modals.add(modal)
          changed = true
        }
      }
      if (record.removedNodes.length && [...modals].some((modal) => !modal.isConnected))
        changed = true
    }
    if (changed) scheduleLayout(false)
  }

  watch(
    nativeMount,
    async (element) => {
      resizeObserver?.disconnect()
      lastBounds = ''
      await nextTick()
      if (disposed || !enabled) return
      if (element) resizeObserver?.observe(element)
      scheduleLayout()
    },
    { flush: 'post' },
  )
  watch(
    () => [state.value.activeTabId, activeTab.value.error, activeTab.value.loading],
    async () => {
      await nextTick()
      scheduleLayout()
      if (activeTab.value.kind === 'new') addressFocus.value += 1
    },
  )

  async function addListener(event: string, handler: (value: unknown) => void): Promise<void> {
    const stop = await listen(event, handler)
    if (disposed) stop()
    else unlisteners.push(stop)
  }

  onMounted(async () => {
    if (!enabled) return
    resizeObserver = new ResizeObserver(() => scheduleLayout())
    if (nativeMount.value) resizeObserver.observe(nativeMount.value)
    for (const modal of document.querySelectorAll<HTMLElement>(modalSelector)) modals.add(modal)
    modalObserver = new MutationObserver(observeModals)
    modalObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'aria-modal', 'role'],
    })
    window.addEventListener('resize', handleResize)
    try {
      await addListener('desktop-tabs:changed', applyState)
      await addListener('desktop-tabs:focus-address', () => {
        addressFocus.value += 1
      })
      await addListener('desktop-tabs:open-link', (value) => {
        const url = String((value as { url?: string })?.url ?? '')
        if (/^https?:\/\//i.test(url)) void openBrowser(url)
      })
      await request('desktop-tabs:get-state')
      scheduleLayout()
    } catch (error) {
      if (!disposed)
        notification.toast(
          __t('ui.navigation', '桌面标签初始化失败：{0}', [String(error)]),
          'error',
        )
    }
  })

  onUnmounted(() => {
    disposed = true
    for (const stop of unlisteners) stop()
    resizeObserver?.disconnect()
    modalObserver?.disconnect()
    window.removeEventListener('resize', handleResize)
    modals.clear()
    if (frame) cancelAnimationFrame(frame)
  })

  function handleResize(): void {
    scheduleLayout()
  }

  function resolveAddress(value: string): string {
    const input = value.trim()
    if (!input) throw new Error('请输入网址或搜索内容')
    if (input === 'about:blank' || /^https?:\/\//i.test(input)) return input
    if (/^(localhost|127(?:\.\d+){3})(?::\d+)?(?:[/?#]|$)/i.test(input)) return `http://${input}`
    if (/^[a-z][a-z0-9+.-]*:/i.test(input)) throw new Error('浏览器只支持 HTTP 和 HTTPS 网页')
    if (!/\s/.test(input) && /^[^/]+\.[^/]+/.test(input)) return `https://${input}`
    return `https://www.bing.com/search?q=${encodeURIComponent(input)}`
  }

  async function openBrowser(value: string, replaceId?: string): Promise<void> {
    if (opening.value) return
    try {
      const url = resolveAddress(value)
      opening.value = true
      await request('desktop-tabs:open-browser', { url, replaceId })
    } catch (error) {
      notification.toast(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      opening.value = false
    }
  }

  async function navigate(value: string): Promise<void> {
    const targetId = activeTab.value.targetId
    if (!targetId) return
    try {
      await request('desktop-tabs:navigate', { targetId, url: resolveAddress(value) })
    } catch (error) {
      notification.toast(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  async function openApplication(appId: string, replaceId?: string): Promise<void> {
    if (opening.value) return
    opening.value = true
    const existing = state.value.tabs.find((tab) => tab.appId === appId)
    if (appId !== 'infos.tarot' && (!existing || existing.loading || existing.error))
      openingApplication.value = {
        id: appId,
        title:
          state.value.applications.find((app) => app.id === appId)?.title ??
          __t('ui.navigation', '应用'),
      }
    try {
      if (appId === 'infos.tarot') {
        await request('desktop-tabs:open-tarot', { replaceId })
        return
      }
      if (appId === 'infos.napcat') {
        const installed = await ensureNapCatInstalled({
          isInstalled: () => invoke('check-napcat'),
          warn: (message) => notification.toast(message, { type: 'warning', duration: 10_000 }),
          openInstallPage: async () => {
            if (replaceId) await request('desktop-tabs:close', replaceId)
            await options.openHomeSection?.('social')
          },
        })
        if (!installed) return
      }
      const url =
        appId === 'infos.arca'
          ? await resolveArcaUiUrl(true)
          : appId === 'infos.pictoria'
            ? await resolvePictoriaUiUrl(useAgentStore().activeAgentId)
            : undefined
      if (!disposed) await request('desktop-tabs:open-application', { appId, url, replaceId })
    } catch (error) {
      if (!disposed)
        notification.toast(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      opening.value = false
      openingApplication.value = null
    }
  }

  return {
    enabled,
    state,
    activeTab,
    isHome,
    nativeMount,
    opening,
    openingApplication,
    addressFocus,
    queries,
    create: () => request('desktop-tabs:create'),
    activate: (id: string) => request('desktop-tabs:activate', id),
    close: (id: string) => request('desktop-tabs:close', id),
    openBrowser,
    openApplication,
    navigate,
    browserAction: (action: string) =>
      request('desktop-tabs:browser-action', {
        targetId: activeTab.value.targetId,
        action,
      }),
  }
}
