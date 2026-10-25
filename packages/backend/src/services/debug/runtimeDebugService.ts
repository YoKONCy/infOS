import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, readdir, realpath, writeFile, open } from 'node:fs/promises'
import { zipSync } from 'fflate'
import path from 'node:path'
import type { RuntimeDebugStatus, PackageContributionKind, PackageManifest } from '@infos/shared'
import type { PackageRuntime } from '../../packages/packageRuntime'
import { ResourceVersions } from '@infos/shared/resource-versions'
import { packagePath, packageDigest } from '../../packages/packageFiles'
import { writeAtomicJson as writeDebugRecord } from '../../lib/atomicJson'
import { DebugWorkspace } from './debugWorkspace'
import { runDebugScript } from './debugScriptRunner'
import { t } from '../../lib/i18n'
import manifest from '../../../package.json'

interface DebugThread {
  id: string
  agentId: string
  channel: string
  interactionMode: string
  purpose: string
  status: string
}
interface PatchRelease {
  id: string
  entry: string
  kind: PackageContributionKind
  digest: string
  releaseDigest: string
  directory: string
}
interface DebugSession {
  id: string
  threadId: string
  agentId: string
  directory: string
  workspace: DebugWorkspace
  controller: AbortController
  loaded: Map<string, PatchRelease>
  running: boolean
  lastLoads: Array<{ id: string; entry: string; kind: PackageContributionKind }>
  previous: Map<string, PatchRelease[]>
  operations: Promise<unknown>
  journal: Promise<unknown>
}
export interface RuntimeDebugDependencies {
  root: string
  appRoot: string
  dataRoot: string
  logsRoot: string
  getThread(id: string): Promise<DebugThread | null>
  runtime: PackageRuntime
  snapshot(threadId: string): unknown
  agentWorkspace?(agentId: string): string
  electron?(threadId: string, agentId: string, signal?: AbortSignal): Promise<unknown>
}

