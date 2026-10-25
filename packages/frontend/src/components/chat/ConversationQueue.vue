<script setup lang="ts">
import { t as __t } from '../../i18n/index'

import { computed, ref, watch } from 'vue'
import type { ConversationQueueItem, ConversationQueueSnapshot } from '@infos/shared'
import PixelIcon from '../pixel/PixelIcon.vue'
import { queueErrorMessage, queueNotice } from '../../composables/chat/queueFeedback'

const props = defineProps<{
  snapshot: ConversationQueueSnapshot
  busy: boolean
  unavailable: boolean
}>()
const emit = defineEmits<{
  change: [item: ConversationQueueItem, action: 'cancel' | 'immediate' | 'draft', content?: string]
  move: [item: ConversationQueueItem, offset: number]
  control: [paused: boolean]
}>()
const expanded = ref(true)
const pending = computed(() => props.snapshot.items.filter((item) => item.state === 'queued'))
const running = computed(() => props.snapshot.items.find((item) => item.state === 'running'))
const order = computed(() =>
  pending.value.filter((item) => item.state === 'queued' && !item.immediate),
)
const hasWaiting = computed(
  () =>
    pending.value.length > 0 &&
    Boolean(
      props.snapshot.active || running.value || props.snapshot.paused || pending.value.length > 1,
    ),
)
const notice = computed(() =>
  queueNotice(props.snapshot.paused, props.unavailable, props.snapshot.reason),
)
const labels = {
  get queued() {
    return __t('ui.chat', '待发送')
  },
  get running() {
    return __t('ui.chat', '执行中')
  },
  get draft() {
    return __t('ui.chat', '已退回编辑')
  },
  get failed() {
    return __t('ui.chat', '执行失败')
  },
  get interrupted() {
    return __t('ui.chat', '执行中断')
  },
  get completed() {
    return __t('ui.chat', '已完成')
  },
  get cancelled() {
    return __t('ui.chat', '已取消')
  },
}
watch(
  () => props.snapshot.threadId,
  () => {
    expanded.value = true
  },
)
</script>

<template>
  <section
    v-if="hasWaiting"
    class="conversation-queue"
    :aria-label="__t('ui.chat', '待发送消息队列')"
  >
    <header class="queue-heading">
      <button
        type="button"
        class="queue-heading-toggle"
        :aria-expanded="expanded"
        @click="expanded = !expanded"
      >
        <PixelIcon name="list" size="xs" />
        <strong>{{ __t('ui.chat', '消息队列') }}</strong>
        <span class="queue-count">{{ pending.length }}</span>
        <span class="queue-state">
          <PixelIcon v-if="notice" :name="notice.icon" size="xs" :animation="notice.animation" />
          {{
            unavailable
              ? __t('ui.chat', '连接恢复中')
              : snapshot.paused
                ? __t('ui.chat', '已暂停')
                : __t('ui.chat', '等待发送')
          }}
        </span>
        <span class="queue-chevron" :class="{ expanded }">⌄</span>
      </button>
      <button
        v-if="pending.some((item) => item.state === 'queued')"
        type="button"
        class="queue-control"
        :disabled="busy || unavailable"
        @click="emit('control', !snapshot.paused)"
      >
        <PixelIcon :name="snapshot.paused ? 'send' : 'pause'" size="xs" />
        {{ snapshot.paused ? __t('ui.chat', '发送') : __t('ui.chat', '暂停') }}
      </button>
    </header>
    <div v-if="expanded" class="queue-body">
      <p v-if="notice" class="queue-notice" role="status">
        <PixelIcon :name="notice.icon" size="xs" :animation="notice.animation" />
        <span>{{ notice.text }}</span>
      </p>
      <p v-if="running" class="queue-running">
        <span class="queue-pulse" />
        {{ __t('ui.chat', '正在执行：')
        }}{{
          running.input.taskResultEvent ? __t('ui.chat', '处理后台任务结果') : running.input.content
        }}
      </p>
      <TransitionGroup name="queue-item" tag="ol" class="queue-items">
        <li
          v-for="(item, index) in pending"
          :key="item.id"
          class="queue-item"
          :class="{ 'queue-item-warning': item.state !== 'queued' }"
        >
          <span class="queue-index">{{ String(index + 1).padStart(2, '0') }}</span>
          <div class="queue-item-body">
            <div class="queue-item-meta">
              <span>{{ item.immediate ? __t('ui.chat', '正在交接') : labels[item.state] }}</span>
              <span v-if="item.input.attachmentIds?.length">
                {{ item.input.attachmentIds.length }} {{ __t('ui.chat', '个附件') }}
              </span>
            </div>
            <p class="queue-content">
              {{
                item.input.taskResultEvent
                  ? __t('ui.chat', '后台任务结果已到达，等待当前对话结束后处理。')
                  : item.input.content
              }}
            </p>
            <p v-if="item.error" class="queue-error">
              <PixelIcon name="alert" size="xs" />
              {{ queueErrorMessage(item.error) }}
            </p>
            <div v-if="!item.immediate" class="queue-actions">
              <template v-if="item.state === 'queued' && !item.input.taskResultEvent">
                <button
                  type="button"
                  class="queue-immediate"
                  :disabled="busy || unavailable"
                  :title="__t('ui.chat', '立即处理（等待当前工具完成）')"
                  @click="emit('change', item, 'immediate')"
                >
                  <PixelIcon name="send" size="xs" />
                  {{ __t('ui.chat', '立即提交') }}
                </button>
                <button
                  type="button"
                  class="queue-return"
                  :disabled="busy || unavailable"
                  :title="__t('ui.chat', '退回输入栏编辑')"
                  :aria-label="__t('ui.chat', '退回输入栏编辑')"
                  @click="emit('change', item, 'draft')"
                >
                  <PixelIcon name="edit" size="xs" />
                </button>
                <button
                  type="button"
                  :disabled="busy || unavailable || order[0]?.id === item.id"
                  :title="__t('ui.chat', '上移')"
                  :aria-label="__t('ui.chat', '上移消息')"
                  @click="emit('move', item, -1)"
                >
                  <PixelIcon name="chevron-up" size="xs" />
                </button>
                <button
                  type="button"
                  :disabled="busy || unavailable || order.at(-1)?.id === item.id"
                  :title="__t('ui.chat', '下移')"
                  :aria-label="__t('ui.chat', '下移消息')"
                  @click="emit('move', item, 1)"
                >
                  <PixelIcon name="chevron-down" size="xs" />
                </button>
              </template>
              <button
                type="button"
                class="queue-remove"
                :title="
                  item.input.taskResultEvent
                    ? __t('ui.chat', '取消自动处理')
                    : __t('ui.chat', '删除待发消息')
                "
                :aria-label="
                  item.input.taskResultEvent
                    ? __t('ui.chat', '取消自动处理')
                    : __t('ui.chat', '删除待发消息')
                "
                :disabled="busy || unavailable"
                @click="emit('change', item, 'cancel')"
              >
                <PixelIcon name="trash" size="xs" />
              </button>
            </div>
          </div>
        </li>
      </TransitionGroup>
    </div>
  </section>
