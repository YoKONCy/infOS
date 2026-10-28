import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { PackageWebUiModule, PackageWebUiSession } from '@infos/shared'
import type { PackageActivationContext } from './types'
import { packagePath } from './packageFiles'
import { packageWebUiBootstrap, packageWebUiHeadEnd } from './packageWebUiBootstrap'
import { createLogger } from '../lib/logger'
import { t } from '../lib/i18n'

const logger = createLogger('PackageWebUi')

export interface PackageWebUiOwner {
  id: string
  token: string
}
interface Page {
  packageId: string
  contributionId: string
  title: string
  root: string
  index: string
  files: Map<string, string>
  actions: Set<string>
  module?: PackageWebUiModule
  signal?: AbortSignal
}
interface Session {
  description: PackageWebUiSession
  ticket: string
  page: Page
  owner: PackageWebUiOwner
  controller: AbortController
  expiresAt: number
  calls: number
}
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
}
const IDLE_MS = 5 * 60_000
const MAX_FILE_BYTES = 16 * 1024 * 1024
const key = (packageId: string, contributionId: string) =>
  JSON.stringify([packageId, contributionId])
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** 每次激活持有独立页面实例；资源票据只读，交互仍使用宿主鉴权与所属会话。 */
export class PackageWebUi {
  private readonly pages = new Map<string, Page>()
  private readonly sessions = new Map<string, Session>()
  private readonly tickets = new Map<string, Session>()
  private readonly timer: ReturnType<typeof setInterval>

  constructor(
    private readonly ownerValid: (owner: PackageWebUiOwner) => boolean,
    private readonly packageActive: (id: string) => boolean,
    private readonly beginWrite?: () => () => void,
  ) {
    this.timer = setInterval(() => this.revalidate(), 30_000)
    this.timer.unref()
  }