/** Agent 只能检查和准备候选，正式生效由用户管理入口发起。 */
export class RuntimeDebugService {
  private sessions = new Map<string, DebugSession>()
  private controls = new Map<string, Promise<unknown>>()
  constructor(private readonly deps: RuntimeDebugDependencies) {}
  allowed(threadId: string, agentId: string): boolean {
    const session = this.sessions.get(threadId)
    return !!session && session.agentId === agentId && !session.controller.signal.aborted
  }
  async getStatus(threadId: string): Promise<RuntimeDebugStatus> {
    let thread: DebugThread
    try {
      thread = await this.thread(threadId)
    } catch (error) {
      await this.close(threadId)
      throw error
    }
    if (thread.interactionMode !== 'work') await this.close(threadId)
    return this.status(threadId, thread.agentId)
  }
  status(threadId: string, agentId: string): RuntimeDebugStatus {
    const session = this.sessions.get(threadId)
    return {
      enabled: this.allowed(threadId, agentId),
      threadId,
      agentId,
      sessionId: session?.id,
      workspace: session?.workspace.root,
      loaded: [],
      prepared: [...(session?.loaded.values() ?? [])].map(({ id, entry, kind, digest }) => ({
        id,
        entry,
        kind,
        digest,
      })),
    }
  }
  async setEnabled(threadId: string, enabled: boolean): Promise<RuntimeDebugStatus> {
    const pending = (this.controls.get(threadId) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.changeEnabled(threadId, enabled))
    this.controls.set(threadId, pending)
    try {
      return await pending
    } finally {
      if (this.controls.get(threadId) === pending) this.controls.delete(threadId)
    }
  }
  private async changeEnabled(threadId: string, enabled: boolean): Promise<RuntimeDebugStatus> {
    const thread = await this.thread(threadId)
    if (!enabled) {
      await this.close(threadId)
      return this.status(threadId, thread.agentId)
    }
    if (thread.interactionMode !== 'work') throw new Error('DEBUG_WORK_MODE_REQUIRED')
    if (!this.allowed(threadId, thread.agentId)) {
      await this.close(threadId)
      const id = randomUUID()
      const directory = path.join(this.deps.root, id)
      const workspace = new DebugWorkspace(path.join(directory, 'workspace'))
      await mkdir(workspace.root, { recursive: true })
      await mkdir(path.join(directory, 'data'), { recursive: true })
      const session: DebugSession = {
        id,
        threadId,
        agentId: thread.agentId,
        directory,
        workspace,
        controller: new AbortController(),
        loaded: new Map(),
        running: false,
        lastLoads: [],
        previous: new Map(),
        operations: Promise.resolve(),
        journal: Promise.resolve(),
      }
      this.sessions.set(threadId, session)
      try {
        await this.persist(session)
      } catch (error) {
        session.controller.abort()
        if (this.sessions.get(threadId) === session) this.sessions.delete(threadId)
        throw error
      }
    }
    return this.status(threadId, thread.agentId)
  }
  description(threadId: string, agentId: string): string {
    if (!this.allowed(threadId, agentId)) return ''
    const session = this.sessions.get(threadId)!
    return t(
      'server.runtime-debug',
      '运行现场：{0}。使用 debug.resources.list() 查看资源版本，debug.resources.checkout(kind) 创建备份和候选目录。只修改候选目录；完成后由用户在资源版本页应用并重启。debug.load() 仅准备导出候选，不执行或热加载；debug.export() 导出插件供用户审核。文件助手只写调试工作区；Node 脚本仍具有后端进程权限，不得自行调用应用、重启或授权接口。',
      [
        JSON.stringify({
          version: manifest.version,
          appRoot: this.deps.appRoot,
          dataRoot: this.deps.dataRoot,
          logs: this.deps.logsRoot,
          workspace: session.workspace.root,
          threadId,
          agentId,
          agentWorkspace: this.deps.agentWorkspace?.(agentId),
          resources: {
            skills: path.join(this.deps.dataRoot, 'skills'),
            custom: path.join(this.deps.dataRoot, 'custom'),
            agents: path.join(this.deps.dataRoot, 'agents'),
            packages: path.join(this.deps.dataRoot, 'packages'),
          },
          kinds: ['agent-flow', 'context-provider', 'tool', 'event-subscriber'],
        }),
      ],
    )
  }
  async execute(input: {
    threadId: string
    agentId: string
    code?: string
    approved: boolean
    signal?: AbortSignal
    timeoutMs?: number
  }) {
    const session = await this.guard(input.threadId, input.agentId)
    if (!input.code?.trim()) return this.inspect(session)
    if (!input.approved) throw new Error('DEBUG_APPROVAL_REQUIRED')
    if (input.code.length > 64000 || session.running) throw new Error('DEBUG_SESSION_BUSY')
    session.running = true
    const controller = new AbortController()
    const signal = AbortSignal.any([
      controller.signal,
      session.controller.signal,
      ...(input.signal ? [input.signal] : []),
    ])
    const runId = randomUUID()
    const startedAt = new Date().toISOString()
    try {
      await writeDebugRecord(path.join(session.directory, 'runs', `${runId}.json`), {
        runId,
        startedAt,
        code: input.code,
        state: 'started',
      })
      const value = await runDebugScript({
        code: input.code,
        signal,
        filename: path.join(session.workspace.root, 'debug-run.cjs'),
        timeoutMs: Math.max(100, Math.min(input.timeoutMs ?? 20000, 60000)),
        invoke: (method, args) => {
          const operation = session.operations
            .catch(() => undefined)
            .then(async () => {
              signal.throwIfAborted()
              await this.guard(input.threadId, input.agentId)
              return this.invoke(session, method, args, signal)
            })
          session.operations = operation
          return operation
        },
      })
      await writeDebugRecord(path.join(session.directory, 'runs', `${runId}.json`), {
        runId,
        startedAt,
        code: input.code,
        value,
      })
      return value
    } catch (error) {
      await writeDebugRecord(path.join(session.directory, 'runs', `${runId}.json`), {
        runId,
        startedAt,
        code: input.code,
        error: String(error),
      })
      throw error
    } finally {
      controller.abort()
      await session.operations.catch(() => undefined)
      session.running = false
    }
  }
  async close(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId)
    if (!session) return
    this.sessions.delete(threadId)
    session.controller.abort()
    await this.journal(session, () =>
      writeDebugRecord(path.join(session.directory, 'state.json'), {
        enabled: false,
        threadId,
        closedAt: new Date().toISOString(),
      }),
    )
  }
  async shutdown(): Promise<void> {
    for (const id of this.sessions.keys()) await this.close(id)
  }
  private async thread(id: string): Promise<DebugThread> {
    const thread = await this.deps.getThread(id)
    if (
      !thread ||
      thread.channel !== 'desktop' ||
      thread.purpose !== 'conversation' ||
      thread.status !== 'active'
    )
      throw new Error('DEBUG_THREAD_UNAVAILABLE')
    return thread
  }
  private async guard(threadId: string, agentId: string): Promise<DebugSession> {
    let thread: DebugThread
    try {
      thread = await this.thread(threadId)
    } catch (error) {
      await this.close(threadId)
      throw error
    }
    if (thread.interactionMode !== 'work' || thread.agentId !== agentId) {
      await this.close(threadId)
      throw new Error('DEBUG_WORK_MODE_REQUIRED')
    }
    if (!this.allowed(threadId, agentId)) throw new Error('DEBUG_DISABLED')
    return this.sessions.get(threadId)!
  }
  private inspect(session: DebugSession) {
    return {
      ...this.status(session.threadId, session.agentId),
      version: manifest.version,
      runtime: process.versions,
      pid: process.pid,
      appRoot: this.deps.appRoot,
      dataRoot: this.deps.dataRoot,
      agentWorkspace: this.deps.agentWorkspace?.(session.agentId),
      logsRoot: this.deps.logsRoot,
      runtimeState: this.deps.snapshot(session.threadId),
      limitations: [
        'CORE_BUNDLE_REQUIRES_RELEASE',
        'ELECTRON_RESTART_REQUIRES_HOST',
        'NO_OS_SANDBOX',
      ],
      sdk: {
        guide: this.description(session.threadId, session.agentId),
        files: {
          list: 'await debug.files.list()',
          read: 'await debug.files.read(relativePath)',
          write: 'await debug.files.write(relativePath, text)',
        },
        read: 'await debug.read("@app/path" | "@data/path" | "@logs/path" | "@debug/path"); at most the last 64000 text characters',
        check:
          'await debug.check() -> {ok, digest, files, diagnostics}; syntax only, not semantic type checking',
        resources: {
          list: 'await debug.resources.list()',
          checkout: 'await debug.resources.checkout("skills" | "custom" | "agents" | "packages")',
          changes: 'await debug.resources.changes(revisionId)',
          activation:
            'User applies and restarts from Tools & Extensions > Resource versions; never invoke application or permission endpoints yourself.',
        },
        load: {
          call: 'await debug.load({id, entry, kind}): prepare only; no runtime activation',
          entry:
            'relative .js/.mjs/.ts file; relative TypeScript imports need explicit .ts extensions',
          contract: {
            'agent-flow': 'export const hooks = {"agent:beforeRequest": async (data, ctx) => data}',
            'context-provider':
              'export async function provide(request) { return [{content: "...", priority: 10}] }',
            tool: 'export const definition = {name, description, parameters}; export async function execute(args, context) { return "..." }',
            'event-subscriber':
              'export const hooks = {"chat:afterToolCall": async (data, ctx) => data}',
          },
          lifecycle:
            'export function createContribution(host) { host.onDispose(cleanup); return contribution }; host.signal, host.threadId, host.agentId, host.dataDirectory',
        },
        recover:
          'await debug.recover(id): restore previous prepared candidate; never activates code',
        export:
          'await debug.export({name, version}): optional ZIP; does not install, grant permissions or persist temporary activation',
        node: 'require("node:fs/promises") is available; helpers are bounded, arbitrary Node code is not an OS sandbox',
        history: path.join(session.directory, 'runs'),
      },
      recovery: Object.fromEntries(
        [...session.previous].map(([id, releases]) => [
          id,
          releases.map(({ directory: _directory, ...release }) => release),
        ]),
      ),
    }
  }
  private async invoke(
    session: DebugSession,
    method: string,
    args: unknown[],
    signal: AbortSignal,
  ): Promise<unknown> {
    const text = (index: number) => {
      if (typeof args[index] !== 'string') throw new Error('DEBUG_ARGUMENT_INVALID')
      return args[index] as string
    }
    switch (method) {
      case 'inspect':
        return this.inspect(session)
      case 'files.list':
        return session.workspace.list()
      case 'files.read':
        return session.workspace.read(text(0))
      case 'files.write':
        await session.workspace.write(text(0), text(1))
        return { written: text(0) }
      case 'resources.list':
        return new ResourceVersions(this.deps.dataRoot).view()
      case 'resources.checkout':
        return new ResourceVersions(this.deps.dataRoot).checkout(
          text(0) as import('@infos/shared').EditableResourceKind,
        )
      case 'resources.changes':
        return new ResourceVersions(this.deps.dataRoot).changes(text(0))
      case 'check':
        return session.workspace.check()
      case 'read':
        return this.read(session, text(0))
      case 'logs': {
        const names = await readdir(this.deps.logsRoot).catch(() => [])
        return Promise.all(
          names
            .filter((name) => name.endsWith('.log'))
            .slice(-5)
            .map(async (name) => ({
              name,
              text: (await this.read(session, `@logs/${name}`)).slice(-16000),
            })),
        )
      }
      case 'electron':
        return (
          this.deps.electron?.(session.threadId, session.agentId, signal) ?? { available: false }
        )
      case 'load':
        return this.load(session, args[0], signal)
      case 'recover': {
        return this.recover(session, text(0), signal)
      }
      case 'export':
        return this.export(session, args[0])
      default:
        throw new Error('DEBUG_INTERFACE_UNKNOWN')
    }
  }
  private async read(session: DebugSession, logical: string): Promise<string> {
    const match = /^@(app|data|logs|debug)\/(.+)$/.exec(logical)
    if (!match) throw new Error('DEBUG_PATH_DENIED')
    const roots: Record<string, string> = {
      app: this.deps.appRoot,
      data: this.deps.dataRoot,
      logs: this.deps.logsRoot,
      debug: session.workspace.root,
    }
    const root = await realpath(roots[match[1]!]!)
    const file = await realpath(packagePath(root, match[2]!))
    const relative = path.relative(root, file)
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('DEBUG_PATH_DENIED')
    if (/\.(db|tdb|sqlite|node|dll|exe)$/i.test(file)) throw new Error('DEBUG_FILE_LIMIT')
    const handle = await open(file, 'r')
    try {
      const info = await handle.stat()
      if (!info.isFile()) throw new Error('DEBUG_FILE_LIMIT')
      const size = Math.min(info.size, 256000)
      const buffer = Buffer.alloc(size)
      const { bytesRead } = await handle.read(buffer, 0, size, info.size - size)
      if (buffer.subarray(0, bytesRead).includes(0)) throw new Error('DEBUG_FILE_LIMIT')
      return buffer.subarray(0, bytesRead).toString('utf8').slice(-64000)
    } finally {
      await handle.close()
    }
  }
  private async load(session: DebugSession, value: unknown, signal: AbortSignal) {
    const input = value as { id?: string; entry?: string; kind?: PackageContributionKind }
    if (
      !input ||
      typeof input.id !== 'string' ||
      !/^[a-z0-9._-]{1,80}$/i.test(input.id) ||
      typeof input.entry !== 'string' ||
      !input.entry ||
      !['agent-flow', 'context-provider', 'tool', 'event-subscriber'].includes(input.kind ?? '')
    )
      throw new Error('DEBUG_ARGUMENT_INVALID')
    const staged = await session.workspace.stage(path.join(session.directory, 'releases'))
    signal.throwIfAborted()
    const entry = input.entry.endsWith('.ts') ? input.entry.slice(0, -3) + '.js' : input.entry
    // 只检查入口存在，不 import 候选模块；语法检查也不执行顶层代码。
    await realpath(packagePath(staged.directory, entry))
    const release: PatchRelease = {
      id: input.id,
      entry,
      kind: input.kind!,
      digest: staged.digest,
      releaseDigest: await packageDigest(staged.directory),
      directory: staged.directory,
    }
    const previous = session.loaded.get(input.id)
    if (previous) {
      const history = session.previous.get(input.id) ?? []
      history.push(previous)
      session.previous.set(input.id, history.slice(-10))
    }
    session.loaded.set(input.id, release)
    await this.persist(session)
    return {
      prepared: input.id,
      digest: staged.digest,
      entry,
      activated: false,
      manualApplyRequired: true,
    }
  }
  private async recover(session: DebugSession, id: string, signal: AbortSignal) {
    const patch = session.loaded.get(id)
    if (!patch) throw new Error('DEBUG_PATCH_NOT_FOUND')
    const history = session.previous.get(id) ?? []
    const previous = history.at(-1)
    signal.throwIfAborted()
    session.loaded.delete(id)
    if (previous) {
      session.loaded.set(id, previous)
      history.pop()
    }
    await this.persist(session)
    return {
      recovered: id,
      restoredPrevious: !!previous,
      remaining: this.status(session.threadId, session.agentId).loaded,
    }
  }
  private async persist(session: DebugSession) {
    session.lastLoads = [...session.loaded.values()].map(({ id, entry, kind }) => ({
      id,
      entry,
      kind,
    }))
    await this.journal(session, async () => {
      if (session.controller.signal.aborted) return
      await writeDebugRecord(path.join(session.directory, 'state.json'), {
        enabled: true,
        threadId: session.threadId,
        loaded: [],
        prepared: [...session.loaded.values()],
        previous: Object.fromEntries(session.previous),
      })
    })
  }
  private journal(session: DebugSession, write: () => Promise<void>): Promise<void> {
    const operation = session.journal.catch(() => undefined).then(write)
    session.journal = operation
    return operation
  }
  private async export(session: DebugSession, value: unknown) {
    const options = value as { name?: string; version?: string }
    if (
      (options?.name !== undefined &&
        (typeof options.name !== 'string' || options.name.length > 128)) ||
      (options?.version !== undefined &&
        (typeof options.version !== 'string' ||
          !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(options.version)))
    )
      throw new Error('DEBUG_ARGUMENT_INVALID')
    if (!session.loaded.size) throw new Error('DEBUG_EXPORT_EMPTY')
    const directory = path.join(session.directory, 'exports', randomUUID())
    await mkdir(directory, { recursive: true })
    const contributions: PackageManifest['contributions'] = []
    let fileCount = 0,
      bytes = 0
    // 每个入口导出各自固定的快照，避免恢复记录后却打包了尚未准备的工作区内容。
    for (const patch of session.loaded.values()) {
      if ((await packageDigest(patch.directory)) !== patch.releaseDigest)
        throw new Error('DEBUG_WORKSPACE_CHANGED')
      const prefix = `patches/${createHash('sha256').update(patch.id).digest('hex').slice(0, 16)}`
      for (const file of await new DebugWorkspace(patch.directory).list()) {
        const content = await readFile(packagePath(patch.directory, file))
        bytes += content.length
        if (++fileCount > 500 || bytes > 8 * 1024 * 1024) throw new Error('DEBUG_FILE_LIMIT')
        const target = packagePath(directory, `${prefix}/${file}`)
        await mkdir(path.dirname(target), { recursive: true })
        await writeFile(target, content)
      }
      if ((await packageDigest(patch.directory)) !== patch.releaseDigest)
        throw new Error('DEBUG_WORKSPACE_CHANGED')
      contributions.push({ id: patch.id, kind: patch.kind, entry: `${prefix}/${patch.entry}` })
    }
    const packageId = `user.debug.${createHash('sha256').update(session.id).digest('hex').slice(0, 12)}`
    const packageManifest: PackageManifest = {
      manifestVersion: 2,
      packageId,
      name: String(options?.name ?? packageId),
      version: String(options?.version ?? '1.0.0'),
      trust: 'user',
      contributions,
    }
    await writeDebugRecord(path.join(directory, 'manifest.json'), packageManifest)
    const files = await new DebugWorkspace(directory).list()
    const archive = `${directory}.zip`
    await writeFile(
      archive,
      zipSync(
        Object.fromEntries(
          await Promise.all(
            files.map(
              async (name) => [name, await readFile(packagePath(directory, name))] as const,
            ),
          ),
        ),
      ),
    )
    return { directory, archive, manifest: packageManifest, installed: false, reviewRequired: true }
  }
}
