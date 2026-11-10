<script setup lang="ts">
import { t as __t } from '../../i18n/index'

/**
 * SessionMediaSection — 会话设置面板的识图/语音分区。
 *
 * 只展示可选项与当前能力说明；选择结果交回 InputBar 保存。
 */
import { computed } from 'vue'
import SessionSegment from './SessionSegment.vue'

type ImageMode = 'auto' | 'native' | 'relay'
type RecordingMode = 'asr' | 'native'

const props = withDefaults(
  defineProps<{
    threadId: string
    imageMode: ImageMode
    enableVision?: boolean
    relayAvailable?: boolean
    /** 录音按钮实际会使用的方式。 */
    recordingMode: RecordingMode
    asrAvailable?: boolean
    nativeAudioAvailable?: boolean
    voiceDisabled?: boolean
  }>(),
  {
    enableVision: false,
    relayAvailable: false,
    asrAvailable: false,
    nativeAudioAvailable: false,
    voiceDisabled: false,
  },
)
const emit = defineEmits<{
  'update:imageMode': [mode: ImageMode]
  'update:recordingMode': [mode: RecordingMode]
}>()

const imageOptions = computed(() => [
  { value: 'auto', label: __t('ui.input-controls', '自动') },
  {
    value: 'native',
    label: __t('ui.input-controls', '原生'),
    disabled: !props.enableVision,
    title: props.enableVision ? __t('ui.chat', '当前可用') : __t('ui.chat', '当前模型不支持'),
  },
  {
    value: 'relay',
    label: __t('ui.input-controls', '转述'),
    disabled: !props.relayAvailable,
    title: props.relayAvailable ? __t('ui.chat', '当前可用') : __t('ui.chat', '尚未配置'),
  },
])
const nativeAudioBlocked = computed(() => !props.nativeAudioAvailable && Boolean(props.threadId))
const voiceOptions = computed(() => [
  {
    value: 'asr',
    label: __t('ui.input-controls', '转写'),
    disabled: !props.asrAvailable,
    title: props.asrAvailable ? __t('ui.chat', '语音转写') : __t('ui.chat', '未配置'),
  },
  {
    value: 'native',
    label: __t('ui.input-controls', '原音'),
    disabled: nativeAudioBlocked.value,
    title: __t('ui.chat', '原生音频'),
  },
])
const mediaDetail = computed(() => {
  const image = {
    auto: props.enableVision
      ? __t('ui.chat', '优先主模型原生识图')
      : props.relayAvailable
        ? __t('ui.chat', '使用多模态转述')
        : __t('ui.chat', '暂无可用能力'),
    native: __t('ui.input-controls', '由主模型直接看图'),
    relay: __t('ui.input-controls', '先由多模态模型转述'),
  }[props.imageMode]
  const voice =
    props.recordingMode === 'asr'
      ? props.asrAvailable
        ? __t('ui.chat', '录音转成文字，可编辑后发送')
        : __t('ui.audio-input', '语音转文字服务尚未启用')
      : nativeAudioBlocked.value
        ? __t('ui.audio-input', '请在 Gemini 模型卡片中手动开启音频输入')
        : __t('ui.audio-input', '录制原音，试听后发送')
  return [
    __t('ui.input-controls', '识图：{0}', [image]),
    __t('ui.input-controls', '语音：{0}', [voice]),
  ].join(' · ')
})
</script>

<template>
  <section class="session-item session-media" :style="{ '--item-accent': 'var(--ui-accent-sky)' }">
    <div>
      <header class="session-item__head">
        <span>{{ __t('ui.input-controls', '识图') }}</span>
      </header>
      <SessionSegment
        :options="imageOptions"
        :model-value="imageMode"
        :label="__t('ui.chat', '识图方式')"
        accent="var(--ui-accent-sky)"
        @update:model-value="emit('update:imageMode', $event as ImageMode)"
      />
    </div>
    <div>
      <header class="session-item__head">
        <span>{{ __t('ui.input-controls', '语音') }}</span>
      </header>
      <SessionSegment
        :options="voiceOptions"
        :model-value="recordingMode"
        :label="__t('ui.chat', '语音输入')"
        accent="var(--ui-accent-sky)"
        :disabled="voiceDisabled"
        @update:model-value="emit('update:recordingMode', $event as RecordingMode)"
      />
    </div>
    <p class="session-item__desc session-media__desc">{{ mediaDetail }}</p>
  </section>
</template>

<style scoped src="./session-settings.css"></style>

<style scoped>
.session-media {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 0 10px;
}
.session-media__desc {
  grid-column: 1 / -1;
}
</style>
