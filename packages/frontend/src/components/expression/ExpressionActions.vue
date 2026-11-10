<script setup lang="ts">
/**
 * ExpressionActions — 助手气泡操作栏上的「对味」「人机」。
 *
 * 标记的是整条回复，再点一次取消，点另一个就改成另一个。
 * 带批注的标记要连点两下才取消，防止手滑把写好的批注一起丢掉。
 */
import { computed, onBeforeUnmount, ref } from 'vue'
import { t as __t } from '../../i18n/index'
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
}
onBeforeUnmount(() => clearTimeout(disarmTimer))
</script>

<template>
  <template v-if="target && ready">
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
      {{ armed && whole?.kind === button.kind ? __t('ui.chat', '连批注一起取消？') : button.label }}
    </button>
  </template>
</template>
