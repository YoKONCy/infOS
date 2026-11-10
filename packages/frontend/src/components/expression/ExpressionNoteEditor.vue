<script setup lang="ts">
/**
 * ExpressionNoteEditor — 就地写红笔批注，不弹对话框。
 * Ctrl+Enter 保存，Esc 放弃；气泡下方和管理页共用。
 */
import { nextTick, onMounted, ref } from 'vue'
import { t as __t } from '../../i18n/index'
import { EXPRESSION_TEXT_LIMIT, type ExpressionMarkKind } from './expressionTypes'
import './expression.css'

const props = withDefaults(
  defineProps<{
    quote?: string
    kind?: ExpressionMarkKind
    note?: string
    /** 编辑已有标记时才显示删除。 */
    removable?: boolean
    busy?: boolean
  }>(),
  { quote: '', kind: 'robotic', note: '', removable: false, busy: false },
)
const emit = defineEmits<{
  save: [value: { kind: ExpressionMarkKind; note: string }]
  cancel: []
  remove: []
}>()

const kind = ref<ExpressionMarkKind>(props.kind)
const note = ref(props.note)
const input = ref<HTMLTextAreaElement | null>(null)
const root = ref<HTMLElement | null>(null)

function save(): void {
  if (!props.busy) emit('save', { kind: kind.value, note: note.value.trim() })
}
function onKeydown(event: KeyboardEvent): void {
  if (event.isComposing) return
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault()
    save()
  } else if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    emit('cancel')
  }
}
onMounted(async () => {
  await nextTick()
  input.value?.focus({ preventScroll: true })
  input.value?.setSelectionRange(note.value.length, note.value.length)
  root.value?.scrollIntoView?.({ block: 'nearest' })
})
</script>

<template>
  <form ref="root" class="expr-editor" data-expression-editor @submit.prevent="save">
    <p class="expr-editor__quote" :class="{ 'is-whole': !quote }">
      {{ quote ? `「${quote}」` : __t('ui.chat', '整条回复') }}
    </p>
    <textarea
      ref="input"
      v-model="note"
      class="expr-hand expr-editor__input"
      rows="2"
      :maxlength="EXPRESSION_TEXT_LIMIT"
      :aria-label="__t('ui.chat', '红笔批注')"
      :placeholder="__t('ui.chat', '红笔写下来：这里怎么了，你想要什么')"
      @keydown="onKeydown"
    />
    <div class="expr-editor__foot">
      <div class="expr-editor__kinds" role="radiogroup" :aria-label="__t('ui.chat', '标记类型')">
        <button
          type="button"
          role="radio"
          data-expression-kind="good"
          :aria-checked="kind === 'good'"
          :class="{ 'is-active': kind === 'good' }"
          @click="kind = 'good'"
        >
          ✓ {{ __t('ui.chat', '对味') }}
        </button>
        <button
          type="button"
          role="radio"
          data-expression-kind="robotic"
          :aria-checked="kind === 'robotic'"
          :class="{ 'is-active': kind === 'robotic' }"
          @click="kind = 'robotic'"
        >
          ✗ {{ __t('ui.chat', '人机') }}
        </button>
      </div>
      <span class="expr-editor__hint">{{ __t('ui.chat', 'Ctrl+Enter 保存 · Esc 放弃') }}</span>
      <div class="expr-editor__buttons">
        <button
          v-if="removable"
          type="button"
          class="expr-editor__remove"
          data-expression-remove
          :disabled="busy"
          @click="emit('remove')"
        >
          {{ __t('ui.chat', '删除') }}
        </button>
        <button type="button" :disabled="busy" @click="emit('cancel')">
          {{ __t('ui.chat', '取消') }}
        </button>
        <button type="submit" class="is-primary" data-expression-save :disabled="busy">
          {{ __t('ui.chat', '保存') }}
        </button>
      </div>
    </div>
  </form>
</template>
