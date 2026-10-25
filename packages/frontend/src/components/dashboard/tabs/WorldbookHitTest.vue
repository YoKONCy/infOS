<script setup lang="ts">
/**
 * 世界书命中测试 — 用当前未保存的条目和一段模拟输入，按全局激活设置计算命中结果。
 */
import { computed, ref, watch } from 'vue'
import type {
  WorldbookActivation,
  WorldbookChannel,
  WorldbookEntry,
  WorldbookHit,
} from '@infos/shared'
import { WORLDBOOK_CHANNELS } from '@infos/shared'
import { t as __t } from '../../../i18n/index'
import { worldbookApi } from '../../../api/modules/worldbookApi'
import { PButton, PSelect, PixelIcon } from '../../pixel'

const props = defineProps<{ bookId: string; entries: WorldbookEntry[] }>()

const text = ref('')
const channel = ref<WorldbookChannel>('desktop')
const running = ref(false)
const error = ref('')
const result = ref<WorldbookActivation | null>(null)
// 每次测试递增；切换世界书或重复点击后，迟到的旧结果不再覆盖当前显示。
let request = 0

// 结果只对应当时的那本书，切换后清空，保留输入的模拟文本。
watch(
  () => props.bookId,
  () => {
    request++
    result.value = null
    error.value = ''
    running.value = false
  },
)

const channelLabels: Record<WorldbookChannel, () => string> = {
  desktop: () => __t('ui.worldbook', '桌面'),
  group: () => __t('ui.worldbook', '据点群聊'),
  social_private: () => __t('ui.worldbook', '社交私聊'),
  social_group: () => __t('ui.worldbook', '社交群聊'),
}
const channelOptions = computed(() =>
  WORLDBOOK_CHANNELS.map((value) => ({ value, label: channelLabels[value]() })),
)

/** 结果中的条目以 `书 ID/条目 ID` 标识，测试时只含当前书，按条目 ID 找回标题。 */
function titleOf(id: string) {
  const entryId = id.slice(id.lastIndexOf('/') + 1)
  const entry = props.entries.find((item) => item.id === entryId)
  return entry?.title || entryId
}
function reasonLabel(hit: WorldbookHit) {
  if (hit.reason === 'constant') return __t('ui.worldbook', '常驻')
  if (hit.reason === 'sticky') return __t('ui.worldbook', '粘滞「{0}」', [hit.keyword ?? ''])
  return __t('ui.worldbook', '关键词「{0}」', [hit.keyword ?? ''])
}

async function run() {
  const current = ++request
  running.value = true
  error.value = ''
  try {
    const response = await worldbookApi.test({
      entries: props.entries,
      text: text.value,
      channel: channel.value,
    })
    if (current === request) result.value = response.data ?? null
  } catch (cause) {
    if (current === request) error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    if (current === request) running.value = false
  }
}
</script>

<template>
  <section class="wb-test" :aria-label="__t('ui.worldbook', '命中测试')">
    <div class="wb-test__form">
      <textarea
        v-model="text"
        class="wb-test__input"
        :placeholder="__t('ui.worldbook', '输入一段模拟对话，检查哪些条目会被触发')"
        :aria-label="__t('ui.worldbook', '模拟输入')"
        @keydown.ctrl.enter.prevent="run"
      />
      <div class="wb-test__controls">
        <PSelect
          :model-value="channel"
          :options="channelOptions"
          size="sm"
          teleport
          @update:model-value="channel = $event as WorldbookChannel"
        />
        <PButton size="sm" :loading="running" :disabled="running" @click="run">
          <PixelIcon name="play" size="xs" />
          {{ __t('ui.worldbook', '测试') }}
        </PButton>
      </div>
      <p class="wb-test__note">
        {{ __t('ui.worldbook', '使用当前未保存的条目与全局激活设置；概率按实际规则随机判定。') }}
      </p>
    </div>
    <p v-if="error" class="wb-test__error" role="alert">{{ error }}</p>
    <div v-if="result" class="wb-test__result">
      <div class="wb-test__summary">
        <span>{{ __t('ui.worldbook', '命中 {0} 条', [result.hits.length]) }}</span>
        <span>{{ __t('ui.worldbook', '共 {0} Token', [result.tokens.toLocaleString()]) }}</span>
      </div>
      <ul v-if="result.hits.length" class="wb-test__hits">
        <li v-for="hit in result.hits" :key="`${hit.bookId}/${hit.entryId}`">
          <strong>{{ hit.title || hit.entryId }}</strong>
          <span class="wb-test__tag" :class="hit.reason">{{ reasonLabel(hit) }}</span>
          <span class="wb-test__meta">{{ hit.tokens.toLocaleString() }} Token</span>
        </li>
      </ul>
      <p v-else class="wb-test__empty">{{ __t('ui.worldbook', '没有条目被触发') }}</p>
      <details v-if="result.content" class="wb-test__content">
        <summary>{{ __t('ui.worldbook', '合并后的注入内容') }}</summary>
        <pre>{{ result.content }}</pre>
      </details>
      <div v-if="result.dropped.length" class="wb-test__group">
        <span>{{ __t('ui.worldbook', '超出 Token 上限被舍弃') }}</span>
        <em v-for="id in result.dropped" :key="id">{{ titleOf(id) }}</em>
      </div>
      <div v-if="result.skipped.length" class="wb-test__group">
        <span>{{ __t('ui.worldbook', '未通过触发概率') }}</span>
        <em v-for="id in result.skipped" :key="id">{{ titleOf(id) }}</em>
      </div>
    </div>
  </section>
