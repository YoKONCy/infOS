<script setup lang="ts">
import { t as __t } from '../../i18n/index'

/**
 * ConversationRewindDialog — 全局统一的对话检查点回滚确认框。
 *
 * Workspace、Chat、Logs 等入口复用同一组件，确保删除语义、风险提示和浅深色视觉一致。
 */
import { computed } from 'vue'
import { PButton, PDialog, PixelIcon } from '../pixel'
import type { RewindPreview } from '../../api/modules/chatApi'

const props = defineProps<{
  modelValue: boolean
  preview: RewindPreview | null
  title?: string
  loading?: boolean
  regenerating?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  confirm: []
}>()

const fileActionLabel = {
  get delete_created() {
    return __t('ui.chat', '删除新建文件')
  },
  get restore_edited() {
    return __t('ui.chat', '恢复编辑前版本')
  },
  get restore_deleted() {
    return __t('ui.chat', '恢复已删除文件')
  },
  restore_renamed: '恢复原文件名',
  get preserve_changed() {
    return __t('ui.chat', '检测到后续修改，将保留')
  },
} as const

const preservedReasonLabel = {
  content_changed: '检测到后续修改，将保留',
  get history_gap() {
    return __t('ui.chat', '变更记录不连续，将保留')
  },
  get incomplete_snapshot() {
    return __t('ui.chat', '恢复记录不完整，将保留')
  },
  get unavailable() {
    return __t('ui.chat', '无法安全读取，将保留')
  },
} as const

const dialogTitle = computed(() =>
  props.preview?.scope
    ? __t('ui.chat', props.regenerating ? '重新生成相关回复？' : '撤回这条消息？')
    : props.regenerating
    ? __t('ui.chat', '从这一轮重新生成？')
    : props.preview?.wholeThread
      ? __t('ui.chat', '删除这段会话？')
      : __t('ui.chat', '回滚到此对话之前？'),
)
const confirmText = computed(() =>
  props.regenerating
    ? __t('ui.chat', '重新生成')
    : props.preview?.wholeThread
      ? __t('ui.chat', '删除会话')
      : __t('ui.chat', '回滚并撤回'),
)
</script>

<template>
  <PDialog
    :model-value="modelValue"
    :title="title || dialogTitle"
    width="580px"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div v-if="preview" class="rewind-dialog">
      <div class="rewind-dialog__summary">
        <div>
          <strong>{{ preview.pairCount }}</strong>
          <span>{{ preview.scope ? __t('ui.chat', '条消息') : __t('ui.chat', '轮对话') }}</span>
        </div>
        <div v-if="!preview.wholeThread">
          <strong>{{ preview.createdCount }}</strong>
          <span>{{ __t('ui.chat', '新建文件') }}</span>
        </div>
        <div v-if="!preview.wholeThread">
          <strong>{{ preview.editedCount }}</strong>
          <span>{{ __t('ui.chat', '恢复文件') }}</span>
        </div>
        <div v-if="!preview.wholeThread" class="is-preserved">
          <strong>{{ preview.preservedCount }}</strong>
          <span>{{ __t('ui.chat', '保留改动') }}</span>
        </div>
      </div>

      <p class="rewind-dialog__description">
        <template v-if="preview.wholeThread">
          {{ __t('ui.chat', '删除全部会话记录，保留文件。') }}
        </template>
        <template v-else-if="preview.scope">
          {{ regenerating ? __t('ui.chat', '撤回这条输入及相关回复，再生成新回复。') : __t('ui.chat', '撤回所选消息。') }}
        </template>
        <template v-else-if="regenerating">
          {{ __t('ui.chat', '本轮及后续对话将被撤回，再生成新的回复。') }}
        </template>
        <template v-else>
          {{ __t('ui.chat', '撤回') }} {{ preview.pairCount }}
          {{ __t('ui.chat', '轮对话，并恢复对应文件。') }}
        </template>
      </p>

      <section v-if="preview.files.length" class="rewind-dialog__files">
        <header>
          <span>{{ __t('ui.chat', '工作区变更') }}</span>
          <i>{{ preview.files.length }}</i>
        </header>
        <div class="rewind-dialog__file-list">
          <div
            v-for="file in preview.files"
            :key="`${file.action}:${file.path}`"
            class="rewind-dialog__file"
          >
            <span class="rewind-dialog__file-icon" :class="`is-${file.action}`">
              <PixelIcon
                :name="
                  file.action === 'delete_created'
                    ? 'trash'
                    : file.action === 'preserve_changed'
                      ? 'shield'
                      : 'refresh'
                "
                size="xs"
              />
            </span>
            <code :title="file.path">{{ file.path }}</code>
            <small>
              {{
                file.preservedReason
                  ? preservedReasonLabel[file.preservedReason]
                  : fileActionLabel[file.action]
              }}
            </small>
          </div>
        </div>
      </section>

      <div v-else class="rewind-dialog__empty">
        <PixelIcon name="info" size="sm" />
        <span>{{ __t('ui.chat', '本次撤回不会产生文件回滚。') }}</span>
      </div>

      <div v-if="preview.files.length" class="rewind-dialog__warning">
        <PixelIcon name="shield" size="sm" />
        <span>
          {{ __t('ui.chat', '后续修改、变更记录不连续或恢复记录不完整的文件将被保留。') }}
        </span>
      </div>
    </div>

    <template #footer>
      <PButton
        variant="secondary"
        size="sm"
        :disabled="loading"
        @click="emit('update:modelValue', false)"
      >
        {{ __t('ui.chat', '取消') }}
      </PButton>
      <PButton
        :variant="regenerating ? 'primary' : 'danger'"
        size="sm"
        :disabled="loading || !preview"
        @click="emit('confirm')"
      >
        {{
          loading
            ? regenerating
              ? __t('ui.chat', '准备中…')
              : preview?.wholeThread
                ? __t('ui.chat', '正在删除…')
                : __t('ui.chat', '正在回滚…')
            : confirmText
        }}
      </PButton>
    </template>
  </PDialog>
