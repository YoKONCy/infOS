<script setup lang="ts">
import { t as __t } from '../../../i18n/index'

import { computed, ref } from 'vue'
import {
  ST_MARKERS,
  ST_MARKER_BINDINGS,
  PROMPT_GENERATION_TYPES,
  ST_UTILITY_FIELDS,
} from '@infos/shared'
import type {
  PromptBlock,
  PromptFramework,
  PromptGenerationType,
  PromptRole,
  StUtilityKey,
  StCharacterPrompt,
} from '@infos/shared'
import { PButton, PInput, PSelect, PSwitch } from '../../pixel'
import SillyTavernVariablePanel from './SillyTavernVariablePanel.vue'

const props = withDefaults(
  defineProps<{
    variables: Array<{ name: string; label: string }>
    agents?: Array<{ label: string; value: string }>
  }>(),
  { agents: () => [] },
)
const emit = defineEmits<{ add: []; move: [from: number, to: number] }>()
const framework = defineModel<PromptFramework>('framework', { required: true })
const dragging = ref(-1),
  variableName = ref('')
const characterId = ref('')
const characterOptions = computed(() => [
  {
    value: '',
    get label() {
      return __t('ui.settings', '通用设置')
    },
  },
  ...props.agents.filter((agent) => agent.value),
])
const character = computed(() => framework.value.sillyTavern?.characters?.[characterId.value] ?? {})
const characterFields: Array<{ value: keyof StCharacterPrompt; label: string }> = [
  {
    value: 'description',
    get label() {
      return __t('ui.settings', '角色描述')
    },
  },
  {
    value: 'personality',
    get label() {
      return __t('ui.settings', '性格')
    },
  },
  {
    value: 'scenario',
    get label() {
      return __t('ui.settings', '场景')
    },
  },
  {
    value: 'examples',
    get label() {
      return __t('ui.settings', '示例对话')
    },
  },
  {
    value: 'firstMessage',
    get label() {
      return __t('ui.settings', '开场白')
    },
  },
  {
    value: 'creatorNotes',
    get label() {
      return __t('ui.settings', '创作者备注')
    },
  },
  {
    value: 'version',
    get label() {
      return __t('ui.settings', '角色版本')
    },
  },
  {
    value: 'authorsNote',
    get label() {
      return __t('ui.settings', '作者注释')
    },
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
const kinds = [
  {
    value: 'template',
    get label() {
      return __t('ui.settings', '提示词')
    },
  },
  {
    value: 'history',
    get label() {
      return __t('ui.settings', '聊天历史')
    },
  },
  {
    value: 'marker',
    get label() {
      return __t('ui.settings', '数据标记')
    },
  },
]
const positions = [
  {
    value: 'relative',
    get label() {
      return __t('ui.settings', '列表位置')
    },
  },
  {
    value: 'in_chat',
    get label() {
      return __t('ui.settings', '历史内插入')
    },
  },
]
const markers = computed(() => [
  ...ST_MARKERS.map((item) => ({ label: __t('common.interface', item.label), value: item.value })),
  ...framework.value.blocks
    .filter(
      (block) =>
        block.kind === 'marker' &&
        block.marker &&
        !ST_MARKERS.some((marker) => marker.value === block.marker),
    )
    .map((block) => ({ label: block.name, value: block.marker! })),
])
const bindings = computed(() => [
  {
    value: '',
    get label() {
      return __t('ui.settings', '留空')
    },
  },
  {
    value: '$text',
    get label() {
      return __t('ui.settings', '手动填写')
    },
  },
  ...props.variables
    .filter((variable) => !['native_history', 'current_message'].includes(variable.name))
    .map((variable) => ({ value: variable.name, label: __t('common.prompts', variable.label) })),
])
const customValues = computed(() =>
  Object.entries(framework.value.sillyTavern?.values ?? {}).filter(
    ([key]) => !markers.value.some((marker) => marker.value === key),
  ),
)
const sampling = computed(() =>
  Object.entries(framework.value.sillyTavern?.sourcePreset ?? {}).filter(
    ([key, value]) =>
      [
        'temperature',
        'top_p',
        'top_k',
        'min_p',
        'frequency_penalty',
        'presence_penalty',
        'openai_max_tokens',
        'openai_max_context',
      ].includes(key) && typeof value === 'number',
  ),
)
const unknownTriggers = (block: PromptBlock) =>
  (block.triggers ?? []).filter(
    (value) => !PROMPT_GENERATION_TYPES.some((type) => type.value === value),
  )
function forbidValue(block: PromptBlock): boolean {
  if (block.forbidOverrides !== undefined) return block.forbidOverrides
  const source = framework.value.sillyTavern?.sourcePreset?.prompts
  const original = Array.isArray(source)
    ? source.find(
        (item) =>
          item && typeof item === 'object' && item.identifier === (block.stIdentifier ?? block.id),
      )
    : undefined
  return original?.forbid_overrides === true
}
function config() {
  return (framework.value.sillyTavern ??= { markerBindings: { ...ST_MARKER_BINDINGS }, values: {} })
}
function utilityValue(key: StUtilityKey): string {
  const cfg = config()
  return (
    cfg.utility?.[key] ??
    (typeof cfg.sourcePreset?.[key] === 'string' ? (cfg.sourcePreset[key] as string) : '')
  )
}
function setUtility(key: StUtilityKey, value: string) {
  ;(config().utility ??= {})[key] = value
}
function setCharacter(key: keyof StCharacterPrompt, value: string) {
  const profiles = (config().characters ??= {})
  if (!Object.hasOwn(profiles, characterId.value)) profiles[characterId.value] = {}
  if (value) profiles[characterId.value]![key] = value
  else delete profiles[characterId.value]![key]
}
function setKind(block: PromptBlock, kind: string) {
  block.kind = kind as PromptBlock['kind']
  if (kind === 'history') {
    block.position = 'relative'
    block.stIdentifier = 'chatHistory'
  } else if (kind === 'marker') {
    block.marker ??= 'charDescription'
    block.stIdentifier = block.marker
  } else {
    block.marker = undefined
    block.stIdentifier = block.id
  }
}
function setMarker(block: PromptBlock, marker: string) {
  block.marker = marker
  block.stIdentifier = marker
}
function toggleTrigger(block: PromptBlock, type: PromptGenerationType) {
  block.triggers = block.triggers?.includes(type)
    ? block.triggers.filter((item) => item !== type)
    : [...(block.triggers ?? []), type]
}
function addVariable() {
  const name = variableName.value.trim()
  if (
    !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) ||
    name.startsWith('__') ||
    ['constructor', 'prototype', 'component'].includes(name)
  )
    return
  config().values[name] ??= ''
  variableName.value = ''
}
</script>

<template>
  <div class="st-editor">
    <details class="bindings-panel">
      <summary>{{ __t('ui.settings', '辅助提示词') }}</summary>
      <details v-for="field in ST_UTILITY_FIELDS" :key="field.value" class="st-utility-field">
        <summary>
          {{ __t('common.interface', field.label) }}
          <small v-if="utilityValue(field.value)" class="muted-text">
            {{ __t('ui.settings', '已配置') }}
          </small>
        </summary>
        <textarea
          :value="utilityValue(field.value)"
          class="code-editor compact-editor"
          :aria-label="__t('common.interface', field.label)"
          spellcheck="false"
          @input="setUtility(field.value, ($event.target as HTMLTextAreaElement).value)"
        />
      </details>
    </details>
    <details class="bindings-panel">
      <summary>{{ __t('ui.settings', '角色覆盖') }}</summary>
      <PSelect v-model="characterId" :options="characterOptions" size="sm" teleport />
      <div class="st-character-fields">
        <label class="field">
          {{ __t('ui.settings', '主提示词') }}
          <textarea
            :value="character.main ?? ''"
            class="code-editor compact-editor"
            :placeholder="__t('ui.settings', '留空继承；可使用 {{original}}')"
            spellcheck="false"
            @input="setCharacter('main', ($event.target as HTMLTextAreaElement).value)"
          />
        </label>
        <label class="field">
          {{ __t('ui.settings', '历史后指令') }}
          <textarea
            :value="character.postHistory ?? ''"
            class="code-editor compact-editor"
            :placeholder="__t('ui.settings', '留空继承；可使用 {{original}}')"
            spellcheck="false"
            @input="setCharacter('postHistory', ($event.target as HTMLTextAreaElement).value)"
          />
        </label>
      </div>
      <details class="st-utility-field">
        <summary>{{ __t('ui.settings', '角色资料') }}</summary>
        <div class="st-character-fields">
          <label v-for="field in characterFields" :key="field.value" class="field">
            {{ field.label }}
            <textarea
              :value="character[field.value] ?? ''"
              class="code-editor compact-editor"
              :aria-label="field.label"
              :placeholder="
                field.value === 'examples'
                  ? __t('ui.settings', '&lt;START>\n{{user}}: 你好\n{{char}}: 你好！')
                  : __t('ui.settings', '留空继承')
              "
              @input="setCharacter(field.value, ($event.target as HTMLTextAreaElement).value)"
            />
          </label>
        </div>
      </details>
    </details>
    <SillyTavernVariablePanel :agents="agents" />
    <details class="bindings-panel">
      <summary>{{ __t('ui.settings', '数据映射') }}</summary>
      <div v-for="marker in markers" :key="marker.value" class="st-mapping-row">
        <label>{{ marker.label }}</label>
        <PSelect
          :model-value="
            framework.sillyTavern?.markerBindings[marker.value] ??
            ST_MARKER_BINDINGS[marker.value] ??
            ''
          "
          :options="bindings"
          size="sm"
          teleport
          @update:model-value="config().markerBindings[marker.value] = String($event)"
        />
        <textarea
          v-if="framework.sillyTavern?.markerBindings[marker.value] === '$text'"
          :value="framework.sillyTavern?.values[marker.value] ?? ''"
          class="code-editor compact-editor"
          :aria-label="marker.label"
          :placeholder="__t('ui.settings', '填写文本')"
          @input="config().values[marker.value] = ($event.target as HTMLTextAreaElement).value"
        />
      </div>
    </details>
    <details class="bindings-panel">
      <summary>
        {{ __t('ui.settings', '固定宏值') }}
        <small>{{ customValues.length }}</small>
      </summary>
      <div v-for="[name, value] in customValues" :key="name" class="st-variable-row">
        <code v-text="`{{${name}}}`" />
        <PInput
          :model-value="value"
          size="sm"
          @update:model-value="config().values[name] = $event"
        />
        <button
          class="icon-button"
          :aria-label="__t('ui.settings', '删除变量')"
          @click="delete config().values[name]"
        >
          ×
        </button>
      </div>
      <div class="row">
        <PInput
          v-model="variableName"
          :placeholder="__t('ui.settings', '变量名')"
          size="sm"
          @keydown.enter.prevent="addVariable"
        />
        <PButton variant="ghost" size="sm" @click="addVariable">
          {{ __t('ui.settings', '＋ 变量') }}
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
            emit('move', dragging, index)
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
            @click="emit('move', index, index - 1)"
          >
            ↑
          </button>
          <button
            class="icon-button"
            :disabled="index === framework.blocks.length - 1"
            :aria-label="__t('ui.settings', '下移')"
            @click="emit('move', index, index + 1)"
          >
            ↓
          </button>
          <button
            class="icon-button"
            :aria-label="__t('ui.settings', '删除条目')"
            @click="framework.blocks.splice(index, 1)"
          >
            ×
          </button>
        </header>
        <div class="st-block-fields">
          <PSelect
            :model-value="block.kind"
            :options="kinds"
            size="sm"
            teleport
            @update:model-value="setKind(block, String($event))"
          />
          <PSelect
            v-if="block.kind !== 'history'"
            :model-value="block.role"
            :options="roleOptions"
            size="sm"
            teleport
            @update:model-value="block.role = $event as PromptRole"
          />
          <PSelect
            v-if="block.kind !== 'history'"
            :model-value="block.position ?? 'relative'"
            :options="positions"
            size="sm"
            teleport
            @update:model-value="block.position = $event as 'relative' | 'in_chat'"
          />
        </div>
        <div
          v-if="block.position === 'in_chat' && block.kind !== 'history'"
          class="st-position-fields"
        >
          <label class="field">
            {{ __t('ui.settings', '深度') }}
            <input
              v-model.number="block.depth"
              class="st-number"
              type="number"
              min="0"
              max="10000"
            />
          </label>
          <label class="field">
            {{ __t('ui.settings', '顺序') }}
            <input
              v-model.number="block.order"
              class="st-number"
              type="number"
              min="-100000"
              max="100000"
            />
          </label>
        </div>
        <textarea
          v-if="block.kind === 'template'"
          v-model="block.template"
          class="code-editor compact-editor"
          spellcheck="false"
          :aria-label="__t('ui.settings', '酒馆宏正文')"
          :placeholder="__t('ui.settings', '填写提示词，可使用酒馆宏')"
        />
        <label
          v-if="['main', 'jailbreak'].includes(block.stIdentifier ?? block.id)"
          class="history-toggle"
        >
          <PSwitch
            :model-value="forbidValue(block)"
            @update:model-value="block.forbidOverrides = $event"
          />
          {{ __t('ui.settings', '禁止角色覆盖') }}
        </label>
        <PSelect
          v-else-if="block.kind === 'marker'"
          :model-value="block.marker ?? 'charDescription'"
          :options="markers"
          size="sm"
          teleport
          @update:model-value="setMarker(block, String($event))"
        />
        <details class="st-triggers">
          <summary>
            {{ __t('ui.settings', '触发') }}
            <small>
              {{
                block.triggers?.length
                  ? block.triggers
                      .map((type) =>
                        __t(
                          'common.interface',
                          PROMPT_GENERATION_TYPES.find((item) => item.value === type)?.label ??
                            type,
                        ),
                      )
                      .join('、')
                  : __t('ui.settings', '全部')
              }}
            </small>
          </summary>
          <div class="st-trigger-options">
            <button
              v-for="type in PROMPT_GENERATION_TYPES"
              :key="type.value"
              :class="{ active: block.triggers?.includes(type.value) }"
              :aria-pressed="Boolean(block.triggers?.includes(type.value))"
              @click="toggleTrigger(block, type.value)"
            >
              {{ __t('common.interface', type.label) }}
            </button>
            <button
              v-for="type in unknownTriggers(block)"
              :key="type"
              class="error"
              :aria-label="__t('ui.settings', '移除未知触发类型 {0}', [type])"
              @click="block.triggers = block.triggers?.filter((value) => value !== type)"
            >
              {{ type }} ×
            </button>
          </div>
        </details>
      </article>
    </TransitionGroup>
    <PButton variant="secondary" size="sm" @click="emit('add')">
      {{ __t('ui.settings', '＋ 条目') }}
    </PButton>
    <details v-if="sampling.length" class="bindings-panel">
      <summary>{{ __t('ui.settings', '原预设参数') }}</summary>
      <dl class="st-sampling">
        <div v-for="[key, value] in sampling" :key="key">
          <dt>{{ key }}</dt>
          <dd>{{ value }}</dd>
        </div>
      </dl>
      <small class="muted-text">{{ __t('ui.settings', '仅保留原预设参数') }}</small>
    </details>
    <details class="tutorial">
      <summary>{{ __t('ui.settings', '酒馆格式教程') }}</summary>
      <p>
        {{ __t('ui.settings', '深度 0 在最新消息后，深度 1 在最新消息前。同一位置按顺序数排列。') }}
      </p>
      <p>
        {{
          __t(
            'ui.settings',
            '支持条件、宏和变量。聊天变量仅用于当前会话，全局变量共享；预览不保存修改。',
          )
        }}
      </p>
      <p>
        {{
          __t(
            'ui.settings',
            'original 引用原提示词；“禁止角色覆盖”保留原正文。示例对话使用 START 分组和 user / char 标记。',
          )
        }}
      </p>
      <p>
        {{
          __t(
            'ui.settings',
            '暂不支持扩展脚本；世界书内容统一放在当前输入之前，不经过世界信息标记。',
          )
        }}
      </p>
    </details>
  </div>
</template>

<style scoped src="./promptManagement.css"></style>
