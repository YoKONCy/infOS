<script setup lang="ts">
/**
 * 世界书条目行 — 折叠时只显示一行常用字段，展开后才渲染关键词、正文等编辑器，
 * 避免数百条目同时挂载大量输入框。所有修改以补丁形式交给父组件，由父组件统一标记未保存。
 */
import { computed, ref } from 'vue'
import {
  WORLDBOOK_CHANNELS,
  WORLDBOOK_LIMITS,
  normalizeWorldbookKeys,
  type WorldbookChannel,
  type WorldbookEntry,
} from '@infos/shared'
import { t as __t } from '../../../i18n/index'
import { PCheckbox, PixelIcon } from '../../pixel'
import WorldbookPopover from './WorldbookPopover.vue'

export type WorldbookTriggerState = 'constant' | 'keyword' | 'off'

const props = defineProps<{
  entry: WorldbookEntry
  expanded: boolean
  /** 当前排序与筛选下是否允许拖动。 */
  sortable: boolean
  /** 拖动经过本行时高亮。 */
  dropTarget: boolean
  /** 是否还有其他书可移动到。 */
  canMove: boolean
}>()
const emit = defineEmits<{
  update: [patch: Partial<WorldbookEntry>]
  /** 关键词、数字等尚未提交的输入，用于提前标记未保存。 */
  pending: []
  toggle: []
  copy: []
  move: []
  remove: []
  dragstart: [event: DragEvent]
  dragend: []
  dragover: []
  drop: []
}>()

const triggerMenu = ref(false)
const triggerAnchor = ref<HTMLElement | null>(null)
const keyDraft = ref('')

const state = computed<WorldbookTriggerState>(() =>
  !props.entry.enabled ? 'off' : props.entry.light === 'constant' ? 'constant' : 'keyword',
)
const triggerStates: Array<{ id: WorldbookTriggerState; label: () => string; hint: () => string }> =
  [
    {
      id: 'constant',
      label: () => __t('ui.worldbook', '蓝灯'),
      hint: () => __t('ui.worldbook', '常驻：始终注入'),
    },
    {
      id: 'keyword',
      label: () => __t('ui.worldbook', '绿灯'),
      hint: () => __t('ui.worldbook', '关键词：对话中出现关键词时注入'),
    },
    {
      id: 'off',
      label: () => __t('ui.worldbook', '关闭'),
      hint: () => __t('ui.worldbook', '不参与激活'),
    },
  ]
const currentState = computed(() => triggerStates.find((item) => item.id === state.value)!)

/** 关闭只改 enabled，保留原来的蓝绿灯，重新开启时恢复。 */
function setState(next: WorldbookTriggerState) {
  triggerMenu.value = false
  if (next === 'off') emit('update', { enabled: false })
  else emit('update', { enabled: true, light: next })
}
function cycleState() {
  setState(state.value === 'constant' ? 'keyword' : state.value === 'keyword' ? 'off' : 'constant')
}

const channelLabels: Record<WorldbookChannel, () => string> = {
  desktop: () => __t('ui.worldbook', '桌面'),
  group: () => __t('ui.worldbook', '据点群聊'),
  social_private: () => __t('ui.worldbook', '社交私聊'),
  social_group: () => __t('ui.worldbook', '社交群聊'),
}
function toggleChannel(channel: WorldbookChannel, checked: boolean) {
  const set = new Set(props.entry.channels)
  if (checked) set.add(channel)
  else set.delete(channel)
  emit('update', { channels: WORLDBOOK_CHANNELS.filter((item) => set.has(item)) })
}

/** 数字输入在提交（失焦或回车）时才写回，避免输入顺序值时条目在列表中跳动。 */
function commitNumber(
  field: 'order' | 'probability' | 'sticky',
  event: Event,
  min: number,
  max: number,
) {
  const input = event.target as HTMLInputElement
  const value = Number(input.value)
  if (input.value.trim() === '' || !Number.isFinite(value)) {
    input.value = String(props.entry[field])
    return
  }
  const next = Math.min(max, Math.max(min, Math.trunc(value)))
  input.value = String(next)
  if (next !== props.entry[field]) emit('update', { [field]: next } as Partial<WorldbookEntry>)
}

