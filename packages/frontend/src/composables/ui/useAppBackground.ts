import { t as __t } from '../../i18n/index'
/** 应用背景预设统一管理图片与材质参数，预览和整窗共享同一状态。 */
import { computed, ref } from 'vue'
import { configApi } from '../../api/modules/configApi'
import {
  systemApi,
  type AppBackgroundPresetId,
  type AppBackgroundSettings,
} from '../../api/modules/systemApi'

export const DEFAULT_APP_BACKGROUND: AppBackgroundSettings = {
  enabled: false,
  opacity: 0.95,
  blur: 0,
  brightness: 1,
  saturation: 1,
  contrast: 1,
  overlayOpacity: 0.18,
  surfaceOpacity: 0.8,
  surfaceBlur: 14,
  positionX: 50,
  positionY: 50,
  fit: 'cover',
}

export const APP_BACKGROUND_PRESETS = [
  {
    id: 'clear',
    get label() {
      return __t('ui.ui', '通透')
    },
    opacity: 0.95,
    blur: 0,
    overlayOpacity: 0.08,
    surfaceOpacity: 0.68,
    surfaceBlur: 12,
  },
  {
    id: 'balanced',
    get label() {
      return __t('ui.ui', '均衡')
    },
    opacity: 0.95,
    blur: 0,
    overlayOpacity: 0.18,
    surfaceOpacity: 0.8,
    surfaceBlur: 14,
  },
  {
    id: 'focus',
    get label() {
      return __t('ui.ui', '专注')
    },
    opacity: 0.75,
    blur: 5,
    overlayOpacity: 0.38,
    surfaceOpacity: 0.94,
    surfaceBlur: 12,
  },
] as const

export const USER_APP_BACKGROUND_PRESETS = [
  {
    id: 'preset-1',
    get label() {
      return __t('ui.ui', '预设 1')
    },
  },
  {
    id: 'preset-2',
    get label() {
      return __t('ui.ui', '预设 2')
    },
  },
  {
    id: 'preset-3',
    get label() {
      return __t('ui.ui', '预设 3')
    },
  },
] as const
type BackgroundSelection = AppBackgroundPresetId | 'default'
interface SavedBackgroundPreset {
  settings: AppBackgroundSettings
  hasImage: boolean
}
const emptyPreset = (): SavedBackgroundPreset => ({
  settings: { ...DEFAULT_APP_BACKGROUND },
  hasImage: false,
})
const savedPresets = ref<Record<AppBackgroundPresetId, SavedBackgroundPreset>>({
  'preset-1': emptyPreset(),
  'preset-2': emptyPreset(),
  'preset-3': emptyPreset(),
})
const selectedPreset = ref<BackgroundSelection>('default')
const settings = ref<AppBackgroundSettings>({ ...DEFAULT_APP_BACKGROUND })
const hasImage = computed(() =>
  selectedPreset.value === 'default' ? false : savedPresets.value[selectedPreset.value].hasImage,
)
const imageVersion = ref(Date.now())
const loaded = ref(false)
const busy = ref(false)
let loading: Promise<void> | null = null
let mutationQueue: Promise<void> = Promise.resolve()
let mutationCount = 0
const selectionKey = 'ui.chatBackground.activePreset'
const presetKey = (id: AppBackgroundPresetId, field: 'settings' | 'mime'): string =>
  id === 'preset-1' ? `ui.chatBackground.${field}` : `ui.chatBackground.${id}.${field}`

/** 保存、切换与上传串行处理，防止较慢的旧请求覆盖新的预设选择。 */
function mutate(operation: () => Promise<void>): Promise<void> {
  mutationCount++
  busy.value = true
  const current = mutationQueue.then(operation)
  mutationQueue = current.catch(() => undefined)
  return current.finally(() => {
    mutationCount--
    busy.value = mutationCount > 0
  })
}

function normalize(raw: unknown): AppBackgroundSettings {
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const number = (key: keyof AppBackgroundSettings, min: number, max: number): number => {
    const candidate = value[key]
    return typeof candidate === 'number' && Number.isFinite(candidate)
      ? Math.min(max, Math.max(min, candidate))
      : (DEFAULT_APP_BACKGROUND[key] as number)
  }
  return {
    enabled: value.enabled === true,
    opacity: number('opacity', 0, 1),
    blur: number('blur', 0, 32),
    brightness: number('brightness', 0.6, 1.4),
    saturation: number('saturation', 0, 1.6),
    contrast: number('contrast', 0.6, 1.4),
    overlayOpacity: number('overlayOpacity', 0, 0.85),
    surfaceOpacity: number('surfaceOpacity', 0.55, 1),
    surfaceBlur: number('surfaceBlur', 0, 24),
    positionX: number('positionX', 0, 100),
    positionY: number('positionY', 0, 100),
    fit: value.fit === 'contain' ? 'contain' : 'cover',
  }
}

