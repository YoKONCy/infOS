<script setup lang="ts">
/**
 * ExpressionAnnotations — 气泡上的红笔。
 *
 * 负责三件事：选中一句后的小浮层、正文里的红色下划线、气泡下方的批注。
 * 批注写在正文外面，不进入消息内容；流式中的气泡这里什么都不挂。
 */
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch, watchPostEffect } from 'vue'
import { t as __t } from '../../i18n/index'
import { useNotificationStore } from '../../stores/useNotificationStore'
import MotionList from '../motion/MotionList.vue'
import ExpressionNoteEditor from './ExpressionNoteEditor.vue'
import { activeSelection, registerSelectionRoot } from './expressionSelection'
import {
  isMessageBusy,
  marksOf,
  removeMark,
  sameQuote,
  saveNote,
  toggleMark,
} from './useExpressionMarks'
import { useExpressionTarget, type ExpressionBubbleInput } from './useExpressionTarget'
import { useQuoteHighlights } from './useQuoteHighlights'
import {
  EXPRESSION_TEXT_LIMIT,
  type ExpressionMark,
  type ExpressionMarkKind,
} from './expressionTypes'
import './expression.css'

const props = defineProps<{
  message: ExpressionBubbleInput['message']
  agentId?: string
  streaming?: boolean
}>()

const { target, ready } = useExpressionTarget(() => ({
  message: props.message,
  agentId: props.agentId,
  streaming: props.streaming,
}))
const marks = computed(() => marksOf(target.value))
const busy = computed(() => isMessageBusy(props.message.id))

const host = ref<HTMLElement | null>(null)
const bubble = shallowRef<HTMLElement | null>(null)
watchPostEffect(() => {
  bubble.value = ready.value
    ? (host.value
        ?.closest('.msg-bubble-container')
        ?.querySelector<HTMLElement>('.msg-bubble-assistant') ?? null)
    : null
})
const { located, markAtPoint } = useQuoteHighlights(bubble, marks)

// 批注加载或增减会改变气泡高度；原本停在底部的聊天继续停在底部，免得最后一条被输入框挡住。
const BOTTOM_SLACK = 48
watch(
  marks,
  () => {
    const scroller = host.value?.closest<HTMLElement>('.chat-messages')
    if (!scroller) return
    const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
    if (distance > BOTTOM_SLACK) return
    void nextTick(() => scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'instant' }))
  },
  { flush: 'pre' },
)

// ── 正在写的批注 ──
const editingId = ref<string | null>(null)
const draft = ref<{ quote: string; kind: ExpressionMarkKind } | null>(null)
const flashId = ref<string | null>(null)
let flashTimer: ReturnType<typeof setTimeout> | undefined
const notes = ref<HTMLElement | null>(null)

function openEditor(mark: ExpressionMark): void {
  draft.value = null
  editingId.value = mark.id
}
function closeEditor(): void {
  draft.value = null
  editingId.value = null
}
async function submit(
  mark: ExpressionMark | null,
  value: { kind: ExpressionMarkKind; note: string },
): Promise<void> {
  if (!target.value) return
  const saved = await saveNote(target.value, {
    markId: mark?.id,
    quote: mark?.quote ?? draft.value?.quote ?? '',
    ...value,
  })
  if (saved) closeEditor()
}
async function remove(mark: ExpressionMark): Promise<void> {
  if (await removeMark(mark)) closeEditor()
}

// ── 选中一句 ──
const selection = computed(() =>
  bubble.value && activeSelection.value?.bubble === bubble.value ? activeSelection.value : null,
)
const selectedMark = computed(() =>
  selection.value
    ? marks.value.find((mark) => mark.quote && sameQuote(mark.quote, selection.value!.quote))
    : undefined,
)
const POPOVER_WIDTH = 188
const POPOVER_HEIGHT = 38
const popoverBelow = computed(() => {
  if (!selection.value) return false
  // 触屏的系统选区菜单在选区上方，浮层放到下方避开。
  const coarse = window.matchMedia?.('(pointer: coarse)').matches
  return coarse || selection.value.rect.top < POPOVER_HEIGHT + 12
})
const popoverStyle = computed(() => {
  const rect = selection.value?.rect
  if (!rect) return {}
  const center = (rect.left + rect.right) / 2
  const left = Math.max(
    8,
    Math.min(center - POPOVER_WIDTH / 2, window.innerWidth - POPOVER_WIDTH - 8),
  )
  const top = popoverBelow.value ? rect.bottom + 8 : rect.top - POPOVER_HEIGHT - 8
  return {
    left: `${left}px`,
    top: `${Math.max(8, Math.min(top, window.innerHeight - POPOVER_HEIGHT - 8))}px`,
    '--motion-origin': popoverBelow.value ? 'top center' : 'bottom center',
    '--motion-pop-direction': popoverBelow.value ? '-1' : '1',
  }
})

