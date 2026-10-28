<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref } from 'vue'
import type {
  ExtensionManager,
  InstalledExtension,
  InstalledExtensionKind,
  InstalledExtensionSource,
  InstalledExtensionState,
  InstalledExtensionsView,
} from '@infos/shared'
import { extensionInventoryApi } from '../../api/modules/extensionInventoryApi'
import { getApiBaseUrl } from '../../api/transport'
import { t } from '../../i18n'
import { PButton, PCard, PDialog, PInput, PixelIcon } from '../pixel'

const PackageManagerPane = defineAsyncComponent(() => import('./PackageManagerPane.vue'))
const ExtensionToolsPane = defineAsyncComponent(() => import('./ExtensionToolsPane.vue'))
const FeatureSourcesPage = defineAsyncComponent(() => import('./FeatureSourcesPage.vue'))
const McpTab = defineAsyncComponent(() => import('../dashboard/tabs/McpTab.vue'))
const AgentConfigTab = defineAsyncComponent(() => import('../dashboard/tabs/AgentConfigTab.vue'))

const kinds: Record<InstalledExtensionKind, { label: string; icon: string }> = {
  package: { label: '插件', icon: 'puzzle' },
  skill: { label: '技能', icon: 'brain' },
  persona: { label: '角色包', icon: 'user' },
  model: { label: '桌宠模型', icon: 'cat' },
  mcp: { label: 'MCP 服务', icon: 'terminal' },
  feature: { label: '拓展功能', icon: 'sparkle' },
}
const sources: Record<InstalledExtensionSource, string> = {
  official: '内置资源',
  local: '本地资源',
  workshop: '工坊资源',
}
const states: Record<InstalledExtensionState, string> = {
  ready: '已启用',
  available: '已收录',
  disabled: '已停用',
  starting: '启动中',
  failed: '运行异常',
  'needs-authorization': '待授权',
  'needs-configuration': '待配置',
}
const view = ref<InstalledExtensionsView>({ items: [], unavailable: [] })
const busy = ref(false)
const error = ref<'' | 'load' | 'rescan'>('')
const errorMessage = computed(() =>
  error.value === 'rescan'
    ? t('ui.integrations', '资源重新扫描失败，仍显示最近登记的信息。')
    : error.value === 'load'
      ? t('ui.integrations', '无法读取已安装拓展，请重试。')
      : '',
)
const query = ref('')
const kind = ref<InstalledExtensionKind | 'all'>('all')
const source = ref<InstalledExtensionSource | 'all'>('all')
const state = ref<InstalledExtensionState | 'all'>('all')
const selectedId = ref('')
const manager = ref<{ type: ExtensionManager; id?: string; name?: string }>()
const roleManager = ref<InstanceType<typeof AgentConfigTab>>()
const confirmLeave = ref(false)
let controller: AbortController | undefined
let disposed = false
let loadedServer = ''

const name = (item: InstalledExtension) =>
  item.kind === 'feature'
    ? t('ui.integrations', item.resourceId === 'search' ? '联网搜索' : 'PDF 解析')
    : item.name
const attention = (item: InstalledExtension) =>
  ['failed', 'needs-authorization', 'needs-configuration'].includes(item.state)
const attentionCount = computed(() => view.value.items.filter(attention).length)
const counts = computed(() =>
  Object.fromEntries(
    Object.keys(kinds).map((key) => [
      key,
      view.value.items.filter((item) => item.kind === key).length,
    ]),
  ),
)
const visible = computed(() => {
  const needle = query.value.trim().toLocaleLowerCase()
  return view.value.items
    .filter(
      (item) =>
        (kind.value === 'all' || item.kind === kind.value) &&
        (source.value === 'all' || item.source === source.value) &&
        (state.value === 'all' || item.state === state.value) &&
        (!needle ||
          [name(item), item.resourceId, item.description, item.author, item.ownerPackageId].some(
            (value) => value?.toLocaleLowerCase().includes(needle),
          )),
    )
    .sort(
      (left, right) =>
        Number(attention(right)) - Number(attention(left)) || name(left).localeCompare(name(right)),
    )
})
const selected = computed(
  () => visible.value.find((item) => item.id === selectedId.value) ?? visible.value[0],
)

