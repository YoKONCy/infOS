<script setup lang="ts">
import { t as __t } from '../../../i18n/index'

/**
 * FenceToolbar — 「桌面卡片」页里的收纳框预制件工具栏
 *
 * - 新建收纳框，或选一个文件夹映射成收纳框；框里只引用路径，不移动用户文件；
 * - 「隐藏桌面原图标」：可选，默认关闭，随时一键恢复。由资源管理器自带切换命令完成，完全可还原；
 *   这是系统设置，只能由用户在这里操作，Agent 工具不能改。
 *
 * @see .docs/P11_DESKTOP_PREFABS.md
 */
import { onMounted, ref } from 'vue'
import { DESKTOP_PREFAB_ADMIN_CHANNELS, type DesktopIconsState } from '@infos/shared'
import { PixelIcon } from '../../pixel'
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
    <div class="fence-toolbar__lead">
      <span class="fence-toolbar__icon" aria-hidden="true">
        <PixelIcon name="folder" size="md" />
      </span>
      <div class="fence-toolbar__text">
        <div class="fence-toolbar__title-row">
          <h2>{{ __t('ui.desktop-shell', '收纳框') }}</h2>
          <span class="fence-toolbar__tag">{{ __t('ui.desktop-shell', '桌面预制件') }}</span>
        </div>
        <p>
          {{
            __t(
              'ui.desktop-shell',
              '把桌面图标分组收进半透明的框里，可折叠、置顶、拖动和缩放；框里只是引用，不会移动文件。',
            )
          }}
        </p>
      </div>
    </div>

    <div class="fence-toolbar__actions">
      <button
        type="button"
        class="fence-btn fence-btn--primary"
        :disabled="busy || working"
        @click="createFence(false)"
      >
        <span class="fence-btn__emblem" aria-hidden="true">
          <PixelIcon name="plus" size="xs" />
        </span>
        <span class="fence-btn__label">{{ __t('ui.desktop-shell', '新建收纳框') }}</span>
      </button>

      <button
        type="button"
        class="fence-btn"
        :disabled="busy || working"
        @click="createFence(true)"
      >
        <span class="fence-btn__emblem" aria-hidden="true">
          <PixelIcon name="folder" size="xs" />
        </span>
        <span class="fence-btn__label">{{ __t('ui.desktop-shell', '映射文件夹') }}</span>
      </button>

      <template v-if="icons?.supported">
        <span class="fence-toolbar__sep" aria-hidden="true" />
        <button
          type="button"
          class="fence-btn"
          :class="{ 'fence-btn--toggled': icons.hidden }"
          :disabled="working"
          :aria-pressed="icons.hidden"
          @click="setIconsHidden(!icons.hidden)"
        >
          <span class="fence-btn__emblem" aria-hidden="true">
            <PixelIcon name="eye" size="xs" />
          </span>
          <span class="fence-btn__label">
            {{
              icons.hidden
                ? __t('ui.desktop-shell', '恢复桌面图标')
                : __t('ui.desktop-shell', '隐藏桌面原图标')
            }}
          </span>
        </button>
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
  gap: 14px;
  padding: 13px 16px;
  border-radius: 0;
  border: 1px solid var(--cards-border, var(--ui-border-default));
  border-left: 2px solid var(--ui-accent-sky);
  background: var(--cards-surface, var(--ui-bg-surface));
  box-shadow: var(--cards-panel-shadow, none);
}

.fence-toolbar__lead {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1 1 320px;
  min-width: 0;
}

.fence-toolbar__icon {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  border-radius: 0;
  border: 1px solid var(--cards-border, var(--ui-border-default));
  background: var(--cards-inset-bg, var(--ui-bg-surface-soft));
  color: var(--ui-accent-sky);
}

.fence-toolbar__text {
  min-width: 0;
}

.fence-toolbar__title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.fence-toolbar__text h2 {
  margin: 0;
  font-family: var(--ui-font-pixel);
  font-size: 13px;
  font-weight: 800;
  color: var(--ui-text-primary);
}

.fence-toolbar__tag {
  padding: 1px 6px;
  border-radius: 0;
  border: 1px solid var(--cards-border, var(--ui-border-subtle));
  background: var(--cards-inset-bg, var(--ui-bg-surface-soft));
  font-family: var(--ui-font-pixel);
  font-size: 10px;
  color: var(--ui-text-tertiary);
}

.fence-toolbar__text p {
  margin: 3px 0 0;
  font-size: 12px;
  line-height: 1.45;
  color: var(--ui-text-secondary);
}

/* ── 硬朗哑光双仓机械按钮组 ── */
.fence-toolbar__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 7px;
}

.fence-toolbar__sep {
  width: 1px;
  height: 18px;
  background: var(--cards-border, var(--ui-border-default));
}

.fence-btn {
  --btn-accent: var(--ui-text-tertiary);
  display: inline-flex;
  align-items: center;
  justify-content: flex-start;
  gap: 0;
  height: 30px;
  padding: 0;
  border-radius: 0;
  border: 1px solid var(--cards-key-border, var(--ui-border-default));
  background: var(--cards-key-bg, var(--ui-bg-surface));
  box-shadow: var(--cards-key-shadow, none);
  color: var(--ui-text-secondary);
  font-family: var(--ui-font-pixel);
  font-size: 11px;
  white-space: nowrap;
  cursor: pointer;
  transition:
    background-color 140ms ease,
    border-color 140ms ease,
    color 140ms ease;
}

.fence-btn__emblem {
  display: grid;
  flex: 0 0 28px;
  align-self: stretch;
  place-items: center;
  border-right: 1px solid var(--ui-border-subtle);
  background: color-mix(in srgb, var(--btn-accent) 6%, transparent);
  color: var(--btn-accent);
}

.fence-btn__label {
  padding: 0 10px;
}

.fence-btn:hover:not(:disabled) {
  --btn-accent: var(--ui-accent-sky);
  background: color-mix(
    in srgb,
    var(--ui-accent-sky) 7%,
    var(--cards-key-bg, var(--ui-bg-surface))
  );
  border-color: var(--ui-accent-sky);
  color: var(--ui-accent-sky);
}

.fence-btn:active:not(:disabled) {
  transform: translate(1px, 1px);
  box-shadow: inset 1px 1px 0 var(--cards-step-shadow, rgba(0, 0, 0, 0.25));
}

.fence-btn:disabled {
  opacity: 0.48;
  cursor: not-allowed;
}

/* 主操作按钮：仅强化左图标微槽与锐利边框，保持哑光主体无油腻渐变 */
.fence-btn--primary {
  --btn-accent: var(--ui-accent-sky);
  border-color: color-mix(
    in srgb,
    var(--ui-accent-sky) 44%,
    var(--cards-key-border, var(--ui-border-default))
  );
  color: var(--ui-text-primary);
}

.fence-btn--primary .fence-btn__emblem {
  background: color-mix(in srgb, var(--ui-accent-sky) 11%, transparent);
}

/* 桌面图标已隐藏时的琥珀指示态 */
.fence-btn--toggled {
  --btn-accent: var(--ui-warning);
  border-color: color-mix(
    in srgb,
    var(--ui-warning) 48%,
    var(--cards-key-border, var(--ui-border-default))
  );
  color: var(--ui-warning);
}

.fence-btn--toggled:hover:not(:disabled) {
  --btn-accent: var(--ui-warning);
  border-color: var(--ui-warning);
  color: var(--ui-warning);
  background: color-mix(in srgb, var(--ui-warning) 8%, var(--cards-key-bg, var(--ui-bg-surface)));
}
</style>
