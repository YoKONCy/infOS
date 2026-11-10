<script setup lang="ts">
import { t as __t } from '../../../i18n/index'

/**
 * CardTile — 「卡片」页里的一张卡片：缩略图、名称、创建时间、状态与操作。
 *
 * 只负责显示与发出操作事件，实际改动由 CardsTab 经主进程管理通道完成。
 * 最近关闭的卡片显示过期时间，操作收窄为「收藏捡回 / 打开 / 删除」。
 */
import { computed } from 'vue'
import type { DesktopCardListItem } from '@infos/shared'
import { PButton, PixelIcon } from '../../pixel'

const props = defineProps<{ card: DesktopCardListItem; busy: boolean; recent?: boolean }>()
const emit = defineEmits<{
  open: []
  close: []
  save: [saved: boolean]
  pin: [pinned: boolean]
  autoOpen: [enabled: boolean]
  rename: []
  source: []
  remove: []
}>()

/** 时间按当前界面语言显示到分钟。 */
function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

const created = computed(() =>
  __t('ui.desktop-shell', '创建于 {0}', [formatTime(props.card.createdAt)]),
)
const expires = computed(() =>
  props.card.expiresAt
    ? __t('ui.desktop-shell', '{0} 后清理', [formatTime(props.card.expiresAt)])
    : '',
)
</script>

<template>
  <article class="card-tile" :class="{ 'card-tile--recent': recent }">
    <div class="card-tile__thumb">
      <img v-if="card.thumbnail" :src="card.thumbnail" :alt="card.name" />
      <PixelIcon v-else name="layout" size="xl" />
      <span v-if="card.open" class="card-tile__live">{{ __t('ui.desktop-shell', '已打开') }}</span>
    </div>
    <div class="card-tile__body">
      <h3 :title="card.name">{{ card.name }}</h3>
      <p>{{ created }}</p>
      <p v-if="recent" class="card-tile__expires">{{ expires }}</p>
      <div v-else class="card-tile__tags">
        <span v-if="card.saved">{{ __t('ui.desktop-shell', '已收藏') }}</span>
        <span v-else>{{ __t('ui.desktop-shell', '临时') }}</span>
        <span v-if="card.alwaysOnTop">{{ __t('ui.desktop-shell', '置顶') }}</span>
        <span v-if="card.autoOpen">{{ __t('ui.desktop-shell', '开机打开') }}</span>
      </div>
    </div>
    <div class="card-tile__actions">
      <PButton
        v-if="card.open"
        size="sm"
        variant="secondary"
        :disabled="busy"
        @click="emit('close')"
      >
        {{ __t('ui.desktop-shell', '关闭') }}
      </PButton>
      <PButton v-else size="sm" variant="secondary" :disabled="busy" @click="emit('open')">
        {{ __t('ui.desktop-shell', '打开') }}
      </PButton>
      <PButton size="sm" variant="ghost" :disabled="busy" @click="emit('save', !card.saved)">
        <PixelIcon name="star" size="xs" />
        {{
          card.saved
            ? __t('ui.desktop-shell', '取消收藏')
            : recent
              ? __t('ui.desktop-shell', '收藏捡回')
              : __t('ui.desktop-shell', '收藏')
        }}
      </PButton>
      <template v-if="!recent">
        <PButton size="sm" variant="ghost" :disabled="busy" @click="emit('pin', !card.alwaysOnTop)">
          {{
            card.alwaysOnTop ? __t('ui.desktop-shell', '取消置顶') : __t('ui.desktop-shell', '置顶')
          }}
        </PButton>
        <PButton
          size="sm"
          variant="ghost"
          :disabled="busy"
          :title="__t('ui.desktop-shell', '启动 infOS 时自动打开（会一并收藏）')"
          @click="emit('autoOpen', !card.autoOpen)"
        >
          {{
            card.autoOpen
              ? __t('ui.desktop-shell', '取消开机打开')
              : __t('ui.desktop-shell', '开机打开')
          }}
        </PButton>
        <PButton size="sm" variant="ghost" :disabled="busy" @click="emit('rename')">
          {{ __t('ui.desktop-shell', '改名') }}
        </PButton>
      </template>
      <PButton size="sm" variant="ghost" :disabled="busy" @click="emit('source')">
        {{ __t('ui.desktop-shell', '源码') }}
      </PButton>
      <PButton size="sm" variant="ghost" :disabled="busy" @click="emit('remove')">
        <PixelIcon name="trash" size="xs" />
        {{ __t('ui.desktop-shell', '删除') }}
      </PButton>
    </div>
  </article>
</template>

<style scoped>
.card-tile {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  padding: 10px;
  border: 1px solid var(--ui-border-subtle);
  border-radius: var(--ui-radius-sm);
  background: var(--ui-bg-surface);
}
.card-tile--recent {
  background: var(--ui-bg-surface-soft);
}
.card-tile__thumb {
  position: relative;
  display: grid;
  place-items: center;
  aspect-ratio: 16 / 10;
  overflow: hidden;
  border: 1px solid var(--ui-border-subtle);
  background: var(--ui-bg-canvas);
  color: var(--ui-text-tertiary);
}
.card-tile__thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: top;
}
.card-tile__live {
  position: absolute;
  top: 6px;
  left: 6px;
  padding: 1px 6px;
  font-size: 10px;
  color: var(--ui-text-primary);
  background: var(--ui-accent-sky-soft);
}
.card-tile__body {
  min-width: 0;
}
.card-tile__body h3 {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 700;
  color: var(--ui-text-primary);
}
.card-tile__body p {
  font-size: 11px;
  color: var(--ui-text-tertiary);
}
.card-tile__expires {
  color: var(--ui-warning) !important;
}
.card-tile__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}
.card-tile__tags span {
  padding: 0 6px;
  font-size: 10px;
  color: var(--ui-text-secondary);
  border: 1px solid var(--ui-border-default);
}
.card-tile__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
</style>
