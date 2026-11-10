<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type {
  PackagePanel,
  PackageToolGroup,
  PackageToolGroupState,
  PackageToolSettingsSnapshot,
} from '@infos/shared'
import { packagesApi } from '../../api/modules/packagesApi'
import { ApiError } from '../../api/errors'
import { t } from '../../i18n'
import { registerTabLeaveGuard } from '../../composables/main/useMainNav'
import { PButton, PixelIcon } from '../pixel'

const props = defineProps<{ panel: PackagePanel }>()
const emit = defineEmits<{ close: [] }>()
const tr = (source: string, values: readonly unknown[] = []) =>
  t('ui.package-tool-settings', source, values)
const stateLabels: Record<PackageToolGroupState, string> = {
  pinned: '常开',
  ondemand: '按需',
  off: '已关闭',
}
const dialog = ref<HTMLDialogElement>()
const editorDialog = ref<HTMLDialogElement>()
const confirmDialog = ref<HTMLDialogElement>()
const snapshot = shallowRef<PackageToolSettingsSnapshot>()
interface Draft {
  revision: number
  values: Record<string, string>
  groups: PackageToolGroup[]
  ungroupedState: PackageToolGroupState
  disabledTools: string[]
}
const draft = ref<Draft>()
const baseline = ref('')
const loading = ref(false),
  saving = ref(false),
  checking = ref(false)
const error = ref(''),
  message = ref('')
const query = ref(''),
  filter = ref('all')
const expanded = ref(new Set<string>(['__ungrouped']))
const editor = ref<PackageToolGroup>()
const editorQuery = ref('')
let editorBaseline = ''
const editorError = ref('')
const confirmation = ref<{ type: 'discard' | 'reload' | 'delete'; group?: PackageToolGroup }>()
let resolveDecision: ((allowed: boolean) => void) | undefined
let disposed = false,
  request = 0
const UNGROUPED = '__ungrouped'
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value))
const busy = computed(() => loading.value || saving.value || checking.value)
const dirty = computed(() => !!draft.value && JSON.stringify(draft.value) !== baseline.value)
watch(
  draft,
  () => {
    message.value = ''
  },
  { deep: true, flush: 'sync' },
)
const tools = computed(() => new Map(snapshot.value?.tools.map((tool) => [tool.id, tool]) ?? []))
const groups = computed(() => {
  if (!draft.value || !snapshot.value) return []
  const assigned = new Set(draft.value.groups.flatMap((group) => group.tools))
  const ungrouped = snapshot.value.tools
    .filter((tool) => !assigned.has(tool.id))
    .map((tool) => tool.id)
  return [
    ...draft.value.groups,
    ...(ungrouped.length
      ? [
          {
            id: UNGROUPED,
            name: tr('未分组'),
            description: tr('新发现或尚未分组的功能'),
            state: draft.value.ungroupedState,
            tools: ungrouped,
          },
        ]
      : []),
  ]
})
const enabledCount = computed(() =>
  groups.value.reduce(
    (total, group) =>
      total +
      group.tools.filter((id) => group.state !== 'off' && tools.value.has(id) && !draft.value?.disabledTools.includes(id))
        .length,
    0,
  ),
)
const editorTools = computed(() => {
  const q = editorQuery.value.trim().toLocaleLowerCase()
  return (
    snapshot.value?.tools.filter((tool) =>
      `${tool.id} ${tool.title} ${tool.description}`.toLocaleLowerCase().includes(q),
    ) ?? []
  )
})
const visibleGroups = computed(() => {
  const q = query.value.trim().toLocaleLowerCase()
  return groups.value.flatMap((group) => {
    const groupHit = !q || `${group.name} ${group.description}`.toLocaleLowerCase().includes(q)
    const ids = group.tools.filter((id) => {
      const enabled = group.state !== 'off' && !draft.value?.disabledTools.includes(id)
      if (filter.value === 'disabled' && enabled) return false
      if (filter.value === 'enabled' && !enabled) return false
      const tool = tools.value.get(id)
      return (
        groupHit ||
        `${id} ${tool?.title ?? ''} ${tool?.description ?? ''}`.toLocaleLowerCase().includes(q)
      )
    })
    return ids.length || (groupHit && filter.value === 'all')
      ? [{ ...group, visibleTools: ids }]
      : []
  })
})
const allExpanded = computed(
  () =>
    visibleGroups.value.length > 0 &&
    visibleGroups.value.every((group) => expanded.value.has(group.id)),
)
let beforeSearchExpanded = new Set<string>()
watch(query, (value, previous) => {
  if (value.trim()) {
    if (!previous.trim()) beforeSearchExpanded = new Set(expanded.value)
    expanded.value = new Set(visibleGroups.value.map((group) => group.id))
  } else expanded.value = beforeSearchExpanded
})
const hasChanges = () =>
  dirty.value || (!!editor.value && JSON.stringify(editor.value) !== editorBaseline)