async function refresh(rescan = false) {
  if (busy.value) return
  controller?.abort()
  const request = new AbortController()
  controller = request
  const server = getApiBaseUrl()
  if (loadedServer !== server) view.value = { items: [], unavailable: [] }
  busy.value = true
  error.value = ''
  try {
    if (rescan) {
      try {
        await extensionInventoryApi.rescanAssets(request.signal)
      } catch {
        error.value = 'rescan'
      }
    }
    if (disposed || request.signal.aborted) return
    if (server !== getApiBaseUrl()) {
      view.value = { items: [], unavailable: [] }
      error.value = 'load'
      return
    }
    const response = await extensionInventoryApi.list(request.signal)
    if (disposed || request.signal.aborted) return
    if (server !== getApiBaseUrl()) {
      view.value = { items: [], unavailable: [] }
      error.value = 'load'
      return
    }
    if (!response.data) throw new Error('EXTENSION_INVENTORY_EMPTY_RESPONSE')
    view.value = response.data
    loadedServer = server
  } catch {
    if (!disposed && !request.signal.aborted) {
      view.value = { items: [], unavailable: [] }
      error.value = 'load'
    }
  } finally {
    if (!disposed && controller === request) busy.value = false
  }
}
function manage(item: InstalledExtension) {
  if (item.manager) manager.value = { type: item.manager, id: item.managerId, name: name(item) }
}
async function back() {
  if (roleManager.value?.saving) return
  if (roleManager.value?.isDirty) {
    confirmLeave.value = true
    return
  }
  await leaveManager()
}
async function leaveManager() {
  confirmLeave.value = false
  manager.value = undefined
  await refresh()
}
async function saveAndBack() {
  await roleManager.value?.saveAgent()
  if (roleManager.value && !roleManager.value.isDirty) await leaveManager()
}
function selectOwner(id: string) {
  query.value = ''
  kind.value = 'package'
  source.value = 'all'
  state.value = 'all'
  selectedId.value = `package:${id}`
}
onMounted(() => {
  void refresh()
})
onBeforeUnmount(() => {
  disposed = true
  controller?.abort()
})
</script>

