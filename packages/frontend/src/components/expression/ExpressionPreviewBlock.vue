<script setup lang="ts">
/** 预览：选场景，看她实际读到的完整内容。后端没有专门的预览时退回预设预览，并说明缺了什么。 */
import { computed, ref } from 'vue'
import { t as __t } from '../../i18n/index'
import { expressionApi, isExpressionApiMissing } from '../../api/modules/expressionApi'
import { promptApi } from '../../api/modules/promptApi'
import { PButton, PInput, PSelect } from '../pixel'
import type { ExpressionPreviewMode } from './expressionTypes'
import type { ExpressionWorkspace } from './useExpressionRules'

const props = defineProps<{ agentId: string; workspace: ExpressionWorkspace }>()

interface PreviewEntry {
  id: string
  role: string
  name: string
  content: string
  hasHandbook: boolean
}

const mode = ref<ExpressionPreviewMode>('chat')
const message = ref('')
const entries = ref<PreviewEntry[] | null>(null)
const partial = ref(false)
const loading = ref(false)
const failure = ref('')

const modeOptions = computed(() => [
  { label: __t('ui.chat', '聊天'), value: 'chat' },
  { label: __t('ui.chat', '工作'), value: 'work' },
  { label: __t('ui.chat', '极简'), value: 'minimal' },
])
const total = computed(() =>
  (entries.value ?? []).reduce((sum, entry) => sum + entry.content.length, 0),
)
function roleLabel(role: string): string {
  if (role === 'system') return __t('ui.chat', '规则和设定')
  if (role === 'user') return __t('ui.chat', '你说的')
  if (role === 'assistant') return __t('ui.chat', '她说的')
  return role
}

/** 块的真实名称来自预设编排；对不上的（比如本轮输入）才按角色显示。 */
function blockName(key: string | undefined, role: string): string {
  const id = key?.startsWith('prompt-slot:') ? key.slice('prompt-slot:'.length) : key
  const block = props.workspace.bundle.value.frameworks
    .flatMap((framework) => framework.blocks)
    .find((item) => item.id === id)
  return block?.name ?? roleLabel(role)
}
function normalize(
  list:
    | Array<{ id?: string; role: string; content: unknown; cacheControl?: { key?: string } }>
    | undefined,
  handbookIndex = -1,
  blockIds: Array<string | null | undefined> = [],
): PreviewEntry[] {
  return (list ?? []).map((item, index) => ({
    id: item.id ?? String(index),
    role: item.role,
    name: blockName(blockIds[index] ?? item.id ?? item.cacheControl?.key, item.role),
    hasHandbook: index === handbookIndex,
    content:
      typeof item.content === 'string' ? item.content : JSON.stringify(item.content, null, 2),
  }))
}

async function run(): Promise<void> {
  const text = message.value.trim() || __t('ui.chat', '今天吃了什么呀')
  loading.value = true
  failure.value = ''
  try {
    try {
      const response = await expressionApi.preview({
        agentId: props.agentId,
        mode: mode.value,
        message: text,
      })
      entries.value = normalize(
        response.data?.messages,
        response.data?.handbookMessageIndex,
        response.data?.blockIds,
      )
      partial.value = false
    } catch (error) {
      if (!isExpressionApiMissing(error)) throw error
      const response = await promptApi.preview({
        bundle: JSON.parse(JSON.stringify(props.workspace.bundle.value)),
        channel: 'desktop',
        agentId: props.agentId,
        variables: {
          channel: 'desktop',
          interaction_mode: mode.value,
          current_message: { role: 'user', content: text },
        },
      })
      entries.value = normalize(response.data?.segments)
      partial.value = true
    }
  } catch (error) {
    entries.value = null
    failure.value = error instanceof Error ? error.message : __t('ui.chat', '读取失败')
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <section class="expr-tune__surface" data-expression-preview>
    <h3 class="expr-tune__title">{{ __t('ui.chat', '预览') }}</h3>
    <p class="expr-tune__hint">
      {{ __t('ui.chat', '选个场景，看她这一轮实际读到的全部内容。') }}
    </p>
    <div class="expr-tune__row">
      <div class="expr-tune__agent">
        <PSelect
          v-model="mode"
          size="sm"
          teleport
          :label="__t('ui.chat', '场景')"
          :options="modeOptions"
        />
      </div>
      <div class="expr-tune__field">
        <PInput
          v-model="message"
          size="sm"
          :label="__t('ui.chat', '你这一句说什么')"
          :placeholder="__t('ui.chat', '今天吃了什么呀')"
        />
      </div>
      <PButton size="sm" :disabled="loading" data-expression-preview-run @click="run">
        {{ loading ? __t('ui.chat', '正在读取…') : __t('ui.chat', '看一看') }}
      </PButton>
    </div>
    <p v-if="failure" class="expr-tune__banner" role="alert">{{ failure }}</p>
    <p
      v-if="entries && partial"
      class="expr-tune__banner"
      role="status"
      data-expression-preview-partial
    >
      {{
        __t(
          'ui.chat',
          '当前后端还不能预览手册和本轮素材，下面没有这两块；没保存的规则改动已算进去。',
        )
      }}
    </p>
    <p v-else-if="entries" class="expr-tune__meta">
      {{ __t('ui.chat', '这里看的是已经生效的内容，没保存的改动不算。') }}
    </p>
    <p v-if="entries" class="expr-tune__meta">{{ __t('ui.chat', '{0} 字', [total]) }}</p>
    <div v-if="entries" class="expr-tune__results">
      <details v-for="entry in entries" :key="entry.id" open>
        <summary>
          {{ entry.name }} · {{ __t('ui.chat', '{0} 字', [entry.content.length]) }}
          <template v-if="entry.hasHandbook"> · {{ __t('ui.chat', '含说话手册') }}</template>
        </summary>
        <pre>{{ entry.content }}</pre>
      </details>
    </div>
  </section>
</template>
