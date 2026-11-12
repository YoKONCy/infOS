<script setup lang="ts">
/** ToolCardTerminal — infOS 命令舱，不模拟 macOS 窗口装饰。 */
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
const command = computed(() =>
  String(args.value.command ?? `terminal #${args.value.terminal_id ?? ''}`),
)
const cwd = computed(() => String(args.value.cwd ?? 'workspace'))
const lines = computed(() => (props.result ?? '').split(/\r?\n/).slice(0, 16))
</script>
<template>
  <section class="terminal-inspector" :class="{ 'is-error': isError }">
    <header>
      <b>$</b>
      <code :title="command">{{ command }}</code>
      <span>{{ cwd }}</span>
    </header>
    <div v-if="result" class="terminal-output">
      <div v-for="(line, index) in lines" :key="index">
        <i>{{ String(index + 1).padStart(2, '0') }}</i>
        <code>{{ line || ' ' }}</code>
      </div>
    </div>
    <footer>
      <span>{{ isError ? __t('ui.tools', '执行异常') : __t('ui.tools', '输出正常') }}</span>
      <span>{{ __t('ui.tools', '{0} 行', [lines.length]) }}</span>
    </footer>
  </section>
</template>
<style scoped>
.terminal-inspector {
  background: #0c111b;
  color: #cbd5e1;
}
.terminal-inspector > header {
  display: grid;
  min-height: 36px;
  grid-template-columns: 36px minmax(0, 1fr) auto;
  align-items: center;
  border-bottom: 1px solid #253044;
  background: #111827;
}
.terminal-inspector > header b {
  display: grid;
  height: 100%;
  place-items: center;
  border-right: 1px solid #253044;
  color: #34d399;
  font: 800 12px var(--ui-font-mono);
}
.terminal-inspector > header code {
  overflow: hidden;
  padding: 0 10px;
  color: #e2e8f0;
  font: 11.5px var(--ui-font-mono);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.terminal-inspector > header span {
  height: 100%;
  padding: 0 10px;
  border-left: 1px solid #253044;
  color: #94a3b8;
  font: 10.5px/36px var(--ui-font-mono);
}
.terminal-output {
  max-height: 280px;
  overflow: auto;
}
.terminal-output > div {
  display: grid;
  min-height: 22px;
  grid-template-columns: 38px minmax(max-content, 1fr);
}
.terminal-output i {
  padding-right: 8px;
  border-right: 1px solid #1f2937;
  color: #64748b;
  font: normal 10px/22px var(--ui-font-mono);
  text-align: right;
}
.terminal-output code {
  padding: 0 10px;
  color: #cbd5e1;
  font: 11px/22px var(--ui-font-mono);
  white-space: pre;
}
.terminal-inspector > footer {
  display: flex;
  min-height: 26px;
  align-items: center;
  justify-content: space-between;
  padding: 0 10px;
  border-top: 1px solid #253044;
  color: #94a3b8;
  background: #111827;
  font: 600 10.5px var(--ui-font-mono);
}
.terminal-inspector.is-error {
  border-top: 2px solid var(--ui-danger);
}
.terminal-inspector.is-error .terminal-output code,
.terminal-inspector.is-error > footer span:first-child {
  color: #fca5a5;
}
</style>
