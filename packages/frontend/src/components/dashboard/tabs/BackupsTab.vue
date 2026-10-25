<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { PButton, PDialog, PInput, PSelect, PSwitch, PixelIcon } from '../../pixel'
import { t, getDisplayLocale } from '../../../i18n'
import { backupApi, type BackupCatalogue } from '../../../api/modules/backupApi'
import type { BackupLevel, BackupModule, BackupPreview, BackupRecord, BackupSelection, ImportPolicy } from '@infos/shared'

const tr = (source: string, values: readonly unknown[] = []) => t('ui.backup', source, values)
const modules: BackupModule[] = ['settings', 'agents', 'conversations', 'memory', 'facts', 'knowledge', 'tasks', 'workspace', 'applications']
const labels: Record<BackupModule, string> = { settings: '配置', agents: '角色资源', conversations: '对话与附件', memory: '主模式与社交记忆', facts: '共享事实', knowledge: '文档知识库', tasks: '任务与成果', workspace: '角色工作区', applications: '子应用数据' }
const levels: Record<BackupLevel, { label: string; detail: string; icon: string; modules: BackupModule[] }> = {
  settings: { label: '配置', detail: '模型、提示词与偏好', icon: 'settings', modules: ['settings'] },
  agent: { label: '角色', detail: '人设、记忆与相伴记录', icon: 'users', modules: ['agents', 'conversations', 'memory', 'workspace'] },
  content: { label: '内容', detail: '选择会话、知识和任务', icon: 'file', modules: ['conversations'] },
  full: { label: '完整服务端', detail: '用于整机迁移与恢复', icon: 'database', modules },
}
const selection = reactive<BackupSelection>({ level: 'settings', modules: ['settings'], agentIds: [], threadIds: [], documentIds: [], factIds: [], taskIds: [], includeSecrets: false })
const catalogue = ref<BackupCatalogue>({ agents: [], threads: [], documents: [], facts: [], tasks: [] })
const records = ref<BackupRecord[]>([])
const recoveryCount = computed(() => records.value.filter((record) => record.reason === 'before-import').length)
const pending = ref<{ ticket: string; backupId: string } | null>(null)
const busy = ref(''), error = ref(''), notice = ref(''), password = ref('')
const fileInput = ref<HTMLInputElement | null>(null)
const preview = ref<BackupPreview | null>(null)
const conflict = ref<ImportPolicy['conflict']>('skip')
const targets = reactive<Record<string, string>>({})
const confirmImport = ref(false), deleteRecord = ref<BackupRecord | null>(null)
const copiedAgents = ref(false)
const activeFilter = ref<'agentIds' | 'threadIds' | 'documentIds' | 'factIds' | 'taskIds'>('agentIds')
const search = ref('')
const filters = computed(() => [
  { value: 'agentIds', label: tr('角色') }, { value: 'threadIds', label: tr('会话') },
  { value: 'documentIds', label: tr('知识文档') }, { value: 'factIds', label: tr('事实对象') }, { value: 'taskIds', label: tr('任务') },
])
const choices = computed(() => {
  const values = { agentIds: catalogue.value.agents, threadIds: catalogue.value.threads, documentIds: catalogue.value.documents, factIds: catalogue.value.facts, taskIds: catalogue.value.tasks }[activeFilter.value]
  return values.filter((item) => `${item.label} ${item.id}`.toLowerCase().includes(search.value.toLowerCase()))
})
const importedAgents = computed(() => [...new Set([...(preview.value?.manifest.selection.agentIds ?? []), ...(preview.value?.manifest.files.filter((file) => file.path.startsWith('agents/')).map((file) => file.path.split('/')[1]!) ?? [])])])
const strategyOptions = computed(() => preview.value?.manifest.selection.level === 'full'
  ? [{ value: 'replace', label: tr('整体恢复') }]
  : [{ value: 'skip', label: tr('保留已有数据') }, { value: 'replace', label: tr('覆盖冲突项') }, { value: 'duplicate', label: tr('追加为新副本') }])
