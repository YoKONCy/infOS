<script setup lang="ts">
import { t as __t } from '../../i18n/index'

import { computed } from 'vue'
import type { DesktopHomeEars, DesktopHomeStatus } from '@infos/shared'
import { MotionCollapse } from '../motion'
import { PButton } from '../pixel'
import DesktopHomeRow from './DesktopHomeRow.vue'
import HomeOptionList from './home/HomeOptionList.vue'
import { EARS_OPTIONS, type HomeOption } from './desktopHomeOptions'

// 耳朵：总开关、听写模型下载（显示大小，用户点了才下载）、录音状态，以及语言等选项。
const props = defineProps<{
  ears: DesktopHomeEars
  status: DesktopHomeStatus | null
  savedKey?: string
}>()
const emit = defineEmits<{
  update: [patch: Partial<DesktopHomeEars>]
  model: [action: 'download' | 'cancel' | 'remove']
  stop: []
}>()
const model = computed(() => props.status?.model)
const megabytes = (bytes = 0) => (bytes / 1024 / 1024).toFixed(0)
const progress = computed(() => {
  const value = model.value
  if (!value || value.state !== 'downloading' || !value.totalBytes) return ''
  return __t('ui.desktop', '已下载 {0} / {1} MB', [
    megabytes(value.receivedBytes),
    megabytes(value.totalBytes),
  ])
})
/** 下载进度（0–100），只在下载中有意义。 */
const percent = computed(() => {
  const value = model.value
  if (!value?.totalBytes || value.state !== 'downloading') return 0
  return Math.min(100, Math.round(((value.receivedBytes ?? 0) / value.totalBytes) * 100))
})
const switchOption: HomeOption = {
  section: 'ears',
  key: 'enabled',
  kind: 'switch',
  get label() {
    return __t('ui.desktop', '允许她听电脑的声音')
  },
  get hint() {
    return __t(
      'ui.desktop',
      '只听扬声器放出来的声音，不开麦克风。声音在本机变成文字，安静的部分直接丢掉；在听的时候界面上会有标识。',
    )
  },
}
/** 错误码 → 说明（详细原因附在后面）。 */
function describe(error?: string): string {
  if (!error) return ''
  const code = error.split(':')[0]
  const known: Record<string, string> = {
    EARS_MODEL_HASH_MISMATCH: __t('ui.desktop', '下载的文件校验不通过，已删除，请重试。'),
    EARS_MODEL_SIZE_MISMATCH: __t('ui.desktop', '下载的文件不完整，已删除，请重试。'),
    EARS_MODEL_DOWNLOAD_FAILED: __t('ui.desktop', '模型下载失败，请检查网络后重试。'),
    EARS_MODEL_CANCELLED: __t('ui.desktop', '已取消下载。'),
    EARS_NATIVE_UNAVAILABLE: __t('ui.desktop', '听写组件没能启动，耳朵暂时用不了。'),
    EARS_CAPTURE_FAILED: __t('ui.desktop', '没能录到电脑的声音。'),
    EARS_CAPTURE_NO_AUDIO: __t('ui.desktop', '没能录到电脑的声音。'),
  }
  return known[code!] ?? ''
}
</script>

