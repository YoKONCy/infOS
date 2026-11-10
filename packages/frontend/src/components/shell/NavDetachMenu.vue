<script setup lang="ts">
import { t as __t } from '../../i18n/index'

/**
 * NavDetachMenu — 主导航右键菜单「摘出到桌面」
 *
 * 只在 Electron 主窗口中出现；不可摘出的页面（对话、危险区域）保持浏览器默认右键行为。
 * 已摘出的页面改为「显示桌面面板」。
 *
 * @see .docs/P03_DESKTOP_SHELL.md 阶段 1
 */
import { ref } from 'vue'
import ContextMenu, { type ContextMenuItem } from '../pixel/ContextMenu.vue'
import { useMainNav } from '../../composables/main/useMainNav'
import { useDetachedPanels } from '../../composables/shell/useDetachedPanels'
import { useNotificationStore } from '../../stores/useNotificationStore'

const shell = useDetachedPanels()
const { currentTab, setTab } = useMainNav()
const menu = ref<{ x: number; y: number; items: ContextMenuItem[] } | null>(null)

/** 摘出当前页面时先在主窗口切回对话（沿用离开确认），再打开面板。 */
async function detach(id: string): Promise<void> {
  if (currentTab.value === id) {
    await setTab('chat')
    if (currentTab.value === id) return
  }
  try {
    await shell.detach(id)
  } catch (cause) {
    useNotificationStore().toast(
      __t('ui.desktop-shell', '面板操作失败：{0}', [
        cause instanceof Error ? cause.message : String(cause),
      ]),
      'error',
    )
  }
}

/** 在导航项上右键时调用；不可摘出时不拦截事件。 */
function open(event: MouseEvent, id: string): void {
  if (!shell.canDetach(id)) return
  event.preventDefault()
  event.stopPropagation()
  const detached = shell.isDetached(id)
  menu.value = {
    x: event.clientX,
    y: event.clientY,
    items: [
      {
        label: detached
          ? __t('ui.desktop-shell', '显示桌面面板')
          : __t('ui.desktop-shell', '摘出到桌面'),
        action: () => void (detached ? shell.focus(id).catch(() => {}) : detach(id)),
      },
    ],
  }
}

defineExpose({ open })
</script>

<template>
  <ContextMenu
    v-if="shell.enabled"
    :visible="Boolean(menu)"
    :x="menu?.x ?? 0"
    :y="menu?.y ?? 0"
    :items="menu?.items ?? []"
    @close="menu = null"
  />
</template>
