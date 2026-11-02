import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

const PREFIX = 'infos/auto-v1/'
const HEAD = `${PREFIX}head.json`
const LEGACY = 'infos/full-snapshot.bundle'
const CHUNK_BYTES = 4 * 1024 * 1024
const MAX_BYTES = 8 * 1024 * 1024 * 1024

export interface SteamCloudFiles {
  isEnabledForApp(): boolean
  isEnabledForAccount?(): boolean
  readFile(name: string): string
  writeFile(name: string, content: string): boolean
  fileExists?(name: string): boolean
  listFiles(): Array<{ name: string }>
  deleteFile(name: string): unknown
}

export interface CloudSnapshot {
  id: string
  createdAt: number
  bytes: number
  sha256: string
  chunks: number
  chunkBytes: number
  legacy?: boolean
}

export interface LocalCloudState {
  version: 1
  baseRevision: string | null
  fingerprint: string | null
  lastLocalSaveAt?: number
  checkpoint?: { snapshot: CloudSnapshot; fingerprint: string; pending: boolean }
  restoring?: { revision: string; snapshotId: string; fingerprint: string }
  obsoleteRevisions?: string[]
}

interface CloudHead {
  version: 1
  current: CloudSnapshot
  previous: CloudSnapshot | null
}

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

function validSnapshot(value: unknown): value is CloudSnapshot {
  if (!value || typeof value !== 'object') return false
  const entry = value as CloudSnapshot
  return (
    /^[a-f0-9-]{36}$/.test(entry.id) &&
    Number.isSafeInteger(entry.createdAt) &&
    entry.createdAt > 0 &&
    Number.isSafeInteger(entry.bytes) &&
    entry.bytes > 0 &&
    entry.bytes <= MAX_BYTES &&
    /^[a-f0-9]{64}$/.test(entry.sha256) &&
    Number.isSafeInteger(entry.chunks) &&
    entry.chunks > 0 &&
    entry.chunks <= 8192 &&
    Number.isSafeInteger(entry.chunkBytes) &&
    entry.chunkBytes > 0 &&
    entry.chunks === Math.ceil(entry.bytes / entry.chunkBytes)
  )
}

/** 本机先持久化密文；云端先写独立分块，最后切换清单，保留上一代供中断恢复。 */
export class CloudSnapshotStore {
  readonly directory: string

  constructor(
    root: string,
    accountId: string,
    private readonly files: () => SteamCloudFiles | null,
    private readonly chunkBytes = CHUNK_BYTES,
  ) {
    if (!/^\d{1,20}$/.test(accountId)) throw new Error('STEAM_CLOUD_ACCOUNT_INVALID')
    this.directory = path.join(root, 'cloud-cache', `steam-${accountId}`)
  }

  async readState(): Promise<LocalCloudState> {
    let contents: string
    try {
      contents = await readFile(path.join(this.directory, 'state.json'), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { version: 1, baseRevision: null, fingerprint: null }
      throw error
    }
    const state = JSON.parse(contents) as LocalCloudState
    if (
      state?.version !== 1 ||
      !(state.baseRevision === null || typeof state.baseRevision === 'string') ||
      !(state.fingerprint === null || typeof state.fingerprint === 'string') ||
      (state.lastLocalSaveAt !== undefined &&
        (!Number.isSafeInteger(state.lastLocalSaveAt) || state.lastLocalSaveAt <= 0)) ||
      (state.checkpoint !== undefined &&
        (!state.checkpoint ||
          !validSnapshot(state.checkpoint.snapshot) ||
          typeof state.checkpoint.fingerprint !== 'string' ||
          typeof state.checkpoint.pending !== 'boolean')) ||
      (state.restoring !== undefined &&
        (!state.restoring ||
          typeof state.restoring.revision !== 'string' ||
          typeof state.restoring.snapshotId !== 'string' ||
          typeof state.restoring.fingerprint !== 'string')) ||
      (state.obsoleteRevisions !== undefined &&
        (!Array.isArray(state.obsoleteRevisions) ||
          !state.obsoleteRevisions.every(
            (id) => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id),
          )))
    )
      throw new Error('STEAM_CLOUD_LOCAL_STATE_INVALID')
    return state
  }

  async saveState(state: LocalCloudState): Promise<void> {
    await this.atomicFile('state.json', JSON.stringify(state))
  }