  async register(
    context: PackageActivationContext,
    module?: PackageWebUiModule,
  ): Promise<() => void> {
    const definition = context.contribution.webUi
    if (!context.rootDir || !definition) throw new Error('PACKAGE_WEB_UI_INVALID')
    const packageRoot = await realpath(context.rootDir)
    const root = await realpath(packagePath(packageRoot, definition.root))
    this.contained(packageRoot, root)
    if (!(await stat(root)).isDirectory()) throw new Error('PACKAGE_WEB_UI_INVALID')
    const actions = new Set(definition.actions ?? [])
    if (
      [...actions].some(
        (action) =>
          !module?.actions ||
          !Object.hasOwn(module.actions, action) ||
          typeof module.actions[action] !== 'function',
      )
    )
      throw new Error('PACKAGE_WEB_UI_ACTION_INVALID')
    const files = new Map<string, string>()
    let bytes = 0
    let entries = 0
    const scan = async (directory: string, depth = 0): Promise<void> => {
      if (depth > 32) throw new Error('PACKAGE_WEB_UI_TOO_LARGE')
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (++entries > 4096) throw new Error('PACKAGE_WEB_UI_TOO_LARGE')
        if (entry.isSymbolicLink()) throw new Error('PACKAGE_PATH_INVALID')
        const file = path.join(directory, entry.name)
        if (entry.isDirectory()) {
          await scan(file, depth + 1)
          continue
        }
        if (!entry.isFile()) throw new Error('PACKAGE_WEB_UI_INVALID')
        if (!MIME[path.extname(entry.name).toLowerCase()]) continue
        const relative = path.relative(root, file).replaceAll('\\', '/')
        packagePath(root, relative)
        const canonical = await realpath(file)
        this.contained(root, canonical)
        const content = await this.readBounded(canonical)
        bytes += content.length
        if (files.size >= 2048 || bytes > 128 * 1024 * 1024)
          throw new Error('PACKAGE_WEB_UI_TOO_LARGE')
        files.set(relative, hash(content))
      }
    }
    await scan(root)
    const index = definition.index ?? 'index.html'
    if (!files.has(index)) throw new Error('PACKAGE_WEB_UI_ENTRY_MISSING')
    const html = new TextDecoder('utf-8', { fatal: true }).decode(
      await this.readBounded(packagePath(root, index)),
    )
    packageWebUiHeadEnd(html)
    context.host?.signal.throwIfAborted()
    const page: Page = {
      packageId: context.manifest.packageId,
      contributionId: context.contribution.id,
      title: definition.title ?? context.manifest.name,
      root,
      index,
      files,
      actions,
      module,
      signal: context.host?.signal,
    }
    const id = key(page.packageId, page.contributionId)
    if (this.pages.has(id)) throw new Error('PACKAGE_WEB_UI_CONFLICT')
    this.pages.set(id, page)
    const cleanup = () => {
      if (this.pages.get(id) === page) this.pages.delete(id)
      for (const session of this.sessions.values()) if (session.page === page) this.remove(session)
    }
    context.host?.onDispose(cleanup)
    return cleanup
  }

  open(packageId: string, contributionId: string, owner: PackageWebUiOwner): PackageWebUiSession {
    this.revalidate()
    const page = this.pages.get(key(packageId, contributionId))
    if (!page || page.signal?.aborted || !this.packageActive(packageId) || !this.ownerValid(owner))
      throw new Error('PACKAGE_WEB_UI_UNAVAILABLE')
    if (
      this.sessions.size >= 128 ||
      [...this.sessions.values()].filter((s) => s.owner.id === owner.id).length >= 8
    )
      throw new Error('PACKAGE_WEB_UI_BUSY')
    const ticket = randomBytes(32).toString('hex')
    const description: PackageWebUiSession = {
      id: randomUUID(),
      channel: randomUUID(),
      packageId,
      contributionId,
      title: page.title,
      documentPath: `/packages/web-ui/files/${ticket}/${page.index.split('/').map(encodeURIComponent).join('/')}`,
    }
    const session: Session = {
      description,
      ticket,
      page,
      owner: { ...owner },
      controller: new AbortController(),
      expiresAt: Date.now() + IDLE_MS,
      calls: 0,
    }
    this.sessions.set(description.id, session)
    this.tickets.set(ticket, session)
    return { ...description }
  }

  touch(id: string, owner: PackageWebUiOwner): void {
    this.owned(id, owner).expiresAt = Date.now() + IDLE_MS
  }
  close(id: string, owner: PackageWebUiOwner): void {
    if (!this.sessions.has(id)) return
    this.remove(this.owned(id, owner))
  }

  async read(ticket: string, relative: string, origin: string) {
    const session = this.tickets.get(ticket)
    if (!session || !this.valid(session)) throw new Error('PACKAGE_WEB_UI_UNAVAILABLE')
    const page = session.page
    if (!page.files.has(relative)) throw new Error('PACKAGE_WEB_UI_FILE_UNAVAILABLE')
    const canonicalRoot = await realpath(page.root)
    if (canonicalRoot !== page.root) throw new Error('PACKAGE_PATH_INVALID')
    const file = await realpath(packagePath(page.root, relative))
    this.contained(page.root, file)
    const info = await stat(file)
    if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error('PACKAGE_WEB_UI_TOO_LARGE')
    let content: Uint8Array = await this.readBounded(file)
    if (hash(content) !== page.files.get(relative)) throw new Error('PACKAGE_SOURCE_CHANGED')
    if (!this.valid(session)) throw new Error('PACKAGE_WEB_UI_UNAVAILABLE')
    if (relative === page.index) {
      const html = new TextDecoder('utf-8', { fatal: true }).decode(content)
      const headEnd = packageWebUiHeadEnd(html)
      content = new TextEncoder().encode(
        html.slice(0, headEnd) +
          packageWebUiBootstrap(session.description.channel) +
          html.slice(headEnd),
      )
    }
    const base = `${origin}/api/packages/web-ui/files/${ticket}/`
    const csp = `default-src 'none'; sandbox allow-scripts; script-src 'unsafe-inline' 'wasm-unsafe-eval' ${base}; style-src 'unsafe-inline' ${base}; img-src data: blob: ${base}; font-src data: ${base}; media-src blob: ${base}; connect-src ${base}; object-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'`
    return { content, type: MIME[path.extname(relative).toLowerCase()]!, csp }
  }

  async invoke(
    id: string,
    owner: PackageWebUiOwner,
    action: string,
    input: unknown,
    progress: (value: unknown) => Promise<void>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const session = this.owned(id, owner)
    const page = session.page
    if (!page.actions.has(action) || typeof page.module?.actions[action] !== 'function')
      throw new Error('PACKAGE_WEB_UI_ACTION_INVALID')
    if (session.calls >= 8) throw new Error('PACKAGE_WEB_UI_BUSY')
    // SSE 响应头先返回；写入计数必须持有到动作结束，而不是持有到路由返回。
    const releaseWrite = this.beginWrite?.()
    session.calls++
    const controller = new AbortController()
    const combined = AbortSignal.any([
      controller.signal,
      signal,
      session.controller.signal,
      AbortSignal.timeout(60_000),
      ...(page.signal ? [page.signal] : []),
    ])
    let writes = Promise.resolve()
    let count = 0
    let abort: (() => void) | undefined
    let acceptingProgress = true
    let operationStarted = false
    try {
      const stopped = new Promise<never>((_, reject) => {
        abort = () => reject(new Error('PACKAGE_WEB_UI_CANCELLED'))
        combined.addEventListener('abort', abort, { once: true })
        if (combined.aborted) abort()
      })
      const operation = Promise.resolve().then(() => {
        combined.throwIfAborted()
        return page.module!.actions[action]!(structuredClone(input), {
          clientId: owner.id,
          signal: combined,
          report: (value: unknown) => {
            if (!acceptingProgress || combined.aborted || ++count > 128) return
            const safe = this.json(value, 8192)
            writes = writes.then(() => {
              combined.throwIfAborted()
              return progress(safe)
            })
            void writes.catch(() => undefined)
          },
        })
      })
      operationStarted = true
      // 取消观察不代表底层 I/O 已完成，实际处理器结束后才释放计数与快照保护。
      void operation
        .finally(() => {
          session.calls--
          releaseWrite?.()
        })
        .catch(() => undefined)
      const result = await Promise.race([operation, stopped])
      await Promise.race([writes, stopped])
      this.owned(id, owner)
      return this.json(result, 256 * 1024)
    } catch (error) {
      logger.warn(t('server.packages', '插件界面操作失败：{0}', [page.packageId]), {
        contributionId: page.contributionId,
        action,
        reason:
          error instanceof Error ? error.message.slice(0, 1000) : 'PACKAGE_WEB_UI_CALL_FAILED',
      })
      throw error
    } finally {
      acceptingProgress = false
      if (abort) combined.removeEventListener('abort', abort)
      controller.abort()
      if (!operationStarted) {
        session.calls--
        releaseWrite?.()
      }
    }
  }

  revalidate(): void {
    for (const session of this.sessions.values()) if (!this.valid(session)) this.remove(session)
  }
  dispose(): void {
    clearInterval(this.timer)
    for (const session of this.sessions.values()) this.remove(session)
    this.pages.clear()
  }
  private valid(session: Session): boolean {
    return (
      !session.controller.signal.aborted &&
      session.expiresAt > Date.now() &&
      !session.page.signal?.aborted &&
      this.ownerValid(session.owner) &&
      this.packageActive(session.page.packageId) &&
      this.pages.get(key(session.page.packageId, session.page.contributionId)) === session.page
    )
  }
  private owned(id: string, owner: PackageWebUiOwner): Session {
    const session = this.sessions.get(id)
    if (
      !session ||
      session.owner.id !== owner.id ||
      session.owner.token !== owner.token ||
      !this.valid(session)
    )
      throw new Error('PACKAGE_WEB_UI_UNAVAILABLE')
    session.expiresAt = Date.now() + IDLE_MS
    return session
  }
  private remove(session: Session): void {
    session.controller.abort()
    this.sessions.delete(session.description.id)
    this.tickets.delete(session.ticket)
  }
  private contained(root: string, file: string): void {
    const relative = path.relative(root, file)
    if (relative.startsWith('..') || path.isAbsolute(relative))
      throw new Error('PACKAGE_PATH_INVALID')
  }
  private json(value: unknown, limit: number): unknown {
    const text = JSON.stringify(value ?? null)
    if (typeof text !== 'string' || Buffer.byteLength(text) > limit)
      throw new Error('PACKAGE_WEB_UI_TOO_LARGE')
    return JSON.parse(text)
  }
  private async readBounded(file: string): Promise<Buffer> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of createReadStream(file, { end: MAX_FILE_BYTES })) {
      size += chunk.length
      if (size > MAX_FILE_BYTES) throw new Error('PACKAGE_WEB_UI_TOO_LARGE')
      chunks.push(chunk as Buffer)
    }
    return Buffer.concat(chunks)
  }
}
