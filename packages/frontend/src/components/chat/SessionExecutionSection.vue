<script setup lang="ts">
import { t as __t } from '../../i18n/index'

/**
 * SessionExecutionSection — 会话设置面板的执行权限分区。
 *
 * 降低权限立即生效；提升到自动审批或完整权限先停在待确认状态，确认后才发出变更。
 */
import { computed, ref, watch } from 'vue'
import type { ExecutionMode } from '@infos/shared'
import {
  EXECUTION_CONFIRM_FROM,
  useExecutionLevels,
} from '../../composables/chat/useExecutionLevels'
import SessionSlider from './SessionSlider.vue'

const props = withDefaults(
  defineProps<{
    executionMode: ExecutionMode
    scopeKey: string
    disabled?: boolean
  }>(),
  { disabled: false },
)
const emit = defineEmits<{ change: [mode: ExecutionMode] }>()

const { levels: executionLevels, index: executionIndex } = useExecutionLevels(
  () => props.executionMode,
)
const pendingExecution = ref<number | null>(null)
const executionPreview = ref<number | null>(null)
const nextExecutionIndex = computed(
  () => ((pendingExecution.value ?? executionIndex.value) + 1) % executionLevels.value.length,
)
const executionCycleHint = computed(() =>
  __t('ui.input-controls', '执行权限，点击切换至「{0}」', [
    executionLevels.value[nextExecutionIndex.value]!.label,
  ]),
)
const slider = ref<InstanceType<typeof SessionSlider> | null>(null)
const shownExecution = computed(
  () =>
    executionLevels.value[
      executionPreview.value ?? pendingExecution.value ?? executionIndex.value
    ]!,
)

function commitExecution(index: number): void {
  if (props.disabled) return
  const level = executionLevels.value[index]
  if (!level || index === executionIndex.value) {
    pendingExecution.value = null
    return
  }
  // 放开权限先停在待确认状态；降低权限立即生效。
  if (index > executionIndex.value && index >= EXECUTION_CONFIRM_FROM) {
    pendingExecution.value = index
    return
  }
  pendingExecution.value = null
  emit('change', level.value)
}
function confirmExecution(): void {
  const level =
    pendingExecution.value === null ? null : executionLevels.value[pendingExecution.value]
  pendingExecution.value = null
  if (level && !props.disabled) emit('change', level.value)
}
function cancelExecution(): void {
  pendingExecution.value = null
}
/** 面板关闭时连同拖动预览一起清掉。 */
function clear(): void {
  slider.value?.cancel()
  pendingExecution.value = null
  executionPreview.value = null
}

watch(
  () => [props.executionMode, props.scopeKey, props.disabled],
  clear,
)
defineExpose({ cancel: cancelExecution, clear })
</script>

<template>
  <section
    class="session-item"
    data-session-execution
    :style="{ '--item-accent': shownExecution.accent }"
  >
    <header class="session-item__head">
      <span>{{ __t('ui.chat', '执行权限') }}</span>
      <button
        type="button"
        class="session-item__value session-item__cycle"
        :disabled="disabled"
        :title="executionCycleHint"
        :aria-label="executionCycleHint"
        @click="commitExecution(nextExecutionIndex)"
      >{{ shownExecution.label }}</button>
    </header>
    <SessionSlider
      ref="slider"
      :key="scopeKey"
      :options="executionLevels.map((level) => level.label)"
      :model-value="pendingExecution ?? executionIndex"
      :label="__t('ui.chat', '执行权限')"
      :value-text="shownExecution.label"
      :accent="shownExecution.accent"
      :disabled="disabled"
      :pending="pendingExecution !== null"
      @preview="executionPreview = $event"
      @update:model-value="commitExecution"
    />
    <div class="session-item__descriptions">
      <p
        v-for="level in executionLevels"
        :key="level.value"
        class="session-item__desc"
        :class="{ 'is-current': level.value === shownExecution.value }"
        :aria-hidden="level.value !== shownExecution.value || undefined"
      >{{ level.description }}</p>
    </div>
    <div class="session-collapse" :class="{ 'is-open': pendingExecution !== null }">
      <div :inert="pendingExecution === null || undefined">
        <div class="session-confirm" role="alertdialog" :aria-label="__t('ui.chat', '执行权限')">
          <span>
            {{
              __t('ui.input-controls', '放开到「{0}」？', [
                pendingExecution === null ? '' : executionLevels[pendingExecution]!.label,
              ])
            }}
          </span>
          <button type="button" data-execution-confirm @click="confirmExecution">
            {{ __t('ui.input-controls', '放开') }}
          </button>
          <button type="button" data-execution-cancel @click="cancelExecution">
            {{ __t('ui.input-controls', '取消') }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped src="./session-settings.css"></style>

<style scoped>
.session-confirm {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  padding: 6px 7px;
  border: 1px solid color-mix(in srgb, var(--item-accent) 40%, transparent);
  background: color-mix(in srgb, var(--item-accent) 8%, transparent);
  color: var(--item-accent);
  font: 11px/1.4 var(--ui-font-pixel);
}
.session-confirm > span {
  flex: 1;
  min-width: 0;
}
.session-confirm > button {
  margin: 0;
  padding: 2px 6px;
  border: 1px solid currentColor;
  border-radius: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
}
.session-confirm > button:hover {
  background: color-mix(in srgb, var(--item-accent) 14%, transparent);
}
.session-confirm > button:focus-visible {
  outline: 2px solid var(--item-accent);
  outline-offset: 1px;
}
</style>
