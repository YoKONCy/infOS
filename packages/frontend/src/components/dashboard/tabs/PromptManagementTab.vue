<script setup lang="ts">
import { t as __t } from '../../../i18n/index'

import { copyClientText } from '../../../lib/clientPlatform'

import { computed, reactive, ref } from 'vue'
import type { PromptRole, PromptFormat, PromptFramework } from '@infos/shared'
import { PROMPT_FORMATS, PROMPT_GENERATION_TYPES, promptFormat } from '@infos/shared'
import { PButton, PInput, PSelect, PSwitch, PDialog, PixelIcon } from '../../pixel'
import {
  usePromptWorkspace,
  type PromptSection,
} from '../../../composables/dashboard/usePromptWorkspace'
import { useAgentStore } from '../../../stores/useAgentStore'
import { useNotificationStore } from '../../../stores/useNotificationStore'
import SillyTavernFrameworkEditor from './SillyTavernFrameworkEditor.vue'

const store = useAgentStore()
const notifications = useNotificationStore()
const {
  view,
  bundle,
  busy,
  error,
  section,
  search,
  formatFilter,
  setFormatFilter,
  stImport,
  stImportOpen,
  presetExportOpen,
  presetImportOpen,
  presetImport,
  exportPreset,
  commitPresetImport,
  reloadStImport,
  commitStImport,
  exportStPreset,
  selectedId,
  mode,
  source,
  issues,
  preview,
  previewOpen,
  previewAgent,
  previewChannel,
  previewGeneration,
  variablesText,
  scopeAgent,
  scopeChannel,
  versionId,
  historical,
  diffId,
  activeDiff,
  changedEntries,
  pendingDialog,
  dirty,
  framework,
  document,
  resources,
  frameworkOptions,
  sourceOptions,
  displayBuiltinName,
  currentAssignment,
  setSection,
  select,
  setMode,
  create,
  createIndependent,
  assignSelectedFramework,
  remove,
  reset,
  addBlock,
  moveBlock,
  assignment,
  save,
  validate,
  renderPreview,
  showVersion,
  restoreVersion,
  restoreDefaults,
  exportBundle,
  importBundle,
  load,
} = usePromptWorkspace()
const fileInput = ref<HTMLInputElement | null>(null)
const dragging = ref(-1)
const overrideFrom = ref('')
const overrideTo = ref('')
const frameworkOverrideFrom = ref('')
const frameworkOverrideTo = ref('')
const independentOpen = ref(false)
const activationOpen = ref(false)
const activation = reactive({ agentId: '', channel: '' })
const independent = reactive({
  name: '我的提示词框架',
  body: '',
  history: true,
  format: 'custom' as PromptFormat,
  layout: 'text' as 'text' | 'blocks',
  scope: 'all' as 'all' | 'range' | 'later',
  agentId: '',
  channel: '',
})
const stScope = reactive({ scope: 'later' as 'all' | 'range' | 'later', agentId: '', channel: '' })
const presetScope = reactive({
  scope: 'later' as 'all' | 'range' | 'later',
  agentId: '',
  channel: '',
})
const exportFrameworkId = ref('')
function openPresetExport() {
  exportFrameworkId.value =
    framework.value?.id ??
    bundle.value.assignments.find((item) => !item.agentId && !item.channel)?.frameworkId ??
    bundle.value.frameworks[0]?.id ??
    ''
  presetExportOpen.value = true
}
const isSt = computed(() =>
  Boolean(framework.value && promptFormat(framework.value) === 'sillytavern'),
)
const formatOptions = computed(() => [
  { value: '', label: __t('ui.settings', '全部格式') },
  ...PROMPT_FORMATS.map((item) => ({ ...item, label: __t('common.interface', item.label) })),
])
const generationOptions = computed(() =>
  PROMPT_GENERATION_TYPES.map((item) => ({
    ...item,
    label: __t('common.interface', item.label),
  })),
)
const formatLabel = (item: PromptFramework) =>
  __t(
    'common.interface',
    PROMPT_FORMATS.find((format) => format.value === promptFormat(item))?.label ?? '自定义框架',
  )
