<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch, type Ref } from 'vue'
import {
  TTS_ADAPTERS,
  createTtsWorkspace,
  createTtsPreset,
  type TtsAdapterId,
  type TtsHttpProfile,
  type TtsWorkspace,
} from '@infos/shared'
import { PButton, PCard, PInput, PSelect, PSwitch, PixelIcon } from '../pixel'
import { voiceApi } from '../../api/modules/voiceApi'
import { useDashboardContext } from '../../composables/dashboard'
import { t } from '../../i18n'
import BrandIcon from '../brands/BrandIcon.vue'
import BrandSelect from '../brands/BrandSelect.vue'
import { resolveProviderBrand } from '../../lib/modelBrands'
import { ttsAdapterBrand, ttsPresetBrand } from '../../lib/ttsBrands'

const ctx = useDashboardContext()
const config = ref(createTtsWorkspace()) as Ref<TtsWorkspace>
const selected = ref('')
const adding = ref<TtsAdapterId>('edge_tts')
const lastPresetByAdapter = new Map<TtsAdapterId, string>()
const busy = ref(false)
const loading = ref(true)
const loaded = ref(false)
const playing = ref(false)
const error = ref('')
const saved = ref('')
const customText = ref('')
const extraText = ref('{}')
const headersText = ref('{}')
const testText = ref('')
const upload = ref<HTMLInputElement | null>(null)
let controller: AbortController | undefined
let player: AudioContext | undefined
let disposed = false
const preset = computed(() => config.value.presets.find((item) => item.id === selected.value))
const model = computed(() => config.value.models.find((item) => item.id === preset.value?.modelId))
const profile = computed(() =>
  config.value.profiles.find((item) => item.id === model.value?.profileId),
)
const connection = computed(() =>
  config.value.connections.find((item) => item.id === model.value?.connectionId),
)
const adapter = computed(() => TTS_ADAPTERS.find((item) => item.id === profile.value?.adapter))
const visiblePresets = computed(() =>
  config.value.presets.filter((item) => {
    const model = config.value.models.find((model) => model.id === item.modelId)
    return (
      config.value.profiles.find((profile) => profile.id === model?.profileId)?.adapter ===
      adding.value
    )
  }),
)
const adapterOptions = computed(() =>
  TTS_ADAPTERS.map((item) => ({
    label: label(item.id),
    value: item.id,
    brand: ttsAdapterBrand(item.id),
  })),
)
const connectionOptions = computed(() =>
  config.value.connections.map((item) => {
    const associatedModel = config.value.models.find((model) => model.connectionId === item.id)
    const associatedProfile = config.value.profiles.find(
      (profile) => profile.id === associatedModel?.profileId,
    )
    return {
      label: item.name,
      value: item.id,
      brand: resolveProviderBrand(associatedProfile?.adapter, item.apiBase),
    }
  }),
)
const presetOptions = computed(() => {
  const defaultPreset = config.value.presets.find(
    (item) => item.id === config.value.defaultPresetId,
  )
  return [
    {
      label: t('ui.tts', '跟随全局默认'),
      value: '',
      brand: defaultPreset ? ttsPresetBrand(config.value, defaultPreset) : undefined,
    },
    ...config.value.presets.map((item) => ({
      label: item.name,
      value: item.id,
      brand: ttsPresetBrand(config.value, item),
    })),
  ]
})
const binding = computed({
  get: () => config.value.bindings[ctx.activeAgentId.value] ?? '',
  set: (value: string | number) => {
    if (value) config.value.bindings[ctx.activeAgentId.value] = String(value)
    else delete config.value.bindings[ctx.activeAgentId.value]
  },
})
const supportsInstructions = computed(
  () =>
    adapter.value?.instructions &&
    !(profile.value?.adapter === 'openai' && /^tts-1(?:-hd)?$/.test(model.value?.modelId ?? '')),
)
const supportsReference = computed(
  () =>
    profile.value?.adapter === 'custom' ||
    (profile.value?.adapter === 'mimo' && model.value?.modelId.endsWith('-voiceclone')),
)
const formatOptions = computed(() =>
  (adapter.value?.formats ?? []).map((value) => ({ value, label: value.toUpperCase() })),
)
const dirty = computed(
  () =>
    JSON.stringify(config.value) !== saved.value ||
    customText.value !== JSON.stringify(profile.value?.custom ?? {}, null, 2) ||
    extraText.value !== JSON.stringify(preset.value?.extra ?? {}, null, 2) ||
    headersText.value !== JSON.stringify(connection.value?.headers ?? {}, null, 2),
)
function label(id: string) {
  return (
    (
      {
        edge_tts: 'Edge TTS',
        openai: 'OpenAI',
        mimo: 'MiMo V2.5',
        bailian: t('ui.tts', '阿里百炼'),
        minimax: 'MiniMax',
        stepfun: t('ui.tts', '阶跃星辰'),
        custom: t('ui.tts', '自定义 HTTP'),
      } as Record<string, string>
    )[id] ?? id
  )
}
function showError(cause: unknown) {
  error.value = cause instanceof Error ? cause.message : t('ui.tts', '操作失败，请重试')
}
function editors() {
  customText.value = JSON.stringify(profile.value?.custom ?? {}, null, 2)
  extraText.value = JSON.stringify(preset.value?.extra ?? {}, null, 2)
  headersText.value = JSON.stringify(connection.value?.headers ?? {}, null, 2)
}
function commitEditors() {
  if (profile.value?.adapter === 'custom') profile.value.custom = JSON.parse(customText.value)
  if (preset.value) preset.value.extra = JSON.parse(extraText.value)
  if (connection.value) connection.value.headers = JSON.parse(headersText.value)
}
function select(id: string) {
  if (busy.value || id === selected.value) return
  try {
    commitEditors()
    activate(id)
  } catch {
    error.value = t('ui.tts', 'JSON 格式无效，请检查高级字段')
  }
}
function activate(id: string) {
  stop()
  selected.value = id
  if (profile.value) {
    adding.value = profile.value.adapter
    lastPresetByAdapter.set(profile.value.adapter, id)
  }
  editors()
  error.value = ''
}
/** 服务选择就是导航；首次进入该服务时只创建本地草稿，保存后才持久化。 */
function chooseAdapter(value: string | number) {
  if (busy.value || value === adding.value) return
  const target = TTS_ADAPTERS.find((item) => item.id === value)?.id
  if (!target) return
  try {
    commitEditors()
  } catch {
    error.value = t('ui.tts', 'JSON 格式无效，请检查高级字段')
    return
  }
  adding.value = target
  const remembered = lastPresetByAdapter.get(target)
  const existing =
    visiblePresets.value.find((item) => item.id === remembered) ?? visiblePresets.value[0]
  if (existing) activate(existing.id)
  else add()
}
function changeConnection(id: string | number) {
  try {
    if (connection.value) connection.value.headers = JSON.parse(headersText.value)
    if (model.value) model.value.connectionId = String(id)
  } catch {
    error.value = t('ui.tts', 'JSON 格式无效，请检查高级字段')
  }
}
const defaultCustom: TtsHttpProfile = {
  path: '/audio/speech',
  method: 'POST',
  bodyType: 'json',
  body: {
    model: '{{model}}',
    input: '{{text}}',
    voice: '{{voice}}',
    response_format: '{{format}}',
  },
  response: { mode: 'binary', format: 'mp3' },
}
function add() {
  if (busy.value) return
  try {
    commitEditors()
  } catch {
    error.value = t('ui.tts', 'JSON 格式无效，请检查高级字段')
    return
  }
  const id = crypto.randomUUID()
  const description = TTS_ADAPTERS.find((item) => item.id === adding.value)!
  config.value.connections.push({
    id,
    name: label(description.id),
    apiBase: description.apiBase,
    apiKey: '',
    headers: {},
    timeoutMs: 60000,
  })
  config.value.profiles.push({
    id,
    adapter: description.id,
    ...(description.id === 'custom' ? { custom: structuredClone(defaultCustom) } : {}),
  })
  config.value.models.push({
    id,
    connectionId: id,
    profileId: id,
    modelId: description.models[0] ?? (description.id === 'custom' ? 'custom' : ''),
  })
  config.value.presets.push({
    ...createTtsPreset(id, id, description.id),
    name: label(description.id),
  })
  activate(id)
}
function remove() {
  if (!preset.value || config.value.presets.length < 2) return
  const id = preset.value.id
  config.value.presets = config.value.presets.filter((item) => item.id !== id)
  if (config.value.defaultPresetId === id)
    config.value.defaultPresetId = config.value.presets[0]!.id
  for (const [agent, value] of Object.entries(config.value.bindings))
    if (value === id) delete config.value.bindings[agent]
  activate(visiblePresets.value[0]?.id ?? config.value.defaultPresetId)
}
async function load() {
  loading.value = true
  error.value = ''
  try {
    const response = await voiceApi.getTtsConfig()
    if (!response.data) throw new Error(t('ui.tts', '读取语音配置失败'))
    config.value = response.data
    saved.value = JSON.stringify(response.data)
    activate(
      response.data.presets.some((item) => item.id === selected.value)
        ? selected.value
        : response.data.defaultPresetId,
    )
    loaded.value = true
  } catch (cause) {
    showError(cause)
  } finally {
    loading.value = false
  }
}
async function save(): Promise<boolean> {
  busy.value = true
  error.value = ''
  try {
    try {
      commitEditors()
    } catch {
      throw new Error(t('ui.tts', 'JSON 格式无效，请检查高级字段'))
    }
    const response = await voiceApi.saveTtsConfig(config.value)
    if (!response.data) throw new Error(t('ui.tts', '操作失败，请重试'))
    config.value = response.data
    saved.value = JSON.stringify(response.data)
    editors()
    return true
  } catch (cause) {
    showError(cause)
    return false
  } finally {
    busy.value = false
  }
}
function stop() {
  controller?.abort()
  controller = undefined
  void player?.close()
  player = undefined
  playing.value = false
}
async function preview() {
  if (playing.value) {
    stop()
    return
  }
  if (!(await save())) return
  if (disposed) return
  playing.value = true
  controller = new AbortController()
  const signal = controller.signal
  try {
    const bytes = await voiceApi.synthesize(
      { text: testText.value || t('ui.tts', '你好，很高兴与你见面。'), presetId: selected.value },
      signal,
    )
    if (signal.aborted) return
    player = new AudioContext()
    const decoded = await player.decodeAudioData(bytes)
    if (signal.aborted) return
    const source = player.createBufferSource()
    source.buffer = decoded
    source.connect(player.destination)
    source.onended = () => {
      if (controller?.signal === signal) stop()
    }
    source.start()
  } catch (cause) {
    if (!signal.aborted) showError(cause)
    if (controller?.signal === signal) stop()
  }
}
async function reference(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || !preset.value) return
  const target = preset.value
  busy.value = true
  error.value = ''
  try {
    target.referenceAssetId = (await voiceApi.uploadTtsReference(file)).assetId
  } catch (cause) {
    showError(cause)
  } finally {
    busy.value = false
  }
}
watch(
  () => ctx.refreshKey.value,
  () => {
    if (!dirty.value && !busy.value) void load()
  },
)
watch(
  () => model.value?.connectionId,
  () => {
    headersText.value = JSON.stringify(connection.value?.headers ?? {}, null, 2)
  },
)
onMounted(load)
onUnmounted(() => {
  disposed = true
  stop()
})
</script>

