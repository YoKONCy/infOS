/**
 * @file 耳朵的模型文件：清单（大小、SHA-256、下载地址）、状态检查、下载与校验。
 *
 * 模型不进仓库，也不随安装包分发：用户在设置「桌面与家」里打开耳朵后，看到模型大小，点「下载」才下载到
 * 用户数据目录的 `ears-model/`。每个文件边下边算哈希，大小或哈希不对就删掉并报错；校验通过后在
 * `desktop-home.json` 的内部状态里记下大小、修改时间和哈希，之后启动只比对大小与修改时间，不再重算。
 *
 * 模型来源：
 * - silero VAD（MIT）：k2-fsa/sherpa-onnx 的 asr-models 发布页；
 * - SenseVoice Small int8（FunASR 模型许可）：Hugging Face `csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17`，
 *   国内网络不通时再试 hf-mirror.com 镜像（哈希一致才接受）。
 *
 * @platform ELECTRON
 * @see .docs/B02_DESKTOP_AUTOMATION.md 耳朵
 */

import { t as __t } from '../../utils/i18n'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { DesktopEarsModelStatus } from '@infos/shared'
import type { HomeSettingsStore } from '../home/homeSettings'
import type { EarsModelPaths } from './earsEngine'

const HF = 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main'

export interface ModelFile {
  name: string
  size: number
  sha256: string
  urls: string[]
}

export const EARS_MODEL_DIR = path.join('ears-model', 'sense-voice-2024-07-17')

export const EARS_MODEL_FILES: readonly ModelFile[] = [
  {
    name: 'silero_vad.onnx',
    size: 643_854,
    sha256: '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6',
    urls: ['https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx'],
  },
  {
    name: 'tokens.txt',
    size: 315_894,
    sha256: 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc',
    urls: [`https://huggingface.co/${HF}/tokens.txt`, `https://hf-mirror.com/${HF}/tokens.txt`],
  },
  {
    name: 'model.int8.onnx',
    size: 239_233_841,
    sha256: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51',
    urls: [
      `https://huggingface.co/${HF}/model.int8.onnx`,
      `https://hf-mirror.com/${HF}/model.int8.onnx`,
    ],
  },
]

export const EARS_MODEL_BYTES = EARS_MODEL_FILES.reduce((sum, file) => sum + file.size, 0)

export type FetchLike = (url: string, init: { signal: AbortSignal }) => Promise<Response>

export class EarsModel {
  private download?: { controller: AbortController; promise: Promise<void> }
  private progress: DesktopEarsModelStatus | undefined
  private lastError?: string

  constructor(
    private readonly store: HomeSettingsStore,
    private readonly root: () => string,
    private readonly fetcher: FetchLike,
    private readonly onChange: (status: DesktopEarsModelStatus) => void = () => {},
    private readonly files: readonly ModelFile[] = EARS_MODEL_FILES,
  ) {}

  dir(): string {
    return path.join(this.root(), EARS_MODEL_DIR)
  }

  paths(): EarsModelPaths {
    const dir = this.dir()
    return {
      vad: path.join(dir, 'silero_vad.onnx'),
      model: path.join(dir, 'model.int8.onnx'),
      tokens: path.join(dir, 'tokens.txt'),
    }
  }

  private totalBytes(): number {
    return this.files.reduce((sum, file) => sum + file.size, 0)
  }

  /** 文件与校验记录一致（大小、修改时间、哈希都对得上）。 */
  private verified(file: ModelFile): boolean {
    const record = this.store.internal().earsModel[file.name]
    if (!record || record.sha256 !== file.sha256 || record.size !== file.size) return false
    try {
      const stat = fs.statSync(path.join(this.dir(), file.name))
      return stat.size === record.size && stat.mtimeMs === record.mtimeMs
    } catch {
      return false
    }
  }

  ready(): boolean {
    return this.files.every((file) => this.verified(file))
  }

  status(): DesktopEarsModelStatus {
    if (this.progress) return { ...this.progress }
    if (this.ready()) return { state: 'ready', totalBytes: this.totalBytes() }
    return {
      state: this.lastError ? 'failed' : 'missing',
      totalBytes: this.totalBytes(),
      ...(this.lastError ? { error: this.lastError } : {}),
    }
  }

  private emit(progress: DesktopEarsModelStatus | undefined): void {
    this.progress = progress
    this.onChange(this.status())
  }

