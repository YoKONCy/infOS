<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { KnowledgeRecallSettings } from '@infos/shared'
import { knowledgeApi } from '../../api/modules/knowledgeApi'
import { PixelIcon, PSwitch } from '../pixel'
import { t } from '../../i18n'

const props = defineProps<{ kind: 'facts' | 'documents' }>()
const settings = ref<KnowledgeRecallSettings | null>(null)
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const key = computed(() => (props.kind === 'documents' ? 'documentAutoRecall' : 'factAutoRecall'))
const title = computed(() =>
  t('ui.knowledge-recall', props.kind === 'documents' ? '文档知识自动召回' : '事实自动召回'),
)
const description = computed(() =>
  t(
    'ui.knowledge-recall',
    props.kind === 'documents'
      ? '将相关资料的极简摘要放入本轮上下文，Agent 仍可按需检索原文。'
      : '将相关对象的少量有效事实放入本轮上下文，保留来源与记录时间。',
  ),
)
async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const response = await knowledgeApi.recallSettings()
    if (!response.data) throw new Error(t('ui.knowledge-recall', '自动召回设置读取失败'))
    settings.value = response.data
  } catch {
    error.value = t('ui.knowledge-recall', '自动召回设置读取失败')
  } finally {
    loading.value = false
  }
}
async function save(enabled: boolean): Promise<void> {
  if (!settings.value || saving.value) return
  saving.value = true
  error.value = ''
  try {
    const response = await knowledgeApi.saveRecallSettings({
      ...settings.value,
      [key.value]: enabled,
    })
    if (!response.data) throw new Error(t('ui.knowledge-recall', '自动召回设置保存失败'))
    settings.value = response.data
  } catch {
    error.value = t('ui.knowledge-recall', '自动召回设置保存失败')
  } finally {
    saving.value = false
  }
}
onMounted(load)
</script>

<template>
  <section
    class="recall-controls"
    :class="{ 'is-enabled': settings?.[key] }"
    :aria-label="title"
    :aria-busy="loading || saving"
  >
    <div class="recall-controls__icon" aria-hidden="true">
      <PixelIcon :name="kind === 'documents' ? 'file' : 'database'" size="sm" />
    </div>
    <div class="recall-controls__copy">
      <strong>
        {{ title }}
        <small>{{ t('ui.knowledge-recall', '独立于事件记忆') }}</small>
      </strong>
      <p>{{ description }}</p>
      <span v-if="error" class="recall-controls__error" role="alert">
        {{ error }}
        <button type="button" :disabled="loading || saving" @click="load">
          {{ t('ui.knowledge-recall', '重新读取') }}
        </button>
      </span>
    </div>
    <div class="recall-controls__action">
      <span role="status">
        {{
          loading
            ? t('ui.knowledge-recall', '读取中…')
            : saving
              ? t('ui.knowledge-recall', '保存中…')
              : settings?.[key]
                ? t('ui.knowledge-recall', '已开启')
                : t('ui.knowledge-recall', '默认关闭')
        }}
      </span>
      <PSwitch
        size="sm"
        :model-value="settings?.[key] ?? false"
        :disabled="!settings || loading || saving"
        :aria-label="title"
        @update:model-value="save"
      />
    </div>
  </section>
</template>

<style scoped>
.recall-controls {
  --recall-accent: var(--ui-accent-emerald, var(--ui-success));
  display: grid;
  grid-template-columns: 30px minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  flex: none;
  box-sizing: border-box;
  min-height: 64px;
  margin: 0;
  padding: 10px 12px;
  border: 1px solid var(--ui-border-default);
  border-radius: 0;
  background: var(--app-panel-fill, var(--ui-bg-surface));
  backdrop-filter: blur(var(--app-material-blur, 0px));
  font-family: var(--ui-font-sans);
}
.recall-controls__icon {
  display: grid;
  place-items: center;
  align-self: stretch;
  border-right: 1px solid var(--ui-border-subtle);
  color: var(--recall-accent);
}
.recall-controls__copy {
  min-width: 0;
}
.recall-controls__copy strong {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 10px;
  color: var(--ui-text-primary);
  font: 13px/1.5 var(--ui-font-pixel);
}
.recall-controls__copy small {
  padding-left: 10px;
  border-left: 1px solid var(--ui-border-default);
  color: var(--ui-text-tertiary);
  font: 10px/1.5 var(--ui-font-sans);
}
.recall-controls__copy p {
  margin: 3px 0 0;
  color: var(--ui-text-secondary);
  font-size: 12px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.recall-controls__action {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  min-width: 112px;
  padding-left: 14px;
  border-left: 1px solid var(--ui-border-subtle);
}
.recall-controls__action > span {
  color: var(--ui-text-tertiary);
  font-size: 10px;
  white-space: nowrap;
}
.recall-controls.is-enabled .recall-controls__action > span {
  color: var(--recall-accent);
}
/* 开关仅在知识库设置栏采用直角样式，沿用共用组件的交互与键盘支持。 */
.recall-controls :deep(.p-switch-wrapper.p-switch-sm) {
  --switch-width: 34px;
  --switch-height: 18px;
  --switch-thumb: 12px;
  --switch-inset: 2px;
  --switch-accent: var(--recall-accent);
  min-height: 30px;
  border-radius: 0;
}
.recall-controls :deep(.p-switch-wrapper .p-switch-track) {
  border-radius: 0;
  background: var(--app-reading-fill, var(--ui-bg-surface-soft));
  box-shadow: inset 1px 1px 0 var(--ui-border-subtle);
}
.recall-controls :deep(.p-switch-track::before),
.recall-controls :deep(.p-switch-thumb::after) {
  display: none;
}
.recall-controls :deep(.p-switch-wrapper .p-switch-track.p-switch-on) {
  border-color: var(--recall-accent);
  background: color-mix(in srgb, var(--recall-accent) 14%, var(--ui-bg-surface-soft));
}
.recall-controls :deep(.p-switch-wrapper .p-switch-thumb) {
  border: 1px solid var(--ui-border-strong);
  border-radius: 0;
  background: var(--ui-bg-elevated);
  box-shadow: none;
}
.recall-controls :deep(.p-switch-wrapper .p-switch-thumb.p-switch-thumb-on) {
  border-color: var(--recall-accent);
  background: var(--recall-accent);
}
.recall-controls :deep(.p-switch-wrapper:not(:disabled):hover .p-switch-thumb) {
  box-shadow: none;
}
.recall-controls__error {
  display: block;
  margin-top: 6px;
  color: var(--ui-danger);
  font-size: 12px;
  line-height: 1.6;
}
.recall-controls__error button {
  margin-left: 8px;
  padding: 2px 6px;
  border: 1px solid currentColor;
  border-radius: 0;
  background: transparent;
  color: var(--ui-text-secondary);
  cursor: pointer;
  font: inherit;
}
.recall-controls__error button:hover:not(:disabled) {
  color: var(--recall-accent);
}
.recall-controls__error button:focus-visible {
  outline: 2px solid var(--recall-accent);
  outline-offset: 2px;
}
.recall-controls__error button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
@media (max-width: 600px) {
  .recall-controls {
    grid-template-columns: 24px minmax(0, 1fr);
    gap: 8px 10px;
    padding: 10px;
  }
  .recall-controls__copy strong {
    align-items: baseline;
  }
  .recall-controls__copy small {
    padding-left: 0;
    border-left: 0;
  }
  .recall-controls__action {
    grid-column: 2;
    justify-content: space-between;
    padding: 6px 0 0;
    border-left: 0;
    border-top: 1px solid var(--ui-border-subtle);
    min-width: 0;
  }
}
</style>
