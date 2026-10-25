import fs from 'node:fs'
import path from 'node:path'

export interface ClientConnection {
  mode: 'local' | 'remote'
  origin?: string
  serverId?: string
  token?: string
  capabilityEndpoint?: string
}
export interface ConnectionInput {
  mode: 'local' | 'remote'
  origin?: string
  token?: string
  capabilityEndpoint?: string
}
export interface SecretCodec {
  encrypt(value: string): string
  decrypt(value: string): string
}

/** 连接配置独立于业务数据和 Steam 快照，且只有主进程持有解密凭据。 */
export class ClientConnectionStore {
  current: ClientConnection | null = null
  private readonly file: string
  constructor(
    directory: string,
    private readonly codec: SecretCodec,
    private readonly request: typeof fetch = fetch,
  ) {
    this.file = path.join(directory, 'client-connection.json')
  }
  load(): ClientConnection | null {
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (saved.version !== 1) return null
      if (saved.mode === 'local') return (this.current = { mode: 'local' })
      if (saved.mode !== 'remote' || typeof saved.serverId !== 'string' || !saved.serverId)
        return null
      return (this.current = {
        mode: 'remote',
        origin: normalizeServerOrigin(saved.origin),
        serverId: saved.serverId,
        token: this.codec.decrypt(saved.secret),
        capabilityEndpoint: normalizeCapabilityEndpoint(saved.capabilityEndpoint),
      })
    } catch {
      return null
    }
  }
  async verify(profile = this.current, signal?: AbortSignal): Promise<void> {
    if (!profile || profile.mode === 'local') return
    const response = await this.request(`${profile.origin}/api/distributed/identity`, {
      headers: { Authorization: `Bearer ${profile.token}` },
      redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]),
    })
    if (!response.ok) throw new Error('REMOTE_CONNECTION_FAILED')
    const body = (await response.json()) as { data?: { serverId?: string } }
    if (
      typeof body.data?.serverId !== 'string' ||
      !body.data.serverId ||
      (profile.serverId && body.data.serverId !== profile.serverId)
    )
      throw new Error('REMOTE_IDENTITY_CHANGED')
    profile.serverId = body.data.serverId
  }
  async save(input: ConnectionInput, activate = true, signal?: AbortSignal): Promise<void> {
    if (!input || !['local', 'remote'].includes(input.mode))
      throw new Error('CONNECTION_INPUT_INVALID')
    const next: ClientConnection = { mode: input.mode }
    if (input.mode === 'remote') {
      next.origin = normalizeServerOrigin(input.origin)
      next.token = input.token?.trim()
      if (!next.token || next.token.length > 4096) throw new Error('CONNECTION_TOKEN_REQUIRED')
      next.capabilityEndpoint = normalizeCapabilityEndpoint(
        input.capabilityEndpoint || defaultCapabilityEndpoint(next.origin),
      )
      if (next.origin.startsWith('https:') && !next.capabilityEndpoint.startsWith('wss:'))
        throw new Error('CONNECTION_TLS_REQUIRED')
      if (this.current?.mode === 'remote' && this.current.origin === next.origin)
        next.serverId = this.current.serverId
      await this.verify(next, signal)
    }
    signal?.throwIfAborted()
    const { token, ...publicProfile } = next
    const saved = {
      version: 1,
      ...publicProfile,
      ...(token ? { secret: this.codec.encrypt(token) } : {}),
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(saved), { mode: 0o600 })
    fs.renameSync(`${this.file}.tmp`, this.file)
    if (activate) this.current = next
  }
  async capabilityPairingCode(): Promise<string> {
    const profile = this.current
    if (profile?.mode !== 'remote') throw new Error('REMOTE_PROFILE_REQUIRED')
    await this.verify(profile)
    const response = await this.request(`${profile.origin}/api/distributed/capability-invites`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${profile.token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    })
    const body = (await response.json()) as { data?: { pairingCode?: string } }
    if (!response.ok || !body.data?.pairingCode) throw new Error('CAPABILITY_PAIRING_FAILED')
    return body.data.pairingCode
  }
  protectSecret(value: string): string {
    return this.codec.encrypt(value)
  }
  revealSecret(value: string): string {
    return this.codec.decrypt(value)
  }
}

export function normalizeServerOrigin(value: unknown): string {
  const url = new URL(String(value || ''))
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !['', '/'].includes(url.pathname)
  )
    throw new Error('CONNECTION_URL_INVALID')
  return url.origin
}
export function normalizeCapabilityEndpoint(value: unknown): string {
  const url = new URL(String(value || ''))
  if (
    !['ws:', 'wss:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  )
    throw new Error('CONNECTION_URL_INVALID')
  return url.href
}
function defaultCapabilityEndpoint(origin: string): string {
  const url = new URL(origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.port = '9121'
  return url.href
}
let store: ClientConnectionStore | undefined
export function configureClientConnection(value: ClientConnectionStore): void {
  store = value
}
export function clientConnection(): ClientConnectionStore {
  if (!store) throw new Error('CONNECTION_NOT_CONFIGURED')
  return store
}
export function isRemoteConnection(): boolean {
  return store?.current?.mode === 'remote'
}
export function getBackendOrigin(): string {
  return isRemoteConnection()
    ? store!.current!.origin!
    : `http://localhost:${Number(process.env.PERO_PORT ?? 9120)}`
}
export function isSelectedBackendUrl(url: URL): boolean {
  if (url.origin === getBackendOrigin()) return true
  return (
    !isRemoteConnection() &&
    url.protocol === 'http:' &&
    ['localhost', '127.0.0.1'].includes(url.hostname) &&
    Number(url.port || 80) === Number(process.env.PERO_PORT ?? 9120)
  )
}
export function remoteClientToken(): string {
  return isRemoteConnection() ? store!.current!.token! : ''
}
export function getCapabilityEndpoint(): string {
  return isRemoteConnection()
    ? store!.current!.capabilityEndpoint!
    : `ws://${process.env.PERO_DAEMON_HOST ?? '127.0.0.1'}:${Number(process.env.PERO_CAPABILITY_PORT ?? 9121)}`
}

/** 启动、重试与恢复共用此边界，远程失败不会触发本地启动回退。 */
export async function ensureSelectedBackend(startLocal: () => Promise<boolean>): Promise<boolean> {
  if (store && !store.current) throw new Error('CONNECTION_SELECTION_REQUIRED')
  if (!isRemoteConnection()) return startLocal()
  await clientConnection().verify()
  return true
}