const errorText = (cause: unknown) => {
  if (cause instanceof ApiError && cause.code === 'CONFLICT')
    return '插件设置已在其他位置修改，请重新载入后再保存。'
  return cause instanceof Error ? cause.message : '操作失败，请重试。'
}

function apply(value: PackageToolSettingsSnapshot | undefined) {
  if (
    !value ||
    !Number.isInteger(value.revision) ||
    !value.values ||
    !Array.isArray(value.fields) ||
    !Array.isArray(value.groups) ||
    !Array.isArray(value.tools) ||
    !Array.isArray(value.disabledTools) ||
    !Array.isArray(value.fresh)
  )
    throw new Error('插件没有返回有效的设置数据。')
  snapshot.value = value
  draft.value = clone({
    revision: value.revision,
    values: value.values,
    groups: value.groups,
    ungroupedState: value.ungroupedState,
    disabledTools: value.disabledTools,
  })
  baseline.value = JSON.stringify(draft.value)
}
async function load() {
  const current = ++request
  loading.value = true
  error.value = ''
  message.value = ''
  try {
    const response = await packagesApi.action<PackageToolSettingsSnapshot>(
      props.panel.id,
      'settings.load',
    )
    if (!disposed && current === request) apply(response.data)
  } catch (cause) {
    if (!disposed && current === request) error.value = errorText(cause)
  } finally {
    if (!disposed && current === request) loading.value = false
  }
}
async function save() {
  if (!draft.value || busy.value || !dirty.value) return
  saving.value = true
  error.value = ''
  message.value = ''
  const current = ++request
  try {
    const response = await packagesApi.action<PackageToolSettingsSnapshot>(
      props.panel.id,
      'settings.save',
      clone(draft.value) as unknown as Record<string, unknown>,
    )
    if (!disposed && current === request) {
      apply(response.data)
      message.value = '已保存，下一轮对话生效。'
    }
  } catch (cause) {
    if (!disposed && current === request) error.value = errorText(cause)
  } finally {
    if (!disposed && current === request) saving.value = false
  }
}
async function checkField(id: string) {
  if (busy.value || !draft.value) return
  const value = draft.value.values[id]
  const current = request
  checking.value = true
  message.value = ''
  error.value = ''
  try {
    const response = await packagesApi.action<{ ok: boolean }>(props.panel.id, 'settings.check', {
      field: id,
      value,
    })
    if (!disposed && current === request)
      message.value = response.data?.ok
        ? '检测通过，保存后生效。'
        : '检测未通过，请检查配置。'
  } catch (cause) {
    if (!disposed && current === request) error.value = errorText(cause)
  } finally {
    if (!disposed && current === request) checking.value = false
  }
}
async function showConfirmation(value: NonNullable<typeof confirmation.value>) {
  confirmation.value = value
  await nextTick()
  confirmDialog.value?.showModal()
}
function settleDecision(allowed: boolean) {
  confirmDialog.value?.close()
  const pending = confirmation.value
  confirmation.value = undefined
  const resolve = resolveDecision
  resolveDecision = undefined
  if (allowed && pending?.type === 'delete' && draft.value)
    draft.value.groups = draft.value.groups.filter((group) => group.id !== pending.group?.id)
  if (allowed && pending?.type === 'reload') void load()
  resolve?.(allowed)
}
async function allowLeave() {
  if (saving.value) return false
  if (!hasChanges()) return true
  if (resolveDecision) return false
  return new Promise<boolean>((resolve) => {
    resolveDecision = resolve
    void showConfirmation({ type: 'discard' })
  })
}
async function requestClose() {
  if (await allowLeave()) emit('close')
}
function reload() {
  if (dirty.value) void showConfirmation({ type: 'reload' })
  else void load()
}
function beforeUnload(event: BeforeUnloadEvent) {
  if (hasChanges()) {
    event.preventDefault()
    event.returnValue = ''
  }
}
function toggleTool(id: string, enabled: boolean) {
  if (!draft.value) return
  draft.value.disabledTools = enabled
    ? draft.value.disabledTools.filter((value) => value !== id)
    : [...new Set([...draft.value.disabledTools, id])]
}
function setGroupState(id: string, state: PackageToolGroupState): void {
  if (!draft.value) return
  if (id === UNGROUPED) draft.value.ungroupedState = state
  else {
    const group = draft.value.groups.find((item) => item.id === id)
    if (group) group.state = state
  }
}
function moveTool(id: string, target: string) {
  if (!draft.value) return
  for (const group of draft.value.groups) group.tools = group.tools.filter((value) => value !== id)
  if (target !== UNGROUPED) draft.value.groups.find((group) => group.id === target)?.tools.push(id)
  expanded.value.add(target)
  void nextTick(() => focusGroup(target))
}
function toggleExpanded(id: string) {
  if (expanded.value.has(id)) expanded.value.delete(id)
  else expanded.value.add(id)
}
function toggleAll() {
  expanded.value = allExpanded.value
    ? new Set()
    : new Set(visibleGroups.value.map((group) => group.id))
}
function reorderGroup(id: string, offset: number) {
  if (!draft.value) return
  const index = draft.value.groups.findIndex((group) => group.id === id)
  const target = index + offset
  if (index < 0 || target < 0 || target >= draft.value.groups.length) return
  const [group] = draft.value.groups.splice(index, 1)
  draft.value.groups.splice(target, 0, group!)
  void nextTick(() => focusGroup(id))
}
function focusGroup(id: string) {
  const element = [...(dialog.value?.querySelectorAll<HTMLElement>('.tool-group') ?? [])].find(
    (group) => group.dataset.groupId === id,
  )
  element?.scrollIntoView?.({ block: 'nearest' })
  element?.querySelector<HTMLButtonElement>('.group-title')?.focus({ preventScroll: true })
}
function onShortcut(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault()
    event.stopPropagation()
    if (confirmation.value) return
    if (editor.value) commitEditor()
    else void save()
  }
}
async function openEditor(group?: PackageToolGroup) {
  editor.value = group
    ? clone(group)
    : { id: `g-${crypto.randomUUID()}`, name: '', description: '', state: 'ondemand', tools: [] }
  editorBaseline = JSON.stringify(editor.value)
  editorQuery.value = ''
  editorError.value = ''
  await nextTick()
  editorDialog.value?.showModal()
}
function closeEditor() {
  editorDialog.value?.close()
  editor.value = undefined
}
function toggleEditorTool(id: string, enabled: boolean) {
  if (!editor.value) return
  editor.value.tools = enabled
    ? [...new Set([...editor.value.tools, id])]
    : editor.value.tools.filter((value) => value !== id)
}
function commitEditor() {
  const value = editor.value
  if (!value || !draft.value) return
  if (!value.name.trim()) {
    editorError.value = '分组名称不能为空。'
    return
  }
  value.name = value.name.trim()
  const selected = new Set(value.tools)
  for (const group of draft.value.groups)
    if (group.id !== value.id) group.tools = group.tools.filter((id) => !selected.has(id))
  const index = draft.value.groups.findIndex((group) => group.id === value.id)
  if (index < 0) draft.value.groups.push(clone(value))
  else draft.value.groups[index] = clone(value)
  query.value = ''
  filter.value = 'all'
  closeEditor()
  void nextTick(() => {
    expanded.value.add(value.id)
    focusGroup(value.id)
  })
}
let removeGuard: (() => void) | undefined
onMounted(() => {
  dialog.value?.showModal()
  window.addEventListener('beforeunload', beforeUnload)
  window.addEventListener('keydown', onShortcut, true)
  removeGuard = registerTabLeaveGuard(allowLeave)
  void load()
})
onBeforeUnmount(() => {
  disposed = true
  request++
  window.removeEventListener('beforeunload', beforeUnload)
  window.removeEventListener('keydown', onShortcut, true)
  removeGuard?.()
  resolveDecision?.(false)
  confirmDialog.value?.close()
  editorDialog.value?.close()
  dialog.value?.close()
})
</script>