  /** 开始下载（已在下载时返回同一个任务）。 */
  start(): Promise<void> {
    if (this.download) return this.download.promise
    const controller = new AbortController()
    const promise = this.run(controller.signal).finally(() => {
      this.download = undefined
    })
    this.download = { controller, promise }
    void promise.catch(() => undefined)
    return promise
  }

  cancel(): void {
    this.download?.controller.abort(
      new Error(`EARS_MODEL_CANCELLED: ${__t('electron.ui.desktopControl', '已取消下载')}`),
    )
  }

  private async run(signal: AbortSignal): Promise<void> {
    this.lastError = undefined
    const total = this.totalBytes()
    let done = this.files.filter((file) => this.verified(file)).reduce((sum, f) => sum + f.size, 0)
    this.emit({ state: 'downloading', totalBytes: total, receivedBytes: done })
    try {
      fs.mkdirSync(this.dir(), { recursive: true })
      for (const file of this.files) {
        if (this.verified(file)) continue
        await this.fetchFile(file, signal, (received) =>
          this.emit({ state: 'downloading', totalBytes: total, receivedBytes: done + received }),
        )
        done += file.size
      }
      this.emit(undefined)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.lastError = message.startsWith('EARS_MODEL_')
        ? message
        : `EARS_MODEL_DOWNLOAD_FAILED: ${message}`
      this.emit(undefined)
      throw new Error(this.lastError)
    }
  }

  /** 依次试每个地址；边下边算哈希，大小和哈希都对才改名并记下。 */
  private async fetchFile(
    file: ModelFile,
    signal: AbortSignal,
    progress: (received: number) => void,
  ): Promise<void> {
    const target = path.join(this.dir(), file.name)
    const partial = `${target}.part`
    const failures: string[] = []
    for (const url of file.urls) {
      signal.throwIfAborted()
      const transferSignal = AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)])
      const hash = createHash('sha256')
      let received = 0
      try {
        const response = await this.fetcher(url, { signal: transferSignal })
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
        let lastReport = 0
        const verify = new Transform({
          transform(value: Buffer, _encoding, callback) {
            received += value.byteLength
            if (received > file.size) return callback(new Error('EARS_MODEL_SIZE_MISMATCH'))
            hash.update(value)
            if (received - lastReport >= 1 << 20) {
              lastReport = received
              progress(received)
            }
            callback(null, value)
          },
        })
        // pipeline 同时处理读、写、背压与取消；磁盘写入错误不能成为未处理的主进程异常。
        await pipeline(
          Readable.fromWeb(response.body as never),
          verify,
          fs.createWriteStream(partial),
          { signal: transferSignal },
        )
        signal.throwIfAborted()
        if (received !== file.size)
          throw new Error(
            `EARS_MODEL_SIZE_MISMATCH: ${__t('electron.ui.desktopControl', '{0} 大小不对（{1}）', [file.name, received])}`,
          )
        this.progress = { state: 'verifying', totalBytes: this.totalBytes() }
        const digest = hash.digest('hex')
        if (digest !== file.sha256)
          throw new Error(
            `EARS_MODEL_HASH_MISMATCH: ${__t('electron.ui.desktopControl', '{0} 校验不通过，已删除', [file.name])}`,
          )
        fs.renameSync(partial, target)
        const stat = fs.statSync(target)
        this.store.updateInternal((internal) => ({
          ...internal,
          earsModel: {
            ...internal.earsModel,
            [file.name]: { size: stat.size, mtimeMs: stat.mtimeMs, sha256: digest },
          },
        }))
        return
      } catch (error) {
        fs.rmSync(partial, { force: true })
        const message = error instanceof Error ? error.message : String(error)
        if (signal.aborted)
          throw new Error(
            `EARS_MODEL_CANCELLED: ${__t('electron.ui.desktopControl', '已取消下载')}`,
          )
        // 哈希或大小不对说明来源有问题，不再试镜像以外的地址也照样报出来。
        failures.push(`${new URL(url).host}: ${message}`)
      }
    }
    throw new Error(
      `EARS_MODEL_DOWNLOAD_FAILED: ${__t('electron.ui.desktopControl', '{0} 下载失败（{1}）', [file.name, failures.join('; ')])}`,
    )
  }

  /** 删除模型文件与校验记录。 */
  async shutdown(): Promise<void> {
    this.cancel()
    await this.download?.promise.catch(() => undefined)
  }

  async remove(): Promise<void> {
    await this.shutdown()
    fs.rmSync(this.dir(), { recursive: true, force: true })
    this.store.updateInternal((internal) => ({ ...internal, earsModel: {} }))
    this.lastError = undefined
    this.onChange(this.status())
  }
}
