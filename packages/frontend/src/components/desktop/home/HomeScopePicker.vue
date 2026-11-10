<script setup lang="ts">
import { t as __t } from '../../../i18n/index'
import { PSelect } from '../../pixel'
import type { HomeScopeState } from './useHomeScope'

// 共享空间与授权记录共用同一份角色、会话选择。
const props = defineProps<{ state: HomeScopeState }>()
const { agentId, sessionId } = props.state
</script>

<template>
  <div class="home-scope">
    <div class="home-scope-text">
      <strong>{{ __t('ui.desktop', '当前范围') }}</strong>
      <p>{{ __t('ui.desktop', '选择角色与会话，查看对应物品和记录。') }}</p>
    </div>
    <label>
      <span>{{ __t('ui.desktop', '角色') }}</span>
      <PSelect v-model="agentId" :options="state.agentOptions.value" size="sm" />
    </label>
    <label>
      <span>{{ __t('ui.desktop', '对话') }}</span>
      <PSelect
        v-model="sessionId"
        :options="state.sessionOptions.value"
        :disabled="!state.sessionOptions.value[0]?.value"
        size="sm"
      />
    </label>
    <p v-if="state.error.value" role="alert" class="home-scope-error">{{ state.error.value }}</p>
  </div>
</template>

<style scoped>
.home-scope {
  display: flex;
  align-items: flex-end;
  gap: 10px 12px;
  flex-wrap: wrap;
  margin-bottom: 20px;
  padding: 12px;
  background: var(--ui-bg-surface-soft);
  border: 1px solid var(--ui-border-default);
  color: var(--ui-text-primary);
}
.home-scope-text {
  flex: 1 1 180px;
  min-width: 0;
}
.home-scope-text strong {
  font: 11px/1.4 var(--ui-font-pixel);
}
.home-scope-text p {
  margin-top: 2px;
  color: var(--ui-text-tertiary);
  font-size: 11px;
  line-height: 1.5;
}
.home-scope label {
  display: flex;
  flex: 1 1 160px;
  flex-direction: column;
  gap: 4px;
  min-width: 150px;
  font-size: 11px;
  color: var(--ui-text-secondary);
}
.home-scope-error {
  flex-basis: 100%;
  padding: 8px 10px;
  border-left: 3px solid var(--ui-danger);
  border-radius: var(--ui-radius-xs);
  background: color-mix(in srgb, var(--ui-danger) 8%, transparent);
  color: var(--ui-text-primary);
  font-size: 12px;
}
</style>