const layoutOptions = [
  {
    value: 'text',
    get label() {
      return __t('ui.settings', '完整正文')
    },
  },
  {
    value: 'blocks',
    get label() {
      return __t('ui.settings', '自由编排')
    },
  },
]
const activationOptions = [
  {
    value: 'all',
    get label() {
      return __t('ui.settings', '全部对话')
    },
  },
  {
    value: 'range',
    get label() {
      return __t('ui.settings', '指定范围')
    },
  },
  {
    value: 'later',
    get label() {
      return __t('ui.settings', '稍后指派')
    },
  },
]
function openIndependent() {
  Object.assign(independent, {
    name: '我的提示词框架',
    body: '',
    history: true,
    format: 'custom',
    layout: 'text',
    scope: 'all',
    agentId: '',
    channel: '',
  })
  independentOpen.value = true
}
function submitIndependent() {
  if (createIndependent(independent)) independentOpen.value = false
}
function openActivation() {
  activation.agentId = scopeAgent.value
  activation.channel = scopeChannel.value
  activationOpen.value = true
}
function submitActivation() {
  if (assignSelectedFramework(activation.agentId, activation.channel)) activationOpen.value = false
}
previewAgent.value = store.activeAgentId
const sections: Array<{ id: PromptSection; label: string; icon: string }> = [
  {
    id: 'framework',
    get label() {
      return __t('ui.settings', '框架')
    },
    icon: 'settings',
  },
  {
    id: 'slot',
    get label() {
      return __t('ui.settings', '槽位')
    },
    icon: 'list',
  },
  {
    id: 'component',
    get label() {
      return __t('ui.settings', '组件')
    },
    icon: 'puzzle',
  },
  {
    id: 'task',
    get label() {
      return __t('ui.settings', '任务')
    },
    icon: 'terminal',
  },
  {
    id: 'assignments',
    get label() {
      return __t('ui.settings', '指派')
    },
    icon: 'users',
  },
  {
    id: 'versions',
    get label() {
      return __t('ui.settings', '版本')
    },
    icon: 'clock',
  },
]
const roleOptions = [
  {
    value: 'system',
    get label() {
      return __t('ui.settings', '系统消息')
    },
  },
  {
    value: 'user',
    get label() {
      return __t('ui.settings', '用户消息')
    },
  },
  {
    value: 'assistant',
    get label() {
      return __t('ui.settings', '助手消息')
    },
  },
]
const kindOptions = [
  {
    value: 'template',
    get label() {
      return __t('ui.settings', '模板')
    },
  },
  {
    value: 'history',
    get label() {
      return __t('ui.settings', '原生历史')
    },
  },
]
const bindingKinds = [
  {
    value: 'template',
    get label() {
      return __t('ui.settings', '模板')
    },
  },
  {
    value: 'persona',
    get label() {
      return __t('ui.settings', '角色人设')
    },
  },
  {
    value: 'capabilities',
    get label() {
      return __t('ui.settings', '能力片段')
    },
  },
]
const channelOptions = [
  {
    value: '',
    get label() {
      return __t('ui.settings', '所有频道')
    },
  },
  {
    value: 'desktop',
    get label() {
      return __t('ui.settings', '主对话')
    },
  },
  {
    value: 'group',
    get label() {
      return __t('ui.settings', '据点')
    },
  },
  {
    value: 'social',
    get label() {
      return __t('ui.settings', '社交')
    },
  },
  {
    value: 'task',
    get label() {
      return __t('ui.settings', '后台任务')
    },
  },
]
const agentOptions = computed(() => [
  {
    get label() {
      return __t('ui.settings', '所有角色')
    },
    value: '',
  },
  ...store.agents.map((agent) => ({ label: agent.name, value: agent.id })),
])
const overrideTargets = computed(() =>
  bundle.value.documents
    .filter((d) => d.kind === bundle.value.documents.find((d) => d.id === overrideFrom.value)?.kind)
    .map((d) => ({ label: displayBuiltinName(d), value: d.id })),
)
const dependencies = computed(() => [
  ...new Set(
    [...(document.value?.body ?? '').matchAll(/component\(\s*['"]([^'"]+)['"]\s*\)/g)].map(
      (m) => m[1],
    ),
  ),
])
const visibleVariables = computed(() => [
  ...(view.value?.variables ?? []),
  ...(document.value?.variables ?? [])
    .filter((name) => !view.value?.variables.some((v) => v.name === name))
    .map((name) => ({ name, label: name })),
])
const hasBuiltin = computed(() =>
  Boolean(
    view.value?.defaults.documents.some((d) => d.id === selectedId.value) ||
    view.value?.defaults.frameworks.some((f) => f.id === selectedId.value),
  ),
)
const activeVersion = computed(() =>
  view.value?.releases.find((r) => r.id === view.value?.activeReleaseId),
)
function addOverride() {
  if (overrideFrom.value && overrideTo.value)
    assignment().overrides[overrideFrom.value] = overrideTo.value
  overrideFrom.value = ''
  overrideTo.value = ''
}
function scopeLabel(agentId: string, channel: string) {
  return `${store.agents.find((a) => a.id === agentId)?.name ?? (agentId || __t('ui.settings', '全局'))} · ${channelOptions.find((c) => c.value === channel)?.label ?? channel}`
}
function onImport(event: Event) {
  const input = event.target as HTMLInputElement
  Object.assign(stScope, { scope: 'later', agentId: '', channel: '' })
  Object.assign(presetScope, { scope: 'later', agentId: '', channel: '' })
  void importBundle(input.files?.[0])
  input.value = ''
}
async function insertVariable(name: string) {
  const value = `{{ ${name} }}`
  try {
    await copyClientText(value)
    notifications.toast(__t('ui.settings', '变量已复制'), 'success')
  } catch {
    notifications.toast(__t('ui.settings', '无法复制变量'), 'error')
  }
}
function setVariables(value: string) {
  if (document.value)
    document.value.variables = value
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean)
}
function moveBinding(index: number, offset: number) {
  const bindings = framework.value?.bindings
  if (!bindings || index + offset < 0 || index + offset >= bindings.length) return
  const binding = bindings.splice(index, 1)[0]!
  bindings.splice(index + offset, 0, binding)
}
function addFrameworkOverride() {
  if (!framework.value || !frameworkOverrideFrom.value || !frameworkOverrideTo.value) return
  framework.value.overrides ??= {}
  framework.value.overrides[frameworkOverrideFrom.value] = frameworkOverrideTo.value
  frameworkOverrideFrom.value = ''
  frameworkOverrideTo.value = ''
}
</script>

