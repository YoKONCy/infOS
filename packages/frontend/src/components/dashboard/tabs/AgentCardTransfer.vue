<script setup lang="ts">
import { ref, useId } from 'vue'
import { t } from '../../../i18n'
import { agentApi, type AgentCardPreview } from '../../../api/modules/agentApi'
import { getApiBaseUrl } from '../../../api/transport'
import { invoke, isElectron } from '../../../utils/ipcAdapter'
import { useAgentStore, useNotificationStore } from '../../../stores'
import { PButton, PDialog, PixelIcon } from '../../pixel'

const props = defineProps<{ agentId: string; avatarUrl?: string; dirty: boolean }>()
const emit = defineEmits<{ imported: [id: string] }>()
const notifications = useNotificationStore()
const agentStore = useAgentStore()
const input = ref<HTMLInputElement>()
const hintId = `card-transfer-hint-${useId()}`
const formats = ['png', 'zip'] as const
const busy = ref(false)
const open = ref(false)
const rows = ref<
  Array<{
    file: File
    preview?: AgentCardPreview
    mode: 'create' | 'overwrite' | 'new'
    error?: string
    done: boolean
  }>
>([])

function notifyError(error: unknown) {
  notifications.toast(
    t('ui.agent', '角色卡处理失败：{0}', [
      error instanceof Error ? error.message : t('ui.agent', '角色卡无效'),
    ]),
    'error',
  )
}
async function choose(files: FileList | null) {
  if (!files?.length || busy.value) return
  if (props.dirty) {
    notifications.toast(t('ui.agent', '请先保存修改再导入'), 'warning')
    return
  }
  if (files.length > 20) {
    notifications.toast(t('ui.agent', '一次最多导入 20 张角色卡'), 'warning')
    return
  }
  busy.value = true
  rows.value = Array.from(files).map((file) => ({ file, mode: 'create', done: false }))
  open.value = true
  try {
    for (const row of rows.value) {
      try {
        if (row.file.size > 64 * 1024 * 1024 || !/\.(png|zip)$/i.test(row.file.name))
          throw new Error(t('ui.agent', '请选择不超过 64 MiB 的 PNG 或 ZIP 角色卡'))
        const result = await agentApi.previewCard(row.file)
        if (!result.data) throw new Error(t('ui.agent', '角色卡无效'))
        row.preview = result.data
        row.mode = result.data.exists ? 'new' : 'create'
      } catch (error) {
        row.error = error instanceof Error ? error.message : t('ui.agent', '角色卡无效')
      }
    }
  } finally {
    busy.value = false
    if (input.value) input.value.value = ''
  }
}
async function importCards() {
  busy.value = true
  let importedId = ''
  try {
    for (const row of rows.value) {
      if (!row.preview || row.done || row.error) continue
      try {
        const result = await agentApi.importCard(row.file, row.mode)
        row.done = true
        if (result.data) importedId = result.data.id
      } catch (error) {
        // 同批卡片可能在预览后产生冲突，重新预览并要求用户显式选择。
        row.error = error instanceof Error ? error.message : t('ui.agent', '角色卡无效')
        const latest = await agentApi.previewCard(row.file)
        if (latest.data) row.preview = latest.data
      }
    }
  } catch (error) {
    notifyError(error)
  } finally {
    if (importedId) {
      emit('imported', importedId)
      await agentStore.fetchAgents()
    }
    busy.value = false
  }
}
async function pngCover(): Promise<Blob | undefined> {
  if (!props.avatarUrl) return undefined
  const image = new Image()
  image.crossOrigin = 'anonymous'
  image.src = `${getApiBaseUrl()}${props.avatarUrl}`
  await image.decode()
  const canvas = document.createElement('canvas')
  const scale = Math.min(1, 2048 / Math.max(image.naturalWidth, image.naturalHeight))
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
  canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height)
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error(t('ui.agent', '头像无法转换为 PNG')))),
      'image/png',
    ),
  )
}
async function exportCard(format: 'png' | 'zip') {
  if (!props.agentId || props.dirty || busy.value) return
  busy.value = true
  try {
    const result = await agentApi.exportCard(
      props.agentId,
      format,
      format === 'png' ? await pngCover() : undefined,
    )
    if (!result.data) throw new Error(t('ui.agent', '角色卡无效'))
    if (isElectron()) {
      await invoke('save-agent-card', result.data)
    } else {
      const bytes = Uint8Array.from(atob(result.data.contentBase64), (char) => char.charCodeAt(0))
      const url = URL.createObjectURL(
        new Blob([bytes], { type: format === 'png' ? 'image/png' : 'application/zip' }),
      )
      const link = document.createElement('a')
      link.href = url
      link.download = result.data.fileName
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    }
  } catch (error) {
    notifyError(error)
  } finally {
    busy.value = false
  }
}
function drop(event: DragEvent) {
  event.preventDefault()
  void choose(event.dataTransfer?.files ?? null)
}
defineExpose({ drop })
</script>

