<script setup lang="ts">
import { t as __t } from '../../i18n/index'

/**
 * SessionSettingsPanel — 输入栏左侧的会话设置入口与面板。
 *
 * 入口以模式图标、当前模式和模型名称分层展示；面板集中模型、模型思考、会话模式、
 * 执行权限与识图/语音。会话模式、执行权限和媒体选择的保存仍由 InputBar 负责，
 * 本组件只发出意图，避免同一状态出现两份写入逻辑。
 */
import { computed, ref, watch } from 'vue'
import type { ExecutionMode, InteractionMode, ThreadModelSettings } from '@infos/shared'
import { useExecutionLevels } from '../../composables/chat/useExecutionLevels'
import PixelIcon from '../pixel/PixelIcon.vue'
import InputBarFoldout from './InputBarFoldout.vue'
import RuntimeDebugToggle from './RuntimeDebugToggle.vue'
import SessionExecutionSection from './SessionExecutionSection.vue'
import SessionMediaSection from './SessionMediaSection.vue'
import SessionSegment from './SessionSegment.vue'
import SessionModelControls from './SessionModelControls.vue'

type ImageMode = 'auto' | 'native' | 'relay'
type RecordingMode = 'asr' | 'native'

const props = withDefaults(
  defineProps<{
    threadId: string
    scopeKey: string
    compact?: boolean
    /** 模型与思考的禁用条件（发送中、切换模式中等）。 */
    modelDisabled?: boolean
    interactionMode: InteractionMode
    pendingInteractionMode?: InteractionMode | null
    modeBusy?: boolean
    modeDisabled?: boolean
    executionMode: ExecutionMode
    executionDisabled?: boolean
    imageMode: ImageMode
    enableVision?: boolean
    relayAvailable?: boolean
    /** 录音按钮实际会使用的方式。 */
    recordingMode: RecordingMode
    asrAvailable?: boolean
    nativeAudioAvailable?: boolean
    voiceDisabled?: boolean
    /** 助手工作期间显示不可修改提示。 */
    locked?: boolean
    ensureThread: () => Promise<string>
  }>(),
  {
    compact: false,
    modelDisabled: false,
    pendingInteractionMode: null,
    modeBusy: false,
    modeDisabled: false,
    executionDisabled: false,
    enableVision: false,
    relayAvailable: false,
    asrAvailable: false,
    nativeAudioAvailable: false,
    voiceDisabled: false,
    locked: false,
  },
)
const emit = defineEmits<{
  open: []
  modelChanged: [settings: ThreadModelSettings]
  modelBusy: [value: boolean]
  selectMode: [mode: InteractionMode]
  changeExecution: [mode: ExecutionMode]
  'update:imageMode': [mode: ImageMode]
  'update:recordingMode': [mode: RecordingMode]
  debugState: [value: { enabled: boolean; busy: boolean }]
  debugChange: []
  reset: []
}>()

const foldout = ref<InstanceType<typeof InputBarFoldout> | null>(null)
const modelControls = ref<InstanceType<typeof SessionModelControls> | null>(null)
const executionSection = ref<InstanceType<typeof SessionExecutionSection> | null>(null)
const modelSettings = ref<ThreadModelSettings | null>(null)
const debug = ref({ enabled: false, busy: false })
const resetSpin = ref(false)

const modeOptions = computed(() => [
  {
    value: 'minimal' as const,
    label: __t('ui.chat', '极简'),
    icon: 'leaf',
    title: __t('ui.chat', '极简模式：交流、截图、心流、记忆查询与记事本'),
    detail: __t('ui.input-controls', '轻量对话与日常工具'),
  },
  {
    value: 'chat' as const,
    label: __t('ui.chat', '聊天'),
    icon: 'chat',
    title: __t('ui.chat', '聊天模式'),
    detail: __t('ui.input-controls', '自然交流与角色互动'),
  },
  {
    value: 'work' as const,
    label: __t('ui.chat', '工作'),
    icon: 'tool',
    title: __t('ui.chat', '工作模式'),
    detail: __t('ui.input-controls', '使用工具处理任务'),
  },
])
const shownMode = computed(() => props.pendingInteractionMode ?? props.interactionMode)
const currentMode = computed(
  () =>
    modeOptions.value.find((option) => option.value === shownMode.value) ?? modeOptions.value[1]!,
)
const modeStatusLabel = computed(() =>
  __t('ui.chat', '{0}{1}模式', [
    props.modeBusy ? __t('ui.chat', '正在切换为') : __t('ui.chat', '当前为'),
    currentMode.value.label,
  ]),
)

