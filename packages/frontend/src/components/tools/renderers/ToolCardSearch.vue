<script setup lang="ts">
import { t as __t } from '../../../i18n/index'

/** 搜索文件的紧凑列表；相同文件合并展示，并保留首个命中位置。 */
import { computed, ref } from 'vue'
import {
  parseToolSearchResult,
  toolSearchSummary,
  type ToolSearchRow,
} from '../../../lib/toolSearchResult'
import { requestWorkspaceSearchFile } from '../../../composables/workspace/useWorkspaceSearchNavigation'
import { resourceNavigation } from '../../../composables/resources/useResources'
import { useAgentStore } from '../../../stores/useAgentStore'
import { useThreadStore } from '../../../stores/useThreadStore'
import { useNotificationStore } from '../../../stores/useNotificationStore'
import PixelIcon from '../../pixel/PixelIcon.vue'
const props = defineProps<{ args: string; result?: string; isError?: boolean }>()
function parse(raw?: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw || '{}')
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}
const args = computed(() => parse(props.args))
const result = computed(() => (props.isError ? undefined : parseToolSearchResult(props.result)))
const query = computed(() => String(args.value.query ?? args.value.pattern ?? ''))
const matches = computed(() => result.value?.rows ?? [])
const files = computed(() => {
  const unique = new Map<string, ToolSearchRow & { hits: number }>()
  for (const row of matches.value) {
    const previous = unique.get(row.file)
    if (previous) previous.hits++
    else unique.set(row.file, { ...row, hits: 1 })
  }
  return [...unique.values()]
})
const opening = ref(false)
function fileName(file: string): string {
  return file.replaceAll('\\', '/').split('/').pop() || file
}
function fileLocation(file: string): string {
  const normalized = file.replaceAll('\\', '/')
  const root = result.value?.searchRoot?.replaceAll('\\', '/').replace(/\/$/, '')
  return root && normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized
}
async function openFile(row: ToolSearchRow): Promise<void> {
  if (opening.value || row.kind === 'directory') return
  opening.value = true
  try {
    const agent = useAgentStore()
    const navigation = result.value?.navigation
    if (navigation) {
      if (agent.activeAgentId !== navigation.agentId) await agent.switchAgent(navigation.agentId)
      requestWorkspaceSearchFile({
        ...navigation,
        file: row.file,
        line: row.line,
        column: row.column,
      })
    } else {
      const thread = useThreadStore()
      resourceNavigation.value = {
        revision: (resourceNavigation.value?.revision ?? 0) + 1,
        origin: {
          type: 'workspace',
          value: row.file,
          agentId: agent.activeAgentId,
          threadId: thread.threadId,
          line: row.line,
        },
      }
    }
    const { useMainNav } = await import('../../../composables/main/useMainNav')
    await useMainNav().setTab('workspace')
  } catch (error) {
    useNotificationStore().toast(
      error instanceof Error ? error.message : __t('ui.navigation', '无法打开文件'),
      { type: 'error' },
    )
  } finally {
    opening.value = false
  }
}
const summary = computed(() => {
  if (props.isError) return __t('ui.tools', '搜索失败')
  if (props.result === undefined) return __t('ui.tools', '等待结果')
  return result.value ? toolSearchSummary(result.value) : __t('ui.tools', '搜索结果')
})
const partialPreview = computed(() => result.value?.previewTruncated || result.value?.truncated)
</script>
<template>
  <section class="search-inspector">
    <header>
      <b><PixelIcon name="search" size="xs" aria-hidden="true" /></b>
      <code :title="query">{{ query || __t('ui.tools', '搜索结果') }}</code>
      <strong>{{ summary }}</strong>
    </header>
    <div v-if="result?.searchRoot" class="search-scope" :title="result.searchRoot">
      <span>{{ __t('ui.toolSearchResult', '搜索范围：{0}', [result.searchRoot]) }}</span>
      <small v-if="result.respectGitIgnore !== undefined">
        {{
          result.respectGitIgnore
            ? __t('ui.toolSearchResult', '遵守 Git 忽略规则')
            : __t('ui.toolSearchResult', '包含 Git 忽略项')
        }}
      </small>
    </div>
    <div v-if="files.length" class="search-files" :aria-label="__t('ui.tools', '搜索结果')">
      <button
        v-for="file in files"
        :key="file.file"
        type="button"
        class="search-file"
        :disabled="opening || file.kind === 'directory'"
        :title="__t('ui.toolSearchResult', '在工作区打开：{0}', [file.file])"
        @click="openFile(file)"
      >
        <PixelIcon
          :name="file.kind === 'directory' ? 'folder' : 'file'"
          size="xs"
          aria-hidden="true"
        />
        <span class="search-file__copy">
          <strong>{{ fileName(file.file) }}</strong>
          <small :title="file.content || file.file">
            {{ fileLocation(file.file) }}
            <template v-if="file.content">· {{ file.content }}</template>
          </small>
        </span>
        <code v-if="file.line">
          {{ file.line }}:{{ file.column ?? 1 }}
          <small v-if="file.hits > 1">+{{ file.hits - 1 }}</small>
        </code>
        <PixelIcon name="chevron-right" size="xs" aria-hidden="true" />
      </button>
    </div>
    <pre v-else-if="isError" class="search-error">{{ props.result }}</pre>
    <div v-else-if="props.result === undefined" class="search-empty">
      {{ __t('ui.tools', '等待搜索结果……') }}
    </div>
    <div v-else-if="result?.auditOnly" class="search-empty">
      {{ __t('ui.tools', '已保留数量，正文需重新搜索') }}
    </div>
    <div v-else-if="result" class="search-empty">{{ __t('ui.tools', '未找到匹配项') }}</div>
    <pre v-else class="search-raw">{{ props.result }}</pre>
    <footer v-if="partialPreview" class="search-note">
      {{ __t('ui.toolSearchResult', '结果已截断，可缩小搜索范围查看其余匹配') }}
    </footer>
  </section>
