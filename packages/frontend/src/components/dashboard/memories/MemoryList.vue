<script setup lang="ts">
import { getDisplayLocale } from '../../../i18n/index'

import { t as __t } from '../../../i18n/index'

/**
 * MemoryList — 记忆档案列表
 *
 * 按日期分组的时间轨道 + 紧凑档案条目。
 * 每条：事件时间 / 叙事（2行截断）/ 主题标签 / 元信息行 / 重要度刻度。
 */
import { computed } from 'vue'
import type { EventNote } from '@infos/shared'
import { PixelIcon, PButton, PEmpty } from '../../pixel'

const props = defineProps<{
  items: EventNote[]
  selectedId: string | null
  isLoading: boolean
  page: number
  pageCount: number
  pageSize: number
  total: number
  checkedIds?: string[]
}>()

const emit = defineEmits<{
  select: [note: EventNote]
  page: [target: number]
  toggle: [id: string]
  restore: [note: EventNote]
}>()

interface DayGroup {
  date: string
  weekday: string
  notes: EventNote[]
}

const grouped = computed<DayGroup[]>(() => {
  const weekdays = [
    __t('ui.settings', '日'),
    __t('ui.settings', '一'),
    __t('ui.settings', '二'),
    __t('ui.settings', '三'),
    __t('ui.settings', '四'),
    __t('ui.settings', '五'),
    __t('ui.settings', '六'),
  ]
  const map = new Map<string, DayGroup>()
  for (const note of props.items) {
    const date = new Date(note.eventAt)
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    let group = map.get(key)
    if (!group) {
      group = {
        date: key,
        get weekday() {
          return __t('ui.settings', '周{0}', [weekdays[date.getDay()] ?? '?'])
        },
        notes: [],
      }
      map.set(key, group)
    }
    group.notes.push(note)
  }
  return [...map.values()]
})

function formatClock(value: string): string {
  return new Date(value).toLocaleTimeString(getDisplayLocale(), {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

/** 重要度 → 0-5 级刻度 */
function importanceLevel(importance: number): number {
  return Math.max(1, Math.min(5, Math.round(importance / 2)))
}

const pageStart = computed(() => (props.total === 0 ? 0 : (props.page - 1) * props.pageSize + 1))
const pageEnd = computed(() => Math.min(props.page * props.pageSize, props.total))
</script>

<template>
  <div class="memory-list">
    <div v-if="isLoading && !items.length" class="list-loading">
      <PixelIcon name="refresh" size="sm" animation="spin" />
      <span class="font-pixel">{{ __t('ui.settings', '读取记忆档案...') }}</span>
    </div>

    <PEmpty
      v-else-if="!items.length"
      :description="__t('ui.settings', '没有匹配的记忆')"
      class="list-empty"
    />

    <div v-else class="list-scroll">
      <section v-for="group in grouped" :key="group.date" class="day-group">
        <div class="day-header">
          <span class="day-date font-pixel">{{ group.date }}</span>
          <span class="day-weekday">{{ group.weekday }}</span>
          <span class="day-count">{{ group.notes.length }} {{ __t('ui.settings', '条') }}</span>
        </div>

        <div class="day-body">
          <article
            v-for="note in group.notes"
            :key="note.id"
            :class="[
              'entry',
              {
                'entry-selected': note.id === selectedId,
                'entry-archived': note.status === 'archived',
              },
            ]"
            @click="emit('select', note)"
          >
            <div class="entry-rail">
              <input
                type="checkbox"
                :checked="checkedIds?.includes(note.id)"
                :aria-label="__t('ui.settings', '选择记忆')"
                @click.stop
                @change="emit('toggle', note.id)"
              />
              <span class="entry-dot" />
              <span class="entry-clock font-pixel">{{ formatClock(note.eventAt) }}</span>
            </div>

            <div class="entry-main">
              <p class="entry-narrative">{{ note.narrative }}</p>
              <div v-if="note.topics.length" class="entry-topics">
                <span v-for="topic in note.topics.slice(0, 4)" :key="topic" class="entry-topic">
                  #{{ topic }}
                </span>
                <span v-if="note.topics.length > 4" class="entry-topic-more">
                  +{{ note.topics.length - 4 }}
                </span>
              </div>
              <div class="entry-meta">
                <span class="meta-item">
                  <PixelIcon name="chat" size="xs" />
                  {{ note.origin.channel }}
                </span>
                <span class="meta-item">
                  <PixelIcon
                    :name="note.origin.mode === 'active' ? 'pencil' : 'thought'"
                    size="xs"
                  />
                  {{
                    note.origin.mode === 'active'
                      ? __t('ui.settings', '主动记事')
                      : __t('ui.settings', '后台炼化')
                  }}
                </span>
                <span v-if="note.participants.length" class="meta-item">
                  <PixelIcon name="user" size="xs" />
                  {{ note.participants.slice(0, 2).join('、')
                  }}{{ note.participants.length > 2 ? ` +${note.participants.length - 2}` : '' }}
                </span>
                <span v-if="note.status === 'archived'" class="meta-item meta-archived">
                  {{ __t('ui.settings', '已归档') }}
                </span>
              </div>
            </div>

            <PButton
              v-if="note.status === 'archived'"
              size="sm"
              variant="ghost"
              @click.stop="emit('restore', note)"
            >
              <PixelIcon name="refresh" size="xs" />
              {{ __t('ui.settings', '恢复') }}
            </PButton>
            <div
              class="entry-importance"
              :title="__t('ui.settings', '重要度 {0}/10', [note.importance])"
            >
              <span
                v-for="level in 5"
                :key="level"
                :class="[
                  'importance-tick',
                  { 'importance-tick-on': level <= importanceLevel(note.importance) },
                ]"
              />
              <span class="importance-value font-pixel">{{ note.importance }}</span>
            </div>
          </article>
        </div>
      </section>

      <!-- 分页 -->
      <div class="pagination">
        <PButton variant="ghost" size="sm" :disabled="page <= 1" @click="emit('page', page - 1)">
          <PixelIcon name="chevron-down" size="xs" class="rotate-90" />
          {{ __t('ui.settings', '上一页') }}
        </PButton>
        <span class="pagination-info font-pixel">
          {{ __t('ui.settings', '第') }} {{ page }} / {{ pageCount }}
          {{ __t('ui.settings', '页 ·') }} {{ pageStart }}-{{ pageEnd }} / {{ total }}
        </span>
        <PButton
          variant="ghost"
          size="sm"
          :disabled="page >= pageCount"
          @click="emit('page', page + 1)"
        >
          {{ __t('ui.settings', '下一页') }}
          <PixelIcon name="chevron-down" size="xs" class="-rotate-90" />
        </PButton>
      </div>
    </div>
  </div>
</template>

<style scoped>
.memory-list {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.list-loading,
.list-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--ui-text-tertiary, #94a3b8);
  font-size: 12px;
}

.list-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-right: 6px;
}

