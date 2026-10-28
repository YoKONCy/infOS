<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import type { ManagedPackageInfo, PackagePermission } from '@infos/shared'
import { packagesApi } from '../../api/modules/packagesApi'
import { t } from '../../i18n'
import { PCard, PButton, PDialog, PixelIcon } from '../pixel'
import PackageSlot from './PackageSlot.vue'
import PackageWebUiPane from './PackageWebUiPane.vue'

const props = defineProps<{ packageId?: string }>()
const items = ref<ManagedPackageInfo[]>([])
const visibleItems = computed(() =>
  props.packageId
    ? items.value.filter((item) => item.manifest.packageId === props.packageId)
    : items.value,
)
const page = ref<{ packageId: string; contributionId: string; name: string }>()
const busy = ref(false)
const error = ref('')
const input = ref<HTMLInputElement>()
const authorization = ref<ManagedPackageInfo>()
const confirmation = ref<{ item: ManagedPackageInfo; action: 'rollback' | 'uninstall' }>()
const extensionSlot = ref<InstanceType<typeof PackageSlot>>()
const permissions: Record<PackagePermission, string> = {
  'runtime:execute': '运行插件代码',
  'filesystem:read': '读取文件',
  'filesystem:write': '写入文件',
  'network:local': '访问本地网络',
  'network:internet': '访问互联网',
  'process:spawn': '创建进程',
  'database:read': '读取数据',
  'database:write': '写入数据',
  'system:info': '读取系统信息',
}
const states: Record<string, string> = {
  installed: '未启用',
  inactive: '已停用',
  active: '运行中',
  activating: '启动中',
  failed: '启动失败',
}
async function refresh() {
  items.value = (await packagesApi.list()).data ?? []
  await extensionSlot.value?.refresh()
}
async function perform(operation: () => Promise<unknown>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await operation()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('ui.packages', '操作失败，请重试。')
  } finally {
    try {
      await refresh()
    } catch {
      error.value ||= t('ui.packages', '无法读取插件列表。')
    }
    busy.value = false
  }
}
async function upload(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (file) await perform(() => packagesApi.install(file))
  if (input.value) input.value.value = ''
}
function toggle(item: ManagedPackageInfo) {
  if (!item.enabled && !item.authorized) {
    authorization.value = item
    return
  }
  void perform(() => packagesApi.enabled(item.manifest.packageId, !item.enabled))
}
async function approve() {
  const item = authorization.value
  if (!item) return
  await perform(async () => {
    await packagesApi.authorize(item.manifest.packageId, item.digest, item.requestedPermissions)
    authorization.value = undefined
    await packagesApi.enabled(item.manifest.packageId, true)
  })
}
async function confirm() {
  const pending = confirmation.value
  if (!pending) return
  confirmation.value = undefined
  await perform(() => packagesApi[pending.action](pending.item.manifest.packageId))
}
function closePage() {
  page.value = undefined
  void perform(async () => undefined)
}
onMounted(() => perform(async () => undefined))
</script>
<template>
  <PackageWebUiPane
    v-if="page"
    :key="`${page.packageId}/${page.contributionId}`"
    v-bind="page"
    @close="closePage"
  />
  <section v-else class="package-manager" :aria-busy="busy">
    <header class="package-toolbar">
      <div>
        <h2>{{ t('ui.packages', '插件') }}</h2>
        <p>{{ t('ui.packages', '导入插件包，审核后启用。更新包可再次导入。') }}</p>
      </div>
      <div class="package-actions">
        <PButton
          variant="secondary"
          size="sm"
          :disabled="busy"
          @click="perform(async () => undefined)"
        >
          {{ t('ui.packages', '刷新') }}
        </PButton>
        <PButton size="sm" :disabled="busy" @click="input?.click()">
          <PixelIcon name="plus" size="xs" />
          {{ t('ui.packages', '导入 ZIP') }}
        </PButton>
      </div>
      <input ref="input" type="file" accept=".zip,application/zip" hidden @change="upload" />
    </header>
    <p v-if="error" role="alert" class="package-error">{{ error }}</p>
    <PCard v-if="!visibleItems.length" pixel padding="lg">
      <p>{{ t('ui.packages', '尚未安装插件') }}</p>
    </PCard>
    <div class="package-list">
      <PCard v-for="item in visibleItems" :key="item.manifest.packageId" pixel padding="lg">
        <div class="package-heading">
          <PixelIcon name="puzzle" size="lg" />
          <div>
            <h3>{{ item.manifest.name }}</h3>
            <code>{{ item.manifest.packageId }} · {{ item.manifest.version }}</code>
          </div>
          <span :class="{ ready: item.state === 'active' }">
            {{ t('ui.packages', states[item.state] ?? '未启用') }}
          </span>
        </div>
        <p class="package-description">{{ item.manifest.description }}</p>
        <details class="package-location">
          <summary>{{ t('ui.packages', '安装目录') }}</summary>
          <code>{{ item.sourceDirectory }}</code>
        </details>
        <div class="package-contributions">
          <span v-for="entry in item.manifest.contributions" :key="entry.id">{{ entry.kind }}</span>
        </div>
        <p v-if="item.error" class="package-error">
          {{ t('ui.packages', '启动未完成，请检查插件依赖或重新审核修改。') }}
        </p>
        <details v-if="item.error" class="package-diagnostics">
          <summary>{{ t('ui.packages', '诊断信息') }}</summary>
          <pre>{{ item.error }}</pre>
        </details>
        <footer class="package-actions">
          <PButton
            v-for="entry in item.manifest.contributions.filter((entry) => entry.kind === 'web-ui')"
            :key="entry.id"
            size="sm"
            variant="secondary"
            :disabled="busy || item.state !== 'active'"
            @click="
              page = {
                packageId: item.manifest.packageId,
                contributionId: entry.id,
                name: item.manifest.name,
              }
            "
          >
            <PixelIcon name="window" size="xs" />
            {{ entry.webUi?.title ?? t('ui.packages', '打开界面') }}
          </PButton>
          <PButton
            size="sm"
            :variant="item.enabled ? 'secondary' : 'primary'"
            :disabled="busy"
            @click="toggle(item)"
          >
            {{ item.enabled ? t('ui.packages', '停用') : t('ui.packages', '启用') }}
          </PButton>
          <PButton
            size="sm"
            variant="secondary"
            :disabled="busy || !item.authorized"
            @click="perform(() => packagesApi.reload(item.manifest.packageId))"
          >
            {{ t('ui.packages', '重载') }}
          </PButton>
          <PButton
            size="sm"
            variant="ghost"
            :disabled="busy"
            @click="perform(() => packagesApi.review(item.manifest.packageId))"
          >
            {{ t('ui.packages', '读取本地修改') }}
          </PButton>
          <PButton
            v-if="item.previousVersion"
            size="sm"
            variant="ghost"
            :disabled="busy"
            @click="confirmation = { item, action: 'rollback' }"
          >
            {{ t('ui.packages', '回退至 {0}', [item.previousVersion]) }}
          </PButton>
          <PButton
            size="sm"
            variant="ghost"
            :disabled="busy"
            @click="confirmation = { item, action: 'uninstall' }"
          >
            {{ t('ui.packages', '卸载') }}
          </PButton>
        </footer>
      </PCard>
    </div>
    <PackageSlot ref="extensionSlot" region="integrations" />
    <PDialog
      :model-value="!!authorization"
      :title="t('ui.packages', '审核插件权限')"
      :auto-close="false"
      :loading="busy"
      @update:model-value="
        (value) => {
          if (!value) authorization = undefined
        }
      "
      @cancel="authorization = undefined"
      @confirm="approve"
    >
      <template v-if="authorization">
        <h3>{{ authorization.manifest.name }} · {{ authorization.manifest.version }}</h3>
        <p v-if="authorization.requestedPermissions.includes('runtime:execute')">
          {{ t('ui.packages', '插件代码将以服务进程的权限运行。请仅授权信任的来源。') }}
        </p>
        <ul>
          <li v-for="permission in authorization.requestedPermissions" :key="permission">
            {{ t('ui.packages', permissions[permission]) }}
          </li>
        </ul>
        <p>{{ t('ui.packages', '授权仅适用于本次审核的版本和内容。') }}</p>
      </template>
    </PDialog>
    <PDialog
      :model-value="!!confirmation"
      :title="t('ui.packages', '确认操作')"
      :message="
        confirmation?.action === 'uninstall'
          ? t('ui.packages', '卸载该插件及其安装文件？')
          : t('ui.packages', '回退后插件将停用，重新审核后可启用。')
      "
      @update:model-value="
        (value) => {
          if (!value) confirmation = undefined
        }
      "
      @cancel="confirmation = undefined"
      @confirm="confirm"
    />
  </section>
