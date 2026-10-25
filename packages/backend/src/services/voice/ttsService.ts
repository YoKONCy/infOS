import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import {
  createTtsWorkspace,
  createTtsPreset,
  TTS_ADAPTERS,
  type TtsWorkspace,
  type TtsSynthesisInput,
  type TtsAdapterId,
  type TtsAudioFormat,
  type KernelAssetId,
} from '@infos/shared'
import type { ConfigRepository } from '../../repositories/config.repo'
import type { AssetFileAuthority } from '../../kernel/assetFileAuthority'
import type { KernelAssetRepository } from '../../kernel/kernelAssetRepository'
import { AppError } from '../../lib/appError'
import { t } from '../../lib/i18n'
import { createLogger } from '../../lib/logger'
import { parseTtsWorkspace } from './ttsSchema'
import { createTtsAdapterRegistry, type TtsAdapterRegistry } from './ttsAdapters'
import { ttsConfigFailure } from './ttsHttp'
import { prepareTtsText } from './spokenReply'

export const TTS_WORKSPACE_KEY = 'tts.workspace.v1'
export type TtsProvider = TtsAdapterId | 'azure' | 'local'
export interface TtsRequest extends TtsSynthesisInput {
  provider?: TtsProvider
  signal?: AbortSignal
  cute?: boolean
}
export interface TtsResult {
  audio: ArrayBuffer
  mimeType: string
  durationSec?: number
  presetId?: string
}
/** 旧配置入口保留兼容；新配置通过工作区合同一次保存。 */
export interface TtsConfig {
  provider: TtsProvider
  apiBase: string
  apiKey: string
  voice: string
  rate: string
  pitch: string
  speed: number
  format: TtsAudioFormat
}
type ConfigStore = Pick<ConfigRepository, 'get' | 'set'>
interface ReferenceStore {
  root: string
  authority: AssetFileAuthority
  repository: KernelAssetRepository
}

/** 唯一语音调度入口：绑定解析 → 配置快照 → 有界队列 → 适配器 → 可播放音频。 */
export class TtsService {
  private workspace = createTtsWorkspace()
  private legacyConfig: Partial<TtsConfig> = {}
  private store?: ConfigStore
  private references?: ReferenceStore
  private active = 0
  private waiting: Array<() => void> = []
  private listeners = new Set<() => void>()
  private mutations: Promise<unknown> = Promise.resolve()
  private logger = createLogger('TtsService')

  constructor(
    config?: Partial<TtsConfig>,
    private registry: TtsAdapterRegistry = createTtsAdapterRegistry(),
  ) {
    if (config) this.updateConfig(config)
  }

