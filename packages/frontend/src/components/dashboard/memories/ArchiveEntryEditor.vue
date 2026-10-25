<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { t } from '../../../i18n/index'
import { ApiError } from '../../../api/errors'
import { memoryApi } from '../../../api/modules/memoryApi'
import { knowledgeApi } from '../../../api/modules/knowledgeApi'
import {
  parseArchiveTags,
  type ArchiveEditSaved,
  type ArchiveEditTarget,
} from '../../../lib/archiveEntryEdit'
import { PButton, PixelIcon } from '../../pixel'

const props = defineProps<{ target: ArchiveEditTarget }>()
const emit = defineEmits<{ close: []; saved: [result: ArchiveEditSaved] }>()
const tr = (key: string) => t('ui.archive-edit', key)
const dialog = ref<HTMLDialogElement | null>(null)
const form = ref<HTMLFormElement | null>(null)
const textArea = ref<HTMLTextAreaElement | null>(null)
const memory = props.target.kind === 'memory' ? props.target.note : null
const fact = props.target.kind === 'fact' ? props.target.fact : null
const title = computed(() => tr(memory ? '编辑记忆' : '编辑事实'))
const narrative = ref(memory?.narrative ?? fact?.statement ?? '')
const importance = ref(memory?.importance ?? 5)
const valence = ref(memory?.affect.valence ?? 5)
const arousal = ref(memory?.affect.arousal ?? 0)
const tags = ref({
  tones: memory?.affect.tones.join('\n') ?? '',
  participants: memory?.participants.join('\n') ?? '',
  places: memory?.places.join('\n') ?? '',
  objects: memory?.objects.join('\n') ?? '',
  topics: memory?.topics.join('\n') ?? '',
})
const tagFields = [
  { key: 'tones', label: '情感基调' },
  { key: 'participants', label: '人物' },
  { key: 'places', label: '地点' },
  { key: 'objects', label: '物品' },
  { key: 'topics', label: '主题' },
] as const
const source = ref(fact?.source ?? '')
const confidence = ref<string | number>(fact?.confidence == null ? '' : String(fact.confidence))
const regenerateVector = ref(false)
const saving = ref(false)
const error = ref('')
const conflict = ref(false)
const confirmDiscard = ref(false)
const snapshot = () =>
  JSON.stringify({
    narrative: narrative.value,
    importance: importance.value,
    valence: valence.value,
    arousal: arousal.value,
    tags: tags.value,
    source: source.value,
    confidence: confidence.value,
    regenerateVector: regenerateVector.value,
  })
const initialSnapshot = snapshot()
const dirty = computed(() => snapshot() !== initialSnapshot)
let lastSubmission = ''
let operationId = ''
let alive = true

function requestClose(): void {
  if (saving.value) return
  if (dirty.value) confirmDiscard.value = true
  else emit('close')
}

async function save(): Promise<void> {
  if (saving.value || conflict.value || !form.value?.reportValidity()) return
  if (!narrative.value.trim()) {
    error.value = tr('正文不能为空。')
    return
  }
  const parsedTags = {
    tones: parseArchiveTags(tags.value.tones),
    participants: parseArchiveTags(tags.value.participants),
    places: parseArchiveTags(tags.value.places),
    objects: parseArchiveTags(tags.value.objects),
    topics: parseArchiveTags(tags.value.topics),
  }
  if (
    Object.values(parsedTags).some(
      (values) => values.length > 100 || values.some((value) => value.length > 200),
    )
  ) {
    error.value = tr('每组最多 100 项，每项最多 200 字。')
    return
  }
  // 同一份草稿重试沿用操作编号，防止网络中断后重复生成修订版本。
  const submission = snapshot()
  if (submission !== lastSubmission) {
    operationId = crypto.randomUUID()
    lastSubmission = submission
  }
  saving.value = true
  error.value = ''
  try {
    let result: ArchiveEditSaved
    if (memory) {
      const response = await memoryApi.edit(memory.id, {
        narrative: narrative.value.trim(),
        importance: Number(importance.value),
        affect: {
          tones: parsedTags.tones ?? [],
          valence: Number(valence.value),
          arousal: Number(arousal.value),
        },
        participants: parsedTags.participants ?? [],
        places: parsedTags.places ?? [],
        objects: parsedTags.objects ?? [],
        topics: parsedTags.topics ?? [],
        expectedStatus: memory.status,
        regenerateVector: regenerateVector.value,
        operationId,
      })
      if (!response.data) throw new Error(tr('保存未完成，请保留编辑内容并重试。'))
      result = { kind: 'memory', note: response.data }
    } else {
      const response = await knowledgeApi.editFact(fact!.id, {
        statement: narrative.value.trim(),
        source: source.value.trim(),
        confidence: String(confidence.value).trim() === '' ? undefined : Number(confidence.value),
        operationId,
      })
      if (!response.data) throw new Error(tr('保存未完成，请保留编辑内容并重试。'))
      result = { kind: 'fact', fact: response.data }
    }
    if (!alive) return
    emit('saved', result)
  } catch (cause) {
    if (!alive) return
    conflict.value = cause instanceof ApiError && cause.code === 'CONFLICT'
    error.value = cause instanceof Error ? cause.message : tr('保存未完成，请保留编辑内容并重试。')
  } finally {
    if (alive) saving.value = false
  }
}

