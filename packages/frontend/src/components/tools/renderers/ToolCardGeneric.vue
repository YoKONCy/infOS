<script setup lang="ts">
/** ToolCardGeneric — 通用工具数据面板，采用清晰的中文化分区与等宽轨道。 */
import { t as __t } from '../../../i18n/index'

defineProps<{ args: string; result?: string; isError?: boolean }>()
</script>
<template>
  <section class="generic-inspector" :class="{ 'is-error': isError }">
    <div v-if="args" class="generic-section">
      <header>
        <b>IN</b>
        <span>{{ __t('ui.tools', '调用参数') }}</span>
      </header>
      <pre>{{ args }}</pre>
    </div>
    <div v-if="result" class="generic-section">
      <header>
        <b>OUT</b>
        <span>{{ isError ? __t('ui.tools', '异常输出') : __t('ui.tools', '返回结果') }}</span>
      </header>
      <pre>{{ result }}</pre>
    </div>
  </section>
</template>
<style scoped>
.generic-inspector {
  display: grid;
  background: transparent;
}
.generic-section + .generic-section {
  border-top: 1px solid var(--ui-border-subtle);
}
.generic-section header {
  display: grid;
  min-height: 28px;
  grid-template-columns: 44px minmax(0, 1fr);
  border-bottom: 1px solid var(--ui-border-subtle);
  background: var(--traj-compartment, var(--ui-bg-surface-soft));
}
.generic-section header b {
  display: grid;
  place-items: center;
  border-right: 1px solid var(--ui-border-default);
  color: var(--tc-accent, var(--ui-accent-purple));
  font: 700 9.5px var(--ui-font-mono);
}
.generic-section header span {
  padding: 0 10px;
  color: var(--ui-text-tertiary);
  font: 600 10.5px/28px var(--ui-font-sans);
}
.generic-section pre {
  max-height: 220px;
  margin: 0;
  overflow: auto;
  padding: 9px 12px 9px 54px;
  background: linear-gradient(
    90deg,
    var(--ui-bg-surface-soft) 43px,
    var(--ui-border-subtle) 44px,
    transparent 45px
  );
  color: var(--ui-text-secondary);
  font: 11px/1.6 var(--ui-font-mono);
  white-space: pre-wrap;
  word-break: break-all;
}
.generic-inspector.is-error {
  border-top: 2px solid var(--ui-danger);
}
.generic-inspector.is-error .generic-section:last-child header b,
.generic-inspector.is-error .generic-section:last-child pre {
  color: var(--ui-danger);
}
.generic-inspector.is-error .generic-section:last-child pre {
  background-color: var(--ui-danger-soft);
}
</style>
