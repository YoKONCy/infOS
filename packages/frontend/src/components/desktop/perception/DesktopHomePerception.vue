<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import type {
  DesktopHomeSection,
  DesktopHomeSettings,
  DesktopHomeStatus,
  PerceptionSwitch,
} from '@infos/shared'
import { t as __t } from '../../../i18n/index'
import { usePerception, type PerceptionStoredPatch } from '../../../composables/usePerception'
import { MotionCollapse } from '../../motion'
import DesktopHomeEars from '../DesktopHomeEars.vue'
import DesktopHomeRow from '../DesktopHomeRow.vue'
import HomeOptionList from '../home/HomeOptionList.vue'
import {
  COMPANION_OPTIONS,
  ENVIRONMENT_OPTIONS,
  PERCEPTION_HEAR_OPTION,
  PERCEPTION_IMAGE_OPTION,
  PERCEPTION_LEVEL_OPTION,
  PERCEPTION_MAIN_OPTION,
  PERCEPTION_SPEAK_OPTION,
  PERCEPTION_TITLES_OPTION,
  PERCEPTION_WATCH_OPTION,
  VISION_OPTIONS,
  type HomeOption,
} from '../desktopHomeOptions'
import PerceptionListEditor from './PerceptionListEditor.vue'

/**
 * 「感知」分组：把看、听、主动开口、陪看、环境事件、保护放到一处。
 * 只合并界面，眼睛、耳朵、陪看、环境事件仍存在各自的分区里，旧值不动。
 * 主进程没有感知通道时，只显示这些旧选项。
 */
const props = defineProps<{
  settings: DesktopHomeSettings
  status: DesktopHomeStatus | null
  savedKey: string
}>()
const emit = defineEmits<{
  save: [section: DesktopHomeSection, patch: Record<string, unknown>]
  model: [action: 'download' | 'cancel' | 'remove']
  stop: []
}>()

const { state, error, act, updateSettings } = usePerception()
const perception = computed(() => state.value?.settings ?? null)
const [environmentSwitch, ...environmentDetails] = ENVIRONMENT_OPTIONS as [
  HomeOption,
  ...HomeOption[],
]

const perceptionSaved = ref('')
let savedTimer: ReturnType<typeof setTimeout> | undefined
onBeforeUnmount(() => clearTimeout(savedTimer))
const shownKey = computed(() => perceptionSaved.value || props.savedKey)

function markSaved(key: string): void {
  clearTimeout(savedTimer)
  perceptionSaved.value = `perception.${key}`
  savedTimer = setTimeout(() => (perceptionSaved.value = ''), 1600)
}
async function saveSwitch(key: PerceptionSwitch | 'enabled', enabled: boolean): Promise<void> {
  const saved = await act(
    key === 'enabled' ? { type: 'set-enabled', enabled } : { type: 'set-switch', key, enabled },
  )
  if (saved) markSaved(key)
}
async function saveStored(patch: PerceptionStoredPatch): Promise<void> {
  if (await updateSettings(patch)) markSaved(Object.keys(patch)[0] ?? '')
}
function valueOf(option: HomeOption): unknown {
  return (props.settings[option.section] as unknown as Record<string, unknown>)[option.key]
}
function change(option: HomeOption, value: unknown): void {
  emit('save', option.section, { [option.key]: value })
}

</script>

