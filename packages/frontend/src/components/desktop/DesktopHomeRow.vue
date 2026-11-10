<script setup lang="ts">
import { computed } from 'vue'
import { t as __t } from '../../i18n/index'
import { PSelect, PSwitch } from '../pixel'
import type { HomeOption } from './desktopHomeOptions'

// 「桌面与家」的一行：标题、一句说明、下拉框或开关。当前值不在预设里时也显示出来。
// saved 为 true 时在控件旁淡入「已保存」，片刻后由父组件清掉。
const props = defineProps<{
  option: HomeOption
  value: unknown
  disabled?: boolean
  saved?: boolean
}>()
const emit = defineEmits<{ change: [value: unknown] }>()
const choices = computed(() => {
  const list = props.option.options ?? []
  return list.some((item) => item.value === props.value) ||
    (typeof props.value !== 'string' && typeof props.value !== 'number')
    ? list
    : [...list, { value: props.value, label: String(props.value) }]
})
</script>

<template>
  <div class="desktop-home-row">
    <div class="desktop-home-row-text">
      <strong>{{ option.label }}</strong>
      <p>{{ option.hint }}</p>
    </div>
    <div class="desktop-home-row-control">
      <Transition name="motion-fade">
        <span v-if="saved" class="desktop-home-saved" role="status">
          {{ __t('ui.desktop', '已保存') }}
        </span>
      </Transition>
      <PSwitch
        v-if="option.kind === 'switch'"
        :model-value="value === true"
        :disabled="disabled"
        :aria-label="option.label"
        @update:model-value="emit('change', $event)"
      />
      <div v-else class="desktop-home-select">
        <PSelect
          :model-value="value as string | number"
          :options="choices"
          :disabled="disabled"
          :aria-label="option.label"
          @update:model-value="emit('change', $event)"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.desktop-home-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 224px;
  align-items: center;
  justify-content: space-between;
  gap: 8px 16px;
  padding: 14px 0;
  border-top: 1px solid var(--ui-border-subtle);
  color: var(--ui-text-primary);
}
.desktop-home-row:first-child {
  border-top-color: transparent;
}
.desktop-home-row-text {
  min-width: 0;
}
.desktop-home-row strong {
  font-size: 12px;
  font-weight: 600;
}
.desktop-home-row p {
  margin-top: 2px;
  color: var(--ui-text-tertiary);
  font-size: 11px;
  line-height: 1.5;
}
.desktop-home-row-control {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}
.desktop-home-select {
  width: 168px;
}
.desktop-home-saved {
  color: var(--ui-success);
  font-size: 10px;
  white-space: nowrap;
}
@container desktop-home-content (max-width: 480px) {
  .desktop-home-row {
    grid-template-columns: minmax(0, 1fr);
    gap: 8px;
  }
  .desktop-home-row-control {
    margin-left: 0;
  }
}
</style>
