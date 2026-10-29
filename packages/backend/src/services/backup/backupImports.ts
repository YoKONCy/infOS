import { randomUUID } from 'node:crypto'
import { open, rm } from 'node:fs/promises'
import path from 'node:path'
import type { BackupImportProgress, BackupPreview } from '@infos/shared'
import type { BackupReadOptions } from './backupArchive'
import { createLogger } from '../../lib/logger'
import { t } from '../../lib/i18n'
import { AppError } from '../../lib/appError'

const logger = createLogger('BackupImport')
const MAX_UPLOAD = 20 * 1024 ** 3
const UPLOAD_CHUNK_BYTES = 1024 ** 2
const TERMINAL = new Set(['ready', 'failed', 'cancelled'])
interface ImportJob {
  state: BackupImportProgress
  password: string
  controller: AbortController
  receiving: boolean
  uploadMode?: 'single' | 'chunked'
  timeout: ReturnType<typeof setTimeout>
  idle?: ReturnType<typeof setTimeout>
  processing?: Promise<void>
  upload?: Promise<void>
  expiry?: ReturnType<typeof setTimeout>
}

/** 操作记录只保存当前进程内的进度；口令不进入响应或磁盘，重启后需重新选择文件。 */
export class BackupImports {
  private readonly jobs = new Map<string, ImportJob>()
  private currentId?: string
  private closing = false
  constructor(
    private readonly root: string,
    private readonly available: () => boolean,
    private readonly preview: (
      file: string,
      password: string,
      options: BackupReadOptions,
    ) => Promise<BackupPreview>,
  ) {}
  get active(): boolean {
    return Boolean(this.currentId)
  }
  current(): BackupImportProgress | null {
    return this.currentId ? this.get(this.currentId) : null
  }
  get(id: string): BackupImportProgress {
    const job = this.jobs.get(id)
    if (!job) throw new Error('BACKUP_IMPORT_EXPIRED')
    return { ...job.state }
  }
  begin(size: number, password: string): BackupImportProgress {
    if (this.closing || this.active || !this.available()) throw new Error('BACKUP_BUSY')
    if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_UPLOAD)
      throw new Error('BACKUP_SIZE_INVALID')
    // 终态记录有时效和数量上限，不无限保留大清单。
    while (this.jobs.size >= 8) {
      const oldest = this.jobs.keys().next().value
      if (oldest) {
        clearTimeout(this.jobs.get(oldest)?.expiry)
        this.jobs.delete(oldest)
      }
    }
    const id = randomUUID()
    const controller = new AbortController()
    const job: ImportJob = {
      state: {
        uploadChunkBytes: UPLOAD_CHUNK_BYTES,
        id,
        phase: 'uploading',
        receivedBytes: 0,
        uploadBytes: size,
        unpackedBytes: 0,
        unpackedTotal: 0,
        completedFiles: 0,
        totalFiles: 0,
      },
      password,
      controller,
      receiving: false,
      timeout: setTimeout(() => controller.abort(new Error('BACKUP_IMPORT_TIMEOUT')), 60 * 60_000),
    }
    job.timeout.unref()
    this.jobs.set(id, job)
    this.currentId = id
    controller.signal.addEventListener(
      'abort',
      () => {
        const reason = (controller.signal.reason as Error).message
        job.state.phase = reason === 'BACKUP_IMPORT_CANCELLED' ? 'cancelling' : 'failed'
        job.state.error = reason
        if (!job.receiving && !job.processing) {
          // 分片间取消或超时也要清理暂存文件并释放名额。
          const empty = job.state.receivedBytes === 0
          if (empty) this.finish(job)
          job.processing = rm(path.join(this.root, 'work', `${id}.upload`), { force: true })
            .catch(() => {})
            .then(() => {
              if (!empty) this.finish(job)
            })
        }
      },
      { once: true },
    )
    this.resetIdle(job)
    this.log(job)
    return this.get(id)
  }
  cancel(id: string): BackupImportProgress {
    const job = this.jobs.get(id)
    if (!job) throw new Error('BACKUP_IMPORT_EXPIRED')
    if (!TERMINAL.has(job.state.phase)) job.controller.abort(new Error('BACKUP_IMPORT_CANCELLED'))
    return this.get(id)
  }
  beginFile(file: string, size: number, password: string): BackupImportProgress {
    const state = this.begin(size, password)
    const job = this.jobs.get(state.id)!
    job.receiving = true
    clearTimeout(job.idle)
    job.state.phase = 'extracting'
    job.state.uploadBytes = 0
    this.log(job)
    job.processing = new Promise<void>((resolve) => {
      setImmediate(() => {
        void this.process(job, file, false).then(resolve, resolve)
      })
    })
    return this.get(state.id)
  }
  async shutdown(): Promise<void> {
    this.closing = true
    for (const job of this.jobs.values()) {
      if (!TERMINAL.has(job.state.phase)) job.controller.abort(new Error('BACKUP_IMPORT_CANCELLED'))
    }
    await Promise.all(
      [...this.jobs.values()].map(async (job) => {
        await job.upload
        await job.processing
      }),
    )
    for (const job of this.jobs.values()) {
      clearTimeout(job.timeout)
      clearTimeout(job.idle)
      clearTimeout(job.expiry)
    }
    this.jobs.clear()
    this.currentId = undefined
  }
  async receive(
    id: string,
    input: ReadableStream<Uint8Array>,
    range?: { offset: number; length: number; total: number },
  ): Promise<BackupImportProgress> {
    const job = this.jobs.get(id)
    if (range && job) {
      if (job.uploadMode && job.uploadMode !== 'chunked') throw new Error('BACKUP_FORMAT_INVALID')
      if (
        ![range.offset, range.length, range.total].every(Number.isSafeInteger) ||
        range.offset < 0 ||
        range.length <= 0 ||
        range.length > UPLOAD_CHUNK_BYTES ||
        range.total !== job.state.uploadBytes ||
        range.offset + range.length > range.total
      )
        throw new Error('BACKUP_SIZE_INVALID')
      // 确认响应丢失时允许重发已提交片，不重复追加；最终片同样支持查询已进入的解包状态。
      if (
        range.offset + range.length <= job.state.receivedBytes &&
        !['failed', 'cancelling', 'cancelled'].includes(job.state.phase)
      ) {
        const duplicate = input.getReader()
        let bytes = 0
        try {
          for (;;) {
            const chunk = await duplicate.read()
            if (chunk.done) break
            bytes += chunk.value.length
            if (bytes > range.length) throw new Error('BACKUP_SIZE_INVALID')
          }
          if (bytes !== range.length) throw new Error('BACKUP_SIZE_INVALID')
        } finally {
          await duplicate.cancel().catch(() => {})
          duplicate.releaseLock()
        }
        return this.get(id)
      }
      if (range.offset !== job.state.receivedBytes || job.receiving)
        throw new AppError('CONFLICT', {
          message: t('server.backup', '上传位置已变化，请查询已确认进度后继续'),
        })
    }
    if (!job || job.state.phase !== 'uploading' || job.receiving)
      throw new Error('BACKUP_IMPORT_EXPIRED')
    const mode = range ? 'chunked' : 'single'
    if (job.uploadMode && job.uploadMode !== mode) throw new Error('BACKUP_FORMAT_INVALID')
    job.uploadMode = mode
    job.receiving = true
    let releaseUpload!: () => void
    job.upload = new Promise<void>((resolve) => {
      releaseUpload = resolve
    })
    const file = path.join(this.root, 'work', `${id}.upload`)
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    const abort = () => {
      void reader?.cancel().catch(() => {})
    }
    job.controller.signal.addEventListener('abort', abort, { once: true })
    let handle: Awaited<ReturnType<typeof open>> | undefined
    let accepted = false
    let canRollbackChunk = false
    const offset = job.state.receivedBytes
    let written = 0
    try {
      job.controller.signal.throwIfAborted()
      reader = input.getReader()
      try {
        handle = await open(file, range ? 'r+' : 'wx', 0o600)
      } catch (error) {
        if (!range || offset !== 0 || (error as NodeJS.ErrnoException).code !== 'ENOENT')
          throw error
        handle = await open(file, 'wx+', 0o600)
      }
      if (range && (await handle.stat()).size !== offset) throw new Error('BACKUP_SIZE_INVALID')
      canRollbackChunk = Boolean(range)
      for (;;) {
        const chunk = await reader.read()
        job.controller.signal.throwIfAborted()
        if (chunk.done) break
        written += chunk.value.length
        if (written > (range?.length ?? job.state.uploadBytes))
          throw new Error('BACKUP_SIZE_INVALID')
        if (range) {
          // Windows 追加句柄不能可靠截断；显式定位写入，并处理底层短写。
          let consumed = 0
          while (consumed < chunk.value.length) {
            const { bytesWritten } = await handle.write(
              chunk.value,
              consumed,
              chunk.value.length - consumed,
              offset + written - chunk.value.length + consumed,
            )
            if (!bytesWritten)
              throw new AppError('CONFLICT', {
                message: t('server.backup', '上传分片未完成，可从已确认位置重试'),
              })
            consumed += bytesWritten
          }
        } else await handle.writeFile(chunk.value)
        if (!range) job.state.receivedBytes = written
        this.resetIdle(job)
      }
      if (written !== (range?.length ?? job.state.uploadBytes))
        throw new Error('BACKUP_SIZE_INVALID')
      await handle.close()
      handle = undefined
      job.state.receivedBytes = offset + written
      accepted = true
      if (range && job.state.receivedBytes < job.state.uploadBytes) {
        this.resetIdle(job)
        return this.get(id)
      }
      if (job.idle) clearTimeout(job.idle)
      job.state.phase = 'extracting'
      this.log(job)
      // 上传响应先结束，解包与校验由可查询的操作继续持有。
      job.processing = new Promise<void>((resolve) => {
        setImmediate(() => {
          void this.process(job, file).then(resolve, resolve)
        })
      })
      return this.get(id)
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOSPC') {
        this.fail(job, new Error('BACKUP_STORAGE_FULL'))
        throw new Error('BACKUP_STORAGE_FULL', { cause: error })
      } else if (canRollbackChunk && !job.controller.signal.aborted && handle) {
        try {
          // 未完成的片不计入确认位置，重试从上一个完整片继续。
          await handle.truncate(offset)
          accepted = true
          this.resetIdle(job)
        } catch {
          this.fail(job, error)
        }
      } else this.fail(job, error)
      if (accepted) {
        logger.warn(t('server.backup', '备份导入阶段：{0}（{1}）', [job.state.phase, id]), {
          reason: 'BACKUP_UPLOAD_INTERRUPTED',
          confirmedBytes: offset,
          code: (error as NodeJS.ErrnoException)?.code,
        })
        throw new AppError('CONFLICT', {
          message: t('server.backup', '上传分片未完成，可从已确认位置重试'),
          cause: error,
        })
      }
      throw error
    } finally {
      job.controller.signal.removeEventListener('abort', abort)
      try {
        await reader?.cancel().catch(() => {})
        reader?.releaseLock()
        await handle?.close().catch(() => {})
        if (job.controller.signal.aborted && !job.processing) accepted = false
        if (!accepted) {
          await rm(file, { force: true }).catch(() => {})
          this.finish(job)
        }
      } finally {
        job.receiving = false
        releaseUpload()
      }
    }
  }
  private async process(job: ImportJob, file: string, removeSource = true): Promise<void> {
    try {
      job.controller.signal.throwIfAborted()
      const preview = await this.preview(file, job.password, {
        signal: job.controller.signal,
        progress: (progress) => {
          Object.assign(job.state, progress)
        },
        validating: () => {
          job.controller.signal.throwIfAborted()
          job.state.phase = 'validating'
          this.log(job)
        },
      })
      if (job.controller.signal.aborted) {
        await rm(path.join(this.root, 'previews', preview.ticket), { recursive: true, force: true })
        job.controller.signal.throwIfAborted()
      }
      job.state.preview = preview
      job.state.phase = 'ready'
      this.log(job)
    } catch (error) {
      this.fail(job, error)
    } finally {
      if (removeSource) await rm(file, { force: true }).catch(() => {})
      this.finish(job)
    }
  }
  private fail(job: ImportJob, error: unknown): void {
    const message = error instanceof Error ? error.message : ''
    job.state.phase =
      job.controller.signal.aborted &&
      (job.controller.signal.reason as Error).message === 'BACKUP_IMPORT_CANCELLED'
        ? 'cancelling'
        : 'failed'
    job.state.error = job.controller.signal.aborted
      ? (job.controller.signal.reason as Error).message
      : /^BACKUP_[A-Z_]+$/.test(message)
        ? message
        : 'BACKUP_IMPORT_FAILED'
    logger.warn(t('server.backup', '备份导入阶段：{0}（{1}）', [job.state.phase, job.state.id]), {
      reason: job.state.error,
      code: (error as NodeJS.ErrnoException | undefined)?.code,
      receivedBytes: job.state.receivedBytes,
      unpackedBytes: job.state.unpackedBytes,
    })
  }
  private finish(job: ImportJob): void {
    clearTimeout(job.timeout)
    if (job.idle) clearTimeout(job.idle)
    job.password = ''
    if (job.state.phase === 'cancelling') {
      job.state.phase = 'cancelled'
      this.log(job)
    }
    if (this.currentId === job.state.id) this.currentId = undefined
    const id = job.state.id
    job.expiry = setTimeout(() => this.jobs.delete(id), 60 * 60_000)
    job.expiry.unref()
  }
  private resetIdle(job: ImportJob): void {
    if (job.idle) clearTimeout(job.idle)
    job.idle = setTimeout(() => job.controller.abort(new Error('BACKUP_IMPORT_TIMEOUT')), 120_000)
    job.idle.unref()
  }
  private log(job: ImportJob): void {
    logger.info(t('server.backup', '备份导入阶段：{0}（{1}）', [job.state.phase, job.state.id]))
  }
}