function commitKeys() {
  if (!keyDraft.value.trim()) return
  const keys = normalizeWorldbookKeys([...props.entry.keys, ...keyDraft.value.split(/[,，]/)])
  keyDraft.value = ''
  emit('update', { keys })
}
function onKeyInput(event: KeyboardEvent) {
  if (event.key === 'Enter' || event.key === ',' || event.key === '，') {
    event.preventDefault()
    commitKeys()
  } else if (event.key === 'Backspace' && !keyDraft.value && props.entry.keys.length) {
    emit('update', { keys: props.entry.keys.slice(0, -1) })
  }
}
function removeKey(key: string) {
  emit('update', { keys: props.entry.keys.filter((item) => item !== key) })
}

const noKeys = computed(() => state.value === 'keyword' && !props.entry.keys.length)
</script>

<template>
  <div
    class="wb-row"
    :class="{ off: state === 'off', expanded, 'drop-target': dropTarget }"
    :data-entry-id="entry.id"
    @dragover.prevent="sortable && emit('dragover')"
    @drop.prevent="sortable && emit('drop')"
  >
    <div class="wb-row__main">
      <button
        class="wb-row__icon wb-row__handle"
        type="button"
        :draggable="sortable"
        :disabled="!sortable"
        :title="
          sortable
            ? __t('ui.worldbook', '拖动排序')
            : __t('ui.worldbook', '仅在自定义排序且未搜索时可拖动')
        "
        :aria-label="__t('ui.worldbook', '拖动排序')"
        @dragstart="emit('dragstart', $event)"
        @dragend="emit('dragend')"
      >
        ⠿
      </button>
      <button
        class="wb-row__icon"
        type="button"
        :aria-expanded="expanded"
        :aria-label="expanded ? __t('ui.worldbook', '折叠') : __t('ui.worldbook', '展开')"
        @click="emit('toggle')"
      >
        <PixelIcon :name="expanded ? 'chevron-down' : 'chevron-right'" size="sm" />
      </button>

      <div ref="triggerAnchor" class="wb-trigger" :class="`wb-trigger--${state}`">
        <button
          type="button"
          class="wb-trigger__main"
          :title="`${currentState.hint()} · ${__t('ui.worldbook', '点击切换')}`"
          @click="cycleState"
        >
          <span class="wb-trigger__dot" aria-hidden="true" />
          {{ currentState.label() }}
        </button>
        <button
          type="button"
          class="wb-trigger__caret"
          :aria-label="__t('ui.worldbook', '选择触发策略')"
          aria-haspopup="menu"
          :aria-expanded="triggerMenu"
          @click="triggerMenu = !triggerMenu"
        >
          <PixelIcon name="chevron-down" size="xs" />
        </button>
      </div>
      <WorldbookPopover
        :open="triggerMenu"
        :anchor="triggerAnchor"
        :min-width="220"
        @close="triggerMenu = false"
      >
        <button
          v-for="item in triggerStates"
          :key="item.id"
          type="button"
          role="menuitemradio"
          :aria-checked="state === item.id"
          class="wb-trigger-option"
          :class="[`wb-trigger--${item.id}`, { active: state === item.id }]"
          :data-autofocus="state === item.id ? '' : undefined"
          @click="setState(item.id)"
        >
          <span class="wb-trigger__dot" aria-hidden="true" />
          <span>
            <strong>{{ item.label() }}</strong>
            <small>{{ item.hint() }}</small>
          </span>
        </button>
      </WorldbookPopover>

      <div class="wb-row__title">
        <input
          class="wb-input"
          :value="entry.title"
          :maxlength="WORLDBOOK_LIMITS.title"
          :placeholder="__t('ui.worldbook', '标题（备忘）')"
          :aria-label="__t('ui.worldbook', '标题（备忘）')"
          @input="emit('update', { title: ($event.target as HTMLInputElement).value })"
        />
        <span
          v-if="noKeys"
          class="wb-row__warn"
          :title="__t('ui.worldbook', '绿灯条目没有关键词，永远不会触发')"
        >
          <PixelIcon name="alert" size="xs" />
        </span>
      </div>

      <input
        class="wb-input wb-num"
        type="number"
        :value="entry.order"
        :min="-WORLDBOOK_LIMITS.order"
        :max="WORLDBOOK_LIMITS.order"
        :title="__t('ui.worldbook', '顺序')"
        :aria-label="__t('ui.worldbook', '顺序')"
        @input="emit('pending')"
        @change="commitNumber('order', $event, -WORLDBOOK_LIMITS.order, WORLDBOOK_LIMITS.order)"
      />
      <label class="wb-percent" :title="__t('ui.worldbook', '触发概率')">
        <input
          class="wb-input wb-num"
          type="number"
          :value="entry.probability"
          :min="0"
          :max="100"
          :aria-label="__t('ui.worldbook', '触发概率')"
          @input="emit('pending')"
          @change="commitNumber('probability', $event, 0, 100)"
        />
        <span>%</span>
      </label>
      <div class="wb-row__actions">
        <button
          class="wb-row__icon"
          type="button"
          :disabled="!canMove"
          :title="__t('ui.worldbook', '移动到其他书')"
          :aria-label="__t('ui.worldbook', '移动到其他书')"
          @click="emit('move')"
        >
          <PixelIcon name="external-link" size="sm" />
        </button>
        <button
          class="wb-row__icon"
          type="button"
          :title="__t('ui.worldbook', '复制条目')"
          :aria-label="__t('ui.worldbook', '复制条目')"
          @click="emit('copy')"
        >
          <PixelIcon name="copy" size="sm" />
        </button>
        <button
          class="wb-row__icon danger"
          type="button"
          :title="__t('ui.worldbook', '删除条目')"
          :aria-label="__t('ui.worldbook', '删除条目')"
          @click="emit('remove')"
        >
          <PixelIcon name="trash" size="sm" />
        </button>
      </div>
    </div>

    <div v-if="expanded" class="wb-row__editor">
      <div class="wb-field">
        <span class="wb-field__label">
          {{ __t('ui.worldbook', '关键词') }}
          <small>{{ entry.keys.length }} / {{ WORLDBOOK_LIMITS.keys }}</small>
        </span>
        <div class="wb-keys" :class="{ warn: noKeys }">
          <span v-for="key in entry.keys" :key="key" class="wb-key">
            {{ key }}
            <button
              type="button"
              :aria-label="__t('ui.worldbook', '移除关键词 {0}', [key])"
              @click="removeKey(key)"
            >
              ×
            </button>
          </span>
          <input
            v-model="keyDraft"
            :maxlength="WORLDBOOK_LIMITS.keyLength * 4"
            :disabled="entry.keys.length >= WORLDBOOK_LIMITS.keys"
            :placeholder="__t('ui.worldbook', '输入关键词，回车或逗号分隔')"
            :aria-label="__t('ui.worldbook', '关键词')"
            @input="emit('pending')"
            @keydown="onKeyInput"
            @blur="commitKeys"
          />
        </div>
        <p v-if="noKeys" class="wb-hint warn">
          {{ __t('ui.worldbook', '绿灯条目没有关键词，永远不会触发') }}
        </p>
        <p v-else-if="state === 'constant'" class="wb-hint">
          {{ __t('ui.worldbook', '蓝灯条目始终注入，不需要关键词') }}
        </p>
      </div>

      <label class="wb-field">
        <span class="wb-field__label">
          {{ __t('ui.worldbook', '内容') }}
          <small>{{ entry.content.length }} / {{ WORLDBOOK_LIMITS.content }}</small>
        </span>
        <textarea
          class="wb-input wb-content"
          :value="entry.content"
          :maxlength="WORLDBOOK_LIMITS.content"
          spellcheck="false"
          :placeholder="__t('ui.worldbook', '触发后注入提示词的内容')"
          @input="emit('update', { content: ($event.target as HTMLTextAreaElement).value })"
        />
      </label>

      <div class="wb-editor-grid">
        <label class="wb-field">
          <span class="wb-field__label">{{ __t('ui.worldbook', '持续轮数') }}</span>
          <input
            class="wb-input wb-num"
            type="number"
            :value="entry.sticky"
            :min="0"
            :max="WORLDBOOK_LIMITS.sticky"
            :disabled="state !== 'keyword'"
            @input="emit('pending')"
            @change="commitNumber('sticky', $event, 0, WORLDBOOK_LIMITS.sticky)"
          />
          <small class="wb-hint">
            {{
              state === 'keyword'
                ? __t('ui.worldbook', '关键词最后一次出现后继续生效的轮数，0 表示不延续')
                : __t('ui.worldbook', '仅绿灯条目可设置')
            }}
          </small>
        </label>

        <div class="wb-field wb-channels">
          <span class="wb-field__label">{{ __t('ui.worldbook', '生效场景') }}</span>
          <div class="wb-channels__list">
            <PCheckbox
              v-for="channel in WORLDBOOK_CHANNELS"
              :key="channel"
              :model-value="entry.channels.includes(channel)"
              :label="channelLabels[channel]()"
              @update:model-value="toggleChannel(channel, $event)"
            />
          </div>
          <small class="wb-hint">{{ __t('ui.worldbook', '都不勾选表示全部场景') }}</small>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wb-row {
  border-bottom: 1px solid var(--ui-border-subtle);
  transition: background-color var(--ui-duration-fast) var(--ui-ease-standard);
}
.wb-row:hover {
  background: color-mix(in srgb, var(--ui-bg-hover) 60%, transparent);
}
.wb-row.expanded {
  background: color-mix(in srgb, var(--ui-accent-sky) 5%, transparent);
}
.wb-row.drop-target {
  box-shadow: inset 0 3px 0 var(--ui-accent-sky);
}
.wb-row.off .wb-row__title .wb-input,
.wb-row.off .wb-num {
  color: var(--ui-text-tertiary);
}
.wb-row__main {
  display: grid;
  grid-template-columns: var(--wb-columns);
  align-items: center;
  gap: 8px;
  min-height: 46px;
  padding: 6px 12px;
}
.wb-row__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  color: var(--ui-text-secondary);
  transition: color var(--ui-duration-fast) var(--ui-ease-standard);
}
.wb-row__icon:hover:not(:disabled) {
  color: var(--ui-accent-sky);
}
.wb-row__icon.danger:hover:not(:disabled) {
  color: var(--ui-danger);
}
.wb-row__icon:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}
.wb-row__handle {
  font-size: 16px;
  cursor: grab;
}
.wb-row__handle:active {
  cursor: grabbing;
}
.wb-row__title {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.wb-row__title .wb-input {
  flex: 1;
  min-width: 0;
}
.wb-row__warn {
  display: inline-flex;
  color: var(--ui-warning);
  flex-shrink: 0;
}
.wb-row__actions {
  display: flex;
  justify-content: flex-end;
}

/* 触发策略：单一三态控件，颜色直接对应蓝灯、绿灯、关闭。 */
.wb-trigger {
  --wb-light: var(--ui-text-tertiary);
  display: flex;
  align-items: stretch;
  height: 32px;
  border: 1px solid color-mix(in srgb, var(--wb-light) 55%, var(--ui-border-default));
  background: color-mix(in srgb, var(--wb-light) 10%, transparent);
  transition:
    border-color var(--ui-duration-fast) var(--ui-ease-standard),
    background-color var(--ui-duration-fast) var(--ui-ease-standard);
}
.wb-trigger--constant {
  --wb-light: var(--ui-accent-sky);
}
.wb-trigger--keyword {
  --wb-light: var(--ui-success);
}
.wb-trigger--off {
  --wb-light: var(--ui-text-tertiary);
}
.wb-trigger__main {
  display: flex;
  align-items: center;
  gap: 7px;
  flex: 1;
  min-width: 0;
  padding: 0 8px;
  font: 700 12px/1 var(--ui-font-pixel);
  color: var(--ui-text-primary);
  white-space: nowrap;
}
.wb-trigger--off .wb-trigger__main {
  color: var(--ui-text-tertiary);
}
.wb-trigger__caret {
  display: inline-flex;
  align-items: center;
  padding: 0 5px;
  border-left: 1px solid color-mix(in srgb, var(--wb-light) 40%, transparent);
  color: var(--ui-text-secondary);
}
.wb-trigger__main:hover,
.wb-trigger__caret:hover {
  background: color-mix(in srgb, var(--wb-light) 14%, transparent);
}
.wb-trigger__dot {
  flex-shrink: 0;
  width: 9px;
  height: 9px;
  background: var(--wb-light);
  box-shadow: 0 0 6px color-mix(in srgb, var(--wb-light) 70%, transparent);
}
.wb-trigger--off .wb-trigger__dot {
  background: transparent;
  border: 2px solid var(--wb-light);
  box-shadow: none;
}
.wb-trigger-option {
  --wb-light: var(--ui-text-tertiary);
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  text-align: left;
  color: var(--ui-text-secondary);
}
.wb-trigger-option > span:last-child {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.wb-trigger-option strong {
  font: 700 12px/1.3 var(--ui-font-pixel);
  color: var(--ui-text-primary);
}
.wb-trigger-option small {
  font-size: 11px;
  color: var(--ui-text-tertiary);
}
.wb-trigger-option:hover,
.wb-trigger-option.active {
  background: color-mix(in srgb, var(--wb-light) 12%, transparent);
}

/* 展开后的编辑区 */
.wb-row__editor {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 6px 16px 18px 82px;
}
.wb-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.wb-field__label {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font: 700 12px/1.4 var(--ui-font-pixel);
  color: var(--ui-text-secondary);
}
.wb-field__label small {
  font: 400 11px/1 var(--ui-font-mono);
  color: var(--ui-text-tertiary);
}
.wb-keys {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-height: 36px;
  padding: 5px 8px;
  background: var(--dash-input-bg);
  border: 1px solid var(--ui-border-default);
}
.wb-keys:focus-within {
  border-color: var(--ui-accent-sky);
  box-shadow: 0 0 0 1px var(--ui-accent-sky);
}
.wb-keys.warn {
  border-color: var(--ui-warning);
}
.wb-keys input {
  flex: 1;
  min-width: 140px;
  background: transparent;
  border: 0;
  outline: none;
  color: var(--ui-text-primary);
  font-size: 13px;
}
.wb-key {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 4px 2px 8px;
  border: 1px solid color-mix(in srgb, var(--ui-success) 55%, transparent);
  background: color-mix(in srgb, var(--ui-success) 12%, transparent);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.wb-key button {
  padding: 0 4px;
  color: var(--ui-text-tertiary);
}
.wb-key button:hover {
  color: var(--ui-danger);
}
.wb-content {
  min-height: 140px;
  padding: 10px 12px;
  font:
    14px/1.7 ui-monospace,
    Consolas,
    monospace;
  resize: vertical;
}
.wb-editor-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 14px 20px;
  align-items: start;
}
.wb-editor-grid .wb-num {
  width: 96px;
}
.wb-channels {
  grid-column: span 2;
}
.wb-channels__list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 18px;
  min-height: 32px;
  align-items: center;
}
.wb-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--ui-text-tertiary);
}
.wb-hint.warn {
  color: var(--ui-warning);
}
.wb-percent {
  display: flex;
  align-items: center;
  gap: 3px;
  color: var(--ui-text-tertiary);
  font-size: 12px;
}
.wb-percent .wb-num {
  flex: 1;
  min-width: 0;
}