const hasConflict = computed(() => Object.values(preview.value?.conflicts ?? {}).some((count) => count > 0))
const previewGroups = computed(() => {
  const groups = [
    { label: '配置', tables: ['configs', 'provider_connections', 'ai_model_configs', 'mcp_configs'] },
    { label: '对话与附件', tables: ['threads', 'thread_messages', 'message_attachments', 'social_messages', 'thread_character_state_events'] },
    { label: '主模式与社交记忆', tables: ['event_notes', 'event_memory_relations', 'event_note_coverages', 'social_contact_impressions', 'backup_social_nodes'] },
    { label: '共享事实', tables: ['fact_objects', 'fact_records'] },
    { label: '文档知识库', tables: ['knowledge_documents', 'knowledge_parts'] },
    { label: '任务与成果', tables: ['background_tasks', 'task_plans', 'task_plan_mutations'] },
  ]
  return groups.map((group) => ({ label: group.label, count: group.tables.reduce((sum, table) => sum + (preview.value?.counts[table] ?? 0), 0), conflicts: group.tables.reduce((sum, table) => sum + (preview.value?.conflicts[table] ?? 0), 0) })).filter((group) => group.count || group.conflicts)
})
const fileBytes = (size: number) => size < 1024 ** 2 ? `${(size / 1024).toFixed(1)} KiB` : size < 1024 ** 3 ? `${(size / 1024 ** 2).toFixed(1)} MiB` : `${(size / 1024 ** 3).toFixed(1)} GiB`
const date = (value: string) => new Date(value).toLocaleString(getDisplayLocale())
const warningText: Record<string, string> = {
  CREDENTIALS_EXCLUDED: '凭据未包含，导入后可能需要重新配置连接',
  MEMORY_INDEX_REBUILD: '记忆正文和关系会保留，检索索引将在恢复时重建',
  EXTERNAL_WORKSPACES_EXCLUDED: '仅包含服务端管理的数据，外部工作目录需单独备份',
  AGENT_DEFINITION_MISSING: '部分角色定义不存在，相关来源信息仍保留',
  APPLICATION_RESULTS_EXCLUDED: '子应用内的任务成果需同时选择子应用数据',
  TASK_RECORDS_EXCLUDED: '未选择任务，历史工具卡片关联的任务详情不会随包导出',
  MEMORY_SOURCES_EXTERNAL: '部分记忆来源会话未导出，来源标识与记忆正文仍保留',
  ATTACHMENTS_MISSING: '部分附件原文件已缺失，备份中会保留对应记录',
}
async function run(key: string, action: () => Promise<void>) {
  if (busy.value) return
  busy.value = key; error.value = ''; notice.value = ''
  try { await action() } catch (cause) { error.value = (cause as Error).message }
  finally { busy.value = '' }
}
async function refresh() {
  const [list, options] = await Promise.all([backupApi.list(), backupApi.catalogue()])
  records.value = list.data!.records; pending.value = list.data!.pending; catalogue.value = options.data!
  if (list.data?.lastImport?.status === 'failed') error.value = tr('上次导入未完成，原有业务数据已保留，请检查备份后重试')
}
function chooseLevel(level: BackupLevel) { selection.level = level; selection.modules = [...levels[level].modules] }
function setFilter(value: string | number) { activeFilter.value = value as typeof activeFilter.value }
function setConflict(value: string | number) { conflict.value = value as ImportPolicy['conflict'] }
function toggleModule(module: BackupModule) {
  selection.modules = selection.modules.includes(module) ? selection.modules.filter((value) => value !== module) : [...selection.modules, module]
}
function toggleChoice(id: string) {
  const values = selection[activeFilter.value]
  selection[activeFilter.value] = values.includes(id) ? values.filter((value) => value !== id) : [...values, id]
}
async function create(download: boolean) {
  await run('create', async () => {
    const result = await backupApi.create(selection, password.value)
    await refresh()
    notice.value = tr('备份已保存在当前服务端')
    if (download) await backupApi.download(result.data!.id, password.value)
  })
}
function showPreview(value: BackupPreview) {
  preview.value = value; copiedAgents.value = false
  for (const key of Object.keys(targets)) delete targets[key]
  for (const id of importedAgents.value) targets[id] = id
  conflict.value = value.manifest.selection.level === 'full' ? 'replace' : 'skip'
}
async function upload(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0]
  if (file) await run('preview', async () => showPreview(await backupApi.upload(file, password.value)))
  input.value = ''
}
async function savedPreview(record: BackupRecord) {
  await run(`preview:${record.id}`, async () => showPreview((await backupApi.previewSaved(record.id, password.value)).data!))
}
watch(copiedAgents, (value) => {
  for (const id of importedAgents.value) {
    let target = id, index = 1
    if (value) { target = `${id.toLowerCase()}_copy`; while (catalogue.value.agents.some((agent) => agent.id === target)) target = `${id.toLowerCase()}_copy_${++index}` }
    targets[id] = target
  }
  if (value) conflict.value = 'duplicate'
})
async function commit() {
  if (!preview.value) return
  await run('import', async () => {
    await backupApi.commit(preview.value!.ticket, { conflict: conflict.value, agentTargets: { ...targets } })
    confirmImport.value = false; preview.value = null
    await refresh(); notice.value = tr('导入已暂存，请重启当前服务端；浏览器刷新不会应用恢复')
  })
}
onMounted(() => { void run('load', refresh) })
</script>