<template>
  <PCard pixel padding="lg" overflow-visible>
    <div class="tts-heading">
      <div>
        <h3>
          <PixelIcon name="mic" size="sm" />
          {{ t('ui.tts', '语音合成') }}
        </h3>
        <p>{{ t('ui.tts', '声音预设与角色绑定') }}</p>
      </div>
      <div class="tts-actions">
        <PSwitch v-model="config.enabled" :disabled="loading || busy || !loaded" />
        <PButton :disabled="loading || busy || !loaded || !dirty" @click="save">
          {{ t('ui.tts', '保存配置') }}
        </PButton>
      </div>
    </div>
    <p v-if="error" class="tts-error" role="alert">{{ error }}</p>
    <p v-if="loading">{{ t('ui.tts', '正在读取配置…') }}</p>
    <PButton v-else-if="!loaded" variant="ghost" @click="load">{{ t('ui.tts', '重试') }}</PButton>
    <fieldset v-else :disabled="busy" class="tts-workspace">
      <aside class="tts-sidebar">
        <label>
          {{ t('ui.tts', '语音服务') }}
          <BrandSelect
            :model-value="adding"
            :options="adapterOptions"
            :disabled="busy"
            fallback="provider"
            @update:model-value="chooseAdapter"
          />
        </label>
        <div class="tts-list">
          <button
            v-for="item in visiblePresets"
            :key="item.id"
            type="button"
            :class="{ active: item.id === selected }"
            :aria-pressed="item.id === selected"
            @click="select(item.id)"
          >
            <BrandIcon :brand="ttsPresetBrand(config, item)" size="sm" framed fallback="provider" />
            <span class="tts-preset-copy">
              <span>{{ item.name }}</span>
              <small>
                {{
                  item.id === config.defaultPresetId
                    ? t('ui.tts', '全局默认')
                    : t('ui.tts', '声音预设')
                }}
              </small>
            </span>
          </button>
        </div>
        <PButton variant="ghost" @click="add">
          <PixelIcon name="plus" size="xs" />
          {{ t('ui.tts', '添加预设') }}
        </PButton>
      </aside>
      <div
        v-if="preset && model && profile && connection && adapter"
        :key="selected"
        class="tts-editor"
      >
        <div class="tts-subheading">
          <strong class="tts-brand-title">
            <BrandIcon
              :brand="ttsAdapterBrand(profile.adapter)"
              size="md"
              framed
              fallback="provider"
            />
            {{ label(profile.adapter) }}
          </strong>
          <div class="tts-actions">
            <PButton
              variant="ghost"
              :disabled="preset.id === config.defaultPresetId"
              @click="config.defaultPresetId = preset.id"
            >
              {{ t('ui.tts', '设为默认') }}
            </PButton>
            <PButton variant="ghost" :disabled="config.presets.length < 2" @click="remove">
              {{ t('ui.tts', '删除预设') }}
            </PButton>
          </div>
        </div>
        <div class="tts-grid">
          <label>
            {{ t('ui.tts', '预设名称') }}
            <PInput v-model="preset.name" />
          </label>
          <label>
            {{ t('ui.tts', '服务连接') }}
            <BrandSelect
              :model-value="model.connectionId"
              :options="connectionOptions"
              fallback="provider"
              @update:model-value="changeConnection"
            />
          </label>
        </div>
        <details v-if="profile.adapter !== 'edge_tts'" class="tts-details" open>
          <summary>{{ t('ui.tts', '连接与模型') }}</summary>
          <div class="tts-grid">
            <label>
              {{ t('ui.tts', '连接名称') }}
              <PInput v-model="connection.name" />
            </label>
            <label>
              API Base
              <PInput v-model="connection.apiBase" :placeholder="adapter.apiBase" />
            </label>
            <label>
              API Key
              <PInput v-model="connection.apiKey" type="password" />
            </label>
            <label>
              {{ t('ui.tts', '超时（毫秒）') }}
              <input v-model.number="connection.timeoutMs" type="number" min="1000" max="300000" />
            </label>
            <label class="tts-wide">
              {{ t('ui.tts', '模型 ID') }}
              <span class="tts-model-field">
                <BrandIcon :brand="ttsPresetBrand(config, preset)" size="sm" />
                <input v-model="model.modelId" :list="`tts-models-${selected}`" />
              </span>
              <datalist :id="`tts-models-${selected}`">
                <option v-for="id in adapter.models" :key="id" :value="id" />
              </datalist>
            </label>
          </div>
        </details>
        <div class="tts-grid">
          <label
            v-if="!model.modelId.endsWith('-voicedesign') && !model.modelId.endsWith('-voiceclone')"
          >
            {{ t('ui.tts', '音色 ID') }}
            <PInput v-model="preset.voice" :placeholder="adapter.voice" />
          </label>
          <label>
            {{ t('ui.tts', '音频格式') }}
            <PSelect v-model="preset.format" :options="formatOptions" />
          </label>
          <template v-if="profile.adapter === 'edge_tts'">
            <label>
              {{ t('ui.tts', '语速') }}
              <PInput v-model="preset.rate" placeholder="+25%" />
            </label>
            <label>
              {{ t('ui.tts', '音调') }}
              <PInput v-model="preset.pitch" placeholder="+5Hz" />
            </label>
          </template>
          <label v-else-if="['openai', 'stepfun', 'minimax', 'custom'].includes(profile.adapter)">
            {{ t('ui.tts', '语速倍率') }}
            <input v-model.number="preset.speed" type="number" min="0.25" max="4" step="0.05" />
          </label>
          <label v-if="['bailian', 'stepfun', 'custom'].includes(profile.adapter)">
            {{ t('ui.tts', '语言') }}
            <PInput v-model="preset.language" />
          </label>
          <label v-if="adapter.emotion">
            {{ t('ui.tts', '情感标识') }}
            <PInput
              v-model="preset.emotion"
              :placeholder="profile.adapter === 'minimax' ? 'happy / sad / angry' : ''"
            />
          </label>
          <label v-if="supportsInstructions" class="tts-wide">
            {{
              model.modelId.endsWith('-voicedesign')
                ? t('ui.tts', '音色描述')
                : t('ui.tts', '演绎指导')
            }}
            <textarea v-model="preset.instructions" rows="3" />
          </label>
        </div>
        <div v-if="supportsReference" class="tts-reference">
          <div class="tts-subheading">
            <strong>{{ t('ui.tts', '参考音频') }}</strong>
            <span v-if="preset.referenceAssetId" class="tts-status">
              {{ t('ui.tts', '已上传') }}
            </span>
          </div>
          <div class="tts-actions">
            <PButton variant="ghost" @click="upload?.click()">
              {{ t('ui.tts', '上传 WAV / MP3') }}
            </PButton>
            <PButton
              v-if="preset.referenceAssetId"
              variant="ghost"
              @click="delete preset.referenceAssetId"
            >
              {{ t('ui.tts', '移除引用') }}
            </PButton>
          </div>
          <input
            ref="upload"
            type="file"
            accept="audio/wav,audio/mpeg,.wav,.mp3"
            hidden
            @change="reference"
          />
          <label v-if="profile.adapter === 'custom'">
            {{ t('ui.tts', '参考音频转写') }}
            <textarea v-model="preset.referenceText" rows="2" />
          </label>
        </div>
        <details class="tts-details">
          <summary>{{ t('ui.tts', '高级字段') }}</summary>
          <label>
            {{ t('ui.tts', '连接 Headers（JSON）') }}
            <textarea v-model="headersText" rows="3" spellcheck="false" class="tts-code" />
          </label>
          <label v-if="profile.adapter !== 'edge_tts'">
            {{ t('ui.tts', '扩展请求字段（JSON）') }}
            <textarea v-model="extraText" rows="4" spellcheck="false" class="tts-code" />
          </label>
          <template v-if="profile.adapter === 'custom'">
            <p>{{ t('ui.tts', '自定义请求、返回路径与解码方式') }}</p>
            <textarea
              v-model="customText"
              rows="18"
              spellcheck="false"
              class="tts-code"
              :aria-label="t('ui.tts', '自定义协议配置')"
            />
            <p v-pre class="tts-variables">
              {{ text }} · {{ model }} · {{ voice }} · {{ apiKey }} · {{ speed }} · {{ format }} ·
              {{ language }} · {{ instructions }} · {{ emotion }} · {{ referenceAudio }} ·
              {{ referenceText }} · {{ extra }}
            </p>
          </template>
        </details>
        <div class="tts-preview">
          <PInput v-model="testText" :placeholder="t('ui.tts', '输入试听文本')" />
          <PButton :loading="busy" :disabled="!config.enabled" @click="preview">
            {{ playing ? t('ui.tts', '停止试听') : t('ui.tts', '保存并试听') }}
          </PButton>
        </div>
      </div>
    </fieldset>
    <div v-if="loaded && ctx.activeAgentId.value" class="tts-binding">
      <label>
        {{ t('ui.tts', '当前角色的声音') }}
        <BrandSelect
          v-model="binding"
          :options="presetOptions"
          :disabled="busy"
          fallback="provider"
        />
      </label>
    </div>
  </PCard>