onMounted(async () => {
  dialog.value?.showModal()
  await nextTick()
  textArea.value?.focus({ preventScroll: true })
})
onUnmounted(() => {
  alive = false
  dialog.value?.close()
})
</script>

<template>
  <dialog
    ref="dialog"
    class="entry-editor"
    aria-labelledby="entry-editor-title"
    @cancel.prevent="requestClose"
  >
    <header class="editor-header">
      <div>
        <span class="editor-eyebrow">{{ tr('手动修订') }}</span>
        <h3 id="entry-editor-title">{{ title }}</h3>
      </div>
      <PButton
        type="button"
        variant="ghost"
        size="sm"
        :disabled="saving"
        :aria-label="tr('关闭')"
        @click="requestClose"
      >
        ×
      </PButton>
    </header>
    <form ref="form" class="editor-body" @submit.prevent="save">
      <div class="editor-context">
        <PixelIcon name="book" size="sm" />
        <span>
          {{ memory ? tr('保留原始对话与事件时间，保存后保留旧版本。') : fact?.objectName }}
        </span>
        <b v-if="memory?.status === 'archived'">{{ tr('保持归档') }}</b>
      </div>
      <label class="editor-field">
        <span>{{ tr('正文') }}</span>
        <textarea
          ref="textArea"
          v-model="narrative"
          class="editor-narrative"
          required
          maxlength="20000"
          :disabled="saving"
        />
      </label>
      <p class="editor-hint">
        {{
          memory
            ? tr('以所属 Agent 的“我”来记述；他人的经历保留“我得知”等信息来源。')
            : tr('使用客观事实表述。旧事实保留在历史中，对象与原始观察时间不变。')
        }}
      </p>
      <template v-if="memory">
        <div class="editor-scores">
          <label class="editor-field">
            <span>{{ tr('重要度') }}</span>
            <input
              v-model.number="importance"
              type="number"
              min="0"
              max="10"
              step="1"
              required
              :disabled="saving"
            />
          </label>
          <label class="editor-field">
            <span>{{ tr('情绪效价') }}</span>
            <input
              v-model.number="valence"
              type="number"
              min="0"
              max="10"
              step="1"
              required
              :disabled="saving"
            />
          </label>
          <label class="editor-field">
            <span>{{ tr('情绪唤醒度') }}</span>
            <input
              v-model.number="arousal"
              type="number"
              min="0"
              max="10"
              step="1"
              required
              :disabled="saving"
            />
          </label>
        </div>
        <details class="editor-tags">
          <summary>{{ tr('情感与关联标签') }}</summary>
          <p class="editor-hint">{{ tr('每行一项，留空可清除。') }}</p>
          <div class="editor-tag-grid">
            <label v-for="field in tagFields" :key="field.key" class="editor-field">
              <span>{{ tr(field.label) }}</span>
              <textarea v-model="tags[field.key]" rows="2" :disabled="saving" />
            </label>
          </div>
        </details>
        <label class="editor-vector">
          <input v-model="regenerateVector" type="checkbox" :disabled="saving" />
          <span>
            <b>{{ tr('重新生成向量') }}</b>
            <small>
              {{ tr('不选则保留原向量，文本搜索仍会更新；语义相似度可能继续反映旧内容。') }}
            </small>
          </span>
        </label>
      </template>
      <div v-else class="editor-fact-meta">
        <label class="editor-field">
          <span>{{ tr('事实来源') }}</span>
          <input v-model="source" maxlength="2000" :disabled="saving" />
        </label>
        <label class="editor-field">
          <span>{{ tr('可信度（0–1，可留空）') }}</span>
          <input v-model="confidence" type="number" min="0" max="1" step="any" :disabled="saving" />
        </label>
      </div>
      <div v-if="error" class="editor-error" role="alert">
        <p>{{ error }}</p>
        <small v-if="conflict">
          {{ tr('草稿已保留。请先复制正文，再关闭并刷新条目，避免覆盖较新的修改。') }}
        </small>
      </div>
    </form>
    <footer class="editor-footer">
      <template v-if="confirmDiscard">
        <span>{{ tr('放弃尚未保存的修改？') }}</span>
        <PButton type="button" variant="secondary" size="sm" @click="confirmDiscard = false">
          {{ tr('继续编辑') }}
        </PButton>
        <PButton type="button" variant="danger" size="sm" @click="emit('close')">
          {{ tr('放弃修改') }}
        </PButton>
      </template>
      <template v-else>
        <span class="editor-footer-hint">{{ tr('保存为新修订，不修改来源对话。') }}</span>
        <PButton
          type="button"
          variant="secondary"
          size="sm"
          :disabled="saving"
          @click="requestClose"
        >
          {{ tr('取消') }}
        </PButton>
        <PButton
          type="button"
          size="sm"
          :loading="saving"
          :disabled="!dirty || conflict"
          @click="save"
        >
          {{ tr('保存修改') }}
        </PButton>
      </template>
    </footer>
  </dialog>