<template>
  <div class="backup-page" :aria-busy="Boolean(busy)">
    <header class="backup-heading">
      <div class="backup-brand">
        <div class="backup-mark" aria-hidden="true"><PixelIcon name="database" size="2xl" /><span><PixelIcon name="heart" size="xs" /></span></div>
        <div><h1>{{ tr('数据与备份') }}</h1><p>{{ tr('把相伴的记录，妥善收藏') }}</p><small class="backup-location"><span />{{ tr('保存在当前连接的服务端') }}</small></div>
      </div>
      <div class="backup-heading-end">
        <dl class="backup-overview"><div><dt>{{ tr('备份记录') }}</dt><dd>{{ records.length }}</dd></div><div><dt>{{ tr('导入前恢复点') }}</dt><dd>{{ recoveryCount }}</dd></div></dl>
        <PButton variant="ghost" :disabled="Boolean(busy)" @click="run('load', refresh)"><PixelIcon name="refresh" size="sm" :animation="busy === 'load' ? 'spin' : ''" />{{ tr('刷新') }}</PButton>
      </div>
    </header>
    <p v-if="error" role="alert" class="backup-message error">{{ error }}</p>
    <p v-if="notice" role="status" class="backup-message">{{ notice }}</p>
    <section v-if="pending" class="backup-pending">
      <PixelIcon name="clock" size="md" /><div><strong>{{ tr('有待应用的导入') }}</strong><p>{{ tr('重启当前服务端后生效；应用前会自动建立恢复点') }}</p></div>
      <PButton variant="ghost" :disabled="Boolean(busy)" @click="run('cancel', async () => { await backupApi.cancel(); await refresh() })">{{ tr('取消导入') }}</PButton>
    </section>
    <div class="backup-workbench">
      <section class="backup-panel backup-export">
        <div class="backup-section-title"><span class="backup-section-icon"><PixelIcon name="download" size="md" /></span><h2>{{ tr('导出与备份') }}</h2><span class="backup-section-index" aria-hidden="true">01</span></div>
        <div class="backup-levels" role="group" :aria-label="tr('导出范围')">
          <button v-for="(option, level) in levels" :key="level" :class="{ selected: selection.level === level }" :aria-pressed="selection.level === level" :disabled="Boolean(busy)" @click="chooseLevel(level)">
            <span class="backup-level-icon"><PixelIcon :name="option.icon" size="md" /></span><strong>{{ tr(option.label) }}</strong><small>{{ tr(option.detail) }}</small><span class="backup-level-check" aria-hidden="true"><PixelIcon v-if="selection.level === level" name="check" size="xs" /></span>
          </button>
        </div>
        <div v-if="selection.level !== 'full'" class="backup-module-group">
          <div class="backup-group-label"><span>{{ tr('包含的数据') }}</span><small>{{ selection.modules.length }} / {{ modules.length }}</small></div>
          <div class="backup-modules">
            <button v-for="module in modules" :key="module" :aria-pressed="selection.modules.includes(module)" :class="{ selected: selection.modules.includes(module) }" :disabled="Boolean(busy)" @click="toggleModule(module)"><span class="pixel-check" aria-hidden="true"><PixelIcon v-if="selection.modules.includes(module)" name="check" size="xs" /></span>{{ tr(labels[module]) }}</button>
          </div>
        </div>
        <details v-if="selection.level !== 'full'" class="backup-filters" :open="selection.level === 'agent'">
          <summary>{{ tr('筛选具体内容') }} <small>{{ tr('未选择的筛选项表示全部') }}</small></summary>
          <div class="backup-filter-controls"><PSelect :model-value="activeFilter" :options="filters" @update:model-value="setFilter" /><PInput v-model="search" :placeholder="tr('搜索名称或标识')" /></div>
          <div class="backup-choice-list">
            <label v-for="item in choices" :key="item.id" :class="{ selected: selection[activeFilter].includes(item.id) }"><input type="checkbox" :checked="selection[activeFilter].includes(item.id)" :disabled="Boolean(busy)" @change="toggleChoice(item.id)" /><span>{{ item.label || item.id }}<small>{{ item.id }}</small></span></label>
            <p v-if="!choices.length" class="backup-muted">{{ tr('暂无可选内容') }}</p>
          </div>
        </details>
        <div class="backup-credentials">
          <div class="backup-group-label"><span><PixelIcon name="shield" size="sm" />{{ tr('口令与凭据') }}</span></div>
          <div class="backup-secret-row"><PSwitch v-model="selection.includeSecrets" :disabled="Boolean(busy)" :label="tr('包含 API Key 与连接凭据')" /></div>
          <p class="backup-muted">{{ tr('携带凭据时需至少八位口令；节点身份与配对关系留在原设备') }}</p>
          <label class="backup-password"><span>{{ tr('备份口令') }}</span><PInput v-model="password" type="password" :disabled="Boolean(busy)" :placeholder="tr('备份口令，也用于解锁导入文件')" /></label>
        </div>
        <div class="backup-actions"><PButton :loading="busy === 'create'" :disabled="Boolean(busy) || !selection.modules.length || (selection.level === 'agent' && !selection.agentIds.length)" @click="create(false)"><PixelIcon v-if="busy !== 'create'" name="database" size="sm" />{{ tr('保存备份') }}</PButton><PButton variant="secondary" :disabled="Boolean(busy) || !selection.modules.length || (selection.level === 'agent' && !selection.agentIds.length)" @click="create(true)"><PixelIcon name="download" size="sm" />{{ tr('导出到本机') }}</PButton></div>
      </section>
      <section class="backup-panel backup-import" :class="{ 'has-preview': preview }">
        <div class="backup-section-title"><span class="backup-section-icon"><PixelIcon name="file" size="md" /></span><h2>{{ tr('导入数据') }}</h2><span class="backup-section-index" aria-hidden="true">02</span></div>
        <div class="backup-upload">
          <div class="backup-file-art" aria-hidden="true"><PixelIcon name="file" size="2xl" /><span><PixelIcon name="sparkle" size="sm" /></span></div>
          <h3>{{ tr('先看看，再恢复') }}</h3><p>{{ tr('上传后只生成预览，确认前不会修改业务数据') }}</p>
          <PButton variant="secondary" :loading="busy === 'preview'" :disabled="Boolean(busy) || Boolean(pending)" @click="fileInput?.click()"><PixelIcon v-if="busy !== 'preview'" name="file" size="sm" />{{ tr('选择备份文件') }}</PButton>
          <input ref="fileInput" class="backup-file-input" type="file" accept=".infos-backup" @change="upload" />
        </div>
        <label class="backup-password backup-import-password"><span>{{ tr('导入文件口令') }}</span><PInput v-model="password" type="password" :disabled="Boolean(busy)" :placeholder="tr('备份口令，也用于解锁导入文件')" /></label>
        <ol v-if="!preview" class="backup-import-steps" :aria-label="tr('导入数据')"><li><span>1</span>{{ tr('选择备份文件') }}</li><li><span>2</span>{{ tr('先看看，再恢复') }}</li><li><span>3</span>{{ tr('确认导入方案') }}</li></ol>
        <template v-if="preview">
          <div class="backup-preview-meta"><strong>{{ tr(levels[preview.manifest.selection.level].label) }}</strong><span>{{ date(preview.manifest.createdAt) }}</span><small>{{ tr('来源版本 {0}', [preview.manifest.appVersion]) }}</small></div>
          <dl class="backup-counts"><div><dt>{{ tr('数据记录') }}</dt><dd>{{ Object.values(preview.counts).reduce((sum, count) => sum + count, 0) }}</dd></div><div><dt>{{ tr('文件') }}</dt><dd>{{ preview.manifest.files.length }}</dd></div><div><dt>{{ tr('文件大小') }}</dt><dd>{{ fileBytes(preview.manifest.files.reduce((sum, file) => sum + file.size, 0)) }}</dd></div></dl>
          <div class="backup-breakdown"><div v-for="group in previewGroups" :key="group.label"><span>{{ tr(group.label) }}</span><strong>{{ tr('{0} 条记录 · {1} 项冲突', [group.count, group.conflicts]) }}</strong></div></div>
          <div v-if="preview.warnings.length" class="backup-warnings"><p v-for="warning in preview.warnings" :key="warning"><PixelIcon name="info" size="xs" />{{ tr(warningText[warning] || '这份备份包含需要留意的兼容信息') }}</p></div>
          <p v-if="preview.alreadyImported" class="backup-message error">{{ tr('这份备份已导入，不能重复执行') }}</p>
          <p v-else-if="hasConflict" class="backup-message">{{ tr('发现已有数据，请选择冲突处理方式') }}</p>
          <label class="backup-field"><span>{{ tr('冲突处理') }}</span><PSelect :model-value="conflict" :options="strategyOptions" @update:model-value="setConflict" /></label>
          <template v-if="preview.manifest.selection.level !== 'full' && importedAgents.length">
            <PSwitch v-model="copiedAgents" :label="tr('导入为新角色')" />
            <label v-for="id in importedAgents" :key="id" class="backup-field"><span>{{ tr('角色 {0} 的目标标识', [id]) }}</span><PInput v-model="targets[id]" /></label>
          </template>
          <p class="backup-muted">{{ tr('确认后暂存，重启时导入；覆盖前自动备份，机器身份保持不变') }}</p>
          <PButton :disabled="Boolean(busy) || preview.alreadyImported || Boolean(pending)" @click="confirmImport = true">{{ tr('确认导入方案') }}</PButton>
        </template>
      </section>
    </div>
    <section class="backup-panel backup-history">
      <div class="backup-section-title"><span class="backup-section-icon"><PixelIcon name="clock" size="md" /></span><h2>{{ tr('备份记录') }}<small class="backup-history-count">{{ records.length }}</small></h2><small class="backup-history-location">{{ tr('保存在当前连接的服务端') }}</small><span class="backup-section-index" aria-hidden="true">03</span></div>
      <div v-if="!records.length" class="backup-empty"><div class="backup-empty-art" aria-hidden="true"><PixelIcon name="database" size="xl" /><span><PixelIcon name="heart" size="xs" /></span></div><p>{{ tr('还没有备份，从保存第一份开始') }}</p></div>
      <article v-for="record in records" :key="record.id" class="backup-record" :class="{ recovery: record.reason === 'before-import' }">
        <span class="backup-record-icon"><PixelIcon :name="record.reason === 'before-import' ? 'shield' : levels[record.level].icon" size="md" /></span><div class="backup-record-info"><strong>{{ record.reason === 'before-import' ? tr('导入前恢复点') : tr(levels[record.level].label) }}<span class="backup-protection" :class="{ encrypted: record.encrypted }">{{ record.encrypted ? tr('已加密') : tr('未加密') }}</span></strong><small><span>{{ date(record.createdAt) }}</span><span>{{ fileBytes(record.size) }}</span></small></div>
        <div class="backup-record-actions"><PButton variant="ghost" :disabled="Boolean(busy) || Boolean(pending)" @click="savedPreview(record)">{{ tr('查看与恢复') }}</PButton><PButton variant="ghost" :disabled="Boolean(busy)" @click="run('download', () => backupApi.download(record.id, password))"><PixelIcon name="download" size="sm" />{{ tr('下载') }}</PButton><PButton class="backup-delete" variant="ghost" :disabled="Boolean(busy)" @click="deleteRecord = record">{{ tr('删除') }}</PButton></div>
      </article>
    </section>
    <PDialog v-model="confirmImport" :title="tr('应用导入方案')" :message="tr('导入将在服务端重启时执行，覆盖前会建立恢复点。是否暂存此方案？')" :loading="busy === 'import'" :auto-close="false" :confirm-variant="conflict === 'replace' ? 'danger' : 'primary'" @confirm="commit" />
    <PDialog :model-value="Boolean(deleteRecord)" :title="tr('删除备份')" :message="tr('删除这份服务端备份文件？当前业务数据不受影响。')" confirm-variant="danger" @cancel="deleteRecord = null" @confirm="run('delete', async () => { await backupApi.remove(deleteRecord!.id); deleteRecord = null; await refresh() })" />
  </div>