</template>

<style scoped>
.tts-heading,
.tts-subheading,
.tts-actions,
.tts-preview {
  display: flex;
  align-items: center;
  gap: 12px;
  justify-content: space-between;
}
.tts-heading {
  padding-bottom: 18px;
  border-bottom: 1px solid var(--dash-panel-border);
}
h3 {
  display: flex;
  align-items: center;
  gap: 10px;
  font-family: var(--ui-font-pixel);
  font-size: 17px;
  color: var(--ui-text-primary);
}
p,
small {
  font-size: 12px;
  color: var(--ui-text-tertiary);
}
.tts-workspace {
  display: grid;
  grid-template-columns: 190px minmax(0, 1fr);
  gap: 24px;
  border: 0;
  padding: 20px 0 0;
  margin: 0;
  min-width: 0;
}
.tts-sidebar {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
.tts-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 400px;
  overflow: auto;
}
.tts-list button {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px;
  text-align: left;
  border: 1px solid var(--dash-panel-border);
  background: var(--dash-panel-soft);
  color: var(--ui-text-primary);
  border-radius: 0;
  box-shadow: 2px 2px 0 var(--dash-panel-border);
}
.tts-list button.active {
  border-left: 3px solid var(--ui-accent-sky);
  background: var(--dash-panel-bg);
  color: var(--ui-accent-sky);
}
.tts-preset-copy {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.tts-preset-copy > span,
.tts-preset-copy > small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tts-brand-title {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.tts-model-field {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.tts-model-field input {
  flex: 1;
}
.tts-editor {
  display: flex;
  flex-direction: column;
  gap: 18px;
  min-width: 0;
  border-left: 1px solid var(--dash-panel-border);
  padding-left: 24px;
}
.tts-subheading strong {
  font-family: var(--ui-font-pixel);
  color: var(--ui-text-primary);
}
.tts-actions {
  justify-content: flex-start;
  flex-wrap: wrap;
}
.tts-heading .tts-actions {
  justify-content: flex-end;
}
.tts-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}
.tts-wide {
  grid-column: 1/-1;
}
label {
  display: flex;
  flex-direction: column;
  gap: 7px;
  font-size: 12px;
  color: var(--ui-text-secondary);
  min-width: 0;
}
textarea,
input:not([hidden]) {
  width: 100%;
  min-width: 0;
  border: 2px solid var(--dash-input-border);
  border-radius: 0;
  background: var(--dash-input-bg);
  color: var(--ui-text-primary);
  padding: 8px 10px;
  font-family: var(--ui-font-pixel);
}
textarea {
  resize: vertical;
}
textarea:focus,
input:focus {
  outline: 1px solid var(--ui-accent-sky);
  border-color: var(--ui-accent-sky);
}
.tts-code {
  font-family: var(--ui-font-mono, monospace);
  font-size: 12px;
}
.tts-details {
  border: 1px solid var(--dash-panel-border);
  padding: 12px;
  background: var(--dash-panel-soft);
}
.tts-details summary {
  font-family: var(--ui-font-pixel);
  font-size: 13px;
  cursor: pointer;
  color: var(--ui-text-primary);
}
.tts-details[open] summary {
  margin-bottom: 14px;
}
.tts-details label + label {
  margin-top: 12px;
}
.tts-reference {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  border: 1px solid var(--dash-panel-border);
  background: var(--dash-panel-soft);
}
.tts-status {
  color: var(--ui-accent-sky);
  font-size: 12px;
}
.tts-error {
  color: var(--ui-color-danger, #fb7185);
  padding: 12px;
  border-left: 2px solid currentColor;
  overflow-wrap: anywhere;
}
.tts-preview {
  padding-top: 14px;
  border-top: 1px solid var(--dash-panel-border);
}
.tts-preview > :first-child {
  flex: 1;
}
.tts-preview > :last-child {
  flex-shrink: 0;
}
.tts-binding {
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid var(--dash-panel-border);
  max-width: 440px;
}
.tts-variables {
  line-height: 1.8;
  overflow-wrap: anywhere;
}
@media (max-width: 850px) {
  .tts-workspace {
    grid-template-columns: 1fr;
  }
  .tts-list {
    flex-direction: row;
    max-height: none;
  }
  .tts-list button {
    flex-shrink: 0;
  }
  .tts-editor {
    border-left: 0;
    padding-left: 0;
  }
  .tts-grid {
    grid-template-columns: 1fr;
  }
  .tts-heading {
    align-items: flex-start;
  }
  .tts-heading .tts-actions {
    flex-direction: column;
  }
}
</style>
