/**
 * 桌面动作接后端共用判断：authorize → consume → 原生派发 → complete（不依赖 Electron，便于测试）。
 *
 * - 业务语义由宿主按核实过的事实分类（shared/desktopSensitive：程序、类别兜底、规范化按键、控件名），
 *   后端用同一份规则复核；宁可归高也不归低。意图参数只留白名单字段和宿主事实，模型自报的说明不进确认。
 * - authorize 需要确认时：如果用户刚在本机审批框里就是对这一个动作点了允许，把同一回答转给后端
 *   （发消息、付款除外，它们必须在确认通知里逐次点）；否则等用户在右下角确认通知里回答，到期作废。
 * - consume 只能调用一次，且后端回的 intent 必须与申请时完全一致；complete 只能在 consume 之后调用一次。
 * - 后端不可用时不放行（fail closed），动作不发出。
 *
 * @see .docs/home/authorization.md 桌面动作共用判断
 */

import type {
  HomeChoice,
  HomeConfirmation,
  HomeIntent,
  HomeScope,
} from '../../../packages/shared/src/home'
import {
  classifyDesktopRisk,
  desktopRiskFactsFromParameters,
  exeName,
} from '../../../packages/shared/src/desktopSensitive'
import { normalizeHotkey } from '../../../packages/shared/src/desktopSafetyNormalize'
import { t as __t } from '../utils/i18n'
import { HomeApiError, type HomeApiCall } from './homeApiCore'

export type HomeDesktopAction = 'app' | 'send' | 'pay' | 'settings' | 'terminal'

/** 本机审批框的回答（与 desktopGuardModel 的 GuardAnswer 对应）。 */
export type NativeAnswer = 'once' | 'thread' | 'trust'

/** 后端应用名：小写 exe 文件名。 */
export const exe = exeName

export interface DesktopIntentTarget {
  program: string
  title?: string
  windowId?: string
  pid?: number
  /** 目标窗口的类名（系统读取）：识别经典控制面板、对话框。 */
  windowClass?: string
}

/** 宿主核实过的、参与判断与显示的事实。 */
export interface DesktopIntentFacts {
  /** 目标控件名：UIA 控件名、AutomationId、OCR 编号文字、点击点下方的控件。 */
  controlNames?: string[]
  /** 点击点下方顶层窗口的标题。 */
  pointWindowTitle?: string
  /** 跨步骤按住的键（规范名）。 */
  heldKeys?: string[]
  /** 跨程序拖动的终点窗口（系统读取）。 */
  drop?: { program: string; title?: string; windowClass?: string }
}

/** 意图里保留的动作参数（白名单）；模型自报的 title、command、window 等一律不要。 */
const ACTION_FIELDS = [
  'action',
  'x',
  'y',
  'x2',
  'y2',
  'coordinateSpace',
  'elementId',
  'ref',
  'direction',
  'amount',
  'button',
  'modifiers',
  'key',
  'times',
  'url',
  'target',
  'targetType',
]
/** 只有这些动作会用到 text（输入的文字或按键）；点击类动作的 text 不进意图、不显示。 */
const TEXT_ACTIONS = ['type', 'set_value', 'hotkey', 'key_down', 'key_up', 'clipboard_write']
const KEY_ACTIONS = ['hotkey', 'key_down', 'key_up']

/**
 * 后端绑定的完整参数：动作参数（白名单）加宿主核实过的事实。
 * 窗口标题只用系统读到的值，读不到就是空字符串（显示为「（无标题）」），不用模型给的值。
 */
export function desktopIntentParameters(
  target: DesktopIntentTarget,
  input: Record<string, unknown>,
  facts: DesktopIntentFacts = {},
): Record<string, unknown> {
  const action = String(input.action ?? '')
  const parameters: Record<string, unknown> = {}
  for (const key of ACTION_FIELDS) if (input[key] !== undefined) parameters[key] = input[key]
  if (TEXT_ACTIONS.includes(action) && typeof input.text === 'string') parameters.text = input.text
  if (KEY_ACTIONS.includes(action) && typeof input.text === 'string')
    parameters.keys = normalizeHotkey(input.text)
  parameters.program = target.program
  parameters.title = typeof target.title === 'string' ? target.title : ''
  if (target.windowId) parameters.windowId = target.windowId
  if (target.pid !== undefined) parameters.pid = target.pid
  if (target.windowClass) parameters.windowClass = target.windowClass
  const names = [...new Set((facts.controlNames ?? []).map((name) => name.trim().slice(0, 120)))]
    .filter(Boolean)
    .slice(0, 8)
  if (names.length) parameters.controlNames = names
  if (facts.pointWindowTitle) parameters.pointWindowTitle = facts.pointWindowTitle.slice(0, 200)
  if (facts.heldKeys?.length) parameters.heldKeys = [...facts.heldKeys].sort()
  if (facts.drop) {
    // 终点程序要同样授权（后端按 dropApp 核对），确认里写清「把 X 拖到 Y」。
    parameters.dropProgram = facts.drop.program
    parameters.dropApp = exe(facts.drop.program)
    parameters.dropTitle = facts.drop.title ?? ''
    if (facts.drop.windowClass) parameters.dropWindowClass = facts.drop.windowClass
  }
  return parameters
}