<template>
  <section class="installed-extensions">
    <template v-if="manager">
      <header class="installed-return">
        <PButton size="sm" variant="ghost" @click="back">
          <PixelIcon name="chevron-left" size="xs" />
          {{ t('ui.integrations', '返回已安装') }}
        </PButton>
        <span>{{ manager.name }}</span>
      </header>
      <PackageManagerPane v-if="manager.type === 'packages'" :package-id="manager.id" />
      <ExtensionToolsPane v-else-if="manager.type === 'extensions'" :package-id="manager.id" />
      <FeatureSourcesPage
        v-else-if="manager.type === 'features' && (manager.id === 'search' || manager.id === 'pdf')"
        :kind="manager.id"
        @back="back"
      />
      <AgentConfigTab
        v-else-if="manager.type === 'agents'"
        ref="roleManager"
        :initial-agent-id="manager.id"
      />
      <McpTab
        v-else
        embedded
        :section="manager.type === 'skills' ? 'skill' : 'mcp'"
        :initial-resource-id="manager.id"
      />
    </template>
    <template v-else>
      <header class="installed-heading">
        <div>
          <h2>{{ t('ui.integrations', '已安装拓展') }}</h2>
          <p>{{ t('ui.integrations', '统一查看当前服务端的拓展与资源。') }}</p>
        </div>
        <div class="installed-actions">
          <PButton variant="secondary" size="sm" :disabled="busy" @click="refresh(true)">
            <PixelIcon name="refresh" size="xs" :animation="busy ? 'spin' : undefined" />
            {{ t('ui.integrations', '刷新') }}
          </PButton>
          <PButton size="sm" @click="manager = { type: 'packages' }">
            <PixelIcon name="plus" size="xs" />
            {{ t('ui.integrations', '导入插件') }}
          </PButton>
        </div>
      </header>
      <div class="installed-summary" aria-live="polite">
        <span>
          <strong>{{ view.items.length }}</strong>
          {{ t('ui.integrations', '已登记') }}
        </span>
        <span :class="{ 'needs-attention': attentionCount }">
          <strong>{{ attentionCount }}</strong>
          {{ t('ui.integrations', '待处理') }}
        </span>
        <span>{{ t('ui.integrations', '服务端资源') }}</span>
      </div>
      <p v-if="errorMessage" class="installed-error" role="alert">{{ errorMessage }}</p>
      <p v-if="view.unavailable.length" class="installed-error" role="alert">
        {{
          t('ui.integrations', '以下分类暂时无法读取：{0}', [
            view.unavailable.map((item) => t('ui.integrations', kinds[item].label)).join('、'),
          ])
        }}
      </p>
      <nav class="installed-kinds" :aria-label="t('ui.integrations', '资源分类')">
        <button
          type="button"
          :class="{ active: kind === 'all' }"
          :aria-pressed="kind === 'all'"
          @click="kind = 'all'"
        >
          {{ t('ui.integrations', '全部') }}
          <span>{{ view.items.length }}</span>
        </button>
        <button
          v-for="(meta, key) in kinds"
          :key="key"
          type="button"
          :class="{ active: kind === key }"
          :aria-pressed="kind === key"
          @click="kind = key"
        >
          <PixelIcon :name="meta.icon" size="xs" />
          {{ t('ui.integrations', meta.label) }}
          <span>{{ view.unavailable.includes(key) ? '—' : counts[key] }}</span>
        </button>
      </nav>
      <div class="installed-filters">
        <PInput
          v-model="query"
          :placeholder="t('ui.integrations', '搜索名称、标识或作者…')"
          :aria-label="t('ui.integrations', '搜索已安装拓展')"
        />
        <select v-model="source" :aria-label="t('ui.integrations', '资源来源')">
          <option value="all">{{ t('ui.integrations', '全部来源') }}</option>
          <option v-for="(label, key) in sources" :key="key" :value="key">
            {{ t('ui.integrations', label) }}
          </option>
        </select>
        <select v-model="state" :aria-label="t('ui.integrations', '运行状态')">
          <option value="all">{{ t('ui.integrations', '全部状态') }}</option>
          <option v-for="(label, key) in states" :key="key" :value="key">
            {{ t('ui.integrations', label) }}
          </option>
        </select>
      </div>
      <div class="installed-layout" :aria-busy="busy">
        <div class="installed-list" :aria-label="t('ui.integrations', '已安装拓展')">
          <p v-if="!visible.length" class="installed-empty" role="status">
            {{ t('ui.integrations', busy ? '正在读取…' : '没有符合条件的拓展。') }}
          </p>
          <button
            v-for="item in visible"
            :key="item.id"
            type="button"
            class="installed-row"
            :class="{ selected: selected?.id === item.id }"
            :aria-pressed="selected?.id === item.id"
            @click="selectedId = item.id"
          >
            <span class="installed-icon">
              <PixelIcon :name="kinds[item.kind].icon" size="md" />
            </span>
            <span class="installed-row-copy">
              <strong>{{ name(item) }}</strong>
              <small>
                {{ item.version ?? t('ui.integrations', '未声明版本') }} ·
                {{ t('ui.integrations', sources[item.source]) }}
              </small>
            </span>
            <span
              class="installed-status"
              :class="{ 'needs-attention': attention(item), ready: item.state === 'ready' }"
            >
              {{ t('ui.integrations', states[item.state]) }}
            </span>
          </button>
        </div>
        <PCard v-if="selected" pixel padding="lg" class="installed-detail">
          <div class="installed-detail-heading">
            <span class="installed-icon">
              <PixelIcon :name="kinds[selected.kind].icon" size="lg" />
            </span>
            <div>
              <small>{{ t('ui.integrations', kinds[selected.kind].label) }}</small>
              <h3>{{ name(selected) }}</h3>
            </div>
          </div>
          <code class="installed-id">{{ selected.resourceId }}</code>
          <p v-if="selected.description" class="installed-description">
            {{ selected.description }}
          </p>
          <dl>
            <div>
              <dt>{{ t('ui.integrations', '版本') }}</dt>
              <dd>{{ selected.version ?? t('ui.integrations', '未声明版本') }}</dd>
            </div>
            <div>
              <dt>{{ t('ui.integrations', '来源') }}</dt>
              <dd>{{ t('ui.integrations', sources[selected.source]) }}</dd>
            </div>
            <div>
              <dt>{{ t('ui.integrations', '状态') }}</dt>
              <dd :class="{ 'needs-attention': attention(selected) }">
                {{ t('ui.integrations', states[selected.state]) }}
              </dd>
            </div>
            <div v-if="selected.author">
              <dt>{{ t('ui.integrations', '作者') }}</dt>
              <dd>{{ selected.author }}</dd>
            </div>
            <div v-if="selected.ownerPackageId">
              <dt>{{ t('ui.integrations', '所属插件') }}</dt>
              <dd>
                <button
                  type="button"
                  class="installed-owner"
                  @click="selectOwner(selected.ownerPackageId!)"
                >
                  {{ selected.ownerPackageId }}
                </button>
              </dd>
            </div>
          </dl>
          <div v-if="selected.contributions?.length" class="installed-tags">
            <span v-for="entry in [...new Set(selected.contributions)]" :key="entry">
              {{ entry }}
            </span>
          </div>
          <section class="installed-requirements">
            <h4>{{ t('ui.integrations', '声明要求') }}</h4>
            <ul v-if="selected.requirements.length">
              <li v-for="(entry, index) in selected.requirements" :key="index">{{ entry }}</li>
            </ul>
            <p v-else>{{ t('ui.integrations', '未声明兼容要求') }}</p>
            <p v-if="selected.missingRequirements.length" class="needs-attention">
              {{ t('ui.integrations', '当前缺少：{0}', [selected.missingRequirements.join(', ')]) }}
            </p>
          </section>
          <p v-if="selected.hasRollback" class="installed-note">
            {{ t('ui.integrations', '保留了上一版本，可在插件管理中回退。') }}
          </p>
          <p v-if="selected.metadataUnavailable" class="needs-attention">
            {{ t('ui.integrations', '部分元数据无法读取，请到管理页面检查。') }}
          </p>
          <p v-if="selected.kind === 'model'" class="installed-note">
            {{ t('ui.integrations', '已发现的模型资源；桌宠加载状态由客户端决定。') }}
          </p>
          <details v-if="selected.location" class="installed-location">
            <summary>{{ t('ui.integrations', '服务端安装位置') }}</summary>
            <code>{{ selected.location }}</code>
          </details>
          <PButton
            v-if="selected.manager"
            class="installed-manage"
            size="sm"
            @click="manage(selected)"
          >
            {{ t('ui.integrations', '管理') }}
            <PixelIcon name="chevron-right" size="xs" />
          </PButton>
          <p v-else class="installed-note">
            {{ t('ui.integrations', '此资源由宿主管理，仅展示信息。') }}
          </p>
        </PCard>
      </div>
    </template>
    <PDialog
      v-model="confirmLeave"
      :title="t('ui.integrations', '返回已安装')"
      :message="t('ui.integrations', '角色修改尚未保存，要保存后返回吗？')"
      :loading="roleManager?.saving"
      :auto-close="false"
    >
      <template #footer>
        <PButton variant="ghost" :disabled="roleManager?.saving" @click="confirmLeave = false">
          {{ t('ui.integrations', '取消') }}
        </PButton>
        <PButton variant="secondary" :disabled="roleManager?.saving" @click="leaveManager">
          {{ t('ui.integrations', '放弃修改并返回') }}
        </PButton>
        <PButton :loading="roleManager?.saving" @click="saveAndBack">
          {{ t('ui.integrations', '保存并返回') }}
        </PButton>
      </template>
    </PDialog>
  </section>