<template>
  <section class="card-transfer" :aria-busy="busy" @dragover.prevent @drop.stop="drop">
    <input
      ref="input"
      type="file"
      accept=".png,.zip"
      multiple
      hidden
      @change="choose(($event.target as HTMLInputElement).files)"
    />
    <div class="card-transfer__actions">
      <button
        type="button"
        class="card-transfer__import"
        :disabled="busy || dirty"
        :title="dirty ? t('ui.agent', '请先保存修改再导入') : t('ui.agent', '导入角色卡')"
        :aria-label="t('ui.agent', '导入角色卡')"
        :aria-describedby="hintId"
        @click="input?.click()"
      >
        <PixelIcon name="folder" size="xs" aria-hidden="true" />
        {{ t('ui.agent', '导入') }}
      </button>
      <div class="card-formats" role="group" :aria-label="t('ui.agent', '导出角色卡')">
        <span class="card-formats__icon" :title="t('ui.agent', '导出角色卡')" aria-hidden="true">
          <PixelIcon name="download" size="xs" />
        </span>
        <button
          v-for="format in formats"
          :key="format"
          type="button"
          :disabled="busy || dirty || !agentId"
          :title="dirty
            ? t('ui.agent', '请先保存修改再导出')
            : t('ui.agent', '导出 {0} 角色卡', [format.toUpperCase()])"
          :aria-label="t('ui.agent', '导出 {0} 角色卡', [format.toUpperCase()])"
          :aria-describedby="hintId"
          @click="exportCard(format)"
        >{{ format.toUpperCase() }}</button>
      </div>
    </div>
    <p :id="hintId" class="card-transfer__hint" :class="{ 'is-dirty': dirty }">
      <PixelIcon :name="dirty ? 'edit' : 'info'" size="xs" aria-hidden="true" />
      {{ dirty ? t('ui.agent', '先保存修改') : t('ui.agent', '拖入 PNG / ZIP 角色卡') }}
    </p>
    <PDialog
      v-model="open"
      :title="t('ui.agent', '导入角色卡预览')"
      :loading="busy"
      :auto-close="false"
      width="640px"
    >
      <article v-for="(row, index) in rows" :key="index" class="card-preview">
        <img v-if="row.preview" :src="row.preview.avatar" :alt="row.preview.name" />
        <div>
          <b>{{ row.preview?.name ?? row.file.name }}</b>
          <p v-if="row.done">{{ t('ui.agent', '导入完成') }}</p>
          <p v-if="row.error" role="alert">{{ row.error }}</p>
          <template v-if="row.preview">
            <label v-if="row.preview.exists && !row.done">
              {{ t('ui.agent', '角色已存在') }}
              <select v-model="row.mode" :disabled="busy" @change="row.error = undefined">
                <option value="new">{{ t('ui.agent', '导入为新角色') }}</option>
                <option value="overwrite">{{ t('ui.agent', '覆盖') }}</option>
              </select>
            </label>
          </template>
        </div>
      </article>
      <template #footer>
        <PButton :disabled="busy" @click="open = false">{{ t('ui.agent', '关闭') }}</PButton>
        <PButton
          :disabled="busy || !rows.some((row) => row.preview && !row.done && !row.error)"
          @click="importCards"
        >
          {{ t('ui.agent', '确认导入') }}
        </PButton>
      </template>
    </PDialog>
  </section>
</template>

<style scoped>
.card-transfer {
  display: grid;
  flex: 0 0 auto;
  min-width: 0;
  gap: 8px;
  padding: 12px 0;
  border-bottom: 1px solid var(--ui-border-subtle);
}
.card-transfer__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}
.card-transfer__import,
.card-formats button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 32px;
  padding: 0 9px;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--ui-text-secondary);
  font: 11px/1 var(--ui-font-pixel);
  cursor: pointer;
  transition:
    color 140ms ease,
    background-color 140ms ease,
    border-color 140ms ease;
}
.card-transfer__import {
  flex: 1 0 auto;
  border: 1px solid color-mix(in srgb, var(--ui-accent-primary) 24%, var(--ui-border-subtle));
  border-radius: 0;
  background: color-mix(in srgb, var(--ui-accent-primary) 6%, var(--ui-bg-surface));
  color: var(--ui-accent-primary);
  white-space: nowrap;
}
.card-transfer__import:hover:not(:disabled) {
  border-color: var(--ui-accent-primary);
  background: var(--ui-accent-primary-soft);
}
.card-transfer__hint {
  display: flex;
  align-items: center;
  gap: 5px;
  margin: 0;
  color: var(--ui-text-tertiary);
  font-size: 10px;
  line-height: 1.4;
}
.card-transfer__hint :deep(.pixel-icon) {
  flex: 0 0 auto;
}
.card-transfer__hint.is-dirty {
  color: var(--ui-warning);
}
.card-formats {
  display: flex;
  flex: 1 0 auto;
  align-items: center;
  min-width: 104px;
  overflow: hidden;
  border: 1px solid var(--ui-border-default);
  border-radius: 0;
  background: var(--ui-bg-surface);
}
.card-formats__icon {
  display: grid;
  width: 26px;
  flex: 0 0 auto;
  place-items: center;
  color: var(--ui-text-tertiary);
}
.card-formats button {
  flex: 1;
  min-width: 0;
  min-height: 30px;
  padding-inline: 6px;
  border-left: 1px solid var(--ui-border-subtle);
  font: 10px/1 var(--ui-font-mono);
}
.card-formats button:hover:not(:disabled) {
  background: var(--ui-bg-hover);
  color: var(--ui-accent-primary);
}
.card-transfer__actions button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.card-transfer__actions button:focus-visible {
  outline: 2px solid var(--ui-accent-primary);
  outline-offset: -2px;
}
.card-preview {
  display: flex;
  gap: 12px;
  padding: 12px 0;
  border-bottom: 1px solid var(--ui-border-default);
  overflow-wrap: anywhere;
}
.card-preview img {
  width: 72px;
  height: 72px;
  object-fit: cover;
}
.card-preview p,
.card-preview li {
  font-size: 12px;
}
.card-preview select {
  margin-left: 8px;
  color: var(--ui-text-primary);
  background: var(--ui-bg-elevated);
}
@media (prefers-reduced-motion: reduce) {
  .card-transfer__actions button {
    transition: none;
  }
}
[data-motion='off'] .card-transfer__actions button,
[data-motion='reduced'] .card-transfer__actions button {
  transition: none;
}
</style>
