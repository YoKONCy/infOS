<script setup lang="ts">
import { computed } from 'vue'
import type { DesktopHomeSettings, DesktopHomeStatus } from '@infos/shared'
import { t as __t } from '../../../i18n/index'
import { useDesktopControl } from '../../../composables/useDesktopControl'
import { usePerception } from '../../../composables/usePerception'
import { MotionSkeleton } from '../../motion'
import { PButton, PixelIcon } from '../../pixel'

/**
 * 总开关和状态：一眼看清桌面操作、耳朵、陪看、感知现在是什么状态；没有感知通道时最后一格是环境事件。
 * 这里只显示状态和「停止」，开关分别位于「桌面操作」与「感知与陪伴」分区。
 */
const props = defineProps<{
  supported: boolean
  settings: DesktopHomeSettings | null
  status: DesktopHomeStatus | null
  error?: string
}>()
const emit = defineEmits<{ stop: []; desktop: [] }>()
const control = useDesktopControl()
const perception = usePerception()
const desktopOn = computed(() => control.settings.value.enabled)

interface Tile {
  id: string
  icon: string
  title: string
  state: string
  tone: 'on' | 'off' | 'live'
}
const tiles = computed<Tile[]>(() => {
  const settings = props.settings
  const status = props.status
  if (!settings) return []
  const on = __t('ui.desktop', '已开')
  const off = __t('ui.desktop', '已关')
  return [
    {
      id: 'desktop',
      icon: 'desktop',
      title: __t('ui.desktop', '桌面操作'),
      state: desktopOn.value ? on : off,
      tone: desktopOn.value ? 'on' : 'off',
    },
    {
      id: 'ears',
      icon: 'headphones',
      title: __t('ui.desktop', '耳朵'),
      state: status?.listening
        ? __t('ui.desktop', '正在听')
        : settings.ears.enabled
          ? __t('ui.desktop', '已开，没在听')
          : off,
      tone: status?.listening ? 'live' : settings.ears.enabled ? 'on' : 'off',
    },
    {
      id: 'companion',
      icon: 'eye',
      title: __t('ui.desktop', '陪看'),
      state: status?.companionTitle
        ? status.companionPaused
          ? __t('ui.desktop', '暂停中')
          : __t('ui.desktop', '正在陪你看')
        : __t('ui.desktop', '没在陪看'),
      tone: status?.companionTitle && !status.companionPaused ? 'live' : 'off',
    },
    perception.phase.value
      ? {
          id: 'perception',
          icon: 'clock',
          title: __t('ui.desktop', '感知'),
          state: perception.shortLabel.value,
          tone:
            perception.phase.value === 'running'
              ? 'live'
              : perception.phase.value === 'paused'
                ? 'on'
                : 'off',
        }
      : {
          id: 'environment',
          icon: 'clock',
          title: __t('ui.desktop', '环境事件'),
          state: settings.environment.enabled ? on : off,
          tone: settings.environment.enabled ? 'on' : 'off',
        },
  ]
})
</script>

<template>
  <section class="home-overview" :aria-label="__t('ui.desktop', '现在的状态')">
    <p v-if="!supported" class="home-overview-note">
      {{
        __t(
          'ui.desktop',
          '浏览器可管理共享空间、授权记录和保护设置。',
        )
      }}
    </p>
    <MotionSkeleton v-else-if="!settings && !error" variant="card" :rows="1" />
    <template v-else-if="settings">
      <ul class="home-overview-tiles motion-enter-children">
        <li
          v-for="(tile, index) in tiles"
          :key="tile.id"
          :class="`is-${tile.tone}`"
          :style="{ '--motion-index': index }"
        >
          <PixelIcon :name="tile.icon" size="sm" class="home-overview-icon" />
          <span class="home-overview-text">
            <span class="home-overview-title">{{ tile.title }}</span>
            <span class="home-overview-state">
              <i aria-hidden="true" />
              {{ tile.state }}
            </span>
          </span>
          <PButton
            v-if="tile.id === 'ears' && status?.listening"
            size="sm"
            variant="ghost"
            @click="emit('stop')"
          >
            {{ __t('ui.desktop', '停止') }}
          </PButton>
        </li>
      </ul>
      <Transition name="motion-rise">
        <p v-if="!desktopOn" class="home-overview-warn" role="status">
          {{
            __t(
              'ui.desktop',
              '桌面操作已关闭，屏幕观察、鼠标键盘操作与环境记录暂停。',
            )
          }}
          <button type="button" @click="emit('desktop')">{{ __t('ui.desktop', '前往桌面操作') }}</button>
        </p>
      </Transition>
    </template>
  </section>
</template>

<style scoped>
.home-overview {
  flex: 0 0 auto;
  margin: 0 24px 16px;
}
.home-overview-tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(128px, 1fr));
  gap: 0;
  list-style: none;
  padding: 0;
  border: 1px solid var(--ui-border-default);
  background: var(--ui-bg-surface-soft);
}
.home-overview-tiles li {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 10px;
  min-width: 0;
  padding: 10px 12px;
  border-right: 1px solid var(--ui-border-subtle);
  color: var(--ui-text-primary);
  transition: border-color var(--motion-duration-medium) var(--motion-ease-out);
}
.home-overview-tiles li.is-live {
  background: color-mix(in srgb, var(--ui-success) 5%, transparent);
}
.home-overview-tiles li:last-child {
  border-right: 0;
}
.home-overview-icon {
  flex-shrink: 0;
  color: var(--ui-text-secondary);
}
.home-overview-text {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}
.home-overview-title {
  color: var(--ui-text-tertiary);
  font: 11px/1.5 var(--ui-font-pixel);
}
.home-overview-state {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--ui-text-secondary);
  font-size: 11px;
}
.home-overview-state i {
  width: 4px;
  height: 4px;
  flex-shrink: 0;
  background: var(--ui-text-tertiary);
}
.is-on .home-overview-state i {
  background: var(--ui-accent-sky);
}
.is-live .home-overview-state i {
  background: var(--ui-success);
}
.home-overview-note,
.home-overview-warn {
  padding: 8px 12px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--ui-text-primary);
  background: var(--ui-bg-surface-soft);
  border: 1px solid var(--ui-border-subtle);
}
.home-overview-warn {
  margin-top: 8px;
  border-color: color-mix(in srgb, var(--ui-warning) 45%, transparent);
  background: color-mix(in srgb, var(--ui-warning) 8%, transparent);
}
.home-overview-warn button {
  margin-left: 8px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--ui-accent-primary);
  font: inherit;
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 3px;
}
@container desktop-home (max-width: 800px) {
  .home-overview {
    margin-inline: 16px;
  }
  .home-overview-tiles {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .home-overview-tiles li:nth-child(n + 3) {
    border-top: 1px solid var(--ui-border-subtle);
  }
  .home-overview-tiles li:nth-child(2n) {
    border-right: 0;
  }
}
</style>