.day-group {
  margin-bottom: 20px;
}

.day-header {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 10px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--ui-border-default, #e2e8f0);
}

.day-date {
  font-size: 13px;
  font-weight: 700;
  color: var(--ui-text-primary, #1e293b);
}

.day-weekday {
  font-size: 10px;
  color: var(--ui-text-tertiary, #94a3b8);
}

.day-count {
  margin-left: auto;
  font-size: 10px;
  font-family: var(--ui-font-mono, monospace);
  color: var(--ui-text-tertiary, #94a3b8);
}

.entry {
  position: relative;
  display: flex;
  gap: 12px;
  padding: 10px 12px 10px 10px;
  margin-bottom: 8px;
  background: var(--ui-bg-elevated, #fff);
  border: 1px solid var(--ui-border-default, #e2e8f0);
  border-left: 3px solid transparent;
  cursor: pointer;
  transition: all 0.15s;
}

.entry:hover {
  border-left-color: #7dd3fc;
  transform: translateX(2px);
}

.entry-selected {
  border-color: #a78bfa;
  border-left-color: #8b5cf6;
  background: rgba(139, 92, 246, 0.05);
  box-shadow: 2px 2px 0 rgba(139, 92, 246, 0.15);
}

.entry-archived {
  opacity: 0.55;
}

.entry-rail {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  width: 46px;
  flex-shrink: 0;
}

.entry-dot {
  width: 7px;
  height: 7px;
  background: #0ea5e9;
  box-shadow: 0 0 0 2px rgba(14, 165, 233, 0.2);
}

.entry-archived .entry-dot {
  background: #94a3b8;
  box-shadow: 0 0 0 2px rgba(148, 163, 184, 0.2);
}

.entry-clock {
  font-size: 9px;
  color: var(--ui-text-tertiary, #94a3b8);
}

.entry-main {
  flex: 1;
  min-width: 0;
}

.entry-narrative {
  margin: 0;
  font-size: 12px;
  line-height: 1.65;
  color: var(--ui-text-primary, #1e293b);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
}

.entry-topics {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 6px;
}

.entry-topic {
  font-size: 10px;
  color: #0284c7;
}

.entry-topic-more {
  font-size: 10px;
  color: var(--ui-text-tertiary, #94a3b8);
}

.entry-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 6px;
}

.meta-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  color: var(--ui-text-tertiary, #94a3b8);
}

.meta-archived {
  padding: 0 5px;
  font-weight: 700;
  color: #b45309;
  background: rgba(245, 158, 11, 0.12);
  border: 1px solid rgba(245, 158, 11, 0.35);
}

.entry-importance {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
  flex-shrink: 0;
  padding-top: 2px;
}

.importance-tick {
  width: 14px;
  height: 3px;
  background: var(--ui-border-default, #e2e8f0);
}

.importance-tick-on {
  background: #8b5cf6;
}

.importance-value {
  margin-top: 3px;
  font-size: 9px;
  color: var(--ui-text-tertiary, #94a3b8);
}

.pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 14px 0 4px;
  border-top: 1px solid var(--ui-border-default, #e2e8f0);
  margin-top: 6px;
}

.pagination-info {
  font-size: 10px;
  color: var(--ui-text-tertiary, #94a3b8);
}

.rotate-90 {
  transform: rotate(90deg);
}

.-rotate-90 {
  transform: rotate(-90deg);
}
</style>