  async checkpoint(bytes: Buffer, fingerprint: string, state: LocalCloudState): Promise<void> {
    if (!bytes.length || bytes.length > MAX_BYTES) throw new Error('STEAM_CLOUD_SIZE_LIMIT')
    const snapshot: CloudSnapshot = {
      id: randomUUID(),
      createdAt: Date.now(),
      bytes: bytes.length,
      sha256: digest(bytes),
      chunks: Math.ceil(bytes.length / this.chunkBytes),
      chunkBytes: this.chunkBytes,
    }
    await this.atomicFile(`${snapshot.id}.bundle`, bytes)
    if (state.checkpoint?.pending) {
      state.obsoleteRevisions = [
        ...new Set([...(state.obsoleteRevisions ?? []), state.checkpoint.snapshot.id]),
      ]
    }
    state.checkpoint = { snapshot, fingerprint, pending: true }
    state.lastLocalSaveAt = snapshot.createdAt
    await this.saveState(state)
    // 只清理本账户缓存中更早的密文文件，保留最近三次本机检查点。
    try {
      const checkpoints = await Promise.all(
        (await readdir(this.directory, { withFileTypes: true }))
          .filter(
            (entry) =>
              entry.isFile() &&
              /^[a-f0-9-]{36}\.bundle$/.test(entry.name) &&
              entry.name !== `${snapshot.id}.bundle`,
          )
          .map(async (entry) => ({
            name: entry.name,
            time: (await stat(path.join(this.directory, entry.name))).mtimeMs,
          })),
      )
      for (const entry of checkpoints.sort((left, right) => right.time - left.time).slice(2)) {
        await rm(path.join(this.directory, entry.name), { force: true })
      }
    } catch {
      // 旧缓存被占用时保留，不能让清理失败阻止新检查点写入云端。
    }
  }

  async readCheckpoint(snapshot: CloudSnapshot): Promise<Buffer> {
    if (!validSnapshot(snapshot)) throw new Error('STEAM_CLOUD_LOCAL_STATE_INVALID')
    const bytes = await readFile(path.join(this.directory, `${snapshot.id}.bundle`))
    this.validateBytes(snapshot, bytes)
    return bytes
  }

  private api(): SteamCloudFiles {
    const api = this.files()
    if (!api?.isEnabledForApp() || api.isEnabledForAccount?.() === false)
      throw new Error('STEAM_CLOUD_UNAVAILABLE')
    return api
  }

  private exists(api: SteamCloudFiles, name: string): boolean {
    return api.fileExists
      ? api.fileExists(name)
      : api.listFiles().some((file) => file.name === name)
  }

  private head(): CloudHead | null {
    const api = this.api()
    if (!this.exists(api, HEAD)) {
      if (!this.exists(api, LEGACY)) return null
      const bytes = this.legacyBytes(api)
      const snapshot: CloudSnapshot = {
        id: `${digest(bytes).slice(0, 8)}-0000-0000-0000-${digest(bytes).slice(8, 20)}`,
        createdAt: 1,
        bytes: bytes.length,
        sha256: digest(bytes),
        chunks: 1,
        chunkBytes: bytes.length,
        legacy: true,
      }
      return { version: 1, current: snapshot, previous: null }
    }
    const head = JSON.parse(api.readFile(HEAD)) as CloudHead
    if (
      head?.version !== 1 ||
      !validSnapshot(head.current) ||
      !(head.previous === null || validSnapshot(head.previous))
    )
      throw new Error('STEAM_CLOUD_MANIFEST_INVALID')
    return head
  }

  current(): CloudSnapshot | null {
    return this.head()?.current ?? null
  }

  private legacyBytes(api: SteamCloudFiles): Buffer {
    const content = api.readFile(LEGACY)
    if (!content.startsWith('base64:')) throw new Error('STEAM_CLOUD_LEGACY_INVALID')
    const bytes = Buffer.from(content.slice(7), 'base64')
    if (!bytes.length || bytes.length > MAX_BYTES) throw new Error('STEAM_CLOUD_SIZE_LIMIT')
    return bytes
  }

  private validateBytes(snapshot: CloudSnapshot, bytes: Buffer): void {
    if (bytes.length !== snapshot.bytes || digest(bytes) !== snapshot.sha256)
      throw new Error('STEAM_CLOUD_CHECKSUM_MISMATCH')
  }

