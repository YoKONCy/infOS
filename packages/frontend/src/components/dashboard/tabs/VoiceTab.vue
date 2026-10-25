<script setup lang="ts">
import { t as __t } from '../../../i18n/index'

/**
 * VoiceTab — 语音功能 Tab (F1-4)
 *
 * TTS (语音合成) + ASR (语音识别) 配置面板。
 * F3: 已对接 configApi 读写。
 */
import { ref, computed, onMounted, watch } from 'vue'
import { PixelIcon, PInput, PSelect, PSlider, PSwitch, PButton, PCard } from '../../pixel'
import { configApi } from '../../../api/modules/configApi'
import TtsSettings from '../../voice/TtsSettings.vue'
import { modelApi } from '../../../api/modules/modelApi'
import { useDashboardContext } from '../../../composables/dashboard'
import PetControlSettings from '../../pet/PetControlSettings.vue'
import BrandIcon from '../../brands/BrandIcon.vue'
import BrandSelect from '../../brands/BrandSelect.vue'
import { resolveModelBrand } from '../../../lib/modelBrands'

const ctx = useDashboardContext()

// ── ASR 配置 (OpenAI 兼容接口，模型无关) ──
const asrEnabled = ref(false)
const asrApiBase = ref('')
const asrApiKey = ref('')
const asrModel = ref('')
const asrLanguage = ref('zh-CN')
const wakeWord = ref('佩洛')
const asrSensitivity = ref(0.7)

/** ASR 获取远程模型列表 */
const isFetchingAsrModels = ref(false)
const remoteAsrModels = ref<string[]>([])
const asrModelChoices = computed(() =>
  remoteAsrModels.value.map((modelId) => ({
    label: modelId,
    value: modelId,
    brand: resolveModelBrand(modelId),
  })),
)

async function fetchRemoteAsrModels() {
  if (!asrApiBase.value && !asrApiKey.value) return
  isFetchingAsrModels.value = true
  try {
    const res = await modelApi.listRemote({
      provider: 'openai',
      apiKey: asrApiKey.value,
      apiBase: asrApiBase.value || undefined,
    })
    remoteAsrModels.value = res.data ?? []
  } catch {
    remoteAsrModels.value = []
  } finally {
    isFetchingAsrModels.value = false
  }
}

const asrLanguageOptions = [
  {
    get label() {
      return __t('ui.settings', '简体中文')
    },
    value: 'zh-CN',
  },
  { label: 'English', value: 'en-US' },
  {
    get label() {
      return __t('ui.settings', '日本語')
    },
    value: 'ja-JP',
  },
  {
    get label() {
      return __t('ui.settings', '自动检测')
    },
    value: 'auto',
  },
]

// ── 加载 / 自动保存 ──

async function loadVoiceConfig() {
  try {
    const res = await configApi.batch([
      'asr.enabled',
      'asr.apiBase',
      'asr.apiKey',
      'asr.model',
      'asr.language',
      'asr.wakeWord',
      'asr.sensitivity',
    ])
    const d = res.data ?? {}
    if (d['asr.enabled'] !== undefined) asrEnabled.value = d['asr.enabled'] === 'true'
    if (d['asr.apiBase']) asrApiBase.value = d['asr.apiBase'] as string
    if (d['asr.apiKey']) asrApiKey.value = d['asr.apiKey'] as string
    if (d['asr.model']) asrModel.value = d['asr.model'] as string
    if (d['asr.language']) asrLanguage.value = d['asr.language'] as string
    if (d['asr.wakeWord']) wakeWord.value = d['asr.wakeWord'] as string
    if (d['asr.sensitivity']) asrSensitivity.value = Number(d['asr.sensitivity'])
  } catch {
    // 默认值
  }
}

/** 防抖自动保存 */
let saveTimer: ReturnType<typeof setTimeout> | null = null
function debouncedSave(key: string, value: string) {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    configApi.set(key, value).catch(() => {})
  }, 500)
}

// 监听关键字段变化，自动保存
watch(asrEnabled, (v) => debouncedSave('asr.enabled', String(v)))
watch(asrApiBase, (v) => debouncedSave('asr.apiBase', v))
watch(asrApiKey, (v) => debouncedSave('asr.apiKey', v))
watch(asrModel, (v) => debouncedSave('asr.model', v))
watch(asrLanguage, (v) => debouncedSave('asr.language', v))

// 监听全局刷新
watch(
  () => ctx.refreshKey.value,
  () => loadVoiceConfig(),
)

onMounted(loadVoiceConfig)
</script>

