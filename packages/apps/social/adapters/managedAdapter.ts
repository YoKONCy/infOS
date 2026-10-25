import { mkdir, writeFile, readFile, readdir, stat, rm, rename } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { AbstractSocialAdapter } from './ISocialAdapter'
import { PlatformStore } from './platformStore'
import type { AdapterStatus, Attachment, InboundMessage, OutboundMessage } from '../runtime/types'

export interface AdapterEnvironment {
  privateRoot?: string
}
export interface ManagedAccount {
  id: string
  token: string
  name: string
  options: Record<string, unknown>
  cursor?: string
  peers?: Record<string, { token?: string; seenAt: number; name?: string }>
}
export interface ManagedState {
  accounts: Record<string, ManagedAccount>
  pending?: Record<string, InboundMessage[]>
}
const emptyState = (): ManagedState => ({ accounts: {} })

/** 一个平台注册一个网关，账号各自持有连接、游标和取消信号。 */
export abstract class ManagedSocialAdapter extends AbstractSocialAdapter {
  protected state: ManagedState = emptyState()
  protected store?: PlatformStore
  protected active = false
  protected controllers = new Map<string, AbortController>()
  protected jobs = new Map<string, Promise<void>>()
  protected online = new Set<string>()
  protected failures = new Map<string, string>()
  protected ownerId?: string
  protected agentId: string
  private lifetime?: AbortSignal
  constructor(
    protected settings: Record<string, unknown>,
    agentId: string,
    protected environment: AdapterEnvironment = {},
  ) {
    super()
    this.agentId = agentId
    this.configure(settings)
  }
  get connectionId(): string {
    return String(this.settings.id ?? this.platform)
  }
  getOwnerId() {
    return this.ownerId
  }
  setOwnerId(value: string | undefined) {
    this.ownerId = value
  }
  setAgentId(value: string) {
    this.agentId = value
  }
  configure(config: Record<string, unknown>) {
    this.settings = config
    this.ownerId = typeof config.ownerId === 'string' && config.ownerId ? config.ownerId : undefined
  }
  protected async load() {
    if (!this.environment.privateRoot) throw new Error('SOCIAL_PRIVATE_STORAGE_REQUIRED')
    this.store ??= new PlatformStore(
      this.environment.privateRoot,
      JSON.stringify([this.platform, this.connectionId]),
    )
    this.state = await this.store.read(emptyState())
  }
  protected async update(change: (state: ManagedState) => void) {
    if (!this.store) await this.load()
    this.state = await this.store!.update(emptyState(), change)
  }
  protected async putAccount(account: ManagedAccount) {
    await this.update((state) => {
      state.accounts[account.id] = account
    })
    if (this.active) await this.restartAccount(account.id)
  }
  async connect(signal?: AbortSignal) {
    if (this.active) return
    signal?.throwIfAborted()
    await this.load()
    this.active = true
    this.lifetime = signal
    for (const id of Object.keys(this.state.accounts)) await this.restartAccount(id)
  }
  protected async restartAccount(id: string) {
    await this.stopAccount(id)
    if (!this.active || this.lifetime?.aborted) return
    const account = this.state.accounts[id]
    if (!account) return
    const controller = new AbortController()
    const signal = this.lifetime
      ? AbortSignal.any([controller.signal, this.lifetime])
      : controller.signal
    this.controllers.set(id, controller)
    const job = Promise.resolve()
      .then(async () => {
        while (!signal.aborted) {
          try {
            await this.runAccount(this.account(id), signal)
          } catch {
            if (!signal.aborted)
              this.failures.set(id, this.failures.get(id) ?? 'SOCIAL_CONNECTION_FAILED')
          }
          this.online.delete(id)
          if (
            signal.aborted ||
            [
              'SOCIAL_TOKEN_INVALID',
              'SOCIAL_LOGIN_EXPIRED',
              'SOCIAL_CONSUMER_CONFLICT',
              'SOCIAL_WEBHOOK_CONFLICT',
              'SOCIAL_INTENT_REQUIRED',
            ].includes(this.failures.get(id) ?? '')
          )
            return
          await delay(5000, signal)
        }
      })
      .catch(() => {
        if (!signal.aborted)
          this.failures.set(id, this.failures.get(id) ?? 'SOCIAL_CONNECTION_FAILED')
      })
      .finally(() => {
        this.online.delete(id)
        if (this.jobs.get(id) === job) this.jobs.delete(id)
        this.emitDisconnected(this.failures.get(id))
      })
    this.jobs.set(id, job)
  }
  protected abstract runAccount(account: ManagedAccount, signal: AbortSignal): Promise<void>
  protected async stopAccount(id: string) {
    this.controllers.get(id)?.abort()
    await this.jobs.get(id)
    this.controllers.delete(id)
    this.online.delete(id)
  }
  async disconnect() {
    this.active = false
    for (const controller of this.controllers.values()) controller.abort()
    await Promise.allSettled([...this.jobs.values()])
    this.controllers.clear()
    this.online.clear()
  }
  protected markOnline(id: string) {
    const wasOnline = this.online.has(id)
    this.online.add(id)
    this.failures.delete(id)
    if (!wasOnline) this.emitConnected()
  }
  getConnectedAccountIds() {
    return [...this.online]
  }
  async getStatus(): Promise<AdapterStatus> {
    return {
      platform: this.platform,
      connected: this.online.size > 0,
      latencyMs: 0,
      accounts: Object.values(this.state.accounts).map((account) => ({
        id: account.id,
        name: account.name,
        connected: this.online.has(account.id),
        error: this.failures.get(account.id),
        fullGroupMessages: account.options.fullGroupMessages === true,
      })),
    }
  }
  async managementSnapshot(): Promise<Record<string, unknown>> {
    if (!this.store) await this.load()
    return { ...(await this.getStatus()), ownerId: this.getOwnerId() }
  }
  async manage(action: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.store) await this.load()
    if (action === 'account_remove' || action === 'account_reconnect') {
      const id = String(input.accountId ?? '')
      if (!this.state.accounts[id]) throw new Error('SOCIAL_ACCOUNT_REQUIRED')
      await this.stopAccount(id)
      if (action === 'account_remove')
        await this.update((state) => {
          delete state.accounts[id]
          if (state.pending) delete state.pending[id]
        })
      else await this.restartAccount(id)
      return { ...(await this.managementSnapshot()), changedAccountId: id }
    }
    throw new Error('SOCIAL_CAPABILITY_UNSUPPORTED')
  }
  protected account(id?: string) {
    if (!id || !this.state.accounts[id]) throw new Error('SOCIAL_ACCOUNT_REQUIRED')
    return this.state.accounts[id]!
  }
  protected async cursor(id: string, cursor: string) {
    await this.update((state) => {
      const account = state.accounts[id]
      if (account) account.cursor = cursor
    })
  }
  protected async cacheMedia(bytes: Buffer, mimeType: string, name?: string): Promise<Attachment> {
    if (!this.environment.privateRoot || bytes.length > 25 * 1024 * 1024)
      throw new Error('SOCIAL_MEDIA_TOO_LARGE')
    const directory = join(
      this.environment.privateRoot,
      'media',
      createHash('sha256').update(this.connectionId).digest('hex'),
    )
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const localPath = join(directory, `${createHash('sha256').update(bytes).digest('hex')}.media`)
    const temporary = `${localPath}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' })
      await rename(temporary, localPath)
    } finally {
      await rm(temporary, { force: true }).catch(() => {})
    }
    // 缓存是可再生数据，清理失败不改变消息的持久接收结果。
    await this.pruneMedia(directory, localPath).catch(() => {})
    return {
      type: mimeType.startsWith('image/')
        ? 'image'
        : mimeType.startsWith('audio/')
          ? 'audio'
          : mimeType.startsWith('video/')
            ? 'video'
            : 'file',
      localPath,
      mimeType,
      name,
    }
  }
  private async pruneMedia(directory: string, current: string) {
    const files = await Promise.all(
      (await readdir(directory))
        .filter((name) => /^[a-f0-9]{64}\.media$/.test(name))
        .map(async (name) => {
          const path = join(directory, name)
          const metadata = await stat(path)
          return { path, size: metadata.size, time: metadata.mtimeMs }
        }),
    )
    files.sort((a, b) => a.time - b.time)
    let size = files.reduce((sum, file) => sum + file.size, 0)
    let count = files.length
    for (const file of files) {
      if (
        file.path === current ||
        (size <= 256 * 1024 * 1024 && count <= 200 && Date.now() - file.time <= 7 * 86400_000)
      )
        continue
      await rm(file.path, { force: true })
      size -= file.size
      count--
    }
  }
  protected async attachmentBytes(attachment: Attachment, signal?: AbortSignal) {
    if (attachment.localPath) {
      const bytes = await readFile(attachment.localPath)
      if (bytes.length > 25 * 1024 * 1024) throw new Error('SOCIAL_MEDIA_TOO_LARGE')
      return bytes
    }
    if (!attachment.url) throw new Error('SOCIAL_MEDIA_UNAVAILABLE')
    return limitedBytes(await fetch(attachment.url, { signal }), 25 * 1024 * 1024)
  }
  protected async receive(message: InboundMessage, signal?: AbortSignal) {
    await this.deliverMessage(message, signal)
  }
  async getSendReadiness(message: OutboundMessage) {
    return {
      ready: !!message.accountId && this.online.has(message.accountId),
      reason: 'SOCIAL_ACCOUNT_NOT_CONNECTED',
    }
  }
}

export async function limitedBytes(response: Response, limit = 25 * 1024 * 1024): Promise<Buffer> {
  if (!response.ok || Number(response.headers.get('content-length') ?? 0) > limit)
    throw new Error('SOCIAL_MEDIA_UNAVAILABLE')
  if (!response.body) throw new Error('SOCIAL_MEDIA_UNAVAILABLE')
  const reader = response.body.getReader()
  const parts: Uint8Array[] = []
  let size = 0
  try {
    let next = await reader.read()
    while (!next.done) {
      size += next.value.byteLength
      if (size > limit) throw new Error('SOCIAL_MEDIA_TOO_LARGE')
      parts.push(next.value)
      next = await reader.read()
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  return Buffer.concat(parts)
}
export function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      resolve()
    }
    const abort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      reject(signal.reason)
    }
    const timer = setTimeout(finish, ms)
    signal.addEventListener('abort', abort, { once: true })
  })
}