<template>
  <dialog
    ref="dialog"
    class="tool-settings-dialog"
    :aria-label="tr('{0} · 工具管理', [panel.title])"
    @cancel.prevent="requestClose"
  >
    <header class="settings-head">
      <div>
        <small>{{ tr('插件设置') }}</small>
        <h2>{{ tr('{0} · 工具管理', [panel.title]) }}</h2>
      </div>
      <button
        class="icon-button"
        type="button"
        :aria-label="tr('关闭')"
        :disabled="saving"
        @click="requestClose"
      >
        <PixelIcon name="close" size="sm" />
      </button>
    </header>
    <p v-if="error" class="settings-error dialog-error" role="alert">{{ tr(error) }}</p>
    <main class="settings-body">
      <p v-if="loading" role="status">{{ tr('正在载入设置…') }}</p>
      <fieldset v-if="draft && snapshot" :disabled="busy">
        <details class="connection-settings" :open="!snapshot.tools.length">
          <summary>
            <span>{{ tr('插件设置') }}</span>
            <small
              v-if="snapshot.notice"
              :title="tr(snapshot.notice.message, snapshot.notice.parameters)"
            >
              {{ tr(snapshot.notice.message, snapshot.notice.parameters) }}
            </small>
            <PixelIcon name="chevron-down" size="xs" />
          </summary>
          <section class="connection-fields">
            <label v-for="field in snapshot.fields" :key="field.id">
              <span>{{ tr(field.label) }}</span>
              <div class="field-input">
                <input
                  v-model="draft.values[field.id]"
                  type="text"
                  :aria-label="tr(field.label)"
                  :placeholder="field.placeholder ? tr(field.placeholder) : ''"
                />
                <PButton
                  v-if="field.checkable"
                  variant="secondary"
                  size="sm"
                  @click="checkField(field.id)"
                >
                  {{ tr('检测') }}
                </PButton>
              </div>
            </label>
            <p v-if="snapshot.notice" class="settings-notice">
              {{ tr(snapshot.notice.message, snapshot.notice.parameters) }}
            </p>
          </section>
        </details>
        <div class="tool-overview">
          <span>
            {{ tr('{0} 个功能 · {1} 个分组', [snapshot.tools.length, draft.groups.length]) }}
          </span>
          <span class="enabled-count">{{ tr('{0} 个可用', [enabledCount]) }}</span>
          <small>{{ tr('修改后需保存，下一轮对话生效。') }}</small>
        </div>
        <div class="sticky-tools">
          <div class="settings-toolbar">
            <div class="search-field">
              <PixelIcon name="search" size="sm" />
              <input
                v-model="query"
                type="search"
                :aria-label="tr('搜索功能或分组')"
                :placeholder="tr('搜索功能或分组')"
              />
              <button
                v-if="query"
                class="icon-button"
                type="button"
                :aria-label="tr('清空搜索')"
                @click="query = ''"
              >
                <PixelIcon name="close" size="xs" />
              </button>
            </div>
            <select v-model="filter" :aria-label="tr('筛选状态')">
              <option value="all">{{ tr('全部') }}</option>
              <option value="enabled">{{ tr('已启用') }}</option>
              <option value="disabled">{{ tr('已关闭') }}</option>
            </select>
            <PButton variant="secondary" size="sm" @click="openEditor()">
              <PixelIcon name="plus" size="xs" />
              {{ tr('新建分组') }}
            </PButton>
          </div>
          <div class="list-controls">
            <small>{{ tr('分组状态控制启用方式，展开收起仅控制显示。') }}</small>
            <button
              class="text-button"
              type="button"
              :disabled="!visibleGroups.length"
              @click="toggleAll"
            >
              {{ allExpanded ? tr('全部收起') : tr('全部展开') }}
            </button>
          </div>
        </div>
        <p v-if="!snapshot.tools.length" class="settings-empty">
          {{ tr('尚未提供工具，请检查插件配置。') }}
        </p>
        <p v-else-if="!visibleGroups.length" class="settings-empty">
          {{ tr('没有符合条件的功能。') }}
        </p>
        <section
          v-for="group in visibleGroups"
          :key="group.id"
          class="tool-group"
          :data-group-id="group.id"
        >
          <header>
            <button
              class="group-title"
              type="button"
              :aria-expanded="expanded.has(group.id)"
              @click="toggleExpanded(group.id)"
            >
              <PixelIcon
                :name="expanded.has(group.id) ? 'chevron-down' : 'chevron-right'"
                size="xs"
              />
              <span>
                <b>{{ group.name }}</b>
                <small>{{ group.description }}</small>
              </span>
              <em>{{ group.tools.length }}</em>
            </button>
            <select
              class="group-status"
              :value="group.state"
              :aria-label="tr('{0}的启用方式', [group.name])"
              @change="setGroupState(group.id, ($event.target as HTMLSelectElement).value as PackageToolGroupState)"
            >
              <option v-for="(label, state) in stateLabels" :key="state" :value="state">
                {{ tr(label) }}
              </option>
            </select>
            <template v-if="group.id !== UNGROUPED">
              <button type="button" class="text-button" @click="openEditor(group)">
                {{ tr('编辑') }}
              </button>
              <div class="group-order">
                <button
                  class="icon-button"
                  type="button"
                  :disabled="draft.groups[0]?.id === group.id"
                  :aria-label="tr('上移 {0}', [group.name])"
                  :title="tr('上移 {0}', [group.name])"
                  @click="reorderGroup(group.id, -1)"
                >
                  <PixelIcon name="chevron-up" size="xs" />
                </button>
                <button
                  class="icon-button"
                  type="button"
                  :disabled="draft.groups.at(-1)?.id === group.id"
                  :aria-label="tr('下移 {0}', [group.name])"
                  :title="tr('下移 {0}', [group.name])"
                  @click="reorderGroup(group.id, 1)"
                >
                  <PixelIcon name="chevron-down" size="xs" />
                </button>
              </div>
              <button
                type="button"
                class="text-button danger"
                @click="showConfirmation({ type: 'delete', group })"
              >
                {{ tr('删除') }}
              </button>
            </template>
          </header>
          <div v-if="expanded.has(group.id)" class="group-tools">
            <p v-if="!group.visibleTools.length" class="empty-group">
              {{ tr('此分组还没有功能，可通过编辑添加。') }}
            </p>
            <div
              v-for="id in group.visibleTools"
              :key="id"
              class="tool-row"
              :class="{
                'tool-inactive': group.state === 'off' || draft.disabledTools.includes(id),
              }"
            >
              <button
                class="tool-power"
                type="button"
                :disabled="group.state === 'off'"
                :class="{ 'is-off': group.state === 'off' || draft.disabledTools.includes(id) }"
                :aria-pressed="group.state !== 'off' && !draft.disabledTools.includes(id)"
                :aria-label="
                  tr(group.state === 'off' || draft.disabledTools.includes(id) ? '开启 {0}' : '关闭 {0}', [
                    tools.get(id)?.title || id,
                  ])
                "
                @click="toggleTool(id, draft.disabledTools.includes(id))"
              >
                {{ group.state === 'off' || draft.disabledTools.includes(id) ? tr('开启') : tr('关闭') }}
              </button>
              <div class="tool-info">
                <b>
                  {{ tools.get(id)?.title || id }}
                  <small v-if="snapshot.fresh.includes(id)" class="fresh">{{ tr('新') }}</small>
                </b>
                <code>{{ id }}</code>
                <p>{{ tools.get(id)?.description || tr('当前不可用，分组记录已保留。') }}</p>
                <small v-if="group.state === 'off' || draft.disabledTools.includes(id)" class="tool-status">
                  {{ tr('已关闭') }}
                </small>
                <details v-if="tools.get(id)?.params">
                  <summary>{{ tr('参数说明') }}</summary>
                  <p v-for="(param, name) in tools.get(id)!.params" :key="name">
                    <code>{{ name }}</code>
                    · {{ param.required ? tr('必填') : tr('可选') }} · {{ param.description }}
                  </p>
                </details>
              </div>
              <select
                :value="group.id"
                :aria-label="tr('移动 {0} 到分组', [tools.get(id)?.title || id])"
                @change="moveTool(id, ($event.target as HTMLSelectElement).value)"
              >
                <option v-for="target in draft.groups" :key="target.id" :value="target.id">
                  {{ target.name }}
                </option>
                <option :value="UNGROUPED">{{ tr('未分组') }}</option>
              </select>
            </div>
          </div>
        </section>
      </fieldset>
    </main>
    <footer class="settings-footer">
      <p role="status" :class="{ 'dirty-status': dirty }">
        {{
          saving
            ? tr('正在保存…')
            : !draft
              ? tr('设置尚未载入')
            : message
              ? tr(message)
              : dirty
                ? tr('有未保存的修改')
                : tr('设置已同步')
        }}
        <small v-if="!saving">
          {{ message && dirty ? tr('有未保存的修改') : tr('Ctrl / ⌘ + S 保存') }}
        </small>
      </p>
      <PButton variant="ghost" size="sm" :disabled="busy" @click="reload">
        {{ tr('重新载入') }}
      </PButton>
      <PButton variant="secondary" size="sm" :disabled="saving" @click="requestClose">
        {{ tr('关闭') }}
      </PButton>
      <PButton size="sm" :disabled="busy || !dirty" :loading="saving" @click="save">
        {{ tr('保存设置') }}
      </PButton>
    </footer>
  </dialog>
  <dialog
    ref="editorDialog"
    class="tool-settings-dialog child-dialog"
    :aria-label="tr('编辑分组')"
    @cancel.prevent="closeEditor"
  >
    <form v-if="editor" @submit.prevent="commitEditor">
      <header class="settings-head">
        <h2>{{ tr('编辑分组') }}</h2>
      </header>
      <div class="settings-body group-form">
        <p v-if="editorError" role="alert" class="settings-error">{{ tr(editorError) }}</p>
        <label>
          {{ tr('分组名称') }}
          <input v-model="editor.name" maxlength="200" required autofocus />
        </label>
        <label>
          {{ tr('分组说明') }}
          <textarea v-model="editor.description" rows="2" maxlength="2000" />
        </label>
        <div class="editor-selection">
          <span>{{ tr('选择组内功能') }}</span>
          <small>{{ tr('已选 {0} 个', [editor.tools.length]) }}</small>
        </div>
        <p class="settings-hint">{{ tr('勾选已在其他分组的功能，会将它移动到此分组。') }}</p>
        <input
          v-model="editorQuery"
          type="search"
          class="editor-search"
          :aria-label="tr('搜索可选功能')"
          :placeholder="tr('搜索可选功能')"
          @keydown.enter.prevent
        />
        <div class="tool-picks">
          <p v-if="!editorTools.length" class="settings-empty">{{ tr('没有符合条件的功能。') }}</p>
          <label v-for="tool in editorTools" :key="tool.id">
            <input
              type="checkbox"
              :checked="editor.tools.includes(tool.id)"
              @change="toggleEditorTool(tool.id, ($event.target as HTMLInputElement).checked)"
            />
            <span>
              {{ tool.title }}
              <code>{{ tool.id }}</code>
            </span>
          </label>
        </div>
      </div>
      <footer class="settings-footer">
        <PButton type="button" variant="secondary" size="sm" @click="closeEditor">
          {{ tr('取消') }}
        </PButton>
        <PButton type="submit" size="sm">{{ tr('确定') }}</PButton>
      </footer>
    </form>
  </dialog>
  <dialog
    ref="confirmDialog"
    class="tool-settings-dialog child-dialog confirm-dialog"
    :aria-label="tr('确认操作')"
    @cancel.prevent="settleDecision(false)"
  >
    <header class="settings-head">
      <h2>{{ confirmation?.type === 'delete' ? tr('删除分组？') : tr('放弃未保存的修改？') }}</h2>
    </header>
    <div class="settings-body">
      <p>
        {{
          confirmation?.type === 'delete'
            ? tr('删除「{0}」后，组内功能会回到未分组；保存设置后生效。', [
                confirmation.group?.name ?? '',
              ])
            : tr('继续操作会丢弃尚未保存的修改。')
        }}
      </p>
    </div>
    <footer class="settings-footer">
      <PButton variant="secondary" size="sm" @click="settleDecision(false)">
        {{ tr('继续编辑') }}
      </PButton>
      <PButton variant="danger" size="sm" @click="settleDecision(true)">
        {{ confirmation?.type === 'delete' ? tr('删除') : tr('放弃修改') }}
      </PButton>
    </footer>
  </dialog>