</template>

<style scoped>
.backup-page {
  --backup-accent: var(--ui-accent-purple);
  --backup-paper: color-mix(in srgb, var(--ui-bg-surface) 95%, transparent);
  --backup-inset: var(--ui-bg-surface-soft);
  max-width: 1480px;
  margin: 0 auto;
  padding: 28px 28px 36px;
  color: var(--ui-text-primary);
}
.backup-heading {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 25px 28px;
  margin-bottom: 26px;
  border: 1px solid var(--ui-border-default);
  border-radius: 3px;
  background: radial-gradient(ellipse at 0 0, color-mix(in srgb, var(--ui-accent-purple) 13%, transparent), transparent 60%), var(--backup-paper);
  box-shadow: var(--ui-shadow-md);
}
.backup-heading::before {
  content: '';
  position: absolute;
  top: -1px;
  left: 28px;
  width: 82px;
  height: 3px;
  background: var(--ui-accent-purple);
  box-shadow: 90px 0 0 -1px var(--ui-accent-primary);
}
.backup-brand, .backup-heading-end { display: flex; align-items: center; gap: 22px; min-width: 0; }
.backup-heading h1 { font-family: var(--font-pixel); font-size: 25px; line-height: 1.4; margin: 0 0 6px; }
.backup-heading p { margin: 0; color: var(--ui-text-secondary); font-size: 13px; }
.backup-location { display: flex; align-items: center; gap: 6px; margin-top: 12px; color: var(--ui-text-secondary); font-size: 10px; }
.backup-location > span { width: 5px; height: 5px; background: var(--ui-accent-purple); }
.backup-mark {
  position: relative;
  display: grid;
  place-items: center;
  width: 66px;
  height: 66px;
  flex-shrink: 0;
  color: var(--ui-accent-purple);
  border: 1px solid color-mix(in srgb, var(--ui-accent-purple) 35%, var(--ui-border-default));
  background: var(--ui-bg-surface);
  box-shadow: 5px 5px 0 color-mix(in srgb, var(--ui-accent-purple) 15%, transparent);
  transform: rotate(-4deg);
}
.backup-mark > span, .backup-file-art > span, .backup-empty-art > span { position: absolute; display: grid; place-items: center; width: 22px; height: 22px; color: var(--ui-accent-primary); background: var(--ui-bg-surface); border: 1px solid color-mix(in srgb, var(--ui-accent-primary) 35%, var(--ui-border-default)); }
.backup-mark > span { right: -9px; bottom: -5px; transform: rotate(4deg); }
.backup-overview { display: flex; gap: 24px; margin: 0; }
.backup-overview > div { display: flex; flex-direction: column-reverse; gap: 5px; min-width: 64px; padding-left: 20px; border-left: 1px solid var(--ui-border-default); }
.backup-overview dt { font-size: 11px; color: var(--ui-text-secondary); }
.backup-overview dd { margin: 0; color: var(--ui-accent-purple); font-family: var(--font-pixel); font-size: 27px; line-height: 1.2; font-variant-numeric: tabular-nums; }
.backup-workbench { display: grid; grid-template-columns: minmax(0, 1.18fr) minmax(0, 1fr); gap: 22px; margin-bottom: 24px; }
.backup-panel {
  position: relative;
  min-width: 0;
  padding: 24px;
  background: var(--backup-paper);
  border: 1px solid var(--ui-border-default);
  border-radius: 3px;
  box-shadow: 0 4px 0 color-mix(in srgb, var(--backup-accent) 8%, transparent), var(--ui-shadow-md);
}
.backup-panel::before { content: ''; position: absolute; top: -1px; left: 24px; width: 48px; height: 2px; background: var(--backup-accent); }
.backup-export { --backup-accent: var(--ui-accent-sky); }
.backup-import { display: flex; flex-direction: column; }
.backup-history { --backup-accent: var(--ui-accent-primary); }
.backup-section-title { display: flex; align-items: center; gap: 11px; margin-bottom: 22px; }
.backup-section-icon { display: grid; place-items: center; width: 32px; height: 32px; flex-shrink: 0; color: var(--backup-accent); background: color-mix(in srgb, var(--backup-accent) 10%, var(--ui-bg-surface)); border: 1px solid color-mix(in srgb, var(--backup-accent) 24%, var(--ui-border-subtle)); }
.backup-section-title h2 { display: flex; align-items: center; gap: 9px; font-size: 16px; font-weight: 650; margin: 0; }
.backup-section-index { margin-left: auto; font-family: var(--font-pixel); font-size: 12px; color: var(--ui-text-tertiary); letter-spacing: .08em; }
.backup-section-title small, .backup-muted { color: var(--ui-text-secondary); font-size: 12px; line-height: 1.75; }
.backup-levels { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.backup-levels button {
  position: relative;
  display: grid;
  grid-template-columns: 38px minmax(0, 1fr);
  align-items: center;
  column-gap: 11px;
  row-gap: 5px;
  min-height: 96px;
  padding: 15px 24px 15px 13px;
  text-align: left;
  color: var(--ui-text-secondary);
  background: var(--backup-inset);
  border: 1px solid var(--ui-border-default);
  border-radius: 2px;
  box-shadow: 0 2px 0 var(--ui-border-subtle);
  cursor: pointer;
  transition: transform 140ms ease, border-color 140ms ease, box-shadow 140ms ease, background-color 140ms ease;
}
.backup-level-icon { display: grid; place-items: center; grid-row: span 2; width: 38px; height: 42px; color: var(--ui-text-secondary); background: var(--ui-bg-surface); border: 1px solid var(--ui-border-subtle); }
.backup-levels strong { align-self: end; color: var(--ui-text-primary); font-size: 14px; line-height: 1.4; }
.backup-levels small { align-self: start; font-size: 11px; line-height: 1.6; }
.backup-level-check { position: absolute; display: grid; place-items: center; right: 8px; top: 8px; width: 14px; height: 14px; color: var(--backup-accent); }
.backup-levels button.selected { border-color: var(--backup-accent); background: color-mix(in srgb, var(--backup-accent) 8%, var(--ui-bg-surface)); box-shadow: 3px 3px 0 color-mix(in srgb, var(--backup-accent) 22%, transparent); }
.backup-levels .selected .backup-level-icon { color: var(--backup-accent); border-color: color-mix(in srgb, var(--backup-accent) 25%, var(--ui-border-subtle)); background: color-mix(in srgb, var(--backup-accent) 10%, var(--ui-bg-surface)); }
.backup-levels .selected strong { color: var(--backup-accent); }
.backup-levels button:hover:not(:disabled) { transform: translateY(-2px); border-color: color-mix(in srgb, var(--backup-accent) 60%, var(--ui-border-default)); box-shadow: 0 5px 12px color-mix(in srgb, var(--backup-accent) 10%, transparent); }
.backup-levels button:active:not(:disabled) { transform: translate(1px, 1px); box-shadow: none; }
.backup-module-group { margin-top: 23px; }
.backup-group-label { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 12px; font-size: 12px; font-weight: 600; }
.backup-group-label > span { display: flex; align-items: center; gap: 7px; }
.backup-group-label > small { padding: 2px 6px; font-size: 10px; font-weight: 400; color: var(--ui-text-secondary); background: var(--backup-inset); border: 1px solid var(--ui-border-subtle); font-variant-numeric: tabular-nums; }
.backup-modules { display: flex; flex-wrap: wrap; gap: 8px; }
.backup-modules button { display: flex; align-items: center; gap: 7px; min-height: 32px; padding: 6px 9px; color: var(--ui-text-secondary); background: var(--backup-inset); border: 1px solid var(--ui-border-default); border-radius: 2px; font-size: 11px; cursor: pointer; transition: border-color 140ms ease, background-color 140ms ease; }
.backup-modules .selected { color: var(--backup-accent); border-color: color-mix(in srgb, var(--backup-accent) 40%, var(--ui-border-default)); background: color-mix(in srgb, var(--backup-accent) 8%, var(--ui-bg-surface)); }
.backup-modules button:hover:not(:disabled) { border-color: var(--backup-accent); }
.pixel-check { width: 12px; height: 12px; border: 1px solid var(--ui-border-strong); display: inline-grid; place-content: center; flex-shrink: 0; }
.selected .pixel-check { border-color: var(--backup-accent); }
.backup-filters { border-block: 1px solid var(--ui-border-subtle); margin: 20px 0; padding: 14px 0; }
.backup-filters summary { cursor: pointer; font-size: 12px; }
.backup-filters summary::marker { color: var(--backup-accent); }
.backup-filters summary small { margin-left: 6px; color: var(--ui-text-secondary); font-size: 10px; }
.backup-filter-controls { display: grid; grid-template-columns: 125px minmax(0, 1fr); gap: 8px; margin: 15px 0 10px; }
.backup-choice-list { max-height: 220px; overflow: auto; display: grid; gap: 4px; }
.backup-choice-list label { display: flex; align-items: center; gap: 9px; padding: 8px; border: 1px solid transparent; font-size: 12px; cursor: pointer; }
.backup-choice-list label:hover { background: var(--ui-bg-hover); }
.backup-choice-list label.selected { border-color: color-mix(in srgb, var(--backup-accent) 28%, transparent); background: color-mix(in srgb, var(--backup-accent) 7%, var(--ui-bg-surface)); }
.backup-choice-list label > span { min-width: 0; overflow-wrap: anywhere; }
.backup-choice-list small { display: block; color: var(--ui-text-secondary); font-size: 10px; margin-top: 3px; }
.backup-choice-list input { accent-color: var(--backup-accent); }
.backup-credentials { margin-top: 20px; padding: 16px; background: var(--backup-inset); border: 1px solid var(--ui-border-subtle); border-left: 2px solid color-mix(in srgb, var(--backup-accent) 45%, var(--ui-border-subtle)); }
.backup-credentials .backup-group-label { color: var(--ui-text-secondary); }
.backup-secret-row { margin-bottom: 8px; }
.backup-credentials .backup-muted { margin: 0 0 14px; font-size: 11px; }
.backup-password { display: grid; gap: 7px; min-width: 0; font-size: 11px; color: var(--ui-text-secondary); }
.backup-password :deep(input) { font-size: 12px; }
.backup-actions, .backup-record-actions { display: flex; gap: 10px; flex-wrap: wrap; }
.backup-actions { margin-top: 22px; padding-top: 18px; border-top: 1px solid var(--ui-border-subtle); }
.backup-actions > :first-child { min-width: 138px; }
.backup-upload {
  position: relative;
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 17px;
  min-height: 290px;
  padding: 30px 24px;
  text-align: center;
  color: var(--backup-accent);
  background: radial-gradient(ellipse at 50% 35%, color-mix(in srgb, var(--backup-accent) 8%, transparent), transparent 68%), var(--backup-inset);
  border: 1px dashed color-mix(in srgb, var(--backup-accent) 35%, var(--ui-border-default));
  border-radius: 2px;
}
.backup-upload::before, .backup-upload::after { content: ''; position: absolute; width: 7px; height: 7px; border: 1px solid color-mix(in srgb, var(--backup-accent) 45%, transparent); }
.backup-upload::before { left: 8px; top: 8px; border-right: 0; border-bottom: 0; }
.backup-upload::after { right: 8px; bottom: 8px; border-left: 0; border-top: 0; }
.backup-file-art { position: relative; display: grid; place-items: center; isolation: isolate; width: 78px; height: 88px; margin: 8px 0 4px; border: 1px solid color-mix(in srgb, var(--backup-accent) 35%, var(--ui-border-default)); background: var(--ui-bg-surface); box-shadow: 4px 4px 0 color-mix(in srgb, var(--backup-accent) 14%, transparent); }
.backup-file-art::before { content: ''; position: absolute; z-index: -1; inset: -6px 6px 6px -6px; background: var(--ui-bg-surface); border: 1px solid color-mix(in srgb, var(--backup-accent) 20%, var(--ui-border-default)); transform: rotate(-8deg); }
.backup-file-art > span { right: -12px; top: 9px; width: 26px; height: 26px; }
.backup-upload h3 { font-family: var(--font-pixel); font-size: 18px; margin: 0; color: var(--ui-text-primary); }
.backup-upload p { max-width: 290px; margin: 0 0 5px; color: var(--ui-text-secondary); font-size: 12px; line-height: 1.8; }
.backup-file-input { display: none; }
.backup-import-password { margin-top: 19px; }
.backup-import-steps { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; list-style: none; margin: 22px 0 0; padding: 18px 0 0; border-top: 1px solid var(--ui-border-subtle); }
.backup-import-steps li { position: relative; display: flex; flex-direction: column; align-items: center; gap: 9px; text-align: center; font-size: 10px; line-height: 1.6; color: var(--ui-text-secondary); }
.backup-import-steps li > span { display: grid; place-items: center; width: 22px; height: 22px; border: 1px solid var(--ui-border-default); background: var(--backup-inset); color: var(--backup-accent); font-family: var(--font-pixel); font-size: 10px; }
.backup-import-steps li:not(:last-child)::after { content: ''; position: absolute; top: 10px; left: calc(50% + 19px); width: calc(100% - 26px); height: 1px; background: var(--ui-border-default); }
.has-preview .backup-upload { flex: 0; min-height: 0; padding: 20px; gap: 11px; }
.has-preview .backup-file-art { display: none; }
.has-preview .backup-upload h3 { font-size: 15px; }
.backup-preview-meta { display: flex; flex-wrap: wrap; gap: 10px; padding-top: 22px; font-size: 12px; }
.backup-preview-meta > strong { color: var(--backup-accent); }
.backup-preview-meta > span { margin-left: auto; color: var(--ui-text-secondary); }
.backup-preview-meta small { flex-basis: 100%; color: var(--ui-text-secondary); }
.backup-counts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin: 18px 0; }
.backup-counts > div { padding: 13px 10px; background: var(--backup-inset); border: 1px solid var(--ui-border-subtle); border-top: 2px solid color-mix(in srgb, var(--backup-accent) 40%, var(--ui-border-subtle)); }
.backup-counts dt { font-size: 10px; color: var(--ui-text-secondary); }
.backup-counts dd { margin: 8px 0 0; color: var(--backup-accent); font-family: var(--font-pixel); font-size: 19px; overflow-wrap: anywhere; }
.backup-breakdown { display: grid; margin-bottom: 18px; font-size: 12px; }
.backup-breakdown > div { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 6px; padding: 10px 0; border-bottom: 1px solid var(--ui-border-subtle); }
.backup-breakdown strong { font-weight: 500; color: var(--ui-text-secondary); font-size: 11px; }
.backup-warnings { padding: 10px 12px; background: var(--backup-inset); border-left: 2px solid var(--ui-warning); }
.backup-warnings p { display: flex; align-items: flex-start; gap: 7px; margin: 6px 0; font-size: 11px; line-height: 1.8; color: var(--ui-text-secondary); }
.backup-warnings .pixel-icon { flex-shrink: 0; margin-top: 4px; color: var(--ui-warning); }
.backup-field { display: grid; gap: 8px; margin: 18px 0; font-size: 12px; }
.backup-message, .backup-pending { padding: 14px 16px; border: 1px solid color-mix(in srgb, var(--ui-accent-purple) 25%, var(--ui-border-default)); border-left: 3px solid var(--ui-accent-purple); background: color-mix(in srgb, var(--ui-accent-purple) 8%, var(--ui-bg-surface)); box-shadow: var(--ui-shadow-sm); font-size: 12px; line-height: 1.8; }
.backup-message.error { border-left-color: var(--ui-danger); color: var(--ui-danger); background: color-mix(in srgb, var(--ui-danger) 6%, var(--ui-bg-surface)); }
.backup-pending { display: flex; align-items: center; gap: 12px; margin-bottom: 24px; }
.backup-pending p { margin: 4px 0 0; font-size: 12px; }
.backup-pending > :last-child { margin-left: auto; }
.backup-history-count { display: inline-grid; place-items: center; min-width: 20px; height: 20px; padding: 0 5px; color: var(--backup-accent) !important; background: color-mix(in srgb, var(--backup-accent) 10%, var(--ui-bg-surface)); font-family: var(--font-pixel); font-size: 10px !important; }
.backup-history-location { margin-left: 7px; }
.backup-empty { display: flex; align-items: center; justify-content: center; gap: 24px; min-height: 140px; padding: 26px 20px; background: var(--backup-inset); border: 1px solid var(--ui-border-subtle); }
.backup-empty p { color: var(--ui-text-secondary); font-size: 12px; line-height: 1.8; }
.backup-empty-art { position: relative; display: grid; place-items: center; width: 54px; height: 58px; flex-shrink: 0; color: color-mix(in srgb, var(--ui-accent-purple) 80%, var(--ui-text-secondary)); border: 1px solid var(--ui-border-default); background: var(--ui-bg-surface); box-shadow: 4px 4px 0 var(--ui-border-subtle); transform: rotate(-5deg); }
.backup-empty-art > span { bottom: -5px; right: -8px; transform: rotate(5deg); }
.backup-record { display: flex; align-items: center; gap: 14px; padding: 16px; margin-top: 10px; background: var(--backup-inset); border: 1px solid var(--ui-border-subtle); transition: border-color 140ms ease, background-color 140ms ease; }
.backup-record:hover { border-color: color-mix(in srgb, var(--backup-accent) 28%, var(--ui-border-default)); background: var(--ui-bg-surface); }
.backup-record-icon { display: grid; place-items: center; width: 38px; height: 42px; flex-shrink: 0; color: var(--ui-accent-purple); background: var(--ui-bg-surface); border: 1px solid var(--ui-border-default); }
.backup-record.recovery .backup-record-icon { color: var(--ui-success); }
.backup-record-info { display: grid; gap: 8px; flex: 1; min-width: 0; font-size: 13px; }
.backup-record-info strong { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.backup-record-info > small { display: flex; flex-wrap: wrap; gap: 6px 16px; color: var(--ui-text-secondary); font-size: 11px; }
.backup-protection { padding: 2px 5px; border: 1px solid var(--ui-border-default); font-size: 9px; font-weight: 400; color: var(--ui-text-secondary); }
.backup-protection.encrypted { color: var(--ui-success); border-color: color-mix(in srgb, var(--ui-success) 25%, var(--ui-border-default)); background: var(--ui-success-soft); }
.backup-delete:hover:not(:disabled) { color: var(--ui-danger); }
button:focus-visible, summary:focus-visible { outline: 2px solid var(--backup-accent); outline-offset: 3px; }
button:disabled { cursor: default; opacity: .55; }
@media (max-width: 1100px) {
  .backup-heading { padding: 22px; }
  .backup-heading-end { gap: 15px; }
  .backup-overview { gap: 15px; }
  .backup-overview > div { padding-left: 15px; }
  .backup-workbench { grid-template-columns: 1fr; }
  .backup-upload { min-height: 260px; }
}
@media (max-width: 600px) {
  .backup-page { padding: 16px 14px 24px; }
  .backup-heading { flex-direction: column; align-items: stretch; padding: 22px 18px; gap: 24px; }
  .backup-brand { gap: 18px; }
  .backup-heading h1 { font-size: 21px; }
  .backup-heading-end { justify-content: space-between; }
  .backup-overview > div:first-child { border-left: 0; padding-left: 0; }
  .backup-overview dd { font-size: 23px; }
  .backup-mark { width: 52px; height: 56px; }
  .backup-panel { padding: 18px 15px; }
  .backup-levels { gap: 9px; }
  .backup-levels button { grid-template-columns: 1fr; gap: 8px; padding: 13px; }
  .backup-level-icon { grid-row: auto; width: 32px; height: 34px; }
  .backup-levels strong, .backup-levels small { align-self: auto; }
  .backup-history-location { display: none; }
  .backup-record { flex-wrap: wrap; padding: 13px; }
  .backup-record-actions { width: 100%; padding-top: 5px; }
  .backup-empty { flex-direction: column; gap: 15px; text-align: center; }
  .backup-pending { flex-wrap: wrap; }
  .backup-filters summary small { display: block; margin: 7px 0 0; }
  .backup-filter-controls { grid-template-columns: 1fr; }
}
@media (prefers-reduced-motion: reduce) {
  .backup-page *, .backup-page *::before, .backup-page *::after { transition: none !important; animation: none !important; scroll-behavior: auto; }
}
</style>