<template>
  <div class="p-8 h-full flex flex-col overflow-hidden">
    <div class="mb-6 flex-shrink-0 relative group/header">
      <!-- 背景氛围光晕 -->
      <div
        class="absolute -right-20 -top-10 w-40 h-40 bg-purple-400/5 blur-[60px] rounded-full pointer-events-none group-hover/header:bg-purple-400/15 transition-all duration-1000"
      />
      <h2
        class="flex items-center gap-3 text-2xl font-black text-[var(--ui-text-primary)] font-pixel"
      >
        <span
          class="group-hover/header:scale-110 group-hover/header:rotate-6 transition-transform duration-500"
        >
          <PixelIcon name="mic" size="md" />
        </span>
        <span>{{ __t('ui.settings', '语音功能') }}</span>
        <span class="opacity-0 group-hover/header:opacity-100 transition-opacity duration-500">
          <PixelIcon name="sparkle" size="xs" />
        </span>
      </h2>
      <p
        class="text-[10px] font-bold uppercase tracking-[0.15em] text-slate-400 mt-1 ml-9 font-pixel"
      >
        VOICE CONFIGURATION
      </p>
    </div>

    <div class="flex-1 min-h-0 overflow-y-auto flex flex-col gap-6 voice-scrollbar voice-sections">
      <PetControlSettings />
      <TtsSettings />

      <!-- ASR -->
      <PCard pixel padding="lg" overflow-visible>
        <div class="flex justify-between items-center mb-5">
          <div class="flex items-center gap-4">
            <div
              :class="[
                'w-12 h-12 flex items-center justify-center text-white flex-shrink-0',
                asrEnabled ? 'bg-emerald-500' : 'bg-slate-400',
              ]"
            >
              <PixelIcon name="mic" size="sm" />
            </div>
            <div>
              <h3 class="text-base font-black text-slate-800 font-pixel">
                {{ __t('ui.settings', '语音识别 ASR') }}
              </h3>
              <p class="text-xs text-slate-400 mt-0.5">
                {{ __t('ui.settings', '用语音与助手对话') }}
              </p>
            </div>
          </div>
          <PSwitch v-model="asrEnabled" />
        </div>

        <template v-if="asrEnabled">
          <div class="grid grid-cols-2 gap-4">
            <!-- API Base -->
            <div class="flex flex-col gap-1.5">
              <label
                class="text-[10px] font-bold uppercase tracking-wider text-slate-400 font-pixel"
              >
                API Base
              </label>
              <PInput v-model="asrApiBase" placeholder="https://api.siliconflow.cn/v1" />
              <p class="text-[10px] text-slate-400 italic">
                {{ __t('ui.settings', '* 任何兼容 /audio/transcriptions 的接口均可') }}
              </p>
            </div>
            <!-- API Key -->
            <div class="flex flex-col gap-1.5">
              <label
                class="text-[10px] font-bold uppercase tracking-wider text-slate-400 font-pixel"
              >
                API Key
              </label>
              <PInput v-model="asrApiKey" type="password" placeholder="sk-..." />
            </div>
            <!-- 模型 + 获取列表 -->
            <div class="flex flex-col gap-1.5 col-span-2">
              <label
                class="text-[10px] font-bold uppercase tracking-wider text-slate-400 font-pixel flex items-center justify-between"
              >
                {{ __t('ui.settings', '模型') }}
                <PButton
                  variant="ghost"
                  size="sm"
                  :loading="isFetchingAsrModels"
                  @click="fetchRemoteAsrModels"
                >
                  <PixelIcon name="refresh" size="xs" />
                  {{ __t('ui.settings', '获取模型列表') }}
                </PButton>
              </label>
              <BrandSelect
                v-if="remoteAsrModels.length > 0"
                v-model="asrModel"
                :options="asrModelChoices"
                :placeholder="__t('ui.settings', '从列表中选择...')"
              />
              <div v-else class="asr-model-input">
                <BrandIcon :brand="resolveModelBrand(asrModel)" size="sm" />
                <PInput
                  v-model="asrModel"
                  :placeholder="__t('ui.settings', '例如: FunAudioLLM/SenseVoiceSmall')"
                />
              </div>
            </div>
            <!-- 识别语言 -->
            <div class="flex flex-col gap-1.5">
              <label
                class="text-[10px] font-bold uppercase tracking-wider text-slate-400 font-pixel"
              >
                {{ __t('ui.settings', '识别语言') }}
              </label>
              <PSelect v-model="asrLanguage" :options="asrLanguageOptions" />
            </div>
            <!-- 唤醒词 -->
            <div class="flex flex-col gap-1.5">
              <label
                class="text-[10px] font-bold uppercase tracking-wider text-slate-400 font-pixel"
              >
                {{ __t('ui.settings', '唤醒词') }}
              </label>
              <PInput v-model="wakeWord" :placeholder="__t('ui.settings', '例如: 佩洛')" />
              <p class="text-[10px] text-slate-400 italic">
                {{ __t('ui.settings', '说出唤醒词后开始语音输入') }}
              </p>
            </div>
            <!-- 灵敏度 -->
            <div class="flex flex-col gap-1.5 col-span-2">
              <label
                class="text-[10px] font-bold uppercase tracking-wider text-slate-400 font-pixel"
              >
                {{ __t('ui.settings', '灵敏度 (') }}{{ (asrSensitivity * 100).toFixed(0) }}%)
              </label>
              <PSlider v-model="asrSensitivity" :min="0.1" :max="1.0" :step="0.05" />
            </div>
          </div>
        </template>

        <div
          v-if="!asrEnabled"
          class="p-4 bg-[var(--dash-panel-soft)] border border-[var(--dash-panel-border)] text-center text-[13px] text-[var(--ui-text-tertiary)]"
        >
          <p>{{ __t('ui.settings', '语音识别已关闭。开启后即可用声音与助手对话。') }}</p>
        </div>
      </PCard>
    </div>
  </div>
</template>

<style scoped>
.asr-model-input {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
}
.asr-model-input > :last-child {
  flex: 1;
  min-width: 0;
}
.voice-sections > * {
  flex-shrink: 0;
}
</style>
