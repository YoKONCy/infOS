/**
 * @file 桌面操作护栏核心：名单与用户设置的加载、签名持久化、分区判断、审批与授权记录。
 * @platform ELECTRON
 * @see .docs/P03_DESKTOP_SHELL.md 阶段 2
 */

import { t as __t } from '../utils/i18n'
import fs from 'node:fs'
import path from 'node:path'
import { logger } from '../utils/logger'
import { sameSignature } from './settingsSigner'
import {
  lastAccepted,
  rememberAccepted,
  verifyVersioned,
  versionedPayload,
} from './versionedSettings'
import {
  DESKTOP_SAFETY_LIMITS,
  applyDesktopSafetyChange,
  buildDesktopZoneIndex,
  classifyDesktopTarget,
  createDefaultDesktopSafetySettings,
  decideDesktopAction,
  desktopSafetyLoosenings,
  desktopProgramLists,
  normalizeDesktopSafetyChange,
  normalizeProgramName,
  stricterDesktopSafety,
  validateDesktopSafetyDraft,
  validateDesktopSafetySettings,
  type DesktopSafetyDraft,
  type DesktopSafetyIssue,
  type DesktopSafetySettings,
  type DesktopTarget,
  type DesktopZone,
  type DesktopZoneIndex,
  type DesktopZoneResult,
} from '../../../packages/shared/src/desktopSafety'
import type { DesktopGuardDeps, DesktopSafetyState, GuardCaller } from './desktopGuardModel'

/** 拒绝或要求重新观察的错误（错误码在后端工具中视为“未执行”）。 */
function guardError(code: string, message: string, args: unknown[] = []): Error {
  return new Error(`${code}: ${__t('electron.ui.desktopGuard', message, args)}`)
}

const DOMAIN = 'desktop-safety'
const stableAction = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableAction).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableAction(v)}`)
      .join(',')}}`
  return JSON.stringify(value)
}

/** 执行类动作的审批结果：是否刚弹过审批框，以及“允许这一次”的键（需要时用掉）。 */
export interface GuardOutcome {
  prompted: boolean
  onceKey?: string
  /** 用户在本机审批框里的回答（弹过框时才有），用于转给后端同一个确认请求。 */
  answer?: 'once' | 'thread' | 'trust'
  /** 没弹框直接放行时的依据（信任名单、本次对话、任务预批、只提醒、允许这一次）。 */
  via?: 'trusted' | 'notify' | 'plan' | 'thread' | 'once'
}

export class DesktopGuard {
  private draft: DesktopSafetyDraft | null = null
  private draftIssues: DesktopSafetyIssue[] = []
  /** 生效中的设置。 */
  private settings: DesktopSafetySettings = createDefaultDesktopSafetySettings()
  private externalEdit = false
  private fileIssues: DesktopSafetyIssue[] = []
  private index: DesktopZoneIndex | null = null
  private loaded = false
  private revision = 0
  private fileSnapshot = ''
  private degraded = false
  private readonly threadGrants = new Map<string, Set<string>>()
  private readonly plans = new Map<string, { programs: Set<string>; expiresAt: number }>()
  private readonly onceGrants = new Map<string, number>()

  constructor(private readonly deps: DesktopGuardDeps) {}

  // ─── 名单读写 ─────────────────────────────────────

