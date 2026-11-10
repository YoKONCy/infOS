import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { existsSync, lstatSync } from 'node:fs'
import type {
  HomeChoice,
  HomeConfirmation,
  HomeGrant,
  HomeIntent,
  HomeSettings,
  HomeScope,
} from '@infos/shared'
import type { HomeRepository } from '../../repositories/home.repo'
import type { HomeActivityService } from './homeActivity'
import {
  canonicalPath,
  containsPath,
  isSensitiveLocation,
  pathKey,
  protectedRoots,
  resolveLocations,
  sensitiveLocations,
  type HomeSensitiveLocations,
} from './homePaths'
import { HomeError } from './homeErrors'

/** 等一个确认的结局。 */
export type HomeConfirmationOutcome = 'approved' | 'denied' | 'expired' | 'cancelled'

/** 批量事实：mutation 记录多带一份这次新建的路径。 */
type MutationRow = import('@infos/shared').HomeActivity & { created?: string[] }

interface Declaration extends HomeScope {
  id: string
  paths: string[]
  apps: string[]
}
const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(',')}}`
  return JSON.stringify(value) ?? 'null'
}
/** 跨程序拖动的终点程序（小写 exe 名）；没有返回 undefined。 */
const dropAppOf = (intent: HomeIntent) => {
  const value = intent.parameters?.dropApp
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : undefined
}
export const intentHash = (intent: HomeIntent) =>
  createHash('sha256').update(stable(intent)).digest('hex')

export class HomeAuthorizationService {
  readonly runtimeId = randomUUID()
  private waiters = new Map<string, Set<(outcome: HomeConfirmationOutcome) => void>>()
  private waitGuard?: (threadId: string) => () => void
  /** 用户批准过的批量（工作区删除、大量新建）：本任务内同类不再逐个问。只在内存里，重启就要重新问。 */
  private batchAllowed = new Set<string>()
  constructor(
    private repo: HomeRepository,
    private activity: HomeActivityService,
    private limits: () => HomeSettings,
    private own: (scope: HomeScope, file: string) => boolean,
    private now = Date.now,
    private systemRoots = protectedRoots(),
    private sensitive: HomeSensitiveLocations = sensitiveLocations(),
    private inWorkspace: (scope: HomeScope, file: string) => boolean = () => false,
  ) {
    this.systemRoots = systemRoots.map(canonicalPath)
    this.sensitive = resolveLocations(sensitive)
  }
  private declarationId(scope: HomeScope) {
    return `declaration:${scope.agentId}:${scope.sessionId}:${scope.taskId ?? ''}`
  }
  /**
   * 会话级声明：只由可信宿主在用户批准后合并写入（本机批准任务预批、在确认里选「这个应用以后都允许」）。
   * 任务 ID 不能含 @，Agent 的 home_declare 永远写不到这里。
   */
  private sessionDeclarationId(scope: HomeScope) {
    return `declaration:${scope.agentId}:${scope.sessionId}:@session`
  }
  private epoch() {
    return this.repo.get<{ value: number }>('state', 'home:revision')?.value ?? 0
  }
  private revision() {
    return `${this.epoch()}:${createHash('sha256').update(stable(this.limits())).digest('hex')}`
  }
  version() {
    return this.revision()
  }
  private bump() {
    this.repo.put('state', { id: 'home:revision', agentId: '', value: this.epoch() + 1 } as {
      id: string
      agentId: string
      value: number
    })
  }
  normalize(intent: HomeIntent): HomeIntent {
    return {
      ...intent,
      paths: [...new Set(intent.paths.map((file) => pathKey(canonicalPath(file))))],
      app: intent.app?.trim().toLowerCase(),
    }
  }
  /**
   * 合并进声明：只增不减，已有的路径和应用都保留。只给管理接口（用户或可信宿主的显式意图）用；
   * 不带 taskId 时写会话级声明，带 taskId 时合并进该任务的声明。读改写在同一事务里完成。
   */
  mergeDeclaration(scope: HomeScope, paths: string[], apps: string[]) {
    return this.repo.transaction(() => {
      const id = scope.taskId ? this.declarationId(scope) : this.sessionDeclarationId(scope)
      const previous = this.repo.get<Declaration>('declaration', id)
      const merged = {
        ...scope,
        id,
        paths: [...(previous?.paths ?? [])],
        apps: [
          ...new Set([...(previous?.apps ?? []), ...apps.map((app) => app.trim().toLowerCase())]),
        ],
      }
      for (const file of paths.map(canonicalPath))
        if (!merged.paths.some((root) => pathKey(root) === pathKey(file))) merged.paths.push(file)
      this.repo.put('declaration', merged)
      this.activity.record(scope, {
        action: 'declare',
        objects: [...merged.paths, ...merged.apps],
        result: 'success',
        detail: 'merge',
      })
      return merged
    })
  }
  declare(scope: HomeScope, paths: string[], apps: string[], confirmExpansion = false) {
    const value = {
      ...scope,
      id: this.declarationId(scope),
      paths: paths.map(canonicalPath),
      apps: apps.map((app) => app.trim().toLowerCase()),
    }
    const previous = this.repo.get<Declaration>('declaration', value.id)
    if (
      confirmExpansion &&
      previous &&
      (value.paths.some((file) => !previous.paths.some((root) => containsPath(root, file))) ||
        value.apps.some((app) => !previous.apps.includes(app)))
    ) {
      this.enforce(
        scope,
        { action: 'write', paths: value.paths, parameters: { declaration: value } },
        ['undeclared'],
      )
    }
    this.repo.put('declaration', value)
    this.activity.record(scope, {
      action: 'declare',
      objects: [...value.paths, ...value.apps],
      result: 'success',
    })
    return value
  }
  grants(agentId: string) {
    return this.repo
      .list<HomeGrant>('grant', agentId)
      .filter((grant) => grant.duration === 'permanent' || grant.runtimeId === this.runtimeId)
  }
  grant(
    scope: HomeScope,
    kind: 'folder' | 'app',
    target: string,
    access: 'read' | 'write',
    duration: 'session' | 'permanent',
  ) {
    const value: HomeGrant = {
      ...scope,
      id: randomUUID(),
      kind,
      target: kind === 'folder' ? canonicalPath(target) : target.trim().toLowerCase(),
      access,
      duration,
      runtimeId: duration === 'session' ? this.runtimeId : undefined,
    }
    this.repo.put('grant', value)
    return value
  }
  revoke(agentId: string, id: string) {
    const grant = this.repo.get<HomeGrant>('grant', id)
    if (!grant || grant.agentId !== agentId) throw new HomeError('HOME_NOT_FOUND')
    this.repo.transaction(() => {
      this.repo.remove('grant', id)
      this.bump()
    })
  }
  close(scope: HomeScope) {
    // 会话关了，还在等确认的工具调用立刻收尾。
    for (const row of this.repo.list<HomeConfirmation>(
      'confirmation',
      scope.agentId,
      scope.sessionId,
    ))
      this.settle(row.id, 'cancelled')
    const prefix = `${scope.agentId}\u0000${scope.sessionId}\u0000`
    for (const key of this.batchAllowed) if (key.startsWith(prefix)) this.batchAllowed.delete(key)
    this.repo.transaction(() => {
      for (const kind of ['grant', 'declaration', 'confirmation', 'owned', 'mutation'] as const) {
        for (const value of this.repo.list<{ id: string; duration?: string }>(
          kind,
          scope.agentId,
          scope.sessionId,
        )) {
          if (kind !== 'grant' || value.duration !== 'permanent') this.repo.remove(kind, value.id)
        }
      }
      this.bump()
    })
  }
  /** 只认 write 授权：看不需要授权，旧数据里的 read 授权保留但不放行任何修改。 */
  private hasGrant(scope: HomeScope, kind: 'folder' | 'app', target: string) {
    return this.grants(scope.agentId).some(
      (grant) =>
        grant.kind === kind &&
        (grant.duration === 'permanent' || grant.sessionId === scope.sessionId) &&
        grant.access === 'write' &&
        (kind === 'folder' ? containsPath(grant.target, target) : grant.target === target),
    )
  }
  private batchKey(scope: HomeScope, kind: string) {
    return `${scope.agentId}\u0000${scope.sessionId}\u0000${scope.taskId ?? ''}\u0000${kind}`
  }
  private assess(scope: HomeScope, intent: HomeIntent) {
    const reasons = new Set<string>(),
      mutation = intent.action !== 'read'
    let summary: HomeConfirmation['summary']
    const ownDeclaration = this.repo.get<Declaration>('declaration', this.declarationId(scope))
    // 任务声明与会话级声明（宿主在用户批准后合并的）一起算放行范围。
    const declarations = [
      ownDeclaration,
      this.repo.get<Declaration>('declaration', this.sessionDeclarationId(scope)),
    ].filter((row): row is Declaration => !!row)
    const roots = declarations.flatMap((row) => row.paths),
      apps = declarations.flatMap((row) => row.apps)
    // 跨程序拖动的终点程序同样要声明、授权（宿主填 parameters.dropApp）。
    const dropApp = dropAppOf(intent)
    // 她自己的地方（工作区、这次自己建的文件）增删改都不问，不用声明。
    const foreignPaths = intent.paths.filter((file) => !this.own(scope, file))
    const onlyOwnFiles = intent.paths.length > 0 && foreignPaths.length === 0 && !intent.app
    // 新建原来不存在的文件不算改你的文件；看磁盘事实，不信调用方填的参数。
    const creating = (file: string) =>
      (intent.action === 'write' || intent.action === 'move') && !existsSync(file)
    const yourFiles = foreignPaths.filter((file) => !creating(file))
    // 她自己声明过（home_declare）才有「超出声明」：没声明不因此问。发消息、付款等不靠这条，见下面 sensitive。
    if (
      mutation &&
      !onlyOwnFiles &&
      ownDeclaration &&
      (foreignPaths.some((file) => !roots.some((root) => containsPath(root, file))) ||
        (intent.app && !apps.includes(intent.app)) ||
        (dropApp && !apps.includes(dropApp)))
    )
      reasons.add('undeclared')
    if (['send', 'pay', 'settings', 'terminal'].includes(intent.action)) reasons.add('sensitive')
    if (intent.action === 'delete' && !onlyOwnFiles) reasons.add('delete')
    if (
      intent.action === 'app' &&
      (!intent.app ||
        !this.hasGrant(scope, 'app', intent.app) ||
        (dropApp && !this.hasGrant(scope, 'app', dropApp)))
    )
      reasons.add('app')
    for (const file of intent.paths) {
      if (mutation && this.systemRoots.some((root) => containsPath(root, file)))
        reasons.add('system')
      // 启动项、PATH 这些放进去就会生效：优先于「新建」和「她建的」，文件夹授权也不能跳过。
      if (mutation && isSensitiveLocation(this.sensitive, file)) reasons.add('autorun')
      if (
        mutation &&
        !creating(file) &&
        !this.own(scope, file) &&
        !this.hasGrant(scope, 'folder', file)
      )
        reasons.add('existing')
    }
    if (mutation && intent.paths.length) {
      const limit = this.limits().massChangeThreshold,
        since = this.now() - this.limits().massChangeWindowMs
      const rows = this.repo
        .list<MutationRow>('mutation')
        .filter((row) => row.result === 'success' && !!row.checkpointId)
      const sameTask = (row: MutationRow) =>
        row.agentId === scope.agentId &&
        row.sessionId === scope.sessionId &&
        row.taskId === scope.taskId
      const ownCache = new Map<string, boolean>()
      const isOwn = (file: string) => {
        if (!ownCache.has(file)) ownCache.set(file, this.own(scope, file))
        return ownCache.get(file)!
      }
      /** 同任务累计和短时跨会话累计取较大者。 */
      const counted = (seed: string[], objectsOf: (row: MutationRow) => string[]) => {
        const task = new Set(seed),
          recent = new Set(seed)
        for (const row of rows) {
          const objects = objectsOf(row).map(pathKey)
          if (sameTask(row)) objects.forEach((file) => task.add(file))
          if (row.time >= since) objects.forEach((file) => recent.add(file))
        }
        return Math.max(task.size, recent.size)
      }
      // 你的文件：只计你的，她自己的不算；这次没碰你的文件就不用判。批准只放行这一次。
      if (
        yourFiles.length &&
        counted(yourFiles, (row) => row.objects.filter((f) => !isOwn(pathKey(f)))) > limit
      )
        reasons.add('mass')
      // 新建：在工作区外短时间大量新建也要问一次；不按任务累计，长任务慢慢生成不打扰。
      const created = foreignPaths.filter(creating)
      if (created.length && !this.batchAllowed.has(this.batchKey(scope, 'create'))) {
        const recent = new Set(created)
        for (const row of rows)
          if (row.time >= since)
            for (const file of row.created ?? [])
              if (!this.inWorkspace(scope, file)) recent.add(pathKey(file))
        if (recent.size > limit) {
          reasons.add('mass')
          summary = { kind: 'create', count: recent.size, root: path.dirname(created[0]!) }
        }
      }
      // 她自己的文件：写和改不问；批量删除跨调用累计，防止拆成逐个删，问一次就够。
      const ownDeletes =
        intent.action === 'delete' ? intent.paths.filter((file) => isOwn(file)) : []
      if (ownDeletes.length && !this.batchAllowed.has(this.batchKey(scope, 'own-delete'))) {
        const count = counted(ownDeletes, (row) =>
          row.action === 'delete' ? row.objects.filter((f) => isOwn(pathKey(f))) : [],
        )
        if (count > limit) {
          reasons.add('mass')
          summary = { kind: 'own-delete', count, root: path.dirname(ownDeletes[0]!) }
        }
      }
    }
    return { reasons: [...reasons], summary }
  }
  /** 只在即将产生副作用的同一同步临界区调用；无自动批准路径。 */
  enforce(scope: HomeScope, raw: HomeIntent, additionalReasons: string[] = []): HomeIntent {
    const intent = this.normalize(raw),
      assessed = this.assess(scope, intent),
      reasons = [...new Set([...assessed.reasons, ...additionalReasons])]
    if (!reasons.length) return intent
    const fingerprint = intentHash(intent),
      revision = this.revision()
    const previous = this.repo
      .list<HomeConfirmation>('confirmation', scope.agentId, scope.sessionId)
      .reverse()
      .find(
        (row) =>
          row.runtimeId === this.runtimeId &&
          row.taskId === scope.taskId &&
          row.fingerprint === fingerprint &&
          row.revision === revision &&
          row.expiresAt > this.now() &&
          row.status !== 'consumed' &&
          reasons.every((reason) => row.reasons.includes(reason)),
      )
    if (previous?.status === 'approved') {
      this.repo.put('confirmation', { ...previous, status: 'consumed' })
      if (previous.summary) this.batchAllowed.add(this.batchKey(scope, previous.summary.kind))
      return intent
    }
    if (previous?.status === 'denied')
      throw new HomeError('HOME_DENIED', {
        paths: intent.paths,
        app: intent.app,
        operationId: previous.id,
      })
    if (previous) throw new HomeError('HOME_CONFIRMATION_REQUIRED', previous)
    const hard = reasons.some((reason) =>
      ['undeclared', 'sensitive', 'delete', 'system', 'autorun', 'mass'].includes(reason),
    )
    const grantTargets: HomeConfirmation['grantTargets'] = intent.paths.map((file) => ({
      kind: 'folder',
      target: existsSync(file) && lstatSync(file).isDirectory() ? file : path.dirname(file),
      access: 'write',
    }))
    if (intent.app) grantTargets.push({ kind: 'app', target: intent.app, access: 'write' })
    const dropApp = dropAppOf(intent)
    if (dropApp && dropApp !== intent.app)
      grantTargets.push({ kind: 'app', target: dropApp, access: 'write' })
    const request: HomeConfirmation = {
      ...scope,
      id: randomUUID(),
      intent,
      reasons,
      choices: hard ? ['once', 'deny'] : ['once', 'session', 'permanent', 'deny'],
      createdAt: this.now(),
      expiresAt: this.now() + this.limits().confirmationTimeoutMs,
      status: 'pending',
      fingerprint,
      revision,
      runtimeId: this.runtimeId,
      grantTargets,
      ...(assessed.summary ? { summary: assessed.summary } : {}),
    }
    this.repo.put('confirmation', request, request.createdAt)
    this.activity.record(scope, {
      action: intent.action,
      objects: intent.paths.length ? intent.paths : [intent.app ?? intent.action],
      result: 'waiting',
    })
    this.activity.emit({ type: 'confirmation', data: request })
    throw new HomeError('HOME_CONFIRMATION_REQUIRED', request)
  }
  pending(agentId?: string) {
    return this.repo
      .list<HomeConfirmation>('confirmation', agentId)
      .filter(
        (row) =>
          row.runtimeId === this.runtimeId &&
          row.status === 'pending' &&
          row.expiresAt > this.now() &&
          row.revision === this.revision(),
      )
  }
  answer(id: string, choice: HomeChoice) {
    const request = this.repo.get<HomeConfirmation>('confirmation', id)
    if (!request) throw new HomeError('HOME_NOT_FOUND')
    if (
      request.runtimeId !== this.runtimeId ||
      request.status !== 'pending' ||
      request.expiresAt <= this.now() ||
      request.revision !== this.revision()
    )
      throw new HomeError('HOME_EXPIRED')
    if (!request.choices.includes(choice)) throw new HomeError('HOME_INVALID')
    this.repo.transaction(() => {
      if (choice === 'session' || choice === 'permanent') {
        for (const target of request.grantTargets)
          this.grant(request, target.kind, target.target, target.access, choice)
      }
      this.repo.put('confirmation', {
        ...request,
        status: choice === 'deny' ? 'denied' : 'approved',
      })
    })
    this.activity.record(request, {
      action: 'confirmation',
      objects: request.intent.paths,
      result: choice === 'deny' ? 'failed' : 'success',
      detail: choice,
    })
    // 通知另一处展示端收起卡片；状态不再是 pending，它们只会移除。
    const answered = this.repo.get<HomeConfirmation>('confirmation', id)
    if (answered) this.activity.emit({ type: 'confirmation', data: answered })
    this.settle(id, choice === 'deny' ? 'denied' : 'approved')
    return { id, choice }
  }
  /** 宿主注入：等确认期间暂停这个回合的超时（和终端审批的等待同一个保护），不影响其他会话。 */
  setWaitGuard(guard: (threadId: string) => () => void) {
    this.waitGuard = guard
  }
  private settle(id: string, outcome: HomeConfirmationOutcome) {
    const waiting = this.waiters.get(id)
    if (!waiting) return
    this.waiters.delete(id)
    for (const wake of [...waiting]) wake(outcome)
  }
  /**
   * 挂起等用户应答，上限是确认自带的 expiresAt。只读状态，不会替用户作答；
   * 真正放行还是靠重试时 enforce 消费这条确认。同一确认可以有多个等待方，全部取消才作废。
   */
  waitForAnswer(request: HomeConfirmation, signal?: AbortSignal) {
    const current = this.repo.get<HomeConfirmation>('confirmation', request.id)
    if (current?.status === 'approved' && current.expiresAt > this.now())
      return Promise.resolve<HomeConfirmationOutcome>('approved')
    if (current?.status === 'denied') return Promise.resolve<HomeConfirmationOutcome>('denied')
    if (!current || current.status !== 'pending' || current.expiresAt <= this.now()) {
      this.dismiss(request.id, 'expired')
      return Promise.resolve<HomeConfirmationOutcome>('expired')
    }
    return new Promise<HomeConfirmationOutcome>((resolve) => {
      const waiting = this.waiters.get(request.id) ?? new Set()
      this.waiters.set(request.id, waiting)
      const release = this.waitGuard?.(request.sessionId)
      const finish = (outcome: HomeConfirmationOutcome) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        release?.()
        waiting.delete(finish)
        if (!waiting.size && this.waiters.get(request.id) === waiting)
          this.waiters.delete(request.id)
        resolve(outcome)
      }
      // 用户按停止：当场取消等待并作废确认，之后再点批准也没用。
      const abort = () => {
        finish('cancelled')
        this.dismiss(request.id, 'cancelled')
      }
      const timer = setTimeout(
        () => {
          this.dismiss(request.id, 'expired')
          finish('expired')
        },
        Math.max(0, current.expiresAt - this.now()),
      )
      timer.unref?.()
      waiting.add(finish)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
    })
  }
  /**
   * 作废一条还没用掉的确认（超时、用户按停止、文件已变、没地方确认）：之后再也答不了、消费不了，
   * 同时通知展示端收起卡片。取消时如果还有别的等待方在等同一条，就留着。
   */
  dismiss(id: string, detail: 'expired' | 'cancelled' | 'conflict' | 'no_surface') {
    if (detail === 'cancelled' && this.waiters.get(id)?.size) return
    const request = this.repo.get<HomeConfirmation>('confirmation', id)
    if (!request || (request.status !== 'pending' && request.status !== 'approved')) return
    const closed: HomeConfirmation = { ...request, status: 'consumed' }
    this.repo.put('confirmation', closed)
    this.activity.record(request, {
      action: request.intent.action,
      objects: request.intent.paths.length
        ? request.intent.paths
        : [request.intent.app ?? request.intent.action],
      result: detail === 'conflict' ? 'conflict' : 'failed',
      detail,
    })
    this.activity.emit({ type: 'confirmation', data: closed })
  }
}