/* 行内原生输入框，样式与像素输入保持一致但更紧凑。 */
.wb-input {
  box-sizing: border-box;
  height: 32px;
  padding: 0 8px;
  background: var(--dash-input-bg);
  border: 1px solid var(--dash-input-border, var(--ui-border-default));
  border-radius: 0;
  outline: none;
  color: var(--ui-text-primary);
  font-size: 13px;
  transition:
    border-color var(--ui-duration-fast) var(--ui-ease-standard),
    box-shadow var(--ui-duration-fast) var(--ui-ease-standard);
}
textarea.wb-input {
  height: auto;
}
.wb-input:focus {
  border-color: var(--ui-accent-sky);
  box-shadow: 0 0 0 1px var(--ui-accent-sky);
}
.wb-input:disabled {
  color: var(--ui-text-disabled);
  background: var(--ui-bg-surface-soft);
  cursor: not-allowed;
}
.wb-num {
  width: 100%;
  font-family: var(--ui-font-mono);
  text-align: right;
  -moz-appearance: textfield;
  appearance: textfield;
}
.wb-num::-webkit-inner-spin-button,
.wb-num::-webkit-outer-spin-button {
  -webkit-appearance: none;
  margin: 0;
}

@media (max-width: 800px) {
  .wb-row__editor {
    padding-left: 12px;
  }
  .wb-channels {
    grid-column: auto;
  }
}
</style>