</template>

<style scoped>
.rewind-dialog {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.rewind-dialog__summary {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  overflow: hidden;
  border: 1px solid var(--ui-border-subtle);
  border-radius: var(--ui-radius-md);
  background: var(--ui-bg-surface-soft);
}
.rewind-dialog__summary div {
  display: flex;
  min-height: 64px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  border-right: 1px solid var(--ui-border-subtle);
}
.rewind-dialog__summary div:last-child {
  border-right: 0;
}
.rewind-dialog__summary strong {
  color: var(--ui-text-primary);
  font: 800 19px var(--ui-font-mono);
}
.rewind-dialog__summary span {
  color: var(--ui-text-tertiary);
  font-size: 10px;
}
.rewind-dialog__description {
  margin: 0;
  color: var(--ui-text-secondary);
  font-size: 12px;
  line-height: 1.65;
}
.rewind-dialog__files {
  overflow: hidden;
  border: 1px solid var(--ui-border-default);
  border-radius: var(--ui-radius-md);
  background: var(--ui-bg-surface);
}
.rewind-dialog__files header {
  display: flex;
  min-height: 34px;
  align-items: center;
  justify-content: space-between;
  padding: 0 11px;
  border-bottom: 1px solid var(--ui-border-subtle);
  color: var(--ui-text-secondary);
  font-size: 11px;
  font-weight: 700;
}
.rewind-dialog__files header i {
  display: grid;
  min-width: 20px;
  height: 20px;
  place-items: center;
  border-radius: var(--ui-radius-full);
  background: var(--ui-bg-hover);
  color: var(--ui-text-tertiary);
  font: normal 10px var(--ui-font-mono);
}
.rewind-dialog__file-list {
  max-height: 230px;
  overflow-y: auto;
  padding: 5px;
}
.rewind-dialog__file {
  display: grid;
  min-height: 34px;
  grid-template-columns: 24px minmax(0, 1fr) auto;
  align-items: center;
  gap: 7px;
  padding: 0 7px;
  border-radius: var(--ui-radius-sm);
}
.rewind-dialog__file:hover {
  background: var(--ui-bg-hover);
}
.rewind-dialog__file-icon {
  display: grid;
  width: 22px;
  height: 22px;
  place-items: center;
  border-radius: var(--ui-radius-sm);
  color: var(--ui-warning);
  background: var(--ui-warning-soft);
}
.rewind-dialog__file-icon.is-delete_created {
  color: var(--ui-danger);
  background: var(--ui-danger-soft);
}
.rewind-dialog__file-icon.is-preserve_changed {
  color: var(--ui-success);
  background: var(--ui-success-soft);
}
.rewind-dialog__file code {
  overflow: hidden;
  color: var(--ui-text-primary);
  font: 11px var(--ui-font-mono);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rewind-dialog__file small {
  color: var(--ui-text-tertiary);
  font-size: 9px;
}
.rewind-dialog__empty {
  display: flex;
  min-height: 50px;
  align-items: center;
  gap: 9px;
  padding: 0 12px;
  border: 1px dashed var(--ui-border-default);
  border-radius: var(--ui-radius-md);
  color: var(--ui-text-tertiary);
  font-size: 11px;
}
.rewind-dialog__warning {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--ui-danger) 28%, var(--ui-border-subtle));
  border-radius: var(--ui-radius-md);
  background: var(--ui-danger-soft);
  color: var(--ui-danger);
  font-size: 11px;
  line-height: 1.55;
}
.rewind-dialog__warning :deep(svg) {
  flex-shrink: 0;
  margin-top: 1px;
}
</style>
