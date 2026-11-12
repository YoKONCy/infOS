<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  ASSISTANT_PREFILL_KEY,
  DYNAMIC_CONTEXT_DEPTH_KEY,
  parseAssistantPrefillConfig,
  parseDynamicContextDepth,
} from '@infos/shared'
import { t as __t } from '../../../i18n/index'
import { configApi } from '../../../api/modules/configApi'
import { uiSound } from '../../../services/ui/uiSound'
import { logger } from '../../../lib/logger'
import { useNotificationStore } from '../../../stores'
import AssistantPrefillSettings from '../AssistantPrefillSettings.vue'
import { PButton, PCard, PSelect, PixelIcon } from '../../pixel'

/**
 * PromptReplyStrategyPanel — 回复策略面板
 *
 * 从个人外观设置中剥离「预填充模式」与「动态填充深度」等模型上下文策略项，
 * 收拢到「提示词与策略」工作台统一维护。
 */
const notif = useNotificationStore()
const assistantPrefill = ref(parseAssistantPrefillConfig())
const dynamicContextDepth = ref(parseDynamicContextDepth())
const loading = ref(false)
const saving = ref(false)
const loadError = ref(false)

const dynamicContextDepthOptions = computed(() => [
  { value: 0, label: __t('ui.settings', '贴近当前输入') },
  { value: 1, label: __t('ui.settings', '前移到上一条输入') },
])

async function loadStrategy(): Promise<void> {
  if (loading.value) return
  loading.value = true
  try {
    const res = await configApi.batch([ASSISTANT_PREFILL_KEY, DYNAMIC_CONTEXT_DEPTH_KEY])
    const data = res.data ?? {}
    assistantPrefill.value = parseAssistantPrefillConfig(data[ASSISTANT_PREFILL_KEY])
    dynamicContextDepth.value = parseDynamicContextDepth(data[DYNAMIC_CONTEXT_DEPTH_KEY])
    loadError.value = false
  } catch (cause) {
    loadError.value = true
    logger.error('PromptReplyStrategy', __t('logs.frontend.settings', '读取回复策略失败'), cause)
  } finally {
    loading.value = false
  }
}

async function saveStrategy(): Promise<void> {
  if (saving.value || loading.value || loadError.value) return
  saving.value = true
  try {
    await configApi.batchSet([
      { key: ASSISTANT_PREFILL_KEY, value: JSON.stringify(assistantPrefill.value) },
      { key: DYNAMIC_CONTEXT_DEPTH_KEY, value: String(dynamicContextDepth.value) },
    ])
    void uiSound.play('action.confirmed')
    notif.toast(__t('ui.settings', '设置已保存'), {
      type: 'success',
      title: __t('ui.navigation', '提示词与策略'),
    })
  } catch (cause) {
    logger.error('PromptReplyStrategy', __t('logs.frontend.settings', '保存失败'), cause)
    notif.toast(__t('ui.settings', '保存失败，请稍后重试'), {
      type: 'error',
      title: __t('ui.navigation', '提示词与策略'),
    })
  } finally {
    saving.value = false
  }
}

function changeDynamicContextDepth(value: string | number): void {
  if (value !== 0 && value !== 1) return
  dynamicContextDepth.value = value
  void saveStrategy()
}

onMounted(() => {
  void loadStrategy()
})
</script>

<template>
  <div class="prompt-strategy-panel">
    <div v-if="loadError" class="prompt-strategy-error" role="alert">
      <span>{{ __t('ui.settings', '设置尚未读取完成，请重试') }}</span>
      <PButton size="sm" variant="ghost" :disabled="loading" @click="loadStrategy">
        {{ __t('ui.settings', '重试') }}
      </PButton>
    </div>

    <AssistantPrefillSettings
      v-model="assistantPrefill"
      :disabled="loading || saving || loadError"
      @save="saveStrategy"
    />

    <PCard pixel padding="lg" overflow-visible>
      <div class="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h3
            class="flex items-center gap-2 text-sm font-black text-[var(--ui-text-primary)] font-pixel"
          >
            <PixelIcon name="settings" size="sm" />
            {{ __t('ui.settings', '动态填充深度') }}
          </h3>
          <p class="mt-2 text-xs text-[var(--ui-text-secondary)]">
            {{ __t('ui.settings', '调整状态与检索资料的位置，前移可能增加缓存开销。') }}
          </p>
        </div>
        <div class="w-48">
          <PSelect
            :model-value="dynamicContextDepth"
            :options="dynamicContextDepthOptions"
            :disabled="loading || saving || loadError"
            :aria-label="__t('ui.settings', '动态填充深度')"
            @update:model-value="changeDynamicContextDepth"
          />
        </div>
      </div>
    </PCard>
  </div>
</template>

<style scoped>
.prompt-strategy-panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 920px;
}

.prompt-strategy-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border-left: 3px solid var(--ui-danger);
  background: var(--ui-danger-soft);
  font-size: 12px;
}
</style>