export function useAppBackground() {
  const imageUrl = computed(() =>
    hasImage.value && selectedPreset.value !== 'default'
      ? systemApi.appBackgroundContentUrl(imageVersion.value, selectedPreset.value)
      : '',
  )
  const presets = computed(() =>
    USER_APP_BACKGROUND_PRESETS.map((preset) => ({
      ...preset,
      hasImage: savedPresets.value[preset.id].hasImage,
    })),
  )
  const style = computed(() => {
    const value = normalize(settings.value)
    const readingOpacity = Math.max(0.9, value.surfaceOpacity)
    return {
      '--app-image-opacity': String(value.opacity),
      '--app-image-blur': `${value.blur}px`,
      '--app-image-brightness': String(value.brightness),
      '--app-image-saturation': String(value.saturation),
      '--app-image-contrast': String(value.contrast),
      '--app-image-overlay': String(value.overlayOpacity),
      '--app-image-position': `${value.positionX}% ${value.positionY}%`,
      '--app-image-fit': value.fit,
      '--app-shell-opacity': String(Math.max(0.5, value.surfaceOpacity - 0.15)),
      '--app-panel-opacity': String(value.surfaceOpacity),
      '--app-reading-opacity': String(readingOpacity),
      // 工作区已有整块面板底色，正文只补足可读度，避免多层不透明度叠加。
      '--app-inset-reading-opacity': String(
        Math.max(
          0.12,
          (readingOpacity - value.surfaceOpacity) / Math.max(0.01, 1 - value.surfaceOpacity),
        ),
      ),
      '--app-material-blur': `${value.surfaceBlur}px`,
    }
  })
  const activePreset = computed(
    () =>
      APP_BACKGROUND_PRESETS.find(
        (preset) =>
          (['opacity', 'blur', 'overlayOpacity', 'surfaceOpacity', 'surfaceBlur'] as const).every(
            (key) => Math.abs(settings.value[key] - preset[key]) < 0.001,
          ) &&
          settings.value.brightness === 1 &&
          settings.value.saturation === 1 &&
          settings.value.contrast === 1,
      )?.id,
  )

  function applyPreset(id: string): void {
    const preset = APP_BACKGROUND_PRESETS.find((item) => item.id === id)
    if (!preset) return
    const { id: _id, label: _label, ...values } = preset
    Object.assign(settings.value, values, { brightness: 1, saturation: 1, contrast: 1 })
  }

  async function load(): Promise<void> {
    if (loaded.value) return
    if (loading) return loading
    // 预设一沿用旧配置键和图片；重复打开设置页不覆盖实时调整。
    loading = (async () => {
      const response = await configApi.batch([
        selectionKey,
        ...USER_APP_BACKGROUND_PRESETS.flatMap(({ id }) => [
          presetKey(id, 'settings'),
          presetKey(id, 'mime'),
        ]),
      ])
      const values = response.data ?? {}
      for (const { id } of USER_APP_BACKGROUND_PRESETS) {
        const raw = values[presetKey(id, 'settings')]
        let parsed: unknown = {}
        try {
          parsed = typeof raw === 'string' && raw ? JSON.parse(raw) : {}
        } catch {
          // 无效参数只重置对应预设，不影响其他预设和图片。
        }
        savedPresets.value[id] = {
          settings: normalize(parsed),
          hasImage: !!values[presetKey(id, 'mime')],
        }
      }
      const previous = values[selectionKey]
      selectedPreset.value =
        previous === 'default'
          ? 'default'
          : (USER_APP_BACKGROUND_PRESETS.find(({ id }) => id === previous)?.id ??
            (savedPresets.value['preset-1'].hasImage ? 'preset-1' : 'default'))
      settings.value =
        selectedPreset.value === 'default'
          ? { ...DEFAULT_APP_BACKGROUND }
          : { ...savedPresets.value[selectedPreset.value].settings }
      loaded.value = true
    })()
    try {
      await loading
    } finally {
      loading = null
    }
  }

  async function persistSettings(): Promise<void> {
    const id = selectedPreset.value
    if (id === 'default') return
    const snapshot = normalize(settings.value)
    await configApi.set(presetKey(id, 'settings'), JSON.stringify(snapshot))
    savedPresets.value[id].settings = snapshot
  }

  function save(): Promise<void> {
    return mutate(async () => {
      await load()
      await persistSettings()
      await configApi.set(selectionKey, selectedPreset.value)
    })
  }

  /** 整页保存固定点击当时的背景参数，排队期间不读取后续草稿。 */
  function captureSave(): () => Promise<void> {
    const id = selectedPreset.value
    const snapshot = normalize(settings.value)
    return () =>
      mutate(async () => {
        if (id !== 'default') {
          await configApi.set(presetKey(id, 'settings'), JSON.stringify(snapshot))
          savedPresets.value[id].settings = snapshot
        }
        await configApi.set(selectionKey, id)
      })
  }

  function selectPreset(id: string): Promise<void> {
    return mutate(async () => {
      await load()
      if (id !== 'default' && !USER_APP_BACKGROUND_PRESETS.some((preset) => preset.id === id)) {
        throw new Error('背景预设不存在')
      }
      const selection = id as BackgroundSelection
      if (selection === selectedPreset.value) return
      await persistSettings()
      await configApi.set(selectionKey, selection)
      selectedPreset.value = selection
      settings.value =
        selection === 'default'
          ? { ...DEFAULT_APP_BACKGROUND }
          : { ...savedPresets.value[selection].settings }
    })
  }

  function upload(blob: Blob): Promise<void> {
    return mutate(async () => {
      await load()
      const id = selectedPreset.value
      if (id === 'default') throw new Error('请先选择自定义预设再上传图片')
      await systemApi.uploadAppBackground(blob, id)
      savedPresets.value[id].hasImage = true
      settings.value.enabled = true
      imageVersion.value = Math.max(Date.now(), imageVersion.value + 1)
      await persistSettings()
      await configApi.set(selectionKey, id)
    })
  }

  function remove(): Promise<void> {
    return mutate(async () => {
      await load()
      const id = selectedPreset.value
      if (id === 'default') return
      await systemApi.deleteAppBackground(id)
      savedPresets.value[id].hasImage = false
      settings.value.enabled = false
      imageVersion.value = Math.max(Date.now(), imageVersion.value + 1)
      await persistSettings()
      await configApi.set(selectionKey, id)
    })
  }

  return {
    settings,
    presets,
    selectedPreset,
    selectPreset,
    busy,
    hasImage,
    imageUrl,
    loaded,
    style,
    activePreset,
    applyPreset,
    load,
    save,
    captureSave,
    upload,
    remove,
  }
}