/**
 * 按宿主事实把动作归到 app / send / pay / settings / terminal（规则见 shared/desktopSensitive）。
 * elementName 是 UIA 控件名；input.refText 是「手」带来的 OCR 编号文字。
 */
export function classifyDesktopAction(
  target: DesktopIntentTarget,
  input: Record<string, unknown>,
  elementName?: string,
  facts: DesktopIntentFacts = {},
): HomeDesktopAction {
  const names = [
    ...(elementName ? [elementName] : []),
    ...(typeof input.refText === 'string' ? [input.refText] : []),
    ...(facts.controlNames ?? []),
  ]
  return classifyDesktopRisk(
    desktopRiskFactsFromParameters(
      desktopIntentParameters(target, input, { ...facts, controlNames: names }),
    ),
  ).action
}

/** 后端绑定的意图：动作归类由宿主事实决定，附上「为什么要问」（risk）。observationId 不进意图。 */
export function buildDesktopIntent(
  target: DesktopIntentTarget,
  input: Record<string, unknown>,
  facts: DesktopIntentFacts = {},
): HomeIntent {
  const parameters = desktopIntentParameters(target, input, facts)
  const risk = classifyDesktopRisk(desktopRiskFactsFromParameters(parameters))
  if (risk.reason) parameters.risk = risk.reason
  return { action: risk.action, paths: [], app: exe(target.program), parameters }
}

