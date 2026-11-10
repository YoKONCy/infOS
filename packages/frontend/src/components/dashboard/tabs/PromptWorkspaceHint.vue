<script setup lang="ts">
/** 表达调教分区的保存说明。 */
import { t as __t } from '../../../i18n/index'
import { PixelIcon } from '../../pixel'

</script>

<template>
  <p class="expression-hint">
    <PixelIcon name="info" size="xs" />
    {{ __t('ui.chat', '规则点保存后下一轮生效，手册和开关改完马上生效。') }}
  </p>
</template>

<style scoped>
.expression-hint {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 13px;
  color: var(--ui-text-tertiary);
}
</style>