<template>
  <div class="desktop-home-ears">
    <DesktopHomeRow
      :option="switchOption"
      :value="ears.enabled"
      :saved="savedKey === 'ears.enabled'"
      @change="emit('update', { enabled: $event as boolean })"
    />
    <MotionCollapse :open="ears.enabled">
      <div class="desktop-home-card" role="status">
        <div class="desktop-home-card-text">
          <strong>{{ __t('ui.desktop', '听写模型') }}</strong>
          <Transition name="motion-swap" mode="out-in">
            <p v-if="model?.state === 'ready'" key="ready">
              {{ __t('ui.desktop', '已下载并校验（{0} MB）。', [megabytes(model.totalBytes)]) }}
            </p>
            <p
              v-else-if="model?.state === 'downloading' || model?.state === 'verifying'"
              key="busy"
            >
              {{ progress || __t('ui.desktop', '正在校验…') }}
            </p>
            <p v-else key="missing">
              {{
                __t(
                  'ui.desktop',
                  '需要先下载 {0} MB 的听写模型。只下载一次，存在 infOS 的数据文件夹里。',
                  [megabytes(model?.totalBytes)],
                )
              }}
            </p>
          </Transition>
          <div
            v-if="model?.state === 'downloading'"
            class="desktop-home-progress"
            role="progressbar"
            :aria-valuenow="percent"
            aria-valuemin="0"
            aria-valuemax="100"
          >
            <i :style="{ transform: `scaleX(${percent / 100})` }" />
          </div>
          <p v-if="model?.state === 'failed'" class="desktop-home-error" role="alert">
            {{ describe(model.error) || __t('ui.desktop', '模型没准备好，请重试。') }}
            <small>{{ model.error }}</small>
          </p>
        </div>
        <PButton
          v-if="model?.state === 'downloading'"
          size="sm"
          variant="ghost"
          @click="emit('model', 'cancel')"
        >
          {{ __t('ui.desktop', '取消') }}
        </PButton>
        <PButton
          v-else-if="model?.state === 'ready'"
          size="sm"
          variant="ghost"
          @click="emit('model', 'remove')"
        >
          {{ __t('ui.desktop', '删除模型') }}
        </PButton>
        <PButton v-else-if="model" size="sm" @click="emit('model', 'download')">
          {{ __t('ui.desktop', '下载') }}
        </PButton>
      </div>
      <Transition name="motion-rise">
        <div v-if="status?.listening" class="desktop-home-card is-live">
          <div class="desktop-home-card-text">
            <strong>
              <span class="desktop-home-dot" aria-hidden="true" />
              {{ __t('ui.desktop', '正在听电脑的声音') }}
            </strong>
            <p>
              {{
                status.earsCapture === 'process'
                  ? __t('ui.desktop', '她自己的声音不会被听进去。')
                  : __t('ui.desktop', '她说话的那几秒会暂时不听。')
              }}
            </p>
          </div>
          <PButton size="sm" variant="ghost" @click="emit('stop')">
            {{ __t('ui.desktop', '停止') }}
          </PButton>
        </div>
      </Transition>
      <p v-if="!status?.listening && describe(status?.earsError)" class="desktop-home-error">
        {{ describe(status?.earsError) }}
      </p>
      <p
        v-if="ears.selfExclusion === 'process' && status?.earsCaptureFallback"
        class="desktop-home-note"
      >
        {{ __t('ui.desktop', '这台电脑不支持只排除她的声音，已改成「那几秒整段不听」。') }}
        <small>{{ status.earsCaptureFallback }}</small>
      </p>
      <HomeOptionList
        :options="EARS_OPTIONS"
        :value-of="(option) => ears[option.key as keyof DesktopHomeEars]"
        :saved-key="savedKey"
        @change="(option, value) => emit('update', { [option.key]: value })"
      />
    </MotionCollapse>
  </div>
</template>

<style scoped>
.desktop-home-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px 16px;
  margin: 4px 0 8px;
  padding: 10px 12px;
  border: 1px solid var(--ui-border-subtle);
  border-radius: var(--ui-radius-sm);
  background: var(--ui-bg-surface-soft);
  flex-wrap: wrap;
  color: var(--ui-text-primary);
}
.desktop-home-card.is-live {
  border-color: color-mix(in srgb, var(--ui-success) 40%, transparent);
}
.desktop-home-card-text {
  flex: 1 1 240px;
  min-width: 0;
}
.desktop-home-card strong {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}
.desktop-home-card p {
  margin-top: 2px;
  color: var(--ui-text-secondary);
  font-size: 12px;
  line-height: 1.6;
}
.desktop-home-dot {
  width: 5px;
  height: 5px;
  background: var(--ui-success);
}
.desktop-home-progress {
  height: 4px;
  margin-top: 6px;
  overflow: hidden;
  border-radius: var(--ui-radius-full);
  background: var(--ui-border-subtle);
}
.desktop-home-progress i {
  display: block;
  height: 100%;
  background: var(--ui-accent-sky);
  transform-origin: left center;
  transition: transform var(--motion-duration-slow) var(--motion-ease-standard);
}
.desktop-home-error {
  margin-top: 8px;
  padding: 8px 10px;
  border-left: 3px solid var(--ui-danger);
  border-radius: var(--ui-radius-xs);
  background: color-mix(in srgb, var(--ui-danger) 8%, transparent);
  color: var(--ui-text-primary) !important;
  font-size: 12px;
  overflow-wrap: anywhere;
}
.desktop-home-note {
  margin-top: 8px;
  color: var(--ui-text-secondary);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.desktop-home-error small,
.desktop-home-note small {
  display: block;
  opacity: 0.75;
}
</style>