<template>
  <div class="perception-settings">
    <DesktopHomeRow
      v-if="perception"
      :option="PERCEPTION_MAIN_OPTION"
      :value="perception.enabled"
      :saved="shownKey === 'perception.enabled'"
      @change="saveSwitch('enabled', $event === true)"
    />
    <p v-if="error" class="perception-error" role="alert">{{ error }}</p>

    <h5 class="perception-sub">{{ __t('ui.desktop', '看') }}</h5>
    <template v-if="perception">
      <DesktopHomeRow
        :option="PERCEPTION_TITLES_OPTION"
        :value="perception.windowTitles"
        :saved="shownKey === 'perception.windowTitles'"
        @change="saveSwitch('windowTitles', $event === true)"
      />
      <DesktopHomeRow
        :option="PERCEPTION_IMAGE_OPTION"
        :value="perception.screenImages"
        :saved="shownKey === 'perception.screenImages'"
        @change="saveSwitch('screenImages', $event === true)"
      />
    </template>
    <HomeOptionList
      :options="VISION_OPTIONS"
      :value-of="valueOf"
      :saved-key="shownKey"
      @change="change"
    />

    <h5 class="perception-sub">{{ __t('ui.desktop', '听') }}</h5>
    <DesktopHomeEars
      :ears="settings.ears"
      :status="status"
      :saved-key="shownKey"
      @update="emit('save', 'ears', $event)"
      @model="emit('model', $event)"
      @stop="emit('stop')"
    />
    <template v-if="perception">
      <DesktopHomeRow
        :option="PERCEPTION_HEAR_OPTION"
        :value="perception.sound"
        :disabled="!settings.ears.enabled"
        :saved="shownKey === 'perception.sound'"
        @change="saveSwitch('sound', $event === true)"
      />
      <PerceptionListEditor
        :title="__t('ui.desktop', '不录声音的程序')"
        :hint="
          __t(
            'ui.desktop',
            '通话程序默认在这里，一行一个程序名。挡不住浏览器里的网页通话：分不清来源时她不会转写。',
          )
        "
        :value="perception.unrecordedApps"
        :saved="shownKey === 'perception.unrecordedApps'"
        @save="saveStored({ unrecordedApps: $event })"
      />
    </template>

    <template v-if="perception && state">
      <h5 class="perception-sub">{{ __t('ui.desktop', '主动开口') }}</h5>
      <DesktopHomeRow
        :option="PERCEPTION_SPEAK_OPTION"
        :value="perception.proactive"
        :saved="shownKey === 'perception.proactive'"
        @change="saveSwitch('proactive', $event === true)"
      />
      <DesktopHomeRow
        :option="PERCEPTION_LEVEL_OPTION"
        :value="perception.proactiveLevel"
        :saved="shownKey === 'perception.proactiveLevel'"
        @change="
          saveStored({ proactiveLevel: $event as NonNullable<PerceptionStoredPatch['proactiveLevel']> })
        "
      />
      <p v-if="state.counts" class="perception-note">
        {{
          __t('ui.desktop', '今天开口 {0} 次，感知叫醒 {1} / {2} 次，主动回合 {3} / {4} 次。', [
            state.counts.spoken,
            state.counts.perceptionWake,
            state.counts.wakeLimit,
            state.counts.budgetUsed,
            state.counts.budgetLimit,
          ])
        }}
      </p>
      <p class="perception-note">
        {{ __t('ui.desktop', '智能陪伴在总览页设置，它和感知叫醒共用每日主动回合。') }}
      </p>
    </template>

    <h5 class="perception-sub">{{ __t('ui.desktop', '陪看') }}</h5>
    <template v-if="perception && state">
      <DesktopHomeRow
        :option="PERCEPTION_WATCH_OPTION"
        :value="perception.watchAlong"
        :saved="shownKey === 'perception.watchAlong'"
        @change="saveSwitch('watchAlong', $event === true)"
      />
      <p v-if="state.counts" class="perception-note">
        {{ __t('ui.desktop', '今天陪看调用 {0} 次，不占每日主动回合。', [state.counts.watchAlong]) }}
      </p>
    </template>
    <HomeOptionList
      :options="COMPANION_OPTIONS"
      :value-of="valueOf"
      :saved-key="shownKey"
      @change="change"
    />

    <h5 class="perception-sub">{{ __t('ui.desktop', '环境事件') }}</h5>
    <DesktopHomeRow
      :option="environmentSwitch"
      :value="settings.environment.enabled"
      :saved="shownKey === 'environment.enabled'"
      @change="change(environmentSwitch, $event)"
    />
    <MotionCollapse :open="settings.environment.enabled">
      <HomeOptionList
        :options="environmentDetails"
        :value-of="valueOf"
        :saved-key="shownKey"
        @change="change"
      />
    </MotionCollapse>

    <template v-if="perception">
      <h5 class="perception-sub">{{ __t('ui.desktop', '保护') }}</h5>
      <PerceptionListEditor
        :title="__t('ui.desktop', '涂黑的程序')"
        :hint="
          __t(
            'ui.desktop',
            '密码管理器、网银、支付这类程序，一行一个。她不读标题、不截图、不录声音，只知道有个敏感窗口。',
          )
        "
        :value="perception.redactedApps"
        :saved="shownKey === 'perception.redactedApps'"
        @save="saveStored({ redactedApps: $event })"
      />
      <p class="perception-note">
        {{
          __t(
            'ui.desktop',
            '密钥、卡号这类文字和图上的字会先在本机打码，但不保证百分之百。她看到的内容不会长期保存；她说出口的话和她自己记下的事会保存，逐字抄原文的部分会被替换，换种说法写下的挡不住。',
          )
        }}
      </p>
    </template>
  </div>
</template>

<style scoped>
.perception-sub {
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid var(--ui-border-subtle);
  font-weight: 700;
  font-size: 12px;
  color: var(--ui-text-secondary);
}
.perception-settings > .perception-sub:first-child {
  margin-top: 0;
  padding-top: 0;
  border-top: 0;
}
.perception-note {
  margin-top: 6px;
  color: var(--ui-text-secondary);
  font-size: 12px;
  line-height: 1.6;
}
.perception-error {
  margin-top: 8px;
  padding: 8px 10px;
  border-left: 3px solid var(--ui-danger);
  border-radius: var(--ui-radius-xs);
  background: color-mix(in srgb, var(--ui-danger) 8%, transparent);
  color: var(--ui-text-primary);
  font-size: 12px;
}
.perception-tools {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 4px;
}
</style>