  get isAvailable(): boolean {
    return this.availableFor()
  }
  get hasAvailablePreset(): boolean {
    return this.workspace.presets.some((item) => this.availableFor(undefined, item.id))
  }
  get isRemote(): boolean {
    const preset = this.workspace.presets.find((item) => item.id === this.workspace.defaultPresetId)
    const model = this.workspace.models.find((item) => item.id === preset?.modelId)
    const profile = this.workspace.profiles.find((item) => item.id === model?.profileId)
    if (profile?.adapter === 'edge_tts') return true
    const base = this.workspace.connections.find((item) => item.id === model?.connectionId)?.apiBase
    try {
      return !['localhost', '127.0.0.1', '[::1]'].includes(new URL(base ?? '').hostname)
    } catch {
      return true
    }
  }
  get isMetered(): boolean {
    const preset = this.workspace.presets.find((item) => item.id === this.workspace.defaultPresetId)
    const model = this.workspace.models.find((item) => item.id === preset?.modelId)
    return (
      this.workspace.profiles.find((item) => item.id === model?.profileId)?.adapter !== 'edge_tts'
    )
  }
  availableFor(agentId?: string, presetId?: string): boolean {
    if (!this.workspace.enabled) return false
    const preset = this.workspace.presets.find(
      (item) =>
        item.id ===
        (presetId ??
          ((agentId && this.workspace.bindings[agentId]) || this.workspace.defaultPresetId)),
    )
    const model = this.workspace.models.find((item) => item.id === preset?.modelId)
    const profile = this.workspace.profiles.find((item) => item.id === model?.profileId)
    const connection = this.workspace.connections.find((item) => item.id === model?.connectionId)
    return !!(
      preset &&
      model &&
      profile &&
      connection &&
      (profile.adapter === 'edge_tts' ||
        (connection.apiBase && (profile.adapter === 'custom' || connection.apiKey)))
    )
  }
  getWorkspace(): TtsWorkspace {
    return structuredClone(this.workspace)
  }
  onConfigChanged(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private apply(workspace: TtsWorkspace): void {
    this.workspace = structuredClone(workspace)
    for (const listener of this.listeners) listener()
  }
  configureReferences(store: ReferenceStore): void {
    this.references = store
  }

  async loadWorkspace(store: ConfigStore): Promise<void> {
    this.store = store
    const value = await store.get(TTS_WORKSPACE_KEY)
    if (value) {
      let parsed: unknown
      try {
        parsed = JSON.parse(value)
      } catch {
        throw ttsConfigFailure()
      }
      this.apply(parseTtsWorkspace(parsed))
    } else {
      this.apply({ ...this.workspace, enabled: (await store.get('tts.enabled')) !== 'false' })
    }
  }

  async saveWorkspace(input: unknown): Promise<TtsWorkspace> {
    const candidate = parseTtsWorkspace(input)
    const operation = this.mutations
      .catch(() => undefined)
      .then(async () => {
        if (!this.store) throw ttsConfigFailure()
        await this.store.set(TTS_WORKSPACE_KEY, JSON.stringify(candidate))
        this.apply(candidate)
        return this.getWorkspace()
      })
    this.mutations = operation
    return operation
  }

  updateConfig(config: Partial<TtsConfig>): void {
    this.legacyConfig = { ...this.legacyConfig, ...config }
    config = this.legacyConfig
    const adapter = config.provider ?? this.workspace.profiles[0]!.adapter
    const defaults = TTS_ADAPTERS.find((item) => item.id === adapter)
    if (!defaults) {
      this.apply({ ...this.workspace, enabled: false })
      return
    }
    const preset = createTtsPreset('legacy', 'legacy', defaults.id)
    if (config.voice !== undefined) preset.voice = config.voice
    if (config.speed !== undefined) preset.speed = config.speed
    if (config.rate !== undefined) preset.rate = config.rate
    if (config.pitch !== undefined) preset.pitch = config.pitch
    if (config.format !== undefined) preset.format = config.format
    // 首次迁移沿用旧 OpenAI 的模型和默认声音，避免无意改变现有发声。
    if (adapter === 'openai' && !config.voice) preset.voice = 'shimmer'
    this.apply({
      version: 1,
      enabled: true,
      connections: [
        {
          id: 'legacy',
          name: defaults.id,
          apiBase: config.apiBase || defaults.apiBase,
          apiKey: config.apiKey ?? '',
          headers: {},
          timeoutMs: 60000,
        },
      ],
      profiles: [{ id: 'legacy', adapter: defaults.id }],
      models: [
        {
          id: 'legacy',
          connectionId: 'legacy',
          profileId: 'legacy',
          modelId: adapter === 'openai' ? 'tts-1' : (defaults.models[0] ?? ''),
        },
      ],
      presets: [preset],
      defaultPresetId: 'legacy',
      bindings: {},
    })
  }

  async saveReference(file: File): Promise<{ assetId: string; name: string }> {
    if (!this.references) throw ttsConfigFailure()
    if (!file.size || file.size > 7 * 1024 * 1024)
      throw new AppError('PAYLOAD_TOO_LARGE', {
        message: t('server.tts', '参考音频应大于 0 且不超过 7MB'),
      })
    const bytes = Buffer.from(await file.arrayBuffer())
    const wav =
      bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WAVE'
    const mp3 =
      bytes.subarray(0, 3).toString() === 'ID3' ||
      (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)
    if (!wav && !mp3)
      throw new AppError('UNSUPPORTED_MEDIA_TYPE', {
        message: t('server.tts', '请选择 WAV 或 MP3 参考音频'),
      })
    await mkdir(this.references.root, { recursive: true })
    const target = path.join(this.references.root, `${randomUUID()}.${wav ? 'wav' : 'mp3'}`)
    try {
      await writeFile(target, bytes, { flag: 'wx' })
      const asset = this.references.authority.registerFile({
        ownerPrincipalId: 'system',
        filePath: target,
        kind: 'audio.tts.reference',
        mimeType: wav ? 'audio/wav' : 'audio/mpeg',
        source: 'user',
        retention: 'persistent',
      })
      await this.references.repository.save(asset, target)
      return { assetId: asset.assetId, name: file.name }
    } catch (error) {
      await unlink(target).catch(() => undefined)
      throw error
    }
  }

  private async reference(assetId: string) {
    if (!this.references) throw ttsConfigFailure()
    const record = await this.references.repository.find(assetId as KernelAssetId)
    if (
      !record ||
      record.asset.kind !== 'audio.tts.reference' ||
      record.asset.sizeBytes > 7 * 1024 * 1024
    )
      throw ttsConfigFailure()
    const relative = path.relative(this.references.root, record.storageRef)
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw ttsConfigFailure()
    const bytes = await readFile(record.storageRef)
    if (
      bytes.length !== record.asset.sizeBytes ||
      createHash('sha256').update(bytes).digest('hex') !== record.asset.sha256
    )
      throw ttsConfigFailure()
    return { bytes, mimeType: record.asset.mimeType }
  }

  private acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted()
    const release = () => {
      const next = this.waiting.shift()
      if (next) next()
      else --this.active
    }
    if (this.active < 2) {
      ++this.active
      return Promise.resolve(release)
    }
    if (this.waiting.length >= 16)
      throw new AppError('EXTERNAL_ERROR', { message: t('server.tts', '语音请求过多，请稍后重试') })
    return new Promise((resolve, reject) => {
      const begin = () => {
        signal.removeEventListener('abort', cancel)
        resolve(release)
      }
      const cancel = () => {
        this.waiting = this.waiting.filter((item) => item !== begin)
        reject(signal.reason)
      }
      this.waiting.push(begin)
      signal.addEventListener('abort', cancel, { once: true })
    })
  }