const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`
  return JSON.stringify(value)
}

export interface DesktopPermit {
  permitId: string
  intent: HomeIntent
  /** 派发前立刻调用；只能一次，后端回的意图必须与申请时一致。 */
  consume(): Promise<void>
  /** 派发后如实上报；只能在 consume 之后调用一次。 */
  complete(result: 'success' | 'failed', detail?: string): Promise<void>
}

export interface HomeDesktopDeps {
  api: HomeApiCall
  now(): number
  sleep(ms: number, signal?: AbortSignal): Promise<void>
}

/** 错误码保持稳定，说明按当前语言给出。 */
function desktopError(code: string, message: string, args?: unknown[]): Error {
  return new Error(`${code}: ${__t('electron.ui.home', message, args)}`)
}

const UNAVAILABLE = '「家」的后端暂时不可用，动作没有发出：{0}'

/** 后端失败统一成「动作没有发出」的桌面错误码。 */
function failClosed(error: unknown): Error {
  if (error instanceof HomeApiError) {
    if (error.homeCode === 'HOME_DENIED')
      return desktopError('DESKTOP_APPROVAL_DENIED', '用户拒绝了这次桌面操作')
    if (error.homeCode === 'HOME_EXPIRED')
      return desktopError('DESKTOP_APPROVAL_EXPIRED', '桌面操作许可已过期，请重新观察后再试')
    return desktopError('DESKTOP_HOME_UNAVAILABLE', UNAVAILABLE, [error.message])
  }
  if (error instanceof Error && /^DESKTOP_[A-Z_]+:/.test(error.message)) return error
  return desktopError('DESKTOP_HOME_UNAVAILABLE', UNAVAILABLE, [
    error instanceof Error ? error.message : String(error),
  ])
}

const NATIVE_CHOICE: Record<NativeAnswer, HomeChoice> = {
  once: 'once',
  thread: 'session',
  trust: 'permanent',
}

export class HomeDesktopPermits {
  constructor(private readonly deps: HomeDesktopDeps) {}

  /**
   * 用户批准过的应用合并进当前会话的声明（只增不减，不冲掉已声明的路径）。
   * 只在用户的明确决定之后调用：本机任务预批、本机「本次对话都允许 / 以后都信任」、
   * 确认通知里的「这次会话都允许 / 以后都允许」。失败不放宽任何东西，后续动作照常确认。
   */
  async declareApps(scope: HomeScope, programs: string[]): Promise<boolean> {
    const apps = [...new Set(programs.map(exe).filter((name) => name !== '.exe'))]
    if (!apps.length) return false
    try {
      await this.deps.api('POST', '/declarations', {
        scope: { agentId: scope.agentId, sessionId: scope.sessionId },
        input: { paths: [], apps, mode: 'merge' },
      })
      return true
    } catch {
      return false
    }
  }

  /**
   * 申请许可。native 是用户刚在本机审批框里对这一个动作的回答（没弹框就不传）。
   * 返回 waited=true 表示期间等过用户回答（画面可能变了，调用方要再核对）。
   */
  async authorize(
    scope: HomeScope,
    intent: HomeIntent,
    options: { native?: NativeAnswer; signal?: AbortSignal } = {},
  ): Promise<{ permit: DesktopPermit; waited: boolean }> {
    const relayed = new Set<string>()
    let waited = false
    let deadline = Number.POSITIVE_INFINITY
    for (;;) {
      if (options.signal?.aborted) throw desktopError('DESKTOP_CANCELLED', '桌面操作已取消')
      try {
        const granted = await this.deps.api<{
          permitId: string
          expiresAt: number
          intent: HomeIntent
        }>('POST', '/desktop/authorize', { scope, input: intent }, options.signal)
        // 后端规范化后的意图必须仍是同一个动作（程序名小写、路径规范化，参数原样）。
        if (
          granted.intent.action !== intent.action ||
          granted.intent.app !== intent.app ||
          stable(granted.intent.parameters ?? {}) !== stable(intent.parameters ?? {})
        )
          throw desktopError('DESKTOP_PERMIT_MISMATCH', '后端批准的动作与这次动作不一致，没有执行')
        return { permit: this.permit(granted.permitId, granted.intent), waited }
      } catch (error) {
        if (!(error instanceof HomeApiError) || error.homeCode !== 'HOME_CONFIRMATION_REQUIRED')
          throw failClosed(error)
        const confirmation = error.detail as HomeConfirmation | undefined
        if (!confirmation?.id) throw failClosed(error)
        const choice = this.relayChoice(intent, confirmation, options.native)
        if (choice && !relayed.has(confirmation.id)) {
          relayed.add(confirmation.id)
          waited = true
          try {
            await this.deps.api(
              'POST',
              `/confirmations/${encodeURIComponent(confirmation.id)}/answer`,
              { choice },
              options.signal,
            )
          } catch (answerError) {
            throw failClosed(answerError)
          }
          continue
        }
        // 等用户在右下角确认通知里回答；只等这一个请求的有效期。
        deadline = Math.min(deadline, confirmation.expiresAt)
        if (this.deps.now() >= deadline)
          throw desktopError('DESKTOP_APPROVAL_EXPIRED', '确认请求到期没有回答，这次动作没有执行')
        waited = true
        await this.deps.sleep(Math.min(1000, deadline - this.deps.now()), options.signal)
      }
    }
  }

  /** 本机审批框的回答能否代表用户回答后端的这一个请求。 */
  private relayChoice(
    intent: HomeIntent,
    confirmation: HomeConfirmation,
    native?: NativeAnswer,
  ): HomeChoice | undefined {
    if (!native) return undefined
    // 发消息、付款不在本机审批框的说明里，必须在确认通知里由用户逐次点。
    if (intent.action === 'send' || intent.action === 'pay') return undefined
    const preferred = NATIVE_CHOICE[native]
    if (confirmation.choices.includes(preferred)) return preferred
    // 固定规则只给 once / deny：用户已经允许过这一个动作，只转「这一次」。
    return confirmation.choices.includes('once') ? 'once' : undefined
  }

  private permit(permitId: string, intent: HomeIntent): DesktopPermit {
    let consumed = false
    let completed = false
    const api = this.deps.api
    return {
      permitId,
      intent,
      async consume() {
        if (consumed) throw desktopError('DESKTOP_PERMIT_REPLAY', '这个许可已经用过，不能重放')
        consumed = true
        let bound: { intent: HomeIntent }
        try {
          bound = await api<{ intent: HomeIntent; scope: HomeScope }>('POST', '/desktop/consume', {
            permitId,
          })
        } catch (error) {
          throw failClosed(error)
        }
        // 只执行后端绑定的那一个动作：参数有任何不同都不派发。
        if (stable(bound.intent) !== stable(intent))
          throw desktopError('DESKTOP_PERMIT_MISMATCH', '许可绑定的动作与这次动作不一致，没有执行')
      },
      async complete(result, detail) {
        if (!consumed || completed) return
        completed = true
        await api('POST', '/desktop/complete', {
          permitId,
          result,
          ...(detail ? { detail: detail.slice(0, 1000) } : {}),
        }).catch(() => undefined)
      },
    }
  }
}
