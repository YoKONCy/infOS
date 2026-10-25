<script setup lang="ts">
import { t } from '../../i18n'
import { PCard, PSwitch, PixelIcon } from '../pixel'

defineProps<{ modelValue: boolean; disabled?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()
</script>

<template>
  <PCard pixel padding="lg">
    <div class="flex items-center justify-between gap-4">
      <div class="min-w-0">
        <h3
          class="flex items-center gap-2 text-sm font-black text-[var(--ui-text-primary)] font-pixel"
        >
          <PixelIcon name="shield" size="sm" />
          {{ t('ui.settings', '健全模式') }}
        </h3>
        <p class="mt-2 text-xs text-[var(--ui-text-tertiary)]">
          {{ t('ui.settings', '启用后会引导模型，避免生成限制级内容。') }}
        </p>
      </div>
      <PSwitch
        :model-value="modelValue"
        :disabled="disabled"
        :aria-label="t('ui.settings', '健全模式')"
        @update:model-value="emit('update:modelValue', $event)"
      />
    </div>
  </PCard>
</template>