  load(): void {
    const draft = validateDesktopSafetyDraft(this.deps.draft)
    this.draft = draft.ok ? draft.value : null
    this.draftIssues = draft.issues
    if (!draft.ok)
      logger.error(
        'DesktopGuard',
        __t('electron.logs.desktopGuard', '内置桌面安全名单无效，所有程序按高危区处理：{0}', [
          JSON.stringify(draft.issues),
        ]),
      )
    const acceptedFile = this.deps.acceptedFile()
    const known = lastAccepted<DesktopSafetySettings>(acceptedFile)
    const stored = this.readSigned(acceptedFile)
    this.revision = Math.max(this.revision, known?.revision ?? 0, stored?.revision ?? 0)
    const accepted = stored?.settings ?? known?.value ?? createDefaultDesktopSafetySettings()
    this.externalEdit = false
    this.fileIssues = []
    const file = this.deps.userFile()
    const firstUse =
      !known &&
      !fs.existsSync(acceptedFile) &&
      !fs.existsSync(file) &&
      !this.loaded &&
      !this.deps.signer.hasKey?.()
    if (!stored && !firstUse) this.fileIssues.push({ code: 'BASELINE_INVALID', field: 'accepted' })
    // 用户确认过这一版就不再问：确认记录带签名存盘，只对这一版内容有效，重启后还算数。
    const confirmed = !!stored && (known?.confirmed === true || this.readConfirmation(stored))
    if (stored && !confirmed)
      this.fileIssues.push({ code: 'BASELINE_INVALID', field: 'accepted.confirmation' })
    if (stored) rememberAccepted(acceptedFile, DOMAIN, stored.revision, stored.settings, confirmed)
    let effective = accepted
    let raw: unknown
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      raw = undefined
    }
    if (!firstUse) {
      const parsed = validateDesktopSafetySettings(raw, this.draft ?? undefined)
      const envelope = raw as { signature?: unknown; revision?: number } | undefined
      if (!parsed.ok)
        this.fileIssues.push(
          ...(raw === undefined ? [{ code: 'NOT_OBJECT' as const, field: 'user' }] : parsed.issues),
        )
      else {
        const valid = verifyVersioned(
          acceptedFile,
          DOMAIN,
          envelope?.revision,
          parsed.value,
          envelope?.signature,
          this.deps.signer,
        )
        const matches =
          stored &&
          envelope?.revision === stored.revision &&
          stableAction(parsed.value) === stableAction(stored.settings)
        if (!valid || !matches) {
          // 任何不受信输入只应用收紧部分，旧签名也不能恢复已经撤销的许可。
          effective = stricterDesktopSafety(accepted, parsed.value)
          this.externalEdit = true
          this.fileIssues.push({ code: 'SIGNATURE_INVALID', field: 'user.signature' })
        } else effective = parsed.value
      }
    }
    if (this.degraded && !this.fileIssues.length)
      this.fileIssues.push({ code: 'BASELINE_INVALID', field: 'recovery' })
    this.degraded ||= this.fileIssues.length > 0
    if (this.degraded && this.loaded) effective = stricterDesktopSafety(effective, this.settings)
    if (this.degraded) effective = { ...effective, normalMode: 'always', trusted: [] }
    this.clearGrants()
    this.apply(effective)
    this.loaded = true
    this.fileSnapshot = this.snapshotFiles()
  }

  private snapshotFiles(): string {
    return JSON.stringify(
      [this.deps.userFile(), this.deps.acceptedFile()].map((file) => {
        try {
          return fs.readFileSync(file, 'utf8')
        } catch {
          return null
        }
      }),
    )
  }

  private ensureLoaded(): void {
    if (!this.loaded || this.fileSnapshot !== this.snapshotFiles()) this.load()
  }

  private confirmationFile(): string {
    return `${this.deps.acceptedFile()}.confirmed`
  }

  private confirmationPayload(revision: number, settings: DesktopSafetySettings): string {
    return `confirmed:${versionedPayload(DOMAIN, revision, settings)}`
  }

  private readConfirmation(stored: { settings: DesktopSafetySettings; revision: number }): boolean {
    try {
      const raw = JSON.parse(fs.readFileSync(this.confirmationFile(), 'utf8')) as { signature?: unknown }
      return sameSignature(raw.signature, this.deps.signer.sign(this.confirmationPayload(stored.revision, stored.settings)))
    } catch {
      return false
    }
  }

  private readSigned(file: string): { settings: DesktopSafetySettings; revision: number } | null {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        signature?: unknown
        revision: number
      }
      const parsed = validateDesktopSafetySettings(raw, this.draft ?? undefined)
      if (
        !parsed.ok ||
        !verifyVersioned(
          this.deps.acceptedFile(),
          DOMAIN,
          raw.revision,
          parsed.value,
          raw.signature,
          this.deps.signer,
        )
      )
        return null
      return { settings: parsed.value, revision: raw.revision }
    } catch {
      return null
    }
  }

  private apply(settings: DesktopSafetySettings): void {
    this.settings = settings
    this.index = buildDesktopZoneIndex(this.draft, settings, this.deps.selfPrograms())
    if (this.degraded) this.index.failClosed = true
  }

  /** 写入用户文件与“已接受”副本（都带签名），并立即生效。 */
  private persist(settings: DesktopSafetySettings): void {
    const revision =
      Math.max(this.revision, lastAccepted(this.deps.acceptedFile())?.revision ?? 0) + 1
    const signature = this.deps.signer.sign(versionedPayload(DOMAIN, revision, settings))
    if (!signature) throw new Error('DESKTOP_SAFETY_ENCRYPTION_UNAVAILABLE')
    const content = `${JSON.stringify({ ...settings, revision, signature }, null, 2)}\n`
    for (const file of [this.deps.userFile(), this.deps.acceptedFile()]) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const temporary = `${file}.tmp`
      fs.writeFileSync(temporary, content, 'utf8')
      fs.renameSync(temporary, file)
    }
    const confirmation = this.deps.signer.sign(this.confirmationPayload(revision, settings))
    const confirmationTemporary = `${this.confirmationFile()}.tmp`
    fs.writeFileSync(confirmationTemporary, JSON.stringify({ revision, signature: confirmation }), 'utf8')
    fs.renameSync(confirmationTemporary, this.confirmationFile())
    rememberAccepted(this.deps.acceptedFile(), DOMAIN, revision, settings)
    this.revision = revision
    this.externalEdit = false
    this.fileIssues = []
    this.degraded = false
    this.clearGrants()
    this.apply(settings)
    this.loaded = true
    this.fileSnapshot = this.snapshotFiles()
  }

  state(): DesktopSafetyState {
    this.ensureLoaded()
    return {
      draftStatus: this.draft?.status ?? '',
      draftValid: this.draft !== null,
      draftIssues: [...this.draftIssues],
      draft: this.draft ? desktopProgramLists(this.draft) : null,
      settings: structuredClone(this.settings),
      externalEdit: this.externalEdit,
      fileIssues: [...this.fileIssues],
      filePath: this.deps.userFile(),
    }
  }

  // ─── 判断与审批 ───────────────────────────────────

  private threadKey(caller: GuardCaller): string {
    return `${caller.agentId ?? 'system'}:${caller.threadId ?? 'desktop'}`
  }
  private taskKey(caller: GuardCaller): string {
    return `${caller.agentId ?? 'system'}:${caller.taskId ?? caller.threadId ?? 'desktop'}`
  }
  private onceKey(
    caller: GuardCaller,
    target: DesktopTarget,
    zone: DesktopZoneResult,
    detail: string,
    intent: unknown,
  ): string {
    // 一次授权绑定同一动作及目标，不能把普通动作的授权挪用于高危动作。
    return `${this.taskKey(caller)}\u0000${stableAction({ target, zone, detail, intent })}`
  }

  classify(target: DesktopTarget): DesktopZoneResult {
    this.ensureLoaded()
    return classifyDesktopTarget(this.index!, target)
  }

  /**
   * 动作前检查。允许时返回；禁区或用户拒绝时抛错。
   * reobserve 为 true 时，用户刚批准后也抛 `DESKTOP_APPROVED_REOBSERVE`，批准在有效期内保留。
   * 传入 `outcome` 时（桌面执行类动作）不抛这个错：记下是否弹过审批框与这次批准的键，
   * 由调用方核对画面后决定直接执行（`consumeOnce` 用掉批准）还是要求重新观察（批准保留）。
   */
  async check(
    caller: GuardCaller,
    target: DesktopTarget,
    detail: string,
    reobserve: boolean,
    intent: unknown = null,
    outcome?: GuardOutcome,
  ): Promise<DesktopZone> {
    this.ensureLoaded()
    const now = this.deps.now()
    const zone = classifyDesktopTarget(this.index!, target)
    const onceKey = this.onceKey(caller, target, zone, detail, intent)
    const onceExpiry = this.onceGrants.get(onceKey)
    const plan = this.plans.get(this.taskKey(caller))
    const decision = decideDesktopAction(zone, this.settings.normalMode, this.index!, {
      thread: this.threadGrants.get(this.threadKey(caller)) ?? new Set(),
      plan: plan && plan.expiresAt > now ? plan.programs : new Set(),
      once: onceExpiry !== undefined && onceExpiry > now ? new Set([zone.program]) : new Set(),
    })
    if (decision.verdict === 'allow') {
      if (outcome) outcome.via = decision.via
      // “允许这一次”只用一次。
      if (decision.via === 'once') this.onceGrants.delete(onceKey)
      return zone.zone
    }
    if (decision.verdict === 'deny')
      throw guardError('DESKTOP_FORBIDDEN', '目标程序在禁区内，角色不能操作：{0}', [
        zone.program || target.program,
      ])
    const answer = await this.deps.prompt({ kind: 'action', ask: decision.kind, zone, detail })
    if (answer === 'deny') throw guardError('DESKTOP_APPROVAL_DENIED', '用户拒绝了这次桌面操作')
    this.ensureLoaded()
    const currentZone = classifyDesktopTarget(this.index!, target)
    if (stableAction(currentZone) !== stableAction(zone))
      return this.check(caller, target, detail, reobserve, intent, outcome)
    if (decision.kind === 'every' && answer !== 'once')
      throw guardError('DESKTOP_APPROVAL_DENIED', '用户拒绝了这次桌面操作')
    if (outcome) {
      outcome.prompted = true
      outcome.answer = answer === 'approve' ? 'once' : answer
    }
    if (answer === 'trust')
      this.persist(applyDesktopSafetyChange(this.settings, { trust: [zone.program] }))
    else if (answer === 'thread') {
      const key = this.threadKey(caller)
      this.threadGrants.set(key, new Set([...(this.threadGrants.get(key) ?? []), zone.program]))
    } else if (reobserve || outcome) {
      this.onceGrants.set(onceKey, this.deps.now() + DESKTOP_SAFETY_LIMITS.onceTtlMs)
      if (outcome) outcome.onceKey = onceKey
    }
    if (reobserve)
      throw guardError(
        'DESKTOP_APPROVED_REOBSERVE',
        '用户已批准；审批期间焦点已变化，请重新观察后再执行',
      )
    return zone.zone
  }

  /**
   * 执行模式为「手动」时：本机护栏放行但没弹框（信任、本会话允许、预批、只提醒），
   * 仍要用户对这一个动作点「允许这一次」。禁区照旧拒绝。
   */
  async confirmEach(target: DesktopTarget, detail: string): Promise<void> {
    this.ensureLoaded()
    const zone = classifyDesktopTarget(this.index!, target)
    if (zone.zone === 'forbidden')
      throw guardError('DESKTOP_FORBIDDEN', '目标程序在禁区内，角色不能操作：{0}', [
        zone.program || target.program,
      ])
    const answer = await this.deps.prompt({ kind: 'action', ask: 'every', zone, detail })
    if (answer !== 'once') throw guardError('DESKTOP_APPROVAL_DENIED', '用户拒绝了这次桌面操作')
  }

  /** 批准后动作已直接执行：用掉“允许这一次”，不能再拿它重放同一动作。 */
  consumeOnce(key: string): void {
    this.onceGrants.delete(key)
  }

  /** 任务预批：一次审批覆盖任务声明的普通区程序；高危区与禁区不在预批范围内。 */
  async plan(caller: GuardCaller, programs: unknown, purpose: unknown) {
    this.ensureLoaded()
    if (
      !Array.isArray(programs) ||
      programs.length === 0 ||
      programs.length > DESKTOP_SAFETY_LIMITS.planPrograms ||
      !programs.every((item) => typeof item === 'string' && normalizeProgramName(item))
    )
      throw guardError('DESKTOP_PLAN_INVALID', '预批需要 1–{0} 个程序名', [
        DESKTOP_SAFETY_LIMITS.planPrograms,
      ])
    const covered: string[] = []
    const excluded: string[] = []
    for (const program of new Set((programs as string[]).map(normalizeProgramName))) {
      const zone = classifyDesktopTarget(this.index!, { program })
      ;(zone.zone === 'normal' ? covered : excluded).push(program)
    }
    const text = String(purpose ?? '').slice(0, 300)
    if (!covered.length) return { approved: false, covered, excluded }
    const answer = await this.deps.prompt({ kind: 'plan', covered, excluded, purpose: text })
    if (answer !== 'approve') throw guardError('DESKTOP_APPROVAL_DENIED', '用户拒绝了任务预批')
    this.plans.set(this.taskKey(caller), {
      programs: new Set(covered),
      expiresAt: this.deps.now() + DESKTOP_SAFETY_LIMITS.planTtlMs,
    })
    return {
      approved: true,
      covered,
      excluded,
      expiresInMinutes: DESKTOP_SAFETY_LIMITS.planTtlMs / 60_000,
    }
  }

  /**
   * 修改设置：收紧的部分立即生效；放宽的部分弹出原生确认框，同意后生效。
   * source 为 user 时来自设置页，同样只有确认框能放宽（页面脚本不能代替用户）。
   */
  async change(value: unknown, source: 'agent' | 'user') {
    this.ensureLoaded()
    const change = normalizeDesktopSafetyChange(value)
    if (!change) throw guardError('DESKTOP_SAFETY_INVALID', '设置修改的参数无效')
    const next = applyDesktopSafetyChange(this.settings, change)
    const loosenings = desktopSafetyLoosenings(this.settings, next)
    // 内置名单中的程序永远不能信任；validate 在写入前再兜底一次。
    const checked = validateDesktopSafetySettings(next, this.draft ?? undefined)
    if (!checked.ok) throw guardError('DESKTOP_SAFETY_INVALID', '设置修改的参数无效')
    if (!loosenings.length && !this.degraded) {
      this.persist(next)
      return { applied: 'all' as const, loosenings: [], settings: structuredClone(this.settings) }
    }
    const tightened = stricterDesktopSafety(this.settings, next)
    const answer = await this.deps.prompt({
      kind: 'loosen',
      changes: loosenings,
      source,
      recovery: this.degraded,
      settings: next,
    })
    if (answer === 'approve') {
      this.persist(next)
      return { applied: 'all' as const, loosenings, settings: structuredClone(this.settings) }
    }
    if (this.degraded) this.apply(tightened)
    else this.persist(tightened)
    return {
      applied: 'tightening-only' as const,
      loosenings,
      settings: structuredClone(this.settings),
    }
  }

  /** 接受应用外对设置文件的修改（放宽部分需原生确认）。 */
  async acceptExternal(): Promise<DesktopSafetyState> {
    this.ensureLoaded()
    const file = this.deps.userFile()
    let raw: unknown
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      throw guardError('DESKTOP_SAFETY_INVALID', '设置文件无法解析')
    }
    const parsed = validateDesktopSafetySettings(raw, this.draft ?? undefined)
    if (!parsed.ok) throw guardError('DESKTOP_SAFETY_INVALID', '设置文件无法解析')
    const accepted = this.readSigned(this.deps.acceptedFile())?.settings ?? this.settings
    const loosenings = desktopSafetyLoosenings(accepted, parsed.value)
    if (loosenings.length || this.degraded) {
      const answer = await this.deps.prompt({
        kind: 'loosen',
        changes: loosenings,
        source: 'file',
        recovery: this.degraded,
        settings: parsed.value,
      })
      if (answer !== 'approve') return this.state()
    }
    this.persist(parsed.value)
    return this.state()
  }

  /** 放弃应用外的修改：用当前生效的设置重写文件。 */
  async discardExternal(): Promise<DesktopSafetyState> {
    this.ensureLoaded()
    if (
      this.degraded &&
      (await this.deps.prompt({
        kind: 'loosen',
        changes: [],
        source: 'file',
        recovery: true,
        settings: this.settings,
      })) !== 'approve'
    )
      return this.state()
    this.persist(this.settings)
    return this.state()
  }

  /** 设置页撤销信任（收紧，立即生效）。 */
  untrust(program: unknown): DesktopSafetyState {
    this.ensureLoaded()
    if (typeof program !== 'string')
      throw guardError('DESKTOP_SAFETY_INVALID', '设置修改的参数无效')
    const next = applyDesktopSafetyChange(this.settings, { untrust: [program] })
    if (this.degraded) this.apply(next)
    else this.persist(next)
    return this.state()
  }

  /** 角色结束任务或对话被删除时可调用；目前只在测试与重置中使用。 */
  clearGrants(): void {
    this.threadGrants.clear()
    this.plans.clear()
    this.onceGrants.clear()
  }
}