</template>

<style scoped>
.wb-test {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.wb-test__form {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 200px;
  gap: 8px 12px;
}
.wb-test__input {
  grid-row: span 2;
  min-height: 86px;
  padding: 10px 12px;
  background: var(--dash-input-bg);
  border: 1px solid var(--ui-border-default);
  color: var(--ui-text-primary);
  font-size: 13px;
  line-height: 1.6;
  resize: vertical;
  outline: none;
}
.wb-test__input:focus {
  border-color: var(--ui-accent-sky);
  box-shadow: 0 0 0 1px var(--ui-accent-sky);
}
.wb-test__controls {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.wb-test__note {
  margin: 0;
  align-self: end;
  font-size: 11px;
  line-height: 1.5;
  color: var(--ui-text-tertiary);
}
.wb-test__error {
  margin: 0;
  padding: 8px 12px;
  border-left: 3px solid var(--ui-danger);
  background: color-mix(in srgb, var(--ui-danger) 8%, transparent);
  font-size: 13px;
}
.wb-test__result {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.wb-test__summary {
  display: flex;
  gap: 16px;
  font: 700 12px/1.4 var(--ui-font-pixel);
  color: var(--ui-text-secondary);
}
.wb-test__hits {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.wb-test__hits li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  padding: 6px 10px;
  border-left: 3px solid var(--ui-success);
  background: color-mix(in srgb, var(--ui-success) 6%, transparent);
  font-size: 13px;
}
.wb-test__hits strong {
  flex: 1;
  min-width: 120px;
  overflow-wrap: anywhere;
}
.wb-test__tag {
  padding: 1px 6px;
  font-size: 11px;
  border: 1px solid var(--ui-success);
  color: var(--ui-success);
}
.wb-test__tag.constant {
  border-color: var(--ui-accent-sky);
  color: var(--ui-accent-sky);
}
.wb-test__tag.sticky {
  border-color: var(--ui-accent-purple);
  color: var(--ui-accent-purple);
}
.wb-test__meta {
  font: 400 11px/1.4 var(--ui-font-mono);
  color: var(--ui-text-tertiary);
}
.wb-test__group {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  font-size: 12px;
  color: var(--ui-text-tertiary);
}
.wb-test__group > span {
  font-weight: 700;
  color: var(--ui-warning);
}
.wb-test__group em {
  font-style: normal;
  padding: 1px 6px;
  border: 1px dashed var(--ui-border-default);
  color: var(--ui-text-secondary);
}
.wb-test__content summary {
  cursor: pointer;
  font: 700 12px/1.6 var(--ui-font-pixel);
  color: var(--ui-text-secondary);
}
.wb-test__content summary:hover {
  color: var(--ui-accent-sky);
}
.wb-test__content pre {
  max-height: 280px;
  overflow: auto;
  margin: 8px 0 0;
  padding: 10px 12px;
  background: var(--dash-input-bg);
  border: 1px solid var(--ui-border-subtle);
  font:
    13px/1.7 ui-monospace,
    Consolas,
    monospace;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.wb-test__empty {
  margin: 0;
  font-size: 13px;
  color: var(--ui-text-tertiary);
}
@media (max-width: 700px) {
  .wb-test__form {
    grid-template-columns: 1fr;
  }
  .wb-test__input {
    grid-row: auto;
  }
}
</style>
