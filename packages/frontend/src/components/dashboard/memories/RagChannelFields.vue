<script setup lang="ts">
import { t } from '../../../i18n'
import type { MemoryRuntimeConfig } from '../../../api/modules/maintenanceApi'
import { PixelIcon, PSwitch } from '../../pixel'
import RagNumberControl from './RagNumberControl.vue'

/** 单个通道（桌面 / 据点群聊）的上下文与自动召回设置。 */
defineProps<{ channelId: 'desktop' | 'group' }>()
const channel = defineModel<MemoryRuntimeConfig['channels']['desktop']>('channel', {
  required: true,
})
</script>

<template>
  <div class="rag-switch-row rag-switch-row--featured">
    <span class="rag-feature-icon"><PixelIcon name="search" size="md" /></span>
    <div class="rag-row-copy">
      <label :id="`rag-auto-${channelId}`">{{ t('ui.rag', '自动召回') }}</label>
      <p>{{ t('ui.rag', '对话时查找相关长期记忆') }}</p>
    </div>
    <PSwitch v-model="channel.enableAutoRag" :aria-labelledby="`rag-auto-${channelId}`" />
  </div>
  <div class="rag-number-grid">
    <RagNumberControl
      :id="`rag-context-${channelId}`"
      v-model="channel.historyTokenBudget"
      :label="t('ui.rag', '历史 Token 预算')"
      :description="t('ui.rag', '近期消息可使用的上下文容量')"
      :min="1024"
      :max="262144"
      unit="Token"
    />
    <RagNumberControl
      v-if="channelId === 'desktop'"
      id="rag-side-context"
      v-model="channel.contextPairs"
      :label="t('ui.rag', '侧会话历史轮数')"
      :description="t('ui.rag', '侧会话按完整对话保留历史')"
      :min="1"
      :max="100"
      :unit="t('ui.rag', '轮')"
    />
    <RagNumberControl
      :id="`rag-limit-${channelId}`"
      v-model="channel.retrievalLimit"
      :label="t('ui.rag', '召回事件数')"
      :description="t('ui.rag', '每次检索带回的相关记忆数量')"
      :min="1"
      :max="30"
      :unit="t('ui.rag', '条')"
      :disabled="!channel.enableAutoRag"
    />
    <RagNumberControl
      :id="`rag-budget-${channelId}`"
      v-model="channel.memoryTokenBudget"
      :label="t('ui.rag', '记忆注入上限')"
      :description="
        t('ui.rag', '自动注入记忆的 Token 上限，超出时优先保留直接相关的完整事件；0 表示不限')
      "
      :min="0"
      :max="32000"
      :step="100"
      :unit="t('ui.rag', 'Token')"
      :disabled="!channel.enableAutoRag"
    />
  </div>
</template>

<style scoped src="./rag-config.css"></style>
