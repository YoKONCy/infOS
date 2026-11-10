<script setup lang="ts">
import { t as __t } from '../../../i18n/index'

/**
 * FenceToolbar — 「卡片」页里的收纳框入口（预制件）。
 *
 * - 新建收纳框，或选一个文件夹映射成收纳框；框里只引用路径，不移动用户文件；
 * - 「隐藏桌面原图标」：可选，默认关闭，随时一键恢复。由资源管理器自带的切换命令完成，完全可还原；
 *   这是系统设置，只能由用户在这里操作，Agent 工具不能改。
 *
 * 收纳框本身也出现在下面的卡片列表里，可以照常打开、关闭、改名、删除（删除不碰引用的文件）。
 *
 * @see .docs/P11_DESKTOP_PREFABS.md
 */
import { onMounted, ref } from 'vue'
import { DESKTOP_PREFAB_ADMIN_CHANNELS, type DesktopIconsState } from '@infos/shared'
import { PButton, PixelIcon } from '../../pixel'
import { invoke } from '../../../utils/ipcAdapter'
import { useNotificationStore } from '../../../stores/useNotificationStore'

defineProps<{ busy: boolean }>()
const emit = defineEmits<{ changed: [] }>()

const icons = ref<DesktopIconsState | null>(null)
const working = ref(false)

function report(cause: unknown): void {
  useNotificationStore().toast(
    __t('ui.desktop-shell', '收纳框操作失败：{0}', [
      cause instanceof Error ? cause.message : String(cause),
    ]),
    'error',
  )
}

async function run(task: () => Promise<void>): Promise<void> {
  working.value = true
  try {
    await task()
  } catch (cause) {
    report(cause)
  } finally {
    working.value = false
  }
}

const createFence = (folder: boolean) =>
  run(async () => {
    await invoke(DESKTOP_PREFAB_ADMIN_CHANNELS.createFence, { folder })
    emit('changed')
  })

const setIconsHidden = (hidden: boolean) =>
  run(async () => {
    icons.value = (await invoke(DESKTOP_PREFAB_ADMIN_CHANNELS.setDesktopIcons, {
      hidden,
    })) as DesktopIconsState
  })

onMounted(() =>
  run(async () => {
    icons.value = (await invoke(DESKTOP_PREFAB_ADMIN_CHANNELS.desktopIcons)) as DesktopIconsState
  }),
)
</script>

<template>
  <section class="fence-toolbar">
    <div class="fence-toolbar__text">
      <h2>{{ __t('ui.desktop-shell', '收纳框') }}</h2>
      <p>
        {{
          __t(
            'ui.desktop-shell',
            '把桌面图标分组收进半透明的框里，可折叠、置顶、拖动和缩放；框里只是引用，不会移动文件。',
          )
        }}
      </p>
    </div>
    <div class="fence-toolbar__actions">
      <PButton size="sm" :disabled="busy || working" @click="createFence(false)">
        <PixelIcon name="plus" size="sm" />
        {{ __t('ui.desktop-shell', '新建收纳框') }}
      </PButton>
      <PButton size="sm" variant="secondary" :disabled="busy || working" @click="createFence(true)">
        {{ __t('ui.desktop-shell', '映射文件夹') }}
      </PButton>
      <template v-if="icons?.supported">
        <PButton
          v-if="!icons.hidden"
          size="sm"
          variant="ghost"
          :disabled="working"
          @click="setIconsHidden(true)"
        >
          {{ __t('ui.desktop-shell', '隐藏桌面原图标') }}
        </PButton>
        <PButton
          v-else
          size="sm"
          variant="ghost"
          :disabled="working"
          @click="setIconsHidden(false)"
        >
          {{ __t('ui.desktop-shell', '恢复桌面图标') }}
        </PButton>
      </template>
    </div>
  </section>
</template>

<style scoped>
.fence-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 12px 14px;
  border: 1px solid var(--ui-border-subtle);
  background: var(--ui-bg-surface);
}
.fence-toolbar__text h2 {
  font-size: 13px;
  font-weight: 700;
  color: var(--ui-text-secondary);
}
.fence-toolbar__text p {
  margin-top: 2px;
  font-size: 12px;
  color: var(--ui-text-tertiary);
}
.fence-toolbar__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
</style>