</template>
<style scoped>
.search-scope {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 10px;
  padding: 5px 10px;
  color: var(--ui-text-tertiary);
  border-bottom: 1px solid var(--ui-border-subtle);
  font: 10px/1.4 var(--ui-font-sans);
}
.search-scope > span {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.search-scope > small {
  font: inherit;
}
.search-files {
  max-height: 240px;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.search-file {
  display: flex;
  align-items: center;
  gap: 7px;
  box-sizing: border-box;
  width: 100%;
  min-height: 32px;
  padding: 5px 10px;
  border: 0;
  border-bottom: 1px solid var(--ui-border-subtle);
  background: transparent;
  color: var(--ui-text-tertiary);
  text-align: left;
  cursor: pointer;
}
.search-file:hover:not(:disabled) {
  background: var(--ui-bg-hover);
  color: var(--tc-accent);
}
.search-file:focus-visible {
  outline: 2px solid var(--tc-accent);
  outline-offset: -2px;
}
.search-file:disabled {
  cursor: default;
}
.search-file__copy {
  display: grid;
  flex: 1;
  gap: 2px;
  min-width: 0;
}
.search-file__copy strong,
.search-file__copy small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font: 10px/1.4 var(--ui-font-mono);
}
.search-file__copy strong {
  color: var(--ui-text-primary);
}
.search-file__copy small {
  color: var(--ui-text-tertiary);
}
.search-file > code {
  flex-shrink: 0;
  font: 10px var(--ui-font-mono);
  color: var(--tc-accent);
}
.search-file > code small {
  font: inherit;
  color: var(--ui-text-tertiary);
}
.search-inspector {
  background: var(--ui-bg-surface);
}
.search-inspector > header {
  display: grid;
  min-height: 32px;
  grid-template-columns: 32px minmax(0, 1fr) auto;
  align-items: center;
  border-bottom: 1px solid var(--ui-border-default);
  background: var(--ui-bg-surface-soft);
}
.search-inspector > header b {
  display: grid;
  height: 100%;
  place-items: center;
  border-right: 1px solid var(--ui-border-default);
  color: var(--tc-accent);
  font: 800 9px var(--ui-font-mono);
  letter-spacing: 0.1em;
}
.search-inspector > header code {
  overflow: hidden;
  padding: 0 10px;
  color: var(--ui-text-primary);
  font: 10px var(--ui-font-mono);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.search-inspector > header strong {
  height: 100%;
  padding: 0 10px;
  border-left: 1px solid var(--ui-border-default);
  color: var(--tc-accent);
  font: 800 9px/32px var(--ui-font-mono);
}
.search-empty {
  padding: 18px;
  color: var(--ui-text-disabled);
  font: 800 9px var(--ui-font-mono);
  text-align: center;
  letter-spacing: 0.12em;
}
.search-error {
  margin: 0;
  padding: 10px;
  border-top: 2px solid var(--ui-danger);
  color: var(--ui-danger);
  background: var(--ui-danger-soft);
  font: 10px/1.5 var(--ui-font-mono);
}
.search-raw {
  margin: 0;
  padding: 10px;
  color: var(--ui-text-secondary);
  font: 10px/1.5 var(--ui-font-mono);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.search-note {
  padding: 6px 10px;
  color: var(--ui-text-tertiary);
  font: 10px var(--ui-font-mono);
  text-align: right;
}
@media (max-width: 480px) {
  .search-inspector > header {
    grid-template-columns: 32px minmax(0, 1fr);
  }
  .search-inspector > header strong {
    grid-column: 1 / -1;
    border-left: 0;
    border-top: 1px solid var(--ui-border-subtle);
    line-height: 24px;
  }
}
</style>
