/**
 * useDesktopCardAdmin — 「卡片」页与主进程卡片管理通道之间的薄封装
 *
 * 所有改动经 `DESKTOP_CARD_ADMIN_CHANNELS`，主进程改完返回最新列表（含缩略图与最近关闭的过期时间），
 * 这里只负责保存列表、忙碌状态与失败提示，不在前端推算卡片状态。仅 Electron 主应用可用。
 *
 * @see .docs/P03_DESKTOP_SHELL.md 卡片页
 */
import { t as __t } from '../../../i18n/index'
import { computed, ref, shallowRef } from 'vue'
import {
  DESKTOP_CARD_ADMIN_CHANNELS,
  type DesktopCardAdminPatch,
  type DesktopCardListItem,
} from '@infos/shared'
import { invoke, isElectron, isToastOverlay } from '../../../utils/ipcAdapter'
import { useNotificationStore } from '../../../stores/useNotificationStore'

/** 卡片是否进了「最近关闭」（未收藏且已关闭）。 */
export function isRecentCard(card: DesktopCardListItem): boolean {
  return !card.saved && !card.open
}

/** 按名称搜索（不区分大小写，忽略首尾空白）；关键字为空时全部保留。 */
export function filterCards(cards: DesktopCardListItem[], query: string): DesktopCardListItem[] {
  const keyword = query.trim().toLowerCase()
  if (!keyword) return cards
  return cards.filter((card) => card.name.toLowerCase().includes(keyword))
}

export function useDesktopCardAdmin() {
  const enabled = isElectron() && !isToastOverlay() && window.electron?.embedded !== true
  const cards = shallowRef<DesktopCardListItem[]>([])
  const busy = ref(false)
  const query = ref('')

  const visible = computed(() => filterCards(cards.value, query.value))
  const mine = computed(() => visible.value.filter((card) => !isRecentCard(card)))
  const recent = computed(() => visible.value.filter(isRecentCard))

  async function call(channel: string, input?: unknown): Promise<void> {
    if (!enabled) return
    busy.value = true
    try {
      cards.value = (await invoke(channel, input)) as DesktopCardListItem[]
    } catch (cause) {
      useNotificationStore().toast(
        __t('ui.desktop-shell', '卡片操作失败：{0}', [
          cause instanceof Error ? cause.message : String(cause),
        ]),
        'error',
      )
    } finally {
      busy.value = false
    }
  }

  async function source(id: string): Promise<string | null> {
    try {
      return (await invoke(DESKTOP_CARD_ADMIN_CHANNELS.source, id)) as string
    } catch (cause) {
      useNotificationStore().toast(
        __t('ui.desktop-shell', '卡片操作失败：{0}', [
          cause instanceof Error ? cause.message : String(cause),
        ]),
        'error',
      )
      return null
    }
  }

  return {
    enabled,
    cards,
    busy,
    query,
    mine,
    recent,
    refresh: () => call(DESKTOP_CARD_ADMIN_CHANNELS.list),
    open: (id: string) => call(DESKTOP_CARD_ADMIN_CHANNELS.show, id),
    close: (id: string) => call(DESKTOP_CARD_ADMIN_CHANNELS.close, id),
    remove: (id: string) => call(DESKTOP_CARD_ADMIN_CHANNELS.remove, id),
    patch: (id: string, patch: DesktopCardAdminPatch) =>
      call(DESKTOP_CARD_ADMIN_CHANNELS.patch, { id, patch }),
    source,
  }
}