function takeSelection(): string | null {
  const quote = selection.value?.quote ?? null
  if (quote && quote.length > EXPRESSION_TEXT_LIMIT) {
    useNotificationStore().toast(
      __t('ui.chat', '选中的文字太长了，最多 {0} 字', [EXPRESSION_TEXT_LIMIT]),
      'warning',
    )
    return null
  }
  activeSelection.value = null
  window.getSelection()?.removeAllRanges()
  return quote
}
async function markSelection(kind: ExpressionMarkKind): Promise<void> {
  const existing = selectedMark.value
  const quote = takeSelection()
  if (!quote || !target.value) return
  // 已写了批注的句子不一键取消，打开来让用户自己决定。
  if (existing?.kind === kind && existing.note) openEditor(existing)
  else await toggleMark(target.value, quote, kind)
}
function annotateSelection(): void {
  const existing = selectedMark.value
  const quote = takeSelection()
  if (!quote) return
  if (existing) openEditor(existing)
  else {
    editingId.value = null
    draft.value = { quote, kind: 'robotic' }
  }
}

// ── 点下划线定位到批注 ──
function onBubbleClick(event: MouseEvent): void {
  if (!window.getSelection()?.isCollapsed) return
  const id = markAtPoint(event.clientX, event.clientY)
  if (!id) return
  flashId.value = id
  clearTimeout(flashTimer)
  flashTimer = setTimeout(() => (flashId.value = null), 1200)
  notes.value
    ?.querySelector(`[data-expression-mark="${CSS.escape(id)}"]`)
    ?.scrollIntoView?.({ block: 'nearest' })
}

let unregister: (() => void) | undefined
watch(
  bubble,
  (element, _old, onCleanup) => {
    if (!element) return
    unregister = registerSelectionRoot(element)
    element.addEventListener('click', onBubbleClick)
    onCleanup(() => {
      unregister?.()
      unregister = undefined
      element.removeEventListener('click', onBubbleClick)
    })
  },
  { flush: 'post' },
)
onBeforeUnmount(() => clearTimeout(flashTimer))

function shortQuote(quote: string): string {
  return quote.length > 48 ? `${quote.slice(0, 48)}…` : quote
}
const kindLabel = (kind: ExpressionMarkKind) =>
  kind === 'good' ? __t('ui.chat', '对味') : __t('ui.chat', '人机')
</script>

<template>
  <div v-if="target" ref="host" class="expr-host">
    <div v-if="ready" ref="notes">
      <MotionList class="expr-notes">
        <div v-for="mark in marks" :key="mark.id" :data-expression-mark="mark.id">
          <ExpressionNoteEditor
            v-if="editingId === mark.id"
            :quote="mark.quote"
            :kind="mark.kind"
            :note="mark.note"
            :busy="busy"
            removable
            @save="submit(mark, $event)"
            @cancel="closeEditor"
            @remove="remove(mark)"
          />
          <button
            v-else
            type="button"
            class="expr-note motion-press"
            :class="[`is-${mark.kind}`, { 'is-flash': flashId === mark.id }]"
            :title="__t('ui.chat', '点开修改或删除')"
            @click="openEditor(mark)"
          >
            <span class="expr-hand expr-note__sign" aria-hidden="true">
              {{ mark.kind === 'good' ? '✓' : '✗' }}
            </span>
            <span class="expr-note__body">
              <span
                v-if="mark.quote"
                class="expr-note__quote"
                :class="{ 'is-unmatched': !located.has(mark.id) }"
                :title="mark.quote"
              >
                「{{ shortQuote(mark.quote) }}」
              </span>
              <span v-else class="expr-note__scope">{{ __t('ui.chat', '整条') }}</span>
              <span v-if="mark.note" class="expr-hand expr-note__text">{{ mark.note }}</span>
              <span v-else class="expr-note__empty">
                {{ kindLabel(mark.kind) }} · {{ __t('ui.chat', '写批注') }}
              </span>
            </span>
          </button>
        </div>
        <div v-if="draft" key="expression-draft">
          <ExpressionNoteEditor
            :quote="draft.quote"
            :kind="draft.kind"
            :busy="busy"
            @save="submit(null, $event)"
            @cancel="closeEditor"
          />
        </div>
      </MotionList>
    </div>

    <Teleport v-if="ready" to="body">
      <Transition name="motion-pop">
        <div
          v-if="selection"
          class="expr-popover"
          :style="popoverStyle"
          role="toolbar"
          :aria-label="__t('ui.chat', '批改这一句')"
          data-expression-popover
          @pointerdown.prevent
        >
          <button
            type="button"
            data-expression-select="good"
            :class="{ 'is-active': selectedMark?.kind === 'good' }"
            @click="markSelection('good')"
          >
            ✓ {{ __t('ui.chat', '对味') }}
          </button>
          <button
            type="button"
            data-expression-select="robotic"
            :class="{ 'is-active': selectedMark?.kind === 'robotic' }"
            @click="markSelection('robotic')"
          >
            ✗ {{ __t('ui.chat', '人机') }}
          </button>
          <button type="button" data-expression-select="note" @click="annotateSelection">
            {{ __t('ui.chat', '批注') }}
          </button>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>
