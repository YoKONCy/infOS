<script setup lang="ts">
/**
 * ExpressionActions — 助手气泡操作栏上的「对味」「人机」收拢判据组。
 *
 * 默认收拢为单个红笔入口按钮（已标记整条回复时回显当前判据），点击后二次展开两个判据按钮。
 * 标记的是整条回复，再点一次取消，点另一个就改成另一个。
 * 带批注的标记要连点两下才取消，防止手滑把写好的批注一起丢掉。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { t as __t } from '../../i18n/index'
import PixelIcon from '../pixel/PixelIcon.vue'
import { isMessageBusy, marksOf, removeMark, toggleMark } from './useExpressionMarks'
import { useExpressionTarget, type ExpressionBubbleInput } from './useExpressionTarget'
import type { ExpressionMarkKind } from './expressionTypes'
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
const whole = computed(() => marksOf(target.value).find((mark) => !mark.quote))
const busy = computed(() => isMessageBusy(props.message.id))
const rootRef = ref<HTMLElement | null>(null)
const expanded = ref(false)
const armed = ref(false)
let disarmTimer: ReturnType<typeof setTimeout> | undefined

const buttons = computed(() => [
  {
    kind: 'good' as const,
    sign: '✓',
    label: __t('ui.chat', '对味'),
    title: __t('ui.chat', '这条回复对味'),
  },
  {
    kind: 'robotic' as const,
    sign: '✗',
    label: __t('ui.chat', '人机'),
    title: __t('ui.chat', '这条回复像人机'),
  },
])

const activeButton = computed(
  () => buttons.value.find((item) => item.kind === whole.value?.kind) ?? null,
)
const triggerTitle = computed(() => {
  if (expanded.value) return __t('ui.chat', '收起表达判据')
  if (activeButton.value) return activeButton.value.title
  return __t('ui.chat', '评价回复表达')
})

function collapse(): void {
  expanded.value = false
  clearTimeout(disarmTimer)
  armed.value = false
}

function toggleExpand(): void {
  if (busy.value) return
  if (expanded.value) collapse()
  else expanded.value = true
}

function onOutsidePointerDown(event: PointerEvent): void {
  const el = rootRef.value
  if (!el || el.contains(event.target as Node)) return
  collapse()
}

function onWindowKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  event.stopPropagation()
  collapse()
}

function detachListeners(): void {
  window.removeEventListener('pointerdown', onOutsidePointerDown, true)
  window.removeEventListener('keydown', onWindowKeydown, true)
}

watch(expanded, (open) => {
  if (open) {
    window.addEventListener('pointerdown', onOutsidePointerDown, true)
    window.addEventListener('keydown', onWindowKeydown, true)
  } else {
    detachListeners()
  }
})

watch(
  () => Boolean(target.value && ready.value),
  (available) => {
    if (!available && expanded.value) collapse()
  },
)

async function press(kind: ExpressionMarkKind): Promise<void> {
  if (!target.value || busy.value) return
  const current = whole.value
  if (current?.kind === kind && current.note && !armed.value) {
    armed.value = true
    clearTimeout(disarmTimer)
    disarmTimer = setTimeout(() => (armed.value = false), 3000)
    return
  }
  clearTimeout(disarmTimer)
  armed.value = false
  if (current?.kind === kind) await removeMark(current)
  else await toggleMark(target.value, '', kind)
  collapse()
}

onBeforeUnmount(() => {
  detachListeners()
  clearTimeout(disarmTimer)
})
</script>

<template>
  <div
    v-if="target && ready"
    ref="rootRef"
    class="expr-box"
    :class="{ 'is-open': expanded, 'is-marked': Boolean(whole) }"
  >
    <button
      type="button"
      class="expr-trigger motion-press"
      :class="{ 'is-active': Boolean(whole), 'is-open': expanded }"
      :aria-expanded="expanded"
      :title="triggerTitle"
      :aria-label="triggerTitle"
      :disabled="busy"
      @click="toggleExpand"
    >
      <template v-if="activeButton && !expanded">
        <span class="expr-action__sign" aria-hidden="true">{{ activeButton.sign }}</span>
        <span>{{ activeButton.label }}</span>
      </template>
      <PixelIcon v-else :name="expanded ? 'chevron-left' : 'pencil'" size="xs" />
    </button>

    <Transition name="expr-expand">
      <div v-if="expanded" class="expr-choices" role="group">
        <button
          v-for="button in buttons"
          :key="button.kind"
          type="button"
          class="expr-action motion-press"
          :class="{ 'is-active': whole?.kind === button.kind }"
          :data-expression-action="button.kind"
          :aria-pressed="whole?.kind === button.kind"
          :title="button.title"
          :disabled="busy"
          @click="press(button.kind)"
        >
          <span class="expr-action__sign" aria-hidden="true">{{ button.sign }}</span>
          {{
            armed && whole?.kind === button.kind ? __t('ui.chat', '连批注一起取消？') : button.label
          }}
        </button>
      </div>
    </Transition>
  </div>
</template>
