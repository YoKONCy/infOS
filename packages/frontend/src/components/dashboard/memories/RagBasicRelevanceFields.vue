<script setup lang="ts">
import { t } from '../../../i18n'
import type { MemoryRuntimeConfig } from '../../../api/modules/maintenanceApi'
import { PixelIcon, PSwitch } from '../../pixel'
import RagNumberControl from './RagNumberControl.vue'

/** 基础检索（未开启 SA-PPR）的相关度门槛；开启高级检索后改由最低分数控制。 */
defineProps<{ advancedEnabled: boolean }>()
const basic = defineModel<MemoryRuntimeConfig['basic']>('basic', { required: true })
</script>

<template>
  <div class="rag-extension-list">
    <h4>{{ t('ui.rag', '基础检索门槛') }}</h4>
    <div class="rag-switch-row">
      <div class="rag-row-copy">
        <label id="rag-basic-gate">{{ t('ui.rag', '只注入相关记忆') }}</label>
        <p>{{ t('ui.rag', '候选不够相关时少放，不按召回事件数补满；关闭后恢复旧行为') }}</p>
        <small v-if="advancedEnabled">
          {{ t('ui.rag', '已开启高级检索，此处设置暂不生效') }}
        </small>
      </div>
      <PSwitch v-model="basic.enableRelevanceGate" aria-labelledby="rag-basic-gate" />
    </div>
  </div>
  <div class="rag-number-grid">
    <RagNumberControl
      id="rag-basic-similarity"
      v-model="basic.minSimilarity"
      :label="t('ui.rag', '最低向量相似度')"
      :description="t('ui.rag', '查询与记忆的余弦相似度下限；标签与查询一致的记忆不受此限制')"
      :min="-1"
      :max="1"
      :step="0.05"
      :disabled="!basic.enableRelevanceGate"
    />
  </div>
  <p class="rag-dependency">
    <PixelIcon name="info" size="xs" />
    {{ t('ui.rag', '以下高级检索选项与基础检索门槛互不叠加') }}
  </p>
</template>

<style scoped src="./rag-config.css"></style>