<template>
  <section class="prompt-page" :aria-busy="busy">
    <header class="prompt-heading">
      <div>
        <h2>
          <PixelIcon name="edit" />
          {{ __t('ui.settings', '提示词') }}
          <span class="status-chip" :class="{ changed: dirty }">
            {{ dirty ? __t('ui.settings', '未保存') : __t('ui.settings', '草稿') }}
          </span>
        </h2>
        <span class="eyebrow">PROMPT WORKSPACE</span>
      </div>
      <div class="actions">
        <PButton variant="secondary" size="sm" :disabled="busy || !view" @click="openIndependent">
          {{ __t('ui.settings', '＋ 新建框架') }}
        </PButton>
        <PButton variant="ghost" size="sm" :disabled="busy" @click="fileInput?.click()">
          {{ __t('ui.prompt-presets', '导入预设') }}
        </PButton>
        <PButton variant="ghost" size="sm" :disabled="busy || !view" @click="openPresetExport">
          {{ __t('ui.prompt-presets', '导出预设') }}
        </PButton>
        <PButton variant="ghost" size="sm" :disabled="busy || !view" @click="restoreDefaults">
          {{ __t('ui.settings', '内置预设') }}
        </PButton>
        <PButton variant="secondary" size="sm" :disabled="busy" @click="validate">
          {{ __t('ui.settings', '校验') }}
        </PButton>
        <PButton variant="secondary" size="sm" :disabled="busy || !view" @click="save()">
          {{ __t('ui.settings', '保存草稿') }}
        </PButton>
        <PButton size="sm" :disabled="busy || !view" @click="save(true)">
          {{ __t('ui.settings', '发布') }}
        </PButton>
      </div>
      <input
        ref="fileInput"
        type="file"
        accept="application/json,.json"
        hidden
        @change="onImport"
      />
    </header>

    <nav class="section-tabs" :aria-label="__t('ui.settings', '提示词管理')">
      <button
        v-for="tab in sections"
        :key="tab.id"
        :class="{ active: section === tab.id }"
        @click="setSection(tab.id)"
      >
        <PixelIcon :name="tab.icon" size="sm" />
        {{ tab.label }}
      </button>
      <span class="release-label" :title="view?.activeReleaseId">
        {{ __t('ui.settings', '已发布') }}
        {{ activeVersion ? new Date(activeVersion.createdAt).toLocaleString() : '—' }}
      </span>
    </nav>
    <div v-if="error" class="error-banner" role="alert">
      {{ error }}
      <PButton size="sm" variant="ghost" :disabled="busy" @click="load">
        {{ __t('ui.settings', '重新载入') }}
      </PButton>
    </div>
    <div v-if="view?.recoveryError" class="error-banner" role="alert">{{ view.recoveryError }}</div>

    <div v-if="view" class="prompt-body" :inert="busy">
      <template v-if="!['assignments', 'versions'].includes(section)">
        <aside class="resource-rail surface">
          <PInput v-model="search" :placeholder="__t('ui.settings', '搜索名称 / ID')" size="sm" />
          <PSelect
            v-if="section === 'framework'"
            :model-value="formatFilter"
            :options="formatOptions"
            class="format-filter"
            size="sm"
            teleport
            @update:model-value="setFormatFilter($event as PromptFormat | '')"
          />
          <div class="rail-actions">
            <PButton
              size="sm"
              variant="secondary"
              @click="section === 'framework' ? openIndependent() : create()"
            >
              ＋
              {{
                section === 'framework'
                  ? __t('ui.settings', '新建框架')
                  : __t('ui.settings', '新模板')
              }}
            </PButton>
          </div>
          <div class="resource-list">
            <button
              v-for="item in resources"
              :key="item.id"
              :class="['resource-item', { active: item.id === selectedId }]"
              :title="item.id"
              @click="select(item.id)"
            >
              <span>{{ displayBuiltinName(item) }}</span>
              <small>
                {{
                  section === 'framework'
                    ? {
                        infos: __t('ui.settings', '原生'),
                        sillytavern: __t('ui.settings', '酒馆'),
                        custom: __t('ui.settings', '自定义'),
                      }[promptFormat(item as PromptFramework)]
                    : item.builtin
                      ? __t('ui.settings', '内置')
                      : __t('ui.settings', '自定义')
                }}
              </small>
            </button>
            <p v-if="!resources.length" class="empty">{{ __t('ui.settings', '暂无条目') }}</p>
          </div>
        </aside>

        <main class="editor surface">
          <template v-if="framework || document">
            <div class="editor-heading">
              <div class="title-input">
                <PInput v-if="framework" v-model="framework.name" />
                <PInput v-else-if="document" v-model="document.name" />
                <code>{{ selectedId }}</code>
              </div>
              <div class="actions">
                <PButton size="sm" variant="ghost" @click="create(true)">
                  {{ __t('ui.settings', '复制') }}
                </PButton>
                <PButton v-if="hasBuiltin" size="sm" variant="ghost" @click="reset">
                  {{ __t('ui.settings', '恢复内置') }}
                </PButton>
                <PButton v-else size="sm" variant="danger" @click="remove">
                  {{ __t('ui.settings', '删除') }}
                </PButton>
              </div>
            </div>
            <div class="editor-tools">
              <div class="mode-tabs">
                <button :class="{ active: mode === 'visual' }" @click="setMode('visual')">
                  {{ framework ? __t('ui.settings', '编排') : __t('ui.settings', '编辑') }}
                </button>
                <button :class="{ active: mode === 'source' }" @click="setMode('source')">
                  {{ __t('ui.settings', '源码') }}
                </button>
              </div>
              <PButton size="sm" variant="secondary" :disabled="busy" @click="renderPreview">
                {{ __t('ui.settings', '渲染预览') }}
              </PButton>
            </div>
            <div v-if="framework" class="framework-entry">
              <span class="format-badge">{{ formatLabel(framework) }}</span>
              <div class="actions">
                <PButton
                  v-if="isSt"
                  size="sm"
                  variant="ghost"
                  :disabled="busy"
                  @click="exportStPreset"
                >
                  {{ __t('ui.settings', '导出酒馆预设') }}
                </PButton>
                <PButton size="sm" variant="secondary" @click="openActivation">
                  {{ __t('ui.settings', '指派此框架') }}
                </PButton>
              </div>
            </div>

            <textarea
              v-if="mode === 'source'"
              v-model="source"
              class="code-editor source-editor"
              spellcheck="false"
              :aria-label="__t('ui.settings', '模板源码')"
              @keydown.ctrl.s.prevent="save()"
            />
            <template v-else-if="document">
              <div class="document-meta">
                <label>
                  {{ __t('ui.settings', '启用') }}
                  <PSwitch v-model="document.enabled" />
                </label>
              </div>
              <textarea
                v-model="document.body"
                class="code-editor source-editor"
                spellcheck="false"
                :aria-label="__t('ui.settings', '模板正文')"
                @keydown.ctrl.s.prevent="save()"
              />
              <label class="field">
                {{ __t('ui.settings', '自定义变量') }}
                <PInput
                  :model-value="document.variables.join(', ')"
                  :placeholder="__t('ui.settings', '逗号分隔')"
                  size="sm"
                  @update:model-value="setVariables"
                />
              </label>
              <div v-if="dependencies.length" class="dependency-list">
                <span>{{ __t('ui.settings', '引用') }}</span>
                <button
                  v-for="key in dependencies"
                  :key="key"
                  @click="
                    select(key!, bundle.documents.find((d) => d.id === key)?.kind ?? 'component')
                  "
                >
                  {{ key }}
                </button>
              </div>
            </template>
            <template v-else-if="framework">
              <SillyTavernFrameworkEditor
                v-if="isSt"
                :framework="framework"
                :variables="view.variables"
                :agents="agentOptions"
                @update:framework="Object.assign(framework, $event)"
                @add="addBlock"
                @move="moveBlock"
              />
              <template v-else>
                <details class="bindings-panel">
                  <summary>
                    {{ __t('ui.settings', '数据装配') }}
                    <small>{{ framework.bindings.length }}</small>
                  </summary>
                  <div
                    v-for="(binding, index) in framework.bindings"
                    :key="index"
                    class="binding-row"
                  >
                    <div class="row">
                      <PInput
                        v-model="binding.name"
                        :placeholder="__t('ui.settings', '变量名')"
                        size="sm"
                      />
                      <PSelect
                        :model-value="binding.kind"
                        :options="bindingKinds"
                        size="sm"
                        teleport
                        @update:model-value="
                          binding.kind = $event as 'template' | 'capabilities' | 'persona'
                        "
                      />
                      <button
                        class="icon-button"
                        :disabled="index === 0"
                        :aria-label="__t('ui.settings', '上移装配')"
                        @click="moveBinding(index, -1)"
                      >
                        ↑
                      </button>
                      <button
                        class="icon-button"
                        :disabled="index === framework.bindings.length - 1"
                        :aria-label="__t('ui.settings', '下移装配')"
                        @click="moveBinding(index, 1)"
                      >
                        ↓
                      </button>
                      <button
                        class="icon-button"
                        :aria-label="__t('ui.settings', '删除装配')"
                        @click="framework.bindings.splice(index, 1)"
                      >
                        ×
                      </button>
                    </div>
                    <template v-if="binding.kind === 'template'">
                      <PSelect
                        :model-value="binding.source ?? ''"
                        :options="sourceOptions"
                        size="sm"
                        teleport
                        @update:model-value="binding.source = String($event) || undefined"
                      />
                      <textarea
                        v-if="!binding.source"
                        v-model="binding.template"
                        class="code-editor compact-editor"
                        :placeholder="__t('ui.settings', '内联模板')"
                        spellcheck="false"
                      />
                    </template>
                    <PInput
                      v-model="binding.when"
                      :placeholder="__t('ui.settings', '生效条件（可选）')"
                      size="sm"
                    />
                  </div>
                  <PButton
                    size="sm"
                    variant="ghost"
                    @click="
                      framework.bindings.push({
                        name: `variable_${framework.bindings.length + 1}`,
                        kind: 'template',
                        template: '',
                      })
                    "
                  >
                    {{ __t('ui.settings', '＋ 数据装配') }}
                  </PButton>
                </details>
                <details class="bindings-panel">
                  <summary>
                    {{ __t('ui.settings', '框架模板替换') }}
                    <small>{{ Object.keys(framework.overrides ?? {}).length }}</small>
                  </summary>
                  <div
                    v-for="(target, origin) in framework.overrides ?? {}"
                    :key="origin"
                    class="override-row"
                  >
                    <code>{{ origin }}</code>
                    <span>→</span>
                    <span>{{ bundle.documents.find((d) => d.id === target)?.name ?? target }}</span>
                    <button
                      class="icon-button"
                      :aria-label="__t('ui.settings', '移除替换')"
                      @click="delete framework.overrides![origin]"
                    >
                      ×
                    </button>
                  </div>
                  <div class="binding-row">
                    <PSelect
                      v-model="frameworkOverrideFrom"
                      :options="sourceOptions.filter((o) => o.value)"
                      :placeholder="__t('ui.settings', '原模板')"
                      size="sm"
                      teleport
                    />
                    <PSelect
                      v-model="frameworkOverrideTo"
                      :options="sourceOptions.filter((o) => o.value)"
                      :placeholder="__t('ui.settings', '替换为')"
                      size="sm"
                      teleport
                    />
                    <PButton
                      size="sm"
                      variant="ghost"
                      :disabled="!frameworkOverrideFrom || !frameworkOverrideTo"
                      @click="addFrameworkOverride"
                    >
                      {{ __t('ui.settings', '＋ 替换') }}
                    </PButton>
                  </div>
                </details>
                <TransitionGroup name="blocks" tag="div" class="blocks-list">
                  <article
                    v-for="(block, index) in framework.blocks"
                    :key="block.id"
                    class="prompt-block"
                    :class="{ muted: !block.enabled }"
                    @dragover.prevent
                    @drop.prevent="
                      () => {
                        moveBlock(dragging, index)
                        dragging = -1
                      }
                    "
                  >
                    <header class="block-header">
                      <button
                        class="drag-handle"
                        draggable="true"
                        :aria-label="__t('ui.settings', '拖动排序')"
                        @dragstart="
                          ($event) => {
                            dragging = index
                            $event.dataTransfer?.setData('text/plain', block.id)
                          }
                        "
                        @dragend="dragging = -1"
                      >
                        ⠿
                      </button>
                      <span class="block-number">{{ String(index + 1).padStart(2, '0') }}</span>
                      <PInput v-model="block.name" size="sm" />
                      <PSwitch v-model="block.enabled" />
                      <button
                        class="icon-button"
                        :disabled="index === 0"
                        :aria-label="__t('ui.settings', '上移')"
                        @click="moveBlock(index, index - 1)"
                      >
                        ↑
                      </button>
                      <button
                        class="icon-button"
                        :disabled="index === framework.blocks.length - 1"
                        :aria-label="__t('ui.settings', '下移')"
                        @click="moveBlock(index, index + 1)"
                      >
                        ↓
                      </button>
                      <button
                        class="icon-button"
                        :aria-label="__t('ui.settings', '删除区块')"
                        @click="framework.blocks.splice(index, 1)"
                      >
                        ×
                      </button>
                    </header>
                    <div class="block-fields">
                      <PSelect
                        :model-value="block.kind"
                        :options="kindOptions"
                        size="sm"
                        teleport
                        @update:model-value="block.kind = $event as 'template' | 'history'"
                      />
                      <PSelect
                        :model-value="block.role"
                        :options="roleOptions"
                        size="sm"
                        teleport
                        @update:model-value="block.role = $event as PromptRole"
                      />
                      <PInput
                        v-model="block.when"
                        :placeholder="__t('ui.settings', '生效条件（可选）')"
                        size="sm"
                      />
                    </div>
                    <template v-if="block.kind === 'template'">
                      <PSelect
                        :model-value="block.source ?? ''"
                        :options="sourceOptions"
                        size="sm"
                        teleport
                        @update:model-value="block.source = String($event) || undefined"
                      />
                      <textarea
                        v-if="!block.source"
                        v-model="block.template"
                        class="code-editor compact-editor"
                        :placeholder="__t('ui.settings', '模板正文')"
                        spellcheck="false"
                      />
                      <button
                        v-else
                        class="text-link"
                        @click="
                          select(
                            block.source!,
                            bundle.documents.find((d) => d.id === block.source)?.kind ??
                              'component',
                          )
                        "
                      >
                        {{ __t('ui.settings', '编辑模板 ↗') }}
                      </button>
                    </template>
                  </article>
                </TransitionGroup>
                <p v-if="!framework.blocks.length" class="empty">
                  {{ __t('ui.settings', '添加消息区块，开始编写你的框架') }}
                </p>
                <PButton variant="secondary" size="sm" @click="addBlock">
                  {{ __t('ui.settings', '＋ 区块') }}
                </PButton>
              </template>
            </template>
          </template>
          <p v-else class="empty">{{ __t('ui.settings', '选择一个条目') }}</p>
        </main>

        <aside class="inspector surface">
          <template v-if="isSt">
            <h3>{{ __t('ui.settings', '常用宏') }}</h3>
            <div class="st-quick-macros">
              <button
                v-for="name in [
                  'char',
                  'user',
                  'description',
                  'personality',
                  'scenario',
                  'model',
                  'maxPrompt',
                  'date',
                  'time',
                ]"
                :key="name"
                @click="insertVariable(name)"
                v-text="`{{${name}}}`"
              />
            </div>
          </template>
          <h3>{{ __t('ui.settings', '变量') }}</h3>
          <div class="variable-list">
            <button
              v-for="variable in visibleVariables"
              :key="variable.name"
              :title="__t('common.prompts', variable.label)"
              @click="insertVariable(variable.name)"
            >
              <span>{{ __t('common.prompts', variable.label) }}</span>
              <code>{{ variable.name }}</code>
            </button>
          </div>
          <details v-if="!isSt" class="tutorial">
            <summary>{{ __t('ui.settings', '模板教程') }}</summary>
            <p>
              {{ __t('ui.settings', '变量使用') }}
              <code v-pre>{{ owner_name }}</code>
              {{ __t('ui.settings', '。条件使用 Nunjucks 语法。') }}
            </p>
            <p>
              {{ __t('ui.settings', '组件需显式引用：') }}
              <code v-pre>{{ component('components/example') }}</code>
              。
            </p>
            <p>{{ __t('ui.settings', '按顺序排列变量和消息；system 区块放在对话之前。') }}</p>
            <p>
              {{ __t('ui.settings', '空白框架需自行编写人设与规则；任务模板在“指派”中启用。') }}
            </p>
            <p>{{ __t('ui.settings', '预览读取所选角色的人设，记忆和历史使用示例变量。') }}</p>
          </details>
        </aside>
      </template>

      <main v-else-if="section === 'assignments'" class="assignment-page surface">
        <div class="assignment-heading">
          <div>
            <h3>{{ __t('ui.settings', '生效范围') }}</h3>
            <div class="row">
              <PSelect v-model="scopeAgent" :options="agentOptions" teleport />
              <PSelect v-model="scopeChannel" :options="channelOptions" teleport />
            </div>
          </div>
          <span class="muted-text">{{ __t('ui.settings', '全局 → 频道 → 角色 → 角色频道') }}</span>
        </div>
        <label class="field">
          {{ __t('ui.settings', '框架') }}
          <PSelect
            :model-value="currentAssignment?.frameworkId ?? ''"
            :options="[
              {
                label: __t('ui.settings', '继承'),
                value: '',
                disabled: !scopeAgent && !scopeChannel,
              },
              ...frameworkOptions,
            ]"
            teleport
            @update:model-value="assignment().frameworkId = String($event)"
          />
        </label>
        <h3>{{ __t('ui.settings', '模板替换') }}</h3>
        <div
          v-for="(target, origin) in currentAssignment?.overrides ?? {}"
          :key="origin"
          class="override-row"
        >
          <code>{{ origin }}</code>
          <span>→</span>
          <span>{{ bundle.documents.find((d) => d.id === target)?.name ?? target }}</span>
          <button
            class="icon-button"
            :aria-label="__t('ui.settings', '移除替换')"
            @click="delete assignment().overrides[origin]"
          >
            ×
          </button>
        </div>
        <div class="row">
          <PSelect
            v-model="overrideFrom"
            :options="sourceOptions.filter((o) => o.value)"
            :placeholder="__t('ui.settings', '原模板')"
            teleport
          />
          <span>→</span>
          <PSelect
            v-model="overrideTo"
            :options="overrideTargets"
            :placeholder="__t('ui.settings', '替换为')"
            teleport
          />
          <PButton
            size="sm"
            variant="secondary"
            :disabled="!overrideFrom || !overrideTo"
            @click="addOverride"
          >
            {{ __t('ui.settings', '添加') }}
          </PButton>
        </div>
        <div class="scope-list">
          <h3>{{ __t('ui.settings', '已有指派') }}</h3>
          <div
            v-for="(scope, index) in bundle.assignments"
            :key="`${scope.agentId}/${scope.channel}`"
            class="scope-row"
          >
            <button
              @click="
                () => {
                  scopeAgent = scope.agentId
                  scopeChannel = scope.channel
                }
              "
            >
              {{ scopeLabel(scope.agentId, scope.channel) }}
            </button>
            <span>
              {{
                bundle.frameworks.find((f) => f.id === scope.frameworkId)?.name ??
                __t('ui.settings', '继承')
              }}
            </span>
            <button
              v-if="scope.agentId || scope.channel"
              class="icon-button"
              :aria-label="__t('ui.settings', '删除指派')"
              @click="bundle.assignments.splice(index, 1)"
            >
              ×
            </button>
          </div>
        </div>
      </main>

      <main v-else class="versions-page surface">
        <aside class="version-list">
          <button
            v-for="version in [...view.releases].reverse()"
            :key="version.id"
            :class="{ active: version.id === versionId }"
            @click="showVersion(version.id)"
          >
            <strong>
              {{
                version.id === view.activeReleaseId
                  ? __t('ui.settings', '当前版本')
                  : __t('ui.settings', '发布版本')
              }}
            </strong>
            <span>{{ new Date(version.createdAt).toLocaleString() }}</span>
            <small>{{ version.note || version.id.slice(0, 8) }}</small>
          </button>
        </aside>
        <div class="version-content">
          <div class="row">
            <h3>
              {{ __t('ui.settings', '与当前草稿比较') }}
              <small>{{ changedEntries.length }} {{ __t('ui.settings', '项') }}</small>
            </h3>
            <PButton variant="secondary" size="sm" :disabled="!historical" @click="restoreVersion">
              {{ __t('ui.settings', '恢复到草稿') }}
            </PButton>
          </div>
          <div v-if="historical" class="diff-pills">
            <button
              v-for="entry in changedEntries"
              :key="entry.id"
              :class="{ active: activeDiff?.id === entry.id }"
              @click="diffId = entry.id"
            >
              {{ entry.kind }} · {{ entry.id }}
            </button>
          </div>
          <div v-if="activeDiff" class="diff-columns">
            <div>
              <h4>{{ __t('ui.settings', '历史版本') }}</h4>
              <pre>{{ activeDiff.before || '（不存在）' }}</pre>
            </div>
            <div>
              <h4>{{ __t('ui.settings', '当前草稿') }}</h4>
              <pre>{{ activeDiff.after || '（不存在）' }}</pre>
            </div>
          </div>
          <p v-else class="empty">
            {{ historical ? __t('ui.settings', '内容一致') : __t('ui.settings', '选择一个版本') }}
          </p>
        </div>
      </main>
    </div>
    <p v-else-if="busy" class="empty">{{ __t('ui.settings', '正在载入……') }}</p>
    <section
      v-if="issues.length"
      class="validation-panel"
      :aria-label="__t('ui.settings', '校验结果')"
    >
      <div v-for="(issue, index) in issues" :key="index" :class="issue.level">
        <code>{{ issue.source }}</code>
        <span>{{ issue.message }}</span>
      </div>
    </section>

    <PDialog
      v-model="activationOpen"
      :title="__t('ui.settings', '指派框架')"
      width="min(580px, calc(100vw - 48px))"
    >
      <p v-if="error" class="preview-issue error" role="alert">{{ error }}</p>
      <div class="independent-form">
        <strong>{{ framework?.name }}</strong>
        <div class="independent-scopes">
          <PSelect v-model="activation.agentId" :options="agentOptions" teleport />
          <PSelect
            v-model="activation.channel"
            :options="channelOptions.filter((option) => option.value !== 'task')"
            teleport
          />
        </div>
        <p class="muted-text">{{ __t('ui.settings', '发布后生效，更具体的已有指派仍优先。') }}</p>
      </div>
      <template #footer>
        <PButton size="sm" variant="secondary" @click="activationOpen = false">
          {{ __t('ui.settings', '取消') }}
        </PButton>
        <PButton size="sm" :disabled="busy" @click="submitActivation">
          {{ __t('ui.settings', '应用到草稿') }}
        </PButton>
      </template>
    </PDialog>
    <PDialog
      v-model="independentOpen"
      :title="__t('ui.settings', '新建框架')"
      width="min(780px, calc(100vw - 48px))"
    >
      <p v-if="error" class="preview-issue error" role="alert">{{ error }}</p>
      <div class="independent-form">
        <div class="format-choices" role="group" :aria-label="__t('ui.settings', '框架格式')">
          <button
            v-for="format in PROMPT_FORMATS"
            :key="format.value"
            :class="['format-choice', { active: independent.format === format.value }]"
            :aria-pressed="independent.format === format.value"
            @click="independent.format = format.value"
          >
            <strong>{{ __t('common.interface', format.label) }}</strong>
            <small>{{ format.description }}</small>
          </button>
        </div>
        <label class="field">
          {{ __t('ui.settings', '名称') }}
          <PInput v-model="independent.name" maxlength="100" />
        </label>
        <label v-if="independent.format !== 'infos'" class="field">
          {{ __t('ui.settings', '写法') }}
          <PSelect
            :model-value="independent.layout"
            :options="layoutOptions"
            teleport
            @update:model-value="independent.layout = $event as 'text' | 'blocks'"
          />
        </label>
        <label v-if="independent.format !== 'infos' && independent.layout === 'text'" class="field">
          {{ __t('ui.settings', '完整提示词') }}
          <textarea
            v-model="independent.body"
            class="code-editor independent-body"
            spellcheck="false"
            :placeholder="
              independent.format === 'sillytavern'
                ? __t('ui.settings', '填写提示词，可使用 {{char}}、{{user}} 等酒馆宏。')
                : __t('ui.settings', '直接编写完整提示词，可使用变量与模板语法。')
            "
          />
        </label>
        <label v-if="independent.format !== 'infos'" class="history-toggle">
          <PSwitch v-model="independent.history" />
          {{ __t('ui.settings', '保留对话历史') }}
        </label>
        <label class="field">
          {{ __t('ui.settings', '生效范围') }}
          <PSelect
            :model-value="independent.scope"
            :options="activationOptions"
            teleport
            @update:model-value="independent.scope = $event as 'all' | 'range' | 'later'"
          />
        </label>
        <div v-if="independent.scope === 'range'" class="independent-scopes">
          <PSelect v-model="independent.agentId" :options="agentOptions" teleport />
          <PSelect
            v-model="independent.channel"
            :options="channelOptions.filter((option) => option.value !== 'task')"
            teleport
          />
        </div>
        <p class="muted-text">
          {{
            independent.scope === 'all'
              ? __t('ui.settings', '全部对话：替换现有角色与频道的框架指派，发布后生效。')
              : independent.scope === 'range'
                ? __t('ui.settings', '发布后生效，更具体的已有指派仍优先。')
                : __t('ui.settings', '创建后可在“指派”中启用。')
          }}
        </p>
        <details class="tutorial">
          <summary>{{ __t('ui.settings', '框架教程') }}</summary>
          <p>
            {{ __t('ui.settings', '原生格式基于内置框架；酒馆格式支持宏，也可导入 JSON 预设。') }}
          </p>
          <p>{{ __t('ui.settings', '自定义格式从空白开始，可引用变量与组件。') }}</p>
          <p>{{ __t('ui.settings', '正文可拆分为多个区块；后台任务提示词在“任务”中编辑。') }}</p>
        </details>
      </div>
      <template #footer>
        <PButton variant="secondary" size="sm" @click="independentOpen = false">
          {{ __t('ui.settings', '取消') }}
        </PButton>
        <PButton
          size="sm"
          :disabled="busy || !independent.name.trim() || independent.name.trim().length > 100"
          @click="submitIndependent"
        >
          {{ __t('ui.settings', '创建框架') }}
        </PButton>
      </template>
    </PDialog>
    <PDialog
      v-model="presetExportOpen"
      :title="__t('ui.prompt-presets', '导出提示词')"
      width="min(680px, calc(100vw - 48px))"
    >
      <div class="independent-form">
        <section class="preset-package-choice">
          <strong>{{ __t('ui.prompt-presets', '框架预设') }}</strong>
          <p>
            {{
              __t(
                'ui.prompt-presets',
                '包含选中框架及其引用的槽位、组件与替换关系，适合分享和迁移。',
              )
            }}
          </p>
          <PSelect
            :model-value="exportFrameworkId"
            :options="frameworkOptions"
            :disabled="busy"
            teleport
            @update:model-value="exportFrameworkId = String($event)"
          />
          <PButton
            size="sm"
            :disabled="busy || !exportFrameworkId"
            @click="exportPreset(exportFrameworkId)"
          >
            <PixelIcon name="download" size="xs" />
            {{ __t('ui.prompt-presets', '导出预设 JSON') }}
          </PButton>
        </section>
        <section class="preset-package-choice">
          <strong>{{ __t('ui.prompt-presets', '完整工作区备份') }}</strong>
          <p>
            {{
              __t(
                'ui.prompt-presets',
                '包含全部框架、模板和指派。导入备份时会确认是否替换当前草稿。',
              )
            }}
          </p>
          <PButton size="sm" variant="secondary" :disabled="busy" @click="exportBundle">
            {{ __t('ui.prompt-presets', '导出完整备份') }}
          </PButton>
        </section>
        <p v-if="error" class="preview-issue error" role="alert">{{ error }}</p>
      </div>
      <template #footer>
        <PButton size="sm" variant="secondary" :disabled="busy" @click="presetExportOpen = false">
          {{ __t('ui.settings', '关闭') }}
        </PButton>
      </template>
    </PDialog>
    <PDialog
      v-model="presetImportOpen"
      :title="__t('ui.prompt-presets', '导入提示词预设')"
      width="min(780px, calc(100vw - 48px))"
    >
      <div v-if="presetImport" class="independent-form">
        <p v-if="error" class="preview-issue error" role="alert">{{ error }}</p>
        <label class="field">
          {{ __t('ui.settings', '名称') }}
          <PInput v-model="presetImport.preset.name" maxlength="100" :disabled="busy" />
        </label>
        <div class="st-import-stats">
          <span>{{ formatLabel(presetImport.preset.framework) }}</span>
          <span>
            {{
              __t('ui.prompt-presets', '区块 {0} · 依赖模板 {1}', [
                presetImport.preset.framework.blocks.length,
                presetImport.preset.documents.length,
              ])
            }}
          </span>
        </div>
        <p>{{ __t('ui.prompt-presets', '将作为独立副本加入草稿，现有框架和模板保持不变。') }}</p>
        <div v-if="presetImport.issues.length" class="st-import-issues">
          <p v-for="(issue, index) in presetImport.issues" :key="index" :class="issue.level">
            {{ issue.source }}：{{ issue.message }}
          </p>
        </div>
        <label class="field">
          {{ __t('ui.settings', '生效范围') }}
          <PSelect
            :model-value="presetScope.scope"
            :options="activationOptions"
            :disabled="busy"
            teleport
            @update:model-value="presetScope.scope = $event as 'all' | 'range' | 'later'"
          />
        </label>
        <div v-if="presetScope.scope === 'range'" class="independent-scopes">
          <PSelect
            :model-value="presetScope.agentId"
            :options="agentOptions"
            :disabled="busy"
            teleport
            @update:model-value="presetScope.agentId = String($event)"
          />
          <PSelect
            :model-value="presetScope.channel"
            :options="channelOptions.filter((option) => option.value !== 'task')"
            :disabled="busy"
            teleport
            @update:model-value="presetScope.channel = String($event)"
          />
        </div>
        <p class="muted-text">
          {{
            presetScope.scope === 'all'
              ? __t('ui.settings', '替换已有角色与频道的框架指派，发布后生效。')
              : __t('ui.settings', '导入草稿后可编辑和预览，发布后生效。')
          }}
        </p>
      </div>
      <template #footer>
        <PButton size="sm" variant="secondary" :disabled="busy" @click="presetImportOpen = false">
          {{ __t('ui.settings', '取消') }}
        </PButton>
        <PButton
          size="sm"
          :disabled="busy || !presetImport || !presetImport.preset.name.trim()"
          @click="commitPresetImport(presetScope)"
        >
          {{ __t('ui.settings', '导入草稿') }}
        </PButton>
      </template>
    </PDialog>
    <PDialog
      v-model="stImportOpen"
      :title="__t('ui.settings', '导入酒馆预设')"
      width="min(780px, calc(100vw - 48px))"
    >
      <div v-if="stImport" class="independent-form">
        <p v-if="error" class="preview-issue error" role="alert">{{ error }}</p>
        <label class="field">
          {{ __t('ui.settings', '名称') }}
          <PInput v-model="stImport.framework.name" maxlength="100" />
        </label>
        <label v-if="stImport.orderProfiles.length > 1" class="field">
          {{ __t('ui.settings', '排序方案') }}
          <PSelect
            :model-value="stImport.framework.sillyTavern?.orderProfile ?? 0"
            :options="stImport.orderProfiles"
            :disabled="busy"
            teleport
            @update:model-value="reloadStImport(Number($event))"
          />
        </label>
        <div class="st-import-stats">
          <span>{{ stImport.framework.blocks.length }} {{ __t('ui.settings', '条目') }}</span>
          <span>
            {{ stImport.framework.blocks.filter((block) => block.enabled).length }}
            {{ __t('ui.settings', '启用') }}
          </span>
          <span>{{ stImport.issues.length }} {{ __t('ui.settings', '项提示') }}</span>
        </div>
        <div v-if="stImport.issues.length" class="st-import-issues">
          <p v-for="(issue, index) in stImport.issues" :key="index" :class="issue.level">
            {{ issue.source }}：{{ issue.message }}
          </p>
        </div>
        <label class="field">
          {{ __t('ui.settings', '生效范围') }}
          <PSelect
            :model-value="stScope.scope"
            :options="activationOptions"
            teleport
            @update:model-value="stScope.scope = $event as 'all' | 'range' | 'later'"
          />
        </label>
        <div v-if="stScope.scope === 'range'" class="independent-scopes">
          <PSelect v-model="stScope.agentId" :options="agentOptions" teleport />
          <PSelect
            v-model="stScope.channel"
            :options="channelOptions.filter((option) => option.value !== 'task')"
            teleport
          />
        </div>
        <p class="muted-text">
          {{
            stScope.scope === 'all'
              ? __t('ui.settings', '替换已有角色与频道的框架指派，发布后生效。')
              : __t('ui.settings', '导入草稿后可编辑和预览，发布后生效。')
          }}
        </p>
      </div>
      <template #footer>
        <PButton size="sm" variant="secondary" :disabled="busy" @click="stImportOpen = false">
          {{ __t('ui.settings', '取消') }}
        </PButton>
        <PButton
          size="sm"
          :disabled="busy || !stImport || !stImport.framework.name.trim()"
          @click="commitStImport(stScope)"
        >
          {{ __t('ui.settings', '导入草稿') }}
        </PButton>
      </template>
    </PDialog>
    <PDialog
      v-model="previewOpen"
      :title="__t('ui.settings', '渲染预览')"
      width="min(1120px, calc(100vw - 48px))"
    >
      <div v-if="error" class="preview-issue error" role="alert">{{ error }}</div>
      <div class="preview-controls">
        <PSelect v-model="previewAgent" :options="agentOptions" size="sm" teleport />
        <PSelect
          v-model="previewChannel"
          :options="channelOptions.filter((o) => o.value)"
          size="sm"
          teleport
        />
        <PSelect
          v-if="isSt"
          v-model="previewGeneration"
          :options="generationOptions"
          size="sm"
          teleport
        />
        <PButton size="sm" :disabled="busy" @click="renderPreview">
          {{ __t('ui.settings', '刷新') }}
        </PButton>
        <span v-if="preview" class="token-count">
          {{ preview.tokens.toLocaleString() }} {{ __t('ui.settings', '文本 Token · o200k_base') }}
        </span>
      </div>
      <details class="preview-variables">
        <summary>{{ __t('ui.settings', '示例变量') }}</summary>
        <textarea
          v-model="variablesText"
          class="code-editor compact-editor"
          spellcheck="false"
          :aria-label="__t('ui.settings', '示例变量 JSON')"
        />
      </details>
      <div class="preview-results">
        <div
          v-for="(issue, index) in preview?.issues ?? []"
          :key="index"
          :class="['preview-issue', issue.level]"
        >
          {{ issue.source }}：{{ issue.message }}
        </div>
        <details v-for="segment in preview?.segments ?? []" :key="segment.id" open>
          <summary>
            <b>{{ segment.role }}</b>
            <small v-if="segment.originalRole" class="format-badge">
              {{ segment.originalRole }} {{ __t('ui.settings', '适配') }}
            </small>
            <code>{{ segment.source }}</code>
            <span>{{ segment.tokens.toLocaleString() }}</span>
          </summary>
          <pre>{{ segment.content }}</pre>
        </details>
        <p v-if="preview && !preview.segments.length && !preview.issues.length" class="empty">
          {{ __t('ui.settings', '没有渲染内容') }}
        </p>
      </div>
      <template #footer>
        <PButton variant="secondary" size="sm" @click="previewOpen = false">
          {{ __t('ui.settings', '关闭') }}
        </PButton>
      </template>
    </PDialog>
    <PDialog
      :model-value="Boolean(pendingDialog)"
      :title="pendingDialog?.title"
      :message="pendingDialog?.message"
      @update:model-value="!$event && (pendingDialog = null)"
      @confirm="pendingDialog?.action()"
      @cancel="pendingDialog = null"
    />
  </section>
</template>

<style scoped src="./promptManagement.css"></style>
