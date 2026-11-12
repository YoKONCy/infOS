<script setup lang="ts">
/** ToolCardWeb — Web 请求检查器：协议、主机、目标与响应正文分轨显示。 */
import { computed } from 'vue'
import { t as __t } from '../../../i18n/index'

const props = defineProps<{ args: string; result?: string; isError?: boolean }>()
function parse(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {}
  }
}
const args = computed(() => parse(props.args))
const url = computed(() => String(args.value.url ?? args.value.target ?? ''))
const target = computed(() => {
  try {
    return new URL(url.value)
  } catch {
    return null
  }
})
const lines = computed(() => (props.result ?? '').split(/\r?\n/).slice(0, 12))
</script>
<template>
  <section class="web-inspector" :class="{ 'is-error': isError }">
    <header>
      <b>{{ __t('ui.tools', '网页') }}</b>
      <strong>{{ target?.hostname || __t('ui.tools', '未知站点') }}</strong>
      <code>{{ target?.protocol.replace(':', '').toUpperCase() || 'URL' }}</code>
    </header>
    <div class="web-target">
      <span>{{ __t('ui.tools', '地址') }}</span>
      <code :title="url">{{ url || __t('ui.tools', '未知地址') }}</code>
    </div>
    <div v-if="result" class="web-response">
      <div v-for="(line, index) in lines" :key="index">
        <i>{{ index + 1 }}</i>
        <code>{{ line || ' ' }}</code>
      </div>
    </div>
    <footer>
      <span>{{ isError ? __t('ui.tools', '请求失败') : __t('ui.tools', '已获取响应') }}</span>
      <span>{{ __t('ui.tools', '{0} 字符', [(result || '').length]) }}</span>
    </footer>
  </section>
</template>
<style scoped>
.web-inspector {
  background: transparent;
}
.web-inspector > header {
  display: grid;
  min-height: 32px;
  grid-template-columns: 52px minmax(0, 1fr) auto;
  align-items: center;
  border-bottom: 1px solid var(--ui-border-subtle);
  background: var(--traj-compartment, var(--ui-bg-surface-soft));
}
.web-inspector > header b {
  display: grid;
  height: 100%;
  place-items: center;
  border-right: 1px solid var(--ui-border-subtle);
  color: var(--tc-accent, var(--ui-accent-sky));
  font: 700 10.5px var(--ui-font-sans);
}
.web-inspector > header strong {
  overflow: hidden;
  padding: 0 10px;
  color: var(--ui-text-primary);
  font: 600 11px var(--ui-font-mono);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.web-inspector > header code {
  height: 100%;
  padding: 0 10px;
  border-left: 1px solid var(--ui-border-subtle);
  color: var(--tc-accent, var(--ui-accent-sky));
  font: 700 10px/32px var(--ui-font-mono);
}
.web-target {
  display: grid;
  min-height: 30px;
  grid-template-columns: 54px minmax(0, 1fr);
  border-bottom: 1px solid var(--ui-border-default);
}
.web-target span {
  padding: 0 9px;
  border-right: 1px solid var(--ui-border-default);
  color: var(--ui-text-tertiary);
  font: 600 10.5px/30px var(--ui-font-sans);
  text-align: center;
}
.web-target code {
  overflow: hidden;
  padding: 0 10px;
  color: var(--ui-text-secondary);
  font: 11px/30px var(--ui-font-mono);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.web-response {
  max-height: 220px;
  overflow: auto;
}
.web-response > div {
  display: grid;
  min-height: 22px;
  grid-template-columns: 42px minmax(max-content, 1fr);
  border-bottom: 1px solid color-mix(in srgb, var(--ui-border-subtle) 55%, transparent);
}
.web-response i {
  padding-right: 9px;
  border-right: 1px solid var(--ui-border-subtle);
  color: var(--ui-text-disabled);
  font: normal 10px/22px var(--ui-font-mono);
  text-align: right;
}
.web-response code {
  padding: 0 10px;
  color: var(--ui-text-secondary);
  font: 11px/22px var(--ui-font-mono);
  white-space: pre;
}
.web-inspector > footer {
  display: flex;
  min-height: 26px;
  align-items: center;
  justify-content: space-between;
  padding: 0 10px;
  border-top: 1px solid var(--ui-border-default);
  background: var(--ui-bg-surface-soft);
  color: var(--ui-text-tertiary);
  font: 600 10.5px var(--ui-font-mono);
}
.web-inspector.is-error {
  border-top: 2px solid var(--ui-danger);
}
.web-inspector.is-error footer span:first-child {
  color: var(--ui-danger);
}
</style>