</template>
<style scoped>
.package-manager {
  min-width: 0;
}
.package-toolbar,
.package-heading {
  display: flex;
  align-items: center;
  gap: 14px;
}
.package-toolbar {
  flex-wrap: wrap;
  justify-content: space-between;
  margin-bottom: 22px;
}
h2,
h3 {
  margin: 0;
  font-family: var(--ui-font-pixel);
}
h3 {
  font-size: 16px;
}
p {
  color: var(--ui-text-secondary);
  font-size: 12px;
  line-height: 1.8;
}
.package-list {
  display: grid;
  gap: 20px;
}
.package-heading > span {
  margin-left: auto;
  color: var(--ui-text-tertiary);
  font-size: 12px;
}
.package-heading .ready {
  color: var(--ui-accent-green);
}
code {
  display: block;
  margin-top: 5px;
  font: 10px var(--ui-font-mono);
  color: var(--ui-text-tertiary);
}
.package-description {
  margin: 16px 0;
}
.package-location {
  margin-bottom: 14px;
  color: var(--ui-text-tertiary);
  font-size: 11px;
}
.package-location code {
  overflow-wrap: anywhere;
}
.package-contributions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 18px;
}
.package-contributions span {
  padding: 3px 7px;
  border: 1px solid var(--ui-border-default);
  color: var(--ui-text-secondary);
  font: 10px var(--ui-font-mono);
}
.package-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.package-error {
  color: var(--ui-accent-pink);
  overflow-wrap: anywhere;
}
.package-diagnostics {
  margin: 12px 0;
  color: var(--ui-text-secondary);
  font-size: 11px;
}
.package-diagnostics pre {
  max-height: 160px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: 11px/1.7 var(--ui-font-mono);
}
</style>
