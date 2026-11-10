<script setup lang="ts">
import { t as __t } from '../../i18n/index'

import { computed } from 'vue'
import { useDesktopHome } from '../../composables/useDesktopHome'

// 桌宠旁的「正在听」小标记（设置「桌面与家 → 耳朵」里可以关掉；应用内的录音标识总会显示）。
const home = useDesktopHome()
const visible = computed(
  () => home.supported && !!home.status.value?.listening && home.settings.value?.ears.petIndicator,
)
</script>

<template>
  <div v-if="visible" data-pet-ui class="pet-listening" role="status" aria-live="polite">
    <span aria-hidden="true" />
    {{ __t('ui.pet', '正在听') }}
  </div>
</template>

<style scoped>
.pet-listening {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(209, 67, 67, 0.9);
  color: #fff;
  font-size: 11px;
  pointer-events: none;
}
.pet-listening span {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #fff;
}
</style>
