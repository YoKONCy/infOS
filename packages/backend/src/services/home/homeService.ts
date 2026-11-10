import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { DrizzleDb } from '../../database'
import {
  classifyDesktopRisk,
  desktopRiskFactsFromParameters,
  isSensitiveDesktopAction,
  type HomeIntent,
  type HomeLimits,
  type HomeScope,
  type HomeSettings,
} from '@infos/shared'
import { HomeRepository } from '../../repositories/home.repo'
import { HomeActivityService } from './homeActivity'
import { HomeAuthorizationService } from './homeAuthorization'
import { HomeStorage } from './homeStorage'
import { HomeCheckpointService } from './homeCheckpoints'
import { HomeFileService } from './homeFiles'
import { HomeBelongingsService } from './homeBelongings'
import { HomeCardService } from './homeCards'
import { HomeError } from './homeErrors'
import { ConfigRepository } from '../../repositories/config.repo'
import { HomeSettingsService } from './homeSettings'
import type { HomeNativeTrashHost } from './homeNativeDelete'
import type { HomeChatConfirmation } from './homeConfirmWait'
import { canonicalPath, containsPath, type HomeSensitiveLocations } from './homePaths'

/** 服务入口只由容器创建；同步文件通道使授权检查与写入在同一临界区完成。 */
export class HomeService {
  readonly repo: HomeRepository
  readonly activity: HomeActivityService
  readonly authorization: HomeAuthorizationService
  readonly storage: HomeStorage
  readonly checkpoints: HomeCheckpointService
  readonly files: HomeFileService
  readonly belongings: HomeBelongingsService
  readonly cards: HomeCardService
  readonly settings: HomeSettingsService
  /** 主进程提供的 Windows 回收站；没有在线客户端时为 undefined（见 homeNativeDelete）。 */
  nativeTrash?: HomeNativeTrashHost
  /** 没有桌面客户端在线时的确认入口：聊天审批卡片（见 homeConfirmWait）。 */
  chatConfirmation?: HomeChatConfirmation
  private permits = new Map<
    string,
    {
      scope: HomeScope
      intent: HomeIntent
      expiresAt: number
      revision: string
      consumed?: boolean
    }
  >()
  constructor(
    db: DrizzleDb,
    dataDir: string,
    workspace: (agentId: string) => string,
    now = Date.now,
    systemRoots?: string[],
    sensitive?: HomeSensitiveLocations,
  ) {
    this.repo = new HomeRepository(db)
    this.settings = new HomeSettingsService(new ConfigRepository(db))
    const limits = () => this.limits()
    this.activity = new HomeActivityService(this.repo, now, limits)
    this.storage = new HomeStorage(path.join(dataDir, 'home'), this.repo, limits, now)
    this.authorization = new HomeAuthorizationService(
      this.repo,
      this.activity,
      limits,
      (scope, file) => this.files.isOwn(scope, file),
      now,
      systemRoots,
      sensitive,
      (scope, file) => containsPath(canonicalPath(workspace(scope.agentId)), file),
    )
    this.checkpoints = new HomeCheckpointService(
      this.repo,
      this.storage,
      this.activity,
      limits,
      now,
    )
    this.files = new HomeFileService(
      this.repo,
      this.storage,
      this.authorization,
      this.checkpoints,
      this.activity,
      workspace,
      [dataDir],
    )
    this.belongings = new HomeBelongingsService(this.repo, this.storage, limits, now)
    this.cards = new HomeCardService(this.repo, this.activity, now)
    this.now = now
  }
  private now: () => number
  limits(): HomeSettings {
    return this.settings.read()
  }
  setLimits(input: Partial<HomeLimits>) {
    return this.settings.update(input)
  }
  authorizeDesktop(scope: HomeScope, intent: HomeIntent) {
    if (!['app', 'send', 'pay', 'settings', 'terminal'].includes(intent.action) || !intent.app)
      throw new HomeError('HOME_INVALID')
    for (const [id, permit] of this.permits)
      if (permit.expiresAt <= this.now()) this.permits.delete(id)
    // 复核：用同一份规则按宿主填的事实再判一次。宿主归成普通操作、复核却是发消息 / 付款 / 设置 / 终端时，
    // 照样按敏感动作每次都问（「以后都允许」免不掉）。
    const recheck = classifyDesktopRisk(
      desktopRiskFactsFromParameters(intent.parameters, intent.app),
    )
    const extra =
      !isSensitiveDesktopAction(intent.action) && isSensitiveDesktopAction(recheck.action)
        ? ['sensitive']
        : []
    const normalized = this.authorization.enforce(scope, intent, extra)
    const permitId = randomUUID(),
      expiresAt = this.now() + 30_000
    this.permits.set(permitId, {
      scope,
      intent: normalized,
      expiresAt,
      revision: this.authorization.version(),
    })
    return { permitId, expiresAt, intent: normalized }
  }
  consumeDesktop(permitId: string) {
    const permit = this.permits.get(permitId)
    if (
      !permit ||
      permit.consumed ||
      permit.expiresAt <= this.now() ||
      permit.revision !== this.authorization.version()
    )
      throw new HomeError('HOME_EXPIRED')
    permit.consumed = true
    return { intent: permit.intent, scope: permit.scope }
  }
  completeDesktop(permitId: string, result: 'success' | 'failed', detail?: string) {
    const permit = this.permits.get(permitId)
    if (!permit || !permit.consumed || permit.expiresAt <= this.now())
      throw new HomeError('HOME_EXPIRED')
    this.permits.delete(permitId)
    return this.activity.record(permit.scope, {
      action: permit.intent.action,
      objects: [permit.intent.app!],
      result,
      detail,
    })
  }
  close(scope: HomeScope) {
    this.authorization.close(scope)
    for (const [id, permit] of this.permits)
      if (permit.scope.agentId === scope.agentId && permit.scope.sessionId === scope.sessionId)
        this.permits.delete(id)
  }
  /** 清空聊天或恢复出厂前，结束所有待确认与会话级操作许可。 */
  closeAllSessions(): void {
    const scopes = new Map<string, HomeScope>()
    for (const kind of ['grant', 'confirmation', 'declaration', 'owned'] as const) {
      for (const scope of this.repo.list<HomeScope>(kind)) {
        if (scope.sessionId) scopes.set(JSON.stringify([scope.agentId, scope.sessionId]), scope)
      }
    }
    for (const permit of this.permits.values()) {
      const scope = permit.scope
      scopes.set(JSON.stringify([scope.agentId, scope.sessionId]), scope)
    }
    for (const scope of scopes.values()) this.close(scope)
  }
}