</template>

<style scoped>
.conversation-queue {
  margin: 0 0 8px;
  overflow: hidden;
  border: 1px solid var(--ui-border-default);
  border-left: 2px solid var(--ui-accent-purple);
  border-radius: 10px;
  background: var(--ui-bg-elevated);
  color: var(--ui-text-primary);
  font-size: 12px;
  box-shadow: var(--ui-shadow-xs);
}
.queue-heading {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
}
.queue-heading-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
  text-align: left;
}
button {
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
  border-radius: 5px;
  transition:
    background 150ms,
    color 150ms;
}
button:hover:not(:disabled) {
  background: var(--ui-bg-hover);
  color: var(--ui-accent-purple);
}
button:focus-visible {
  outline: 2px solid var(--ui-focus-color);
  outline-offset: 2px;
}
button:disabled {
  opacity: 0.4;
  cursor: default;
}
.queue-count {
  padding: 1px 6px;
  border-radius: 4px;
  color: var(--ui-accent-purple);
  background: var(--ui-accent-purple-soft);
  font-variant-numeric: tabular-nums;
}
.queue-state {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--ui-text-tertiary);
  font-size: 11px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.queue-chevron {
  margin-left: auto;
  transform: rotate(-90deg);
  transition: transform 150ms;
}
.queue-chevron.expanded {
  transform: rotate(0);
}
.queue-control {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 7px;
  color: var(--ui-accent-purple);
  white-space: nowrap;
}
.queue-body {
  padding: 0 12px 10px;
  max-height: min(32vh, 300px);
  overflow-y: auto;
  overscroll-behavior: contain;
}
.queue-items {
  padding: 0;
  margin: 0;
  list-style: none;
}
.queue-item {
  display: flex;
  gap: 10px;
  padding: 10px 0;
  border-top: 1px solid var(--ui-border-subtle);
}
.queue-index {
  padding-top: 2px;
  color: var(--ui-text-tertiary);
  font: 11px monospace;
}
.queue-item-body {
  min-width: 0;
  flex: 1;
}
.queue-item-meta {
  display: flex;
  gap: 10px;
  color: var(--ui-text-tertiary);
  font-size: 10px;
}
.queue-content {
  margin: 4px 0 6px;
  line-height: 1.65;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.queue-actions {
  display: flex;
  gap: 5px;
  flex-wrap: wrap;
}
.queue-actions button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-width: 28px;
  min-height: 26px;
  padding: 4px 7px;
  color: var(--ui-text-secondary);
}
.queue-actions .queue-immediate {
  color: var(--ui-accent-purple);
  background: var(--ui-accent-purple-soft);
}
.queue-actions .queue-remove {
  margin-left: auto;
}
.queue-notice,
.queue-error {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 4px 0 8px;
  line-height: 1.6;
  color: var(--ui-warning);
}
.queue-item-warning .queue-item-meta {
  color: var(--ui-warning);
}
.queue-running {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 2px 0 8px;
  color: var(--ui-text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.queue-pulse {
  flex: 0 0 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--ui-accent-purple);
  animation: queue-pulse 1.5s ease-in-out infinite;
}
.queue-item-move,
.queue-item-enter-active,
.queue-item-leave-active {
  transition:
    opacity 150ms,
    transform 150ms;
}
.queue-item-enter-from,
.queue-item-leave-to {
  opacity: 0;
  transform: translateY(-5px);
}
@keyframes queue-pulse {
  50% {
    opacity: 0.35;
  }
}
@media (max-width: 520px) {
  .queue-heading {
    padding: 8px;
  }
  .queue-heading-toggle {
    gap: 5px;
  }
  .queue-state {
    max-width: 100px;
  }
  .queue-body {
    padding: 0 8px 8px;
  }
  .queue-actions button {
    min-height: 32px;
  }
}
@media (prefers-reduced-motion: reduce) {
  *,
  .queue-pulse {
    animation: none;
    transition: none;
  }
}
</style>