  async synthesize(request: TtsRequest): Promise<TtsResult> {
    const snapshot = this.getWorkspace()
    if (!snapshot.enabled)
      throw new AppError('CONFIG_ERROR', { message: t('server.tts', '语音合成已关闭') })
    const id =
      request.presetId ??
      (request.agentId ? snapshot.bindings[request.agentId] : undefined) ??
      snapshot.defaultPresetId
    const stored = snapshot.presets.find((item) => item.id === id)
    const model = snapshot.models.find((item) => item.id === stored?.modelId)
    const profile = snapshot.profiles.find((item) => item.id === model?.profileId)
    const connection = snapshot.connections.find((item) => item.id === model?.connectionId)
    if (
      !stored ||
      !model ||
      !profile ||
      !connection ||
      (request.provider && request.provider !== profile.adapter)
    )
      throw ttsConfigFailure()
    if (
      profile.adapter !== 'edge_tts' &&
      (!connection.apiBase || (profile.adapter !== 'custom' && !connection.apiKey))
    )
      throw ttsConfigFailure()
    const preset = {
      ...stored,
      ...(request.voice !== undefined ? { voice: request.voice } : {}),
      ...(typeof request.speed === 'number'
        ? { speed: request.speed }
        : typeof request.speed === 'string'
          ? { rate: request.speed }
          : {}),
      ...(request.pitch !== undefined ? { pitch: request.pitch } : {}),
      ...(request.format !== undefined ? { format: request.format } : {}),
      ...(request.instructions !== undefined ? { instructions: request.instructions } : {}),
      ...(request.emotion !== undefined ? { emotion: request.emotion } : {}),
    }
    if (
      !Number.isFinite(preset.speed) ||
      preset.speed < 0.25 ||
      preset.speed > 4 ||
      !TTS_ADAPTERS.find((item) => item.id === profile.adapter)?.formats.includes(preset.format)
    )
      throw ttsConfigFailure()
    const text = prepareTtsText(request.text)
    const limit =
      model.maxChars ??
      ({ stepfun: 1000, bailian: 600, openai: 4096 } as Record<string, number>)[profile.adapter] ??
      16000
    if (!text || [...text].length > limit)
      throw new AppError('VALIDATION_ERROR', {
        message: t('server.tts', '朗读文本为空或超过模型长度限制'),
      })
    const controller = new AbortController()
    const abort = () => controller.abort(request.signal?.reason)
    request.signal?.addEventListener('abort', abort, { once: true })
    if (request.signal?.aborted) abort()
    const timer = setTimeout(() => controller.abort(new Error('TTS_TIMEOUT')), connection.timeoutMs)
    let release: (() => void) | undefined
    try {
      release = await this.acquire(controller.signal)
      controller.signal.throwIfAborted()
      const reference = preset.referenceAssetId
        ? await this.reference(preset.referenceAssetId)
        : undefined
      controller.signal.throwIfAborted()
      const operation = this.registry.get(profile.adapter).synthesize({
        text,
        model,
        profile,
        connection,
        preset,
        reference,
        signal: controller.signal,
      })
      // Edge 建连等上游可能忽略信号；调度层仍保证调用方及时返回。
      const result = await new Promise<{ audio: ArrayBuffer; mimeType: string }>(
        (resolve, reject) => {
          const cancelled = () => reject(controller.signal.reason)
          controller.signal.addEventListener('abort', cancelled, { once: true })
          operation
            .then(resolve, reject)
            .finally(() => controller.signal.removeEventListener('abort', cancelled))
            .catch(() => undefined)
          if (controller.signal.aborted) cancelled()
        },
      )
      return { ...result, presetId: preset.id }
    } catch (error) {
      if (controller.signal.aborted)
        throw new AppError('EXTERNAL_ERROR', { message: t('server.tts', '语音合成已取消或超时') })
      if (error instanceof AppError) throw error
      this.logger.warn(t('server.tts', '语音合成失败，请检查服务配置'))
      throw new AppError('EXTERNAL_ERROR', {
        message: t('server.tts', '语音合成失败，请检查服务配置'),
      })
    } finally {
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', abort)
      release?.()
    }
  }
}