  async readRemote(snapshot: CloudSnapshot, signal?: AbortSignal): Promise<Buffer> {
    const api = this.api()
    if (!validSnapshot(snapshot)) throw new Error('STEAM_CLOUD_MANIFEST_INVALID')
    if (snapshot.legacy) {
      const bytes = this.legacyBytes(api)
      this.validateBytes(snapshot, bytes)
      return bytes
    }
    const chunks: Buffer[] = []
    let size = 0
    for (let index = 0; index < snapshot.chunks; index++) {
      signal?.throwIfAborted()
      const content = this.api().readFile(this.chunkName(snapshot.id, index))
      if (!content.startsWith('base64:')) throw new Error('STEAM_CLOUD_CHUNK_INVALID')
      const bytes = Buffer.from(content.slice(7), 'base64')
      size += bytes.length
      if (!bytes.length || size > snapshot.bytes) throw new Error('STEAM_CLOUD_SIZE_LIMIT')
      chunks.push(bytes)
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    const bytes = Buffer.concat(chunks)
    this.validateBytes(snapshot, bytes)
    return bytes
  }

  async publish(state: LocalCloudState, signal?: AbortSignal): Promise<void> {
    const checkpoint = state.checkpoint
    if (!checkpoint?.pending) return
    this.api()
    const oldHead = this.head()
    const remoteId = oldHead?.current.id ?? null
    if (remoteId !== checkpoint.snapshot.id && remoteId !== state.baseRevision)
      throw new Error('STEAM_CLOUD_CONFLICT')
    this.cleanObsolete(state)
    if (remoteId !== checkpoint.snapshot.id) {
      const bytes = await this.readCheckpoint(checkpoint.snapshot)
      for (let index = 0; index < checkpoint.snapshot.chunks; index++) {
        signal?.throwIfAborted()
        const content = bytes.subarray(
          index * checkpoint.snapshot.chunkBytes,
          (index + 1) * checkpoint.snapshot.chunkBytes,
        )
        if (
          !this.api().writeFile(
            this.chunkName(checkpoint.snapshot.id, index),
            `base64:${content.toString('base64')}`,
          )
        )
          throw new Error('STEAM_CLOUD_WRITE_FAILED')
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
      signal?.throwIfAborted()
      if ((this.head()?.current.id ?? null) !== state.baseRevision)
        throw new Error('STEAM_CLOUD_CONFLICT')
      if (
        !this.api().writeFile(
          HEAD,
          JSON.stringify({
            version: 1,
            current: checkpoint.snapshot,
            previous: oldHead?.current ?? null,
          }),
        )
      )
        throw new Error('STEAM_CLOUD_WRITE_FAILED')
      if (oldHead?.previous && !oldHead.previous.legacy) {
        state.obsoleteRevisions = [
          ...new Set([...(state.obsoleteRevisions ?? []), oldHead.previous.id]),
        ]
      }
    }
    // SDK 接受本机写入后再更新回执；Steam 客户端负责实际上传，不能宣称服务器已确认。
    state.baseRevision = checkpoint.snapshot.id
    state.fingerprint = checkpoint.fingerprint
    checkpoint.pending = false
    await this.saveState(state)
    this.cleanObsolete(state)
    await this.saveState(state)
  }

  /** 返回上一代描述；调用方仍必须完整校验正文并明确提示恢复方向。 */
  previous(): CloudSnapshot | null {
    return this.head()?.previous ?? null
  }

  /** 用户已确认回退且旧代已完整校验；先修复指针，再允许后续自动保存。 */
  adoptPrevious(snapshot: CloudSnapshot): void {
    const head = this.head()
    if (!head || head.previous?.id !== snapshot.id) throw new Error('STEAM_CLOUD_CONFLICT')
    if (
      !this.api().writeFile(HEAD, JSON.stringify({ version: 1, current: snapshot, previous: null }))
    )
      throw new Error('STEAM_CLOUD_WRITE_FAILED')
  }

  private cleanObsolete(state: LocalCloudState): void {
    try {
      const head = this.head()
      const obsolete = new Set(state.obsoleteRevisions ?? [])
      obsolete.delete(head?.current.id ?? '')
      obsolete.delete(head?.previous?.id ?? '')
      obsolete.delete(state.checkpoint?.snapshot.id ?? '')
      for (const file of this.api().listFiles()) {
        const relative = file.name.startsWith(PREFIX) ? file.name.slice(PREFIX.length) : ''
        const revision = relative.split('/')[0]
        if (revision && obsolete.has(revision) && this.api().deleteFile(file.name) === false)
          obsolete.delete(revision)
      }
      state.obsoleteRevisions = (state.obsoleteRevisions ?? []).filter((id) => !obsolete.has(id))
    } catch {
      // 只回收本机明确废弃或清单已退役的代次，不删除其他设备尚未提交的分块。
    }
  }

  private chunkName(revision: string, index: number): string {
    return `${PREFIX}${revision}/${String(index).padStart(4, '0')}.chunk`
  }

  private async atomicFile(name: string, contents: string | Buffer): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const temporary = path.join(this.directory, `${name}.${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, contents, { mode: 0o600, flush: true })
      await rename(temporary, path.join(this.directory, name))
    } finally {
      await rm(temporary, { force: true })
    }
  }
}
