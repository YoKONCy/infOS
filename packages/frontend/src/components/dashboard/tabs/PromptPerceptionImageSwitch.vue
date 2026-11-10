<script setup lang="ts">
/** 框架编辑器标题栏的「带屏幕图」开关：用这个框架时，用户回合附带当前窗口的小图。 */
import { t as __t } from '../../../i18n/index'
import { PSwitch } from '../../pixel'

const perceptionImage = defineModel<boolean | undefined>()
</script>

<template>
  <label
    class="perception-image-switch"
    :title="
      __t(
        'ui.settings',
        '用这个框架时，你说话的回合会带上当前窗口的小图。还要在桌面与家的感知里开着带上屏幕图，文本模型不带图。',
      )
    "
  >
    <PSwitch
      :model-value="perceptionImage === true"
      @update:model-value="perceptionImage = $event"
    />
    <span>{{ __t('ui.settings', '带屏幕图') }}</span>
  </label>
</template>

<style scoped>
.perception-image-switch {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--ui-text-secondary);
  font-size: 12px;
  white-space: nowrap;
}
</style>
