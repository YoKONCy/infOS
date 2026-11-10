<script setup lang="ts">
import { computed, ref } from 'vue'
import { t as __t } from '../../../i18n/index'
import { MotionCollapse } from '../../motion'
import { PixelIcon } from '../../pixel'
import DesktopHomeRow from '../DesktopHomeRow.vue'
import type { HomeOption } from '../desktopHomeOptions'

/**
 * 一组「桌面与家」选项：常用的直接列出，标了 advanced 的收进「更多选项」。
 * savedKey 为刚保存成功的「分区.键名」，对应行显示一下「已保存」。
 */
const props = defineProps<{
  options: HomeOption[]
  valueOf: (option: HomeOption) => unknown
  savedKey?: string
  disabled?: boolean
}>()
const emit = defineEmits<{ change: [option: HomeOption, value: unknown] }>()
const common = computed(() => props.options.filter((option) => !option.advanced))
const advanced = computed(() => props.options.filter((option) => option.advanced))
const more = ref(false)
const keyOf = (option: HomeOption) => `${option.section}.${option.key}`
</script>

<template>
  <div class="home-options">
    <DesktopHomeRow
      v-for="option in common"
      :key="keyOf(option)"
      :option="option"
      :value="valueOf(option)"
      :disabled="disabled"
      :saved="savedKey === keyOf(option)"
      @change="emit('change', option, $event)"
    />
    <template v-if="advanced.length">
      <button
        type="button"
        class="home-more motion-press"
        :aria-expanded="more"
        @click="more = !more"
      >
        <PixelIcon name="chevron-right" size="xs" class="home-more-icon" :class="{ open: more }" />
        {{
          more
            ? __t('ui.desktop', '收起更多选项')
            : __t('ui.desktop', '更多选项（{0}）', [advanced.length])
        }}
      </button>
      <MotionCollapse :open="more">
        <div class="home-more-body">
          <DesktopHomeRow
            v-for="option in advanced"
            :key="keyOf(option)"
            :option="option"
            :value="valueOf(option)"
            :disabled="disabled"
            :saved="savedKey === keyOf(option)"
            @change="emit('change', option, $event)"
          />
        </div>
      </MotionCollapse>
    </template>
  </div>
</template>

<style scoped>
.home-more {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-top: 12px;
  padding: 4px 8px 4px 4px;
  border-radius: var(--ui-radius-sm);
  color: var(--ui-text-secondary);
  font-size: 12px;
  font-weight: 600;
  background: transparent;
  cursor: pointer;
}
@media (hover: hover) {
  .home-more:hover {
    color: var(--ui-text-primary);
    background: var(--ui-bg-hover);
  }
}
.home-more:focus-visible {
  outline: 2px solid var(--ui-accent-sky);
  outline-offset: 2px;
}
.home-more-icon {
  transition: transform var(--motion-duration-medium) var(--motion-ease-standard);
}
.home-more-icon.open {
  transform: rotate(90deg);
}
.home-more-body {
  margin-top: 2px;
  padding-left: 12px;
  border-left: 2px solid var(--ui-border-subtle);
}
</style>