</template>

<style scoped>
.entry-editor {
  /* 显式居中，避免全局样式重置覆盖原生 dialog 的默认外边距。 */
  position: fixed;
  inset: 0;
  margin: auto;
  box-sizing: border-box;
  width: min(740px, calc(100vw - 32px));
  max-width: calc(100vw - 32px);
  height: fit-content;
  max-height: min(900px, calc(100dvh - 48px));
  padding: 0;
  overflow: hidden;
  border: 2px solid var(--ui-border-strong);
  border-radius: 0;
  background: var(--dash-panel-elevated, var(--ui-bg-surface));
  color: var(--ui-text-primary);
  font-family: var(--ui-font-sans);
  box-shadow:
    5px 5px 0 var(--ui-border-default),
    var(--ui-shadow-lg);
}
.entry-editor::backdrop {
  background: var(--ui-overlay-backdrop);
  backdrop-filter: blur(6px);
}
.entry-editor[open] {
  display: flex;
  flex-direction: column;
}
.editor-header {
  position: relative;
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 22px;
  border-bottom: 2px solid var(--ui-border-default);
  background: var(--dash-panel-soft, var(--ui-bg-surface-soft));
  box-shadow: inset 0 1px 0 var(--ui-border-subtle);
}
.editor-header::before {
  content: '';
  position: absolute;
  top: 0;
  left: 22px;
  width: 48px;
  height: 3px;
  background: var(--ui-accent-purple);
}
.editor-eyebrow {
  font-family: var(--ui-font-pixel);
  font-size: 11px;
  color: var(--ui-accent-purple);
  line-height: 1.6;
  letter-spacing: 0.08em;
}
.editor-header h3 {
  margin: 5px 0 0;
  font-family: var(--ui-font-pixel);
  font-size: 22px;
  font-weight: 400;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.editor-body {
  flex: 1 1 auto;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  min-height: 0;
  margin: 0;
  padding: 20px 22px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.editor-body > * {
  flex-shrink: 0;
}
.editor-context {
  display: flex;
  align-items: flex-start;
  flex-wrap: wrap;
  gap: 8px;
  padding: 9px 12px;
  border-left: 3px solid var(--ui-accent-purple);
  background: var(--dash-panel-soft, var(--ui-bg-surface-soft));
  font-size: 12px;
  line-height: 1.7;
  color: var(--ui-text-secondary);
}
.editor-context > span {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.editor-context b {
  margin-left: auto;
  font-family: var(--ui-font-pixel);
  font-weight: 400;
  color: var(--ui-accent-purple);
}
.editor-field {
  display: flex;
  flex-direction: column;
  gap: 7px;
  min-width: 0;
  font-size: 13px;
}
.editor-field > span {
  font-family: var(--ui-font-pixel);
  line-height: 1.7;
}
.editor-field textarea,
.editor-field input {
  width: 100%;
  box-sizing: border-box;
  min-width: 0;
  border: 2px solid var(--ui-border-default);
  border-radius: 0;
  padding: 10px 12px;
  background: var(--dash-input-bg, var(--ui-bg-surface-soft));
  color: var(--ui-text-primary);
  font: 400 14px / 1.7 var(--ui-font-sans);
  box-shadow: inset 2px 2px 0 var(--ui-border-subtle);
}
.editor-field input {
  min-height: 44px;
}
.editor-field textarea {
  resize: vertical;
  line-height: 1.8;
}
.editor-field textarea:disabled,
.editor-field input:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.editor-narrative {
  min-height: 160px;
  max-height: max(160px, 36dvh);
}
.editor-field textarea:focus-visible,
.editor-field input:focus-visible {
  outline: 2px solid var(--ui-accent-sky);
  outline-offset: 2px;
  border-color: var(--ui-accent-sky);
}
.editor-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--ui-text-secondary);
}
.editor-scores {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}
.editor-scores input {
  font-family: var(--ui-font-pixel);
  font-size: 18px;
  font-variant-numeric: tabular-nums;
}
.editor-tags {
  border: 2px solid var(--ui-border-default);
  border-radius: 0;
  padding: 12px;
  background: var(--dash-panel-soft, var(--ui-bg-surface-soft));
  box-shadow: 2px 2px 0 var(--ui-border-subtle);
}
.editor-tags summary {
  cursor: pointer;
  font-family: var(--ui-font-pixel);
  font-size: 13px;
  line-height: 1.7;
}
.editor-tags summary::marker {
  color: var(--ui-accent-purple);
}
.editor-tags summary:focus-visible {
  outline: 2px solid var(--ui-accent-sky);
  outline-offset: 4px;
}
.editor-tags[open] summary {
  margin-bottom: 10px;
}
.editor-tag-grid,
.editor-fact-meta {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin-top: 10px;
}
.editor-vector {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 13px;
  border: 2px solid var(--ui-border-default);
  background: var(--dash-panel-soft, var(--ui-bg-surface-soft));
  border-radius: 0;
  box-shadow: 2px 2px 0 var(--ui-border-subtle);
  cursor: pointer;
}
.editor-vector:has(input:checked) {
  border-color: var(--ui-accent-purple);
}
.editor-vector input {
  appearance: none;
  display: grid;
  flex-shrink: 0;
  place-content: center;
  width: 18px;
  height: 18px;
  margin: 2px 0 0;
  border: 2px solid var(--ui-border-strong);
  border-radius: 0;
  background: var(--dash-input-bg, var(--ui-bg-surface-soft));
  box-shadow: inset 2px 2px 0 var(--ui-border-subtle);
  cursor: inherit;
}
.editor-vector input:checked {
  border-color: var(--ui-accent-purple);
}
.editor-vector input:checked::before {
  content: '';
  width: 8px;
  height: 8px;
  background: var(--ui-accent-purple);
}
.editor-vector input:focus-visible {
  outline: 2px solid var(--ui-accent-sky);
  outline-offset: 3px;
}
.editor-vector:has(input:disabled) {
  opacity: 0.6;
  cursor: not-allowed;
}
.editor-vector span {
  display: grid;
  min-width: 0;
  gap: 5px;
  font-size: 13px;
}
.editor-vector b {
  font-family: var(--ui-font-pixel);
  font-weight: 400;
  line-height: 1.7;
}
.editor-vector small {
  font-size: 12px;
  color: var(--ui-text-secondary);
  line-height: 1.7;
}
.editor-error {
  padding: 12px;
  border: 2px solid var(--ui-danger);
  border-radius: 0;
  background: var(--dash-panel-soft, var(--ui-bg-surface-soft));
  color: var(--ui-text-primary);
  overflow-wrap: anywhere;
}
.editor-error p {
  margin: 0 0 5px;
  font-size: 13px;
}
.editor-error small {
  line-height: 1.7;
  color: var(--ui-text-secondary);
}
.editor-footer {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 10px;
  padding: 16px 22px;
  border-top: 2px solid var(--ui-border-default);
  background: var(--dash-panel-soft, var(--ui-bg-surface-soft));
  box-shadow: inset 0 1px 0 var(--ui-border-subtle);
}
.editor-footer > span {
  flex: 1;
  min-width: 140px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--ui-text-secondary);
}
@media (max-width: 560px) {
  .entry-editor {
    width: calc(100vw - 24px);
    max-width: calc(100vw - 24px);
    max-height: calc(100dvh - 24px);
    box-shadow:
      3px 3px 0 var(--ui-border-default),
      var(--ui-shadow-lg);
  }
  .editor-scores,
  .editor-tag-grid,
  .editor-fact-meta {
    grid-template-columns: 1fr;
  }
  .editor-body,
  .editor-header,
  .editor-footer {
    padding: 14px;
  }
  .editor-header::before {
    left: 14px;
  }
  .editor-footer > span {
    flex-basis: 100%;
  }
}
@media (forced-colors: active) {
  .editor-vector input {
    appearance: auto;
  }
  .editor-vector input::before {
    display: none;
  }
}
</style>