</template>

<style scoped>
.tool-settings-dialog {
  width: min(1080px, calc(100vw - 32px));
  max-width: none;
  max-height: calc(100dvh - 48px);
  margin: auto;
  padding: 0;
  border: 2px solid var(--ui-border-default);
  border-radius: var(--ui-radius-md, 4px);
  color: var(--ui-text-primary);
  background: var(--ui-bg-surface);
  box-shadow: var(--ui-shadow-lg);
  font: 13px/1.6 var(--ui-font-body, sans-serif);
}
.tool-settings-dialog[open] {
  display: flex;
  flex-direction: column;
}
.tool-settings-dialog::backdrop {
  background: var(--ui-overlay-backdrop, #0008);
  backdrop-filter: blur(4px);
}
.settings-head {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 22px;
  border-bottom: 1px solid var(--ui-border-default);
}
h2 {
  margin: 0;
  font: 700 18px/1.5 var(--ui-font-pixel);
  overflow-wrap: anywhere;
}
.settings-head small {
  color: var(--ui-text-tertiary);
  font-size: 11px;
}
.settings-body {
  min-height: 0;
  padding: 18px 22px;
  overflow-y: auto;
}
.settings-body > fieldset {
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}
input,
textarea,
select {
  box-sizing: border-box;
  min-width: 0;
  padding: 8px 10px;
  border: 1px solid var(--ui-border-default);
  border-radius: 2px;
  color: var(--ui-text-primary);
  background: var(--ui-bg-elevated);
  font: inherit;
}
input:focus,
textarea:focus,
select:focus {
  outline: 2px solid var(--ui-accent-primary);
  outline-offset: 1px;
}
input[type='checkbox'] {
  accent-color: var(--ui-accent-primary);
  width: 17px;
  height: 17px;
}
button {
  cursor: pointer;
}
button:disabled {
  cursor: default;
  opacity: 0.5;
}
.settings-hint,
.settings-notice,
.settings-count,
.settings-empty {
  color: var(--ui-text-tertiary);
  margin: 0 0 12px;
}
.settings-error {
  color: var(--ui-danger);
  padding: 10px;
  border: 1px solid var(--ui-danger);
  overflow-wrap: anywhere;
}
.dialog-error {
  margin: 12px 22px 0;
  max-height: 90px;
  overflow: auto;
  flex-shrink: 0;
}
.connection-settings {
  margin-bottom: 18px;
  border: 1px solid var(--ui-border-default);
  border-radius: 4px;
  background: var(--ui-bg-surface-soft);
}
.connection-settings > summary {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 12px;
  color: var(--ui-text-primary);
  font-size: 13px;
  list-style: none;
}
.connection-settings > summary::-webkit-details-marker {
  display: none;
}
.connection-settings > summary > span {
  flex-shrink: 0;
  font-weight: 600;
}
.connection-settings > summary > small {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ui-text-tertiary);
}
.connection-settings > summary > :last-child {
  margin-left: auto;
}
.connection-settings[open] > summary {
  border-bottom: 1px solid var(--ui-border-default);
}
.connection-settings[open] > summary > :last-child {
  transform: rotate(180deg);
}
.tool-overview {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 16px;
  font-weight: 600;
}
.tool-overview > small {
  margin-left: auto;
  font-size: 11px;
  font-weight: 400;
  color: var(--ui-text-tertiary);
}
.enabled-count {
  padding: 2px 8px;
  background: var(--ui-bg-surface-soft);
  border: 1px solid var(--ui-border-default);
  border-radius: 20px;
  color: var(--ui-text-secondary);
  font-size: 11px;
}
.sticky-tools {
  position: sticky;
  top: -18px;
  z-index: 1;
  padding-top: 8px;
  padding-bottom: 8px;
  background: var(--ui-bg-surface);
}
.search-field {
  flex: 1;
  min-width: 180px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding-left: 10px;
  border: 1px solid var(--ui-border-default);
  background: var(--ui-bg-elevated);
  color: var(--ui-text-tertiary);
}
.search-field > input {
  flex: 1;
  width: 100%;
  border: 0;
  background: transparent;
}
.search-field > .icon-button {
  margin-right: 6px;
}
.list-controls {
  display: flex;
  align-items: center;
  gap: 12px;
  justify-content: space-between;
}
.list-controls > small {
  color: var(--ui-text-tertiary);
  font-size: 11px;
}
.list-controls > button {
  white-space: nowrap;
}
.group-order {
  display: flex;
}
.group-order button {
  padding: 5px;
}
.tool-inactive .tool-info > b {
  color: var(--ui-text-tertiary);
}
.tool-status {
  color: var(--ui-text-tertiary);
  font-size: 11px;
}
.editor-selection {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}
.editor-selection small {
  color: var(--ui-text-tertiary);
}
.editor-search {
  width: 100%;
  margin-bottom: 8px;
}
.connection-fields {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px 16px;
  margin: 12px;
}
.connection-fields > label:first-child,
.settings-notice {
  grid-column: 1 / -1;
}
.connection-fields > label > span {
  display: block;
  margin-bottom: 4px;
  font-size: 12px;
}
.field-input {
  display: flex;
  gap: 8px;
}
.field-input input {
  flex: 1;
  width: 100%;
}
.settings-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 8px;
}
.settings-toolbar > input {
  flex: 1;
  min-width: 180px;
}
.tool-group {
  border-radius: 4px;
  overflow: clip;
  border: 1px solid var(--ui-border-default);
  margin-top: 10px;
}
.tool-group > header {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 10px;
  background: var(--ui-bg-surface-soft);
}
.group-title {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 100px;
  flex: 1;
  padding: 0;
  text-align: left;
  background: none;
  color: inherit;
  border: 0;
}
.group-title span {
  min-width: 0;
  flex: 1;
}
.group-title b,
.group-title small {
  display: block;
  overflow-wrap: anywhere;
}
.group-title small,
.group-title em {
  color: var(--ui-text-tertiary);
  font-size: 11px;
  font-style: normal;
}
.text-button,
.icon-button {
  border: 0;
  background: transparent;
  color: var(--ui-text-secondary);
  padding: 6px;
  min-height: 30px;
  font: inherit;
}
button:focus-visible,
summary:focus-visible {
  outline: 2px solid var(--ui-accent-primary);
  outline-offset: 2px;
}
.text-button:hover:not(:disabled),
.icon-button:hover:not(:disabled) {
  background: var(--ui-bg-surface-soft);
  color: var(--ui-text-primary);
}
.text-button.danger:hover {
  color: var(--ui-danger);
}
.group-title:hover b {
  color: var(--ui-accent-primary);
}
.empty-group {
  padding: 14px;
  color: var(--ui-text-tertiary);
  font-size: 12px;
}
.danger {
  color: var(--ui-danger);
}
.tool-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px;
  border-top: 1px solid var(--ui-border-subtle);
}
.tool-info {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.tool-info > code {
  display: block;
  color: var(--ui-text-tertiary);
}
.tool-info p {
  margin: 3px 0;
  color: var(--ui-text-secondary);
  font-size: 12px;
}
.tool-row > select {
  max-width: 160px;
}
.fresh {
  font-size: 10px;
  color: var(--ui-warning);
}
summary {
  cursor: pointer;
  color: var(--ui-text-tertiary);
  font-size: 11px;
}
code {
  font: 11px var(--ui-font-mono);
}
.settings-footer {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
  padding: 14px 22px;
  border-top: 1px solid var(--ui-border-default);
}
.settings-footer p {
  flex: 1;
  min-width: 120px;
  margin: 0;
  color: var(--ui-text-secondary);
  font-size: 12px;
}
.settings-footer p > small {
  display: block;
  font-size: 10px;
  color: var(--ui-text-tertiary);
}
.settings-footer p.dirty-status {
  color: var(--ui-accent-primary);
}
.child-dialog {
  width: min(560px, calc(100vw - 32px));
}
.child-dialog > form {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}
.group-form > label {
  display: grid;
  gap: 4px;
  margin-bottom: 12px;
}
.tool-picks {
  max-height: 260px;
  overflow: auto;
  border: 1px solid var(--ui-border-default);
  padding: 8px;
}
.tool-picks label {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px;
}
.confirm-dialog {
  max-width: 500px;
}
@media (max-width: 640px) {
  .tool-group > header {
    gap: 8px;
  }
  .group-title {
    flex-basis: 100%;
  }
  .group-order {
    margin-left: auto;
  }
  .tool-overview > small {
    margin-left: 0;
    flex-basis: 100%;
  }
  .sticky-tools {
    top: -12px;
  }
  .search-field {
    min-width: 100%;
  }
  .settings-footer > p {
    flex-basis: 100%;
  }
  .settings-head,
  .settings-body,
  .settings-footer {
    padding: 12px;
  }
  .connection-fields {
    grid-template-columns: 1fr;
  }
  .tool-row {
    flex-wrap: wrap;
  }
  .tool-row > select {
    margin-left: 68px;
    max-width: calc(100% - 68px);
  }
  .settings-toolbar > input {
    min-width: 100%;
  }
}
.group-status {
  padding: 3px 8px;
  border-radius: 20px;
  background: var(--ui-bg-surface);
  border: 1px solid var(--ui-border-default);
  color: var(--ui-text-secondary);
  font-size: 11px;
  white-space: nowrap;
}

.tool-power {
  min-width: 58px;
  min-height: 32px;
  padding: 5px 10px;
  border: 1px solid var(--ui-border-default);
  color: var(--ui-text-secondary);
  background: var(--ui-bg-surface);
  border-radius: 3px;
  font: inherit;
}
.tool-power:hover {
  border-color: var(--ui-accent-primary);
  color: var(--ui-accent-primary);
}
.tool-power.is-off {
  color: var(--ui-accent-primary);
}
</style>