</template>

<style scoped>
.installed-extensions {
  display: flex;
  flex-direction: column;
  gap: 18px;
  min-height: 0;
}
.installed-heading,
.installed-return,
.installed-actions,
.installed-summary,
.installed-detail-heading {
  display: flex;
  align-items: center;
  gap: 12px;
}
.installed-heading {
  justify-content: space-between;
  flex-wrap: wrap;
}
.installed-heading h2,
.installed-detail h3 {
  margin: 0;
  font-family: var(--ui-font-pixel);
}
.installed-heading p,
.installed-description {
  margin: 6px 0 0;
  font-size: 13px;
  color: var(--ui-text-secondary);
  line-height: 1.7;
}
.installed-summary {
  padding: 12px 16px;
  border: 1px solid var(--ui-border-default);
  background: var(--ui-bg-surface-soft);
  font-size: 12px;
  color: var(--ui-text-secondary);
  flex-wrap: wrap;
}
.installed-summary span {
  display: flex;
  align-items: baseline;
  gap: 7px;
}
.installed-summary span + span {
  border-left: 1px solid var(--ui-border-default);
  padding-left: 16px;
}
.installed-summary strong {
  font: 700 21px var(--ui-font-mono);
  color: var(--ui-text-primary);
}
.installed-kinds {
  display: flex;
  gap: 7px;
  flex-wrap: wrap;
}
.installed-kinds button {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 8px 11px;
  background: var(--ui-bg-surface-soft);
  border: 1px solid var(--ui-border-default);
  color: var(--ui-text-secondary);
  cursor: pointer;
  font: 12px var(--ui-font-pixel);
  transition:
    color 150ms,
    border-color 150ms,
    transform 150ms;
}
.installed-kinds button span {
  font: 11px var(--ui-font-mono);
  opacity: 0.75;
}
.installed-kinds button:hover {
  transform: translateY(-1px);
  color: var(--ui-accent-sky);
}
.installed-kinds button.active {
  color: var(--ui-accent-sky);
  border-color: var(--ui-accent-sky);
  box-shadow: inset 0 -2px var(--ui-accent-sky);
}
.installed-filters {
  display: grid;
  grid-template-columns: minmax(180px, 1fr) 150px 150px;
  gap: 10px;
}
.installed-filters select {
  min-width: 0;
  border: 1px solid var(--ui-border-default);
  border-radius: 0;
  background: var(--dash-input-bg);
  color: var(--ui-text-primary);
  padding: 8px;
  font-size: 12px;
}
.installed-layout {
  display: grid;
  grid-template-columns: minmax(260px, 1.1fr) minmax(300px, 1fr);
  gap: 18px;
  align-items: start;
}
.installed-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.installed-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 14px;
  text-align: left;
  border: 1px solid var(--ui-border-default);
  background: var(--ui-bg-surface-soft);
  color: var(--ui-text-primary);
  cursor: pointer;
  transition:
    border-color 150ms,
    background-color 150ms,
    transform 150ms;
}
.installed-row:hover {
  transform: translateX(2px);
  border-color: var(--ui-border-strong);
}
.installed-row.selected {
  border-color: var(--ui-accent-sky);
  box-shadow: inset 3px 0 var(--ui-accent-sky);
}
.installed-icon {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  color: var(--ui-accent-sky);
  border: 1px solid var(--ui-border-default);
  background: var(--ui-bg-surface-soft);
}
.installed-row-copy {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.installed-row-copy strong {
  font-size: 13px;
  overflow-wrap: anywhere;
}
.installed-row-copy small,
.installed-detail-heading small {
  font-size: 11px;
  color: var(--ui-text-tertiary);
}
.installed-status {
  font-size: 11px;
  flex-shrink: 0;
  color: var(--ui-text-secondary);
}
.installed-status.ready {
  color: var(--ui-accent-sky);
}
.needs-attention,
.installed-error {
  color: var(--ui-warning);
}
.installed-error {
  margin: 0;
  font-size: 13px;
}
.installed-detail {
  min-width: 0;
  position: sticky;
  top: 0;
}
.installed-detail h3 {
  font-size: 17px;
  margin-top: 4px;
  overflow-wrap: anywhere;
}
.installed-id {
  display: block;
  margin-top: 14px;
  font-size: 11px;
  color: var(--ui-text-tertiary);
  overflow-wrap: anywhere;
}
.installed-detail dl {
  margin: 20px 0;
}
.installed-detail dl > div {
  display: grid;
  grid-template-columns: 80px minmax(0, 1fr);
  gap: 12px;
  padding: 9px 0;
  border-bottom: 1px solid var(--ui-border-default);
  font-size: 12px;
}
.installed-detail dt {
  color: var(--ui-text-tertiary);
}
.installed-detail dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.installed-owner {
  border: 0;
  padding: 0;
  background: transparent;
  color: var(--ui-accent-sky);
  text-align: left;
  cursor: pointer;
  overflow-wrap: anywhere;
}
.installed-tags {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.installed-tags span {
  padding: 3px 6px;
  border: 1px solid var(--ui-border-default);
  font: 10px var(--ui-font-mono);
  color: var(--ui-text-secondary);
}
.installed-requirements {
  border-left: 2px solid var(--ui-border-strong);
  padding-left: 12px;
  margin: 18px 0;
}
.installed-requirements h4 {
  margin: 0 0 8px;
  font-size: 12px;
}
.installed-requirements p,
.installed-note,
.installed-return {
  font-size: 12px;
  color: var(--ui-text-secondary);
  line-height: 1.7;
}
.installed-requirements ul {
  padding-left: 16px;
  font-size: 12px;
  color: var(--ui-text-secondary);
  overflow-wrap: anywhere;
}
.installed-requirements .needs-attention {
  color: var(--ui-warning);
}
.installed-location {
  margin: 18px 0;
  font-size: 12px;
  color: var(--ui-text-secondary);
}
.installed-location summary {
  cursor: pointer;
}
.installed-location code {
  display: block;
  margin-top: 8px;
  font-size: 11px;
  overflow-wrap: anywhere;
}
.installed-manage {
  margin-top: 16px;
}
.installed-empty {
  padding: 32px 16px;
  text-align: center;
  font-size: 13px;
  color: var(--ui-text-tertiary);
  border: 1px dashed var(--ui-border-default);
}
button:focus-visible,
select:focus-visible {
  outline: 2px solid var(--ui-accent-sky);
  outline-offset: 3px;
}
@media (max-width: 1000px) {
  .installed-layout {
    grid-template-columns: minmax(0, 1fr);
  }
  .installed-detail {
    position: static;
  }
}
@media (max-width: 620px) {
  .installed-filters {
    grid-template-columns: 1fr 1fr;
  }
  .installed-filters :first-child {
    grid-column: 1 / -1;
  }
  .installed-row {
    gap: 8px;
    padding: 10px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .installed-kinds button,
  .installed-row {
    transition: none;
    transform: none;
  }
}
</style>