// 执行权限档位与入口提示共用；待确认状态由权限分区自己管理。
const {
  levels: executionLevels,
  index: executionIndex,
  raised: executionRaised,
} = useExecutionLevels(() => props.executionMode)

const modelName = computed(() => modelSettings.value?.effective.name || __t('ui.chat', '未配置'))
const triggerHint = computed(() =>
  executionRaised.value
    ? __t('ui.input-controls', '执行权限已放开：{0}', [
        executionLevels.value[executionIndex.value]!.label,
      ])
    : [__t('ui.input-controls', '会话设置'), currentMode.value.label, modelName.value].join(' · '),
)
const resetDisabled = computed(() => props.modeDisabled || props.modelDisabled)

function onModelChanged(settings: ThreadModelSettings): void {
  modelSettings.value = settings
  emit('modelChanged', settings)
}
function onDebugState(value: { enabled: boolean; busy: boolean }): void {
  debug.value = value
  emit('debugState', value)
}
function resetDefaults(): void {
  if (resetDisabled.value) return
  resetSpin.value = true
  window.setTimeout(() => (resetSpin.value = false), 360)
  executionSection.value?.cancel()
  void modelControls.value?.reset()
  emit('reset')
}
function onClose(): void {
  executionSection.value?.clear()
  modelControls.value?.collapse()
}

watch(
  () => props.threadId,
  () => (modelSettings.value = null),
)
defineExpose({ close: (restoreFocus = false) => foldout.value?.close(restoreFocus) })
</script>

<template>
  <InputBarFoldout
    ref="foldout"
    class="session-settings-entry"
    variant="text"
    :label="currentMode.label"
    :title="__t('ui.input-controls', '会话设置')"
    :hint="triggerHint"
    icon="settings"
    accent="var(--ui-accent-purple)"
    :busy="modeBusy"
    :compact="compact"
    :scope-key="scopeKey"
    :width="316"
    :arrow-navigation="false"
    @open="emit('open')"
    @close="onClose"
  >
    <template #trigger="{ open }">
      <span
        class="session-trigger__emblem"
        :class="{ 'is-warn': executionRaised }"
        aria-hidden="true"
      >
        <PixelIcon :name="currentMode.icon" size="xs" />
      </span>
      <span v-if="!compact" class="session-trigger__copy">
        <span class="session-trigger__mode" :class="{ 'is-warn': executionRaised }" data-session-mode>
          {{ currentMode.label }}
        </span>
        <span class="session-trigger__model" data-session-model>{{ modelName }}</span>
      </span>
      <span v-if="!compact && debug.enabled && interactionMode === 'work'" class="session-trigger__badge">
        {{ __t('ui.runtime-debug', '调试') }}
      </span>
      <PixelIcon
        v-if="!compact"
        name="chevron-down"
        size="xs"
        class="session-trigger__chevron"
        :class="{ 'is-open': open }"
        aria-hidden="true"
      />
    </template>
    <template #head-actions>
      <button
        type="button"
        class="session-reset"
        :class="{ 'is-spinning': resetSpin }"
        data-foldout-skip
        data-session-reset
        :aria-label="__t('ui.input-controls', '恢复默认')"
        :title="__t('ui.input-controls', '恢复默认')"
        :disabled="resetDisabled"
        @click="resetDefaults"
      >
        <PixelIcon name="refresh" size="xs" />
      </button>
    </template>

    <div class="session-settings">
      <SessionModelControls
        ref="modelControls"
        :thread-id="threadId"
        :disabled="modelDisabled"
        @changed="onModelChanged"
        @busy="emit('modelBusy', $event)"
      />

      <section
        class="session-item"
        :style="{ '--item-accent': 'var(--ui-accent-primary)' }"
        :aria-busy="modeBusy"
      >
        <header class="session-item__head">
          <span>{{ __t('ui.chat', '会话模式') }}</span>
        </header>
        <SessionSegment
          :options="modeOptions"
          :model-value="shownMode"
          :label="__t('ui.chat', '会话模式')"
          accent="var(--ui-accent-primary)"
          :disabled="modeDisabled"
          @update:model-value="emit('selectMode', $event as InteractionMode)"
        />
        <div class="session-item__descriptions">
          <p
            v-for="option in modeOptions"
            :key="option.value"
            class="session-item__desc"
            :class="{ 'is-current': option.value === shownMode }"
            :aria-hidden="option.value !== shownMode || undefined"
          >{{ option.detail }}</p>
        </div>
        <div class="session-collapse" :class="{ 'is-open': shownMode === 'work' }">
          <div class="session-debug" :inert="shownMode !== 'work' || undefined">
            <RuntimeDebugToggle
              layout="menu"
              :thread-id="threadId || null"
              :mode="interactionMode"
              :disabled="modeDisabled"
              :ensure-thread="ensureThread"
              @state="onDebugState"
              @change="emit('debugChange')"
            />
          </div>
        </div>
        <span class="sr-only" role="status">{{ modeStatusLabel }}</span>
      </section>

      <SessionExecutionSection
        ref="executionSection"
        :execution-mode="executionMode"
        :scope-key="scopeKey"
        :disabled="executionDisabled"
        @change="emit('changeExecution', $event)"
      />

      <SessionMediaSection
        :thread-id="threadId"
        :image-mode="imageMode"
        :enable-vision="enableVision"
        :relay-available="relayAvailable"
        :recording-mode="recordingMode"
        :asr-available="asrAvailable"
        :native-audio-available="nativeAudioAvailable"
        :voice-disabled="voiceDisabled"
        @update:image-mode="emit('update:imageMode', $event)"
        @update:recording-mode="emit('update:recordingMode', $event)"
      />

      <p v-if="locked" class="session-locked">
        {{ __t('ui.chat', '助手工作期间暂不能修改功能设置') }}
      </p>
    </div>
  </InputBarFoldout>
