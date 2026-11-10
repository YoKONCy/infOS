<script setup lang="ts">
import { t as __t } from '../../i18n/index'

import { computed } from 'vue'
import { useDesktopControl } from '../../composables/useDesktopControl'
import { PButton } from '../pixel'
import type { ConversationExecutionPause } from '@infos/shared'
const props = defineProps<{
  taskId?: string
  threadId?: string
  pause?: ConversationExecutionPause
  busy?: boolean
}>()
const emit = defineEmits<{ resumeTask: [input: { threadId?: string; callId: string }] }>()
const { state, error, control, supported } = useDesktopControl()
// 只是在准备桌面组件（首次编译），没有暂停也没有在操作：只显示进度提示。
const preparingOnly = computed(
  () => !props.pause && supported && !!state.value.preparing && state.value.phase === 'idle',
)
const visible = computed(
  () =>
    !!props.pause ||
    preparingOnly.value ||
    (supported &&
      state.value.phase !== 'idle' &&
      (!props.taskId || state.value.taskId === props.taskId) &&
      (!props.threadId || state.value.threadId === props.threadId)),
)
async function resume() {
  if (props.busy) return
  const threadId = props.threadId
  const callId = props.pause?.callId
  if (supported && !(await control('resume'))) return
  if (callId) emit('resumeTask', { threadId, callId })
}
</script>

<template>
  <section v-if="visible" class="desktop-control-status" role="status" aria-live="polite">
    <div v-if="preparingOnly">
      <strong>{{ __t('ui.desktop', '正在准备桌面组件') }}</strong>
      <small>
        {{ __t('ui.desktop', '第一次使用或更新后需要编译，大约 10–20 秒，之后会快很多。') }}
      </small>
    </div>
    <div v-else>
      <strong>
        {{
          !pause && state.phase === 'running'
            ? __t('ui.desktop', '正在操作桌面')
            : __t('ui.desktop', '任务已暂停')
        }}
      </strong>
      <small>
        {{
          pause?.message ||
          (state.phase === 'running'
            ? state.targetTitle || __t('ui.desktop', '随时操作鼠标键盘即可接管')
            : state.reason)
        }}
      </small>
      <small v-if="pause">
        {{ __t('ui.desktop', '继续后会核对当前状态，保留已有工作结果。') }}
      </small>
      <small v-if="error" role="alert">{{ error }}</small>
    </div>
    <template v-if="!preparingOnly">
      <PButton
        v-if="!pause && state.phase === 'running'"
        size="sm"
        variant="ghost"
        @click="control('pause')"
      >
        {{ __t('ui.desktop', '暂停') }}
      </PButton>
      <PButton v-else size="sm" variant="ghost" :disabled="busy" @click="resume">
        {{ pause ? __t('ui.desktop', '继续任务') : __t('ui.desktop', '解除桌面暂停') }}
      </PButton>
    </template>
  </section>
</template>

<style scoped>
.desktop-control-status {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--ui-border-strong);
  border-left: 3px solid var(--ui-accent-purple);
  background: var(--ui-bg-surface-soft);
  box-shadow:
    inset 0 1px rgba(255, 255, 255, 0.1),
    2px 2px 0 rgba(0, 0, 0, 0.12);
  color: var(--ui-text-primary);
}
.desktop-control-status div {
  flex: 1;
  min-width: 0;
}
.desktop-control-status small {
  display: block;
  margin-top: 4px;
  color: var(--ui-text-secondary);
  overflow-wrap: anywhere;
}
</style>
