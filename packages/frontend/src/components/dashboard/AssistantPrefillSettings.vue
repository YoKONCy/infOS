<script setup lang="ts">
import { computed } from 'vue'
import { MAX_ASSISTANT_PREFILL_LENGTH, type AssistantPrefillConfig } from '@infos/shared'
import { t } from '../../i18n'
import { PButton, PCard, PSelect, PSwitch, PTextarea, PixelIcon } from '../pixel'

const props = defineProps<{ modelValue: AssistantPrefillConfig; disabled?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: AssistantPrefillConfig]; save: [] }>()
const modeOptions = computed(() => [
  { value: 'once', label: t('ui.settings', '单次填充') },
  { value: 'continuous', label: t('ui.settings', '持续填充') },
])
function update(patch: Partial<AssistantPrefillConfig>, commit = false): void {
  emit('update:modelValue', { ...props.modelValue, ...patch })
  if (commit) emit('save')
}
function updateMode(value: string | number): void {
  if (value === 'once' || value === 'continuous') update({ mode: value }, true)
}
</script>

<template>
  <PCard pixel padding="lg">
    <div class="flex items-center justify-between gap-4">
      <h3
        class="flex items-center gap-2 text-sm font-black text-[var(--ui-text-primary)] font-pixel"
      >
        <PixelIcon name="edit" size="sm" />
        {{ t('ui.settings', '预填充模式') }}
      </h3>
      <PSwitch
        :model-value="modelValue.enabled"
        :disabled="disabled"
        :aria-label="t('ui.settings', '预填充模式')"
        @update:model-value="update({ enabled: $event }, true)"
      />
    </div>
    <div class="mt-5 border-t border-[var(--ui-border-subtle)] pt-4">
      <div class="mb-3 max-w-48">
        <PSelect
          :model-value="modelValue.mode ?? 'once'"
          :options="modeOptions"
          :disabled="disabled"
          :aria-label="t('ui.settings', '填充方式')"
          @update:model-value="updateMode"
        />
      </div>
      <PTextarea
        :model-value="modelValue.content"
        :label="t('ui.settings', '预填充内容')"
        :placeholder="t('ui.settings', '填写模型继续生成前的回答开头')"
        :maxlength="MAX_ASSISTANT_PREFILL_LENGTH"
        :disabled="disabled"
        :rows="3"
        @update:model-value="update({ content: $event })"
      />
      <div class="mt-3 flex justify-end">
        <PButton size="sm" :disabled="disabled" @click="emit('save')">
          <PixelIcon name="save" size="xs" />
          {{ t('ui.settings', '保存') }}
        </PButton>
      </div>
    </div>
  </PCard>
</template>