</template>

<style scoped src="./session-settings.css"></style>

<style scoped>
.session-trigger__emblem {
  display: grid;
  align-self: stretch;
  flex: 0 0 30px;
  place-items: center;
  border-right: 1px solid color-mix(in srgb, var(--ui-accent-primary) 22%, var(--ui-border-subtle));
  background: color-mix(in srgb, var(--ui-accent-primary) 9%, transparent);
  color: var(--ui-accent-primary);
}
.session-trigger__copy {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 0 9px;
  text-align: left;
}
.session-trigger__mode {
  color: var(--ui-text-primary);
  font: 11px/1.2 var(--ui-font-pixel);
  transition: color 140ms ease;
}
.session-trigger__mode.is-warn,
.session-trigger__emblem.is-warn {
  color: var(--ui-warning);
}
.session-trigger__model {
  max-width: 150px;
  overflow: hidden;
  color: var(--ui-text-tertiary);
  font: 9px/1.2 var(--ui-font-mono);
  text-overflow: ellipsis;
}
.session-trigger__badge {
  padding: 2px 4px;
  border: 1px solid color-mix(in srgb, var(--ui-accent-purple) 32%, transparent);
  background: var(--ui-accent-purple-soft);
  color: var(--ui-accent-purple);
  font-size: 9px;
}
.session-trigger__chevron {
  margin-inline: 2px 8px;
  color: var(--ui-text-tertiary);
  transition: transform 180ms ease;
}
.session-trigger__chevron.is-open {
  transform: rotate(180deg);
}
.session-settings {
  margin: -7px;
}
/* 模型分区来自子组件，相邻选择器跨不过组件边界，单独补分隔线。 */
.thread-model-controls + .session-item {
  border-top: 1px solid var(--ui-border-subtle);
}
.session-reset {
  transition:
    transform 350ms ease,
    color 140ms ease,
    border-color 140ms ease;
}
.session-reset.is-spinning {
  transform: rotate(-360deg);
}
.session-reset:disabled {
  cursor: not-allowed;
}
.session-debug {
  padding-top: 9px;
}
.session-debug :deep(.runtime-debug-control) {
  display: flex;
  padding: 0;
}
.session-debug :deep(.runtime-debug-toggle) {
  width: 100%;
  min-height: 0;
  padding: 0;
  border: 0;
  background: transparent;
  box-shadow: none;
}
.session-locked {
  margin: 0;
  padding: 7px 11px;
  border-top: 1px solid var(--ui-border-subtle);
  color: var(--ui-text-tertiary);
  font: 10px/1.5 var(--ui-font-sans);
}
@media (prefers-reduced-motion: reduce) {
  .session-reset,
  .session-trigger__chevron {
    transition: none;
  }
}
</style>
