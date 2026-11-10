/**
 * @file 桌面操作护栏的全局单例与接入点：桌面动作、启动程序、总开关、角色控制与设置页通道。
 * @platform ELECTRON
 */

import { t as __t } from '../utils/i18n'
import fs from 'node:fs'
import path from 'node:path'
import { app, ipcMain, shell, type WebContents } from 'electron'
import { settingsSigner } from './settingsSigner'
import type { DesktopActionGuard } from './desktopControl'
import { DESKTOP_SAFETY_FILE, SAFETY_LISTS } from '../../../packages/shared/src/desktopSafety'
import { DesktopGuard, type GuardOutcome } from './desktopGuardCore'
import {
  DESKTOP_SAFETY_ACCEPTED_FILE,
  DESKTOP_SAFETY_CHANNELS,
  type GuardAnswer,
  type GuardCaller,
  type GuardPrompt,
} from './desktopGuardModel'
import { nativeGuardPrompt } from './desktopGuardPrompt'
import { homeApi } from '../home/homeApi'
import {
  HomeDesktopPermits,
  buildDesktopIntent,
  type DesktopPermit,
} from '../home/homeDesktopPermit'
import { desktopFactLines } from '../home/homeDesktopFacts'
import type { HomeIntent, HomeScope } from '../../../packages/shared/src/home'
import { getBackendOrigin } from './clientConnection'
import { HeldKeyTracker, controlNamesOf, isInfosWebPage, readHostFacts } from './desktopGuardFacts'

const ui = (text: string, args?: unknown[]) => __t('electron.ui.desktopGuard', text, args)

/** 全局单例 */
export const desktopGuard = new DesktopGuard({
  userFile: () => path.join(app.getPath('userData'), DESKTOP_SAFETY_FILE),
  acceptedFile: () => path.join(app.getPath('userData'), DESKTOP_SAFETY_ACCEPTED_FILE),
  signer: settingsSigner,
  draft: SAFETY_LISTS,
  selfPrograms: () => [process.execPath],
  prompt: nativeGuardPrompt,
  now: Date.now,
})

/** 后端「家」的桌面许可：authorize → consume → complete。 */
export const homeDesktopPermits = new HomeDesktopPermits({
  api: homeApi,
  now: Date.now,
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms)
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          reject(new Error('DESKTOP_CANCELLED: 桌面操作已取消'))
        },
        { once: true },
      )
    }),
})

/** 家的作用域：角色、会话（Thread）和任务；缺少会话时不能申请许可，动作不发出。 */
export function homeDesktopScope(caller: GuardCaller): HomeScope {
  const taskId = caller.homeTaskId ?? caller.taskId
  if (!caller.agentId || !caller.threadId)
    throw new Error(`DESKTOP_HOME_SCOPE_REQUIRED: ${ui('桌面动作只能在对话会话里进行')}`)
  return { agentId: caller.agentId, sessionId: caller.threadId, ...(taskId ? { taskId } : {}) }
}

/** 后端随调用附带的会话执行模式（模型参数不能覆盖）。 */
export function manualMode(identity: unknown): boolean {
  return (identity as { executionMode?: unknown } | undefined)?.executionMode === 'manual'
}

/** 本机审批框里的说明：与确认通知同一套宿主事实（见 homeDesktopFacts），不显示模型自报的字段。 */
export function describeDesktopAction(intent: HomeIntent): string {
  return desktopFactLines(intent.parameters ?? {}).join('\n')
}

/** infOS 自己的网页端来源：浏览器里打开它属于禁区。 */
function infosOrigins(): string[] {
  try {
    return [getBackendOrigin()]
  } catch {
    return [`http://localhost:${Number(process.env.PERO_PORT ?? 9120)}`]
  }
}

/**
 * desktopControl 的护栏接入点：执行类动作经 check。批准后不再一律要求重新观察，
 * 而是告诉 desktopControl 刚弹过审批框，由它核对画面没变后直接执行并用掉这次批准。
 *
 * - 意图只含白名单参数与宿主事实（控件名、点击点下方的控件、按住的键、窗口类名），
 *   分类按 shared/desktopSensitive 的多层规则；确认说明只显示这些事实。
 * - 浏览器里打开的 infOS 网页端属于禁区。
 * - 执行模式「手动」：每个动作都要用户点一次（即使程序已被信任或在预批里）。
 */
export function desktopActionGuard(
  guard: DesktopGuard = desktopGuard,
  permits: HomeDesktopPermits | null = homeDesktopPermits,
  held: HeldKeyTracker = new HeldKeyTracker(),
  origins: () => string[] = infosOrigins,
): DesktopActionGuard {
  return async (caller, target, input) => {
    // observationId 只标识画面新鲜度；动作意图绑定白名单参数及可信窗口身份。
    const {
      observationId: _observationId,
      __desktopCaller: identity,
      __hostFacts: rawFacts,
      ...intent
    } = input
    const facts = readHostFacts(rawFacts)
    const drop = facts.drop
    if (
      isInfosWebPage(target.program, target.title, facts, origins()) ||
      (drop && isInfosWebPage(drop.program, drop.title, {}, origins()))
    )
      throw new Error(
        `DESKTOP_FORBIDDEN: ${ui('目标程序在禁区内，角色不能操作：{0}', [ui('浏览器里的 infOS 网页端')])}`,
      )
    const heldKeys = held.current()
    held.track(input)
    const homeIntent = buildDesktopIntent(target, input, {
      controlNames: controlNamesOf(input, facts),
      pointWindowTitle: facts.pointWindowTitle,
      heldKeys,
      ...(drop
        ? { drop: { program: drop.program, title: drop.title, windowClass: drop.windowClass } }
        : {}),
    })
    const outcome: GuardOutcome = { prompted: false }
    const detail = describeDesktopAction(homeIntent)
    // 本机护栏保留：禁区、高危名单、信任名单与预批照旧。
    await guard.check(caller, target, detail, false, intent, outcome)
    // 跨程序拖动：终点程序同样过本机护栏（禁区拒绝、高危区确认、信任与预批照旧）。
    const dropOutcome: GuardOutcome = { prompted: false }
    if (drop) {
      await guard.check(
        caller,
        { program: drop.program, title: drop.title, windowId: drop.windowId, pid: drop.pid },
        detail,
        false,
        { ...intent, dropTarget: true },
        dropOutcome,
      )
      mergeOutcome(outcome, dropOutcome)
    }
    if ((manualMode(identity) || manualMode(caller)) && !outcome.prompted) {
      await guard.confirmEach(target, detail)
      outcome.prompted = true
      outcome.answer = 'once'
    }
    let permit: DesktopPermit | undefined
    let waited = false
    if (permits) {
      const scope = homeDesktopScope(caller)
      // 用户已经认可过这个程序（这次本机点了「本次对话 / 以后都信任」，或之前信任过、本次对话允许过、
      // 在任务预批里）：合并进会话声明，免得每个动作都因「超出声明」再问。「只提醒」是全局档位，不算。
      if (
        outcome.answer === 'thread' ||
        outcome.answer === 'trust' ||
        outcome.via === 'trusted' ||
        outcome.via === 'thread' ||
        outcome.via === 'plan'
      )
        await permits.declareApps(scope, [target.program])
      if (
        drop &&
        (dropOutcome.answer === 'thread' ||
          dropOutcome.answer === 'trust' ||
          dropOutcome.via === 'trusted' ||
          dropOutcome.via === 'thread' ||
          dropOutcome.via === 'plan')
      )
        await permits.declareApps(scope, [drop.program])
      ;({ permit, waited } = await permits.authorize(scope, homeIntent, {
        native: outcome.answer,
        signal: caller.signal,
      }))
    }
    return {
      prompted: outcome.prompted || waited,
      consume: async () => {
        if (outcome.onceKey) guard.consumeOnce(outcome.onceKey)
        if (dropOutcome.onceKey) guard.consumeOnce(dropOutcome.onceKey)
        await permit?.consume()
      },
      complete: async (result, detail) => permit?.complete(result, detail),
    }
  }
}

/**
 * 起点与终点两次本机检查合成一个结果：弹过框就算弹过；转给后端的回答取更保守的
 * （任一边只给了「允许这一次」就只转 once）。
 */
function mergeOutcome(outcome: GuardOutcome, drop: GuardOutcome): void {
  if (!drop.prompted) return
  outcome.prompted = true
  if (!outcome.answer || drop.answer === 'once') outcome.answer = drop.answer
}

/**
 * 手动模式下不经 desktopActionGuard 的动作（切换窗口、启动程序）也要用户点一次「允许这一次」。
 * 已经弹过框（outcome.prompted）就不再问；禁区照旧拒绝。
 */
export async function confirmManualStep(
  caller: { executionMode?: string },
  target: { program: string; title?: string },
  intent: HomeIntent,
  prompted = false,
  guard: DesktopGuard = desktopGuard,
): Promise<boolean> {
  if (!manualMode(caller) || prompted) return false
  await guard.confirmEach(target, describeDesktopAction(intent))
  return true
}

/**
 * 启动程序的后端许可（按路径启动终端、系统设置等归入对应 action）。
 * 返回的许可要在真正启动前 consume、启动后 complete。
 */
export async function authorizeApplicationLaunch(
  caller: GuardCaller,
  plan: import('./applicationLauncher').ApplicationLaunchPlan,
  native: GuardOutcome['answer'],
  permits: HomeDesktopPermits = homeDesktopPermits,
  signal?: AbortSignal,
): Promise<DesktopPermit> {
  const { permit } = await permits.authorize(homeDesktopScope(caller), launchIntent(plan), {
    native,
    signal,
  })
  return permit
}

/** 启动程序的意图：目标来自主进程解析的启动计划。 */
export function launchIntent(plan: import('./applicationLauncher').ApplicationLaunchPlan) {
  const program = plan.program ?? plan.target.split(/[\\/!]/).at(-1) ?? plan.target
  const target = { program, title: plan.title, windowId: plan.windowId, pid: plan.pid }
  return buildDesktopIntent(target, {
    action: 'launch',
    target: plan.target,
    targetType: plan.targetType,
  })
}

/** 按名称或路径启动程序前的检查；按路径启动等同双击文件，至少为高危区。批准后直接启动。 */
export async function guardApplicationLaunch(
  caller: GuardCaller,
  appName: string,
  guard: DesktopGuard = desktopGuard,
  readShortcut: (file: string) => string = (file) => shell.readShortcutLink(file).target,
  resolveLongPath: (file: string) => string = fs.realpathSync.native,
): Promise<void> {
  const launchPath = path.isAbsolute(appName) || /[\\/]/.test(appName)
  let resolvedLaunchTarget = appName
  const identities = new Set<string>([appName])
  const seen = new Set<string>()
  // 保留解析链上每个身份；8.3 文件名先展开，任何节点的禁令都不能被宿主映射覆盖。
  for (let depth = 0; depth < 8; depth++) {
    identities.add(resolvedLaunchTarget)
    if (launchPath) {
      try {
        resolvedLaunchTarget = resolveLongPath(resolvedLaunchTarget)
        identities.add(resolvedLaunchTarget)
      } catch {
        /* 无法解析仍按路径高危确认。 */
      }
    }
    for (const program of identities) {
      if (guard.classify({ program }).zone === 'forbidden') {
        await guard.check(caller, { program }, ui('启动程序：{0}', [appName.slice(0, 200)]), false)
      }
    }
    if (!/\.lnk$/i.test(resolvedLaunchTarget) || seen.has(resolvedLaunchTarget.toLowerCase())) break
    seen.add(resolvedLaunchTarget.toLowerCase())
    try {
      const next = readShortcut(resolvedLaunchTarget)
      if (!next) break
      resolvedLaunchTarget = next
    } catch {
      break
    }
  }
  await guard.check(
    caller,
    {
      program: appName,
      launchPath,
      launchTarget: appName,
      resolvedLaunchTarget,
      launchIdentities: [...identities],
    },
    ui('启动程序：{0}', [appName.slice(0, 200)]),
    false,
    { action: 'launch', target: resolvedLaunchTarget, identities: [...identities] },
  )
}

/** 已发现的应用目标由主进程提供；AUMID 无可靠宿主映射时至少逐次确认。 */
export async function guardApplicationPlan(
  caller: GuardCaller,
  plan: import('./applicationLauncher').ApplicationLaunchPlan,
  guard: DesktopGuard = desktopGuard,
  outcome?: GuardOutcome,
): Promise<void> {
  if (plan.targetType === 'path') {
    await guard.check(
      caller,
      {
        program: plan.target,
        launchPath: true,
        launchTarget: plan.identities?.[0] ?? plan.target,
        resolvedLaunchTarget: plan.target,
        launchIdentities: plan.identities,
      },
      ui('启动程序：{0}', [plan.target]),
      false,
      plan,
      outcome,
    )
    return
  }
  const entry = plan.target.split('!').at(-1) ?? ''
  const identities = [
    plan.program ?? '',
    plan.target,
    plan.title ?? '',
    ...(plan.targetType === 'aumid' ? [`${entry}.exe`] : []),
  ]
  await guard.check(
    caller,
    {
      program: plan.program ?? entry,
      title: plan.title,
      windowId: plan.windowId,
      pid: plan.pid,
      launchPath: plan.targetType === 'aumid',
      launchIdentities: identities,
    },
    ui('启动程序：{0}', [plan.title ?? plan.target]),
    false,
    plan,
    outcome,
  )
}

/**
 * 「桌面操作」总开关的修改（设置页 `desktop-control:update`）：从关闭改为打开时必须经主进程原生确认框，
 * 页面脚本不能代替用户确认；用户拒绝时去掉 `enabled`（其他字段照常保存）。关闭立即生效。
 * 返回要应用的修改；为 null 表示没有需要保存的内容。
 */
export async function confirmDesktopControlPatch<T extends { enabled?: unknown }>(
  patch: T,
  currentlyEnabled: boolean,
  prompt: (request: GuardPrompt) => Promise<GuardAnswer> = nativeGuardPrompt,
): Promise<T | null> {
  if (patch.enabled !== true || currentlyEnabled) return patch
  if ((await prompt({ kind: 'enable-control' })) === 'approve') return patch
  const rest = { ...patch }
  delete rest.enabled
  return Object.keys(rest).length ? rest : null
}

/**
 * 角色经 `desktop.environment/control` 发起的护栏操作：
 * - `disable`：关闭「桌面操作」总开关（没有对应的打开操作）。
 * - `plan`：任务预批（总开关关闭时不可用）。
 * - `safety`：读取设置；带 change 时修改（收紧立即生效，放宽弹确认框）。
 */
export async function handleGuardControl(
  input: Record<string, unknown>,
  caller: GuardCaller,
  control: { enabled(): boolean; disable(): void },
  guard: DesktopGuard = desktopGuard,
  permits: HomeDesktopPermits | null = homeDesktopPermits,
): Promise<unknown> {
  if (input.action === 'disable') {
    control.disable()
    return { success: true, enabled: false }
  }
  if (input.action === 'plan') {
    if (!control.enabled()) throw new Error('DESKTOP_DISABLED: 桌面操作未开启')
    const result = await guard.plan(caller, input.programs, input.purpose)
    // 用户批准了预批：把这些普通程序合并进本会话的「家」声明（不冲掉已声明的路径）。
    if (result.approved && permits && caller.agentId && caller.threadId)
      await permits.declareApps(homeDesktopScope(caller), result.covered)
    return { success: true, ...result }
  }
  if (input.action === 'safety') {
    if (input.change === undefined) {
      const state = guard.state()
      return {
        success: true,
        draftStatus: state.draftStatus,
        draftValid: state.draftValid,
        builtin: state.draft,
        settings: state.settings,
        externalEdit: state.externalEdit,
      }
    }
    return { success: true, ...(await guard.change(input.change, 'agent')) }
  }
  throw new Error('DESKTOP_CONTROL_DENIED: 不支持的桌面控制操作')
}

/** 设置页通道：只接受主窗口与桌面面板。查看、撤销信任与收紧立即生效；放宽一律经原生确认框。 */
export function registerDesktopSafetyHandlers(
  isTrusted: (sender: WebContents) => boolean,
  guard: DesktopGuard = desktopGuard,
): void {
  const assert = (sender: WebContents) => {
    if (!isTrusted(sender)) throw new Error('DESKTOP_SAFETY_FORBIDDEN')
  }
  ipcMain.handle(DESKTOP_SAFETY_CHANNELS.get, (event) => {
    assert(event.sender)
    return guard.state()
  })
  ipcMain.handle(DESKTOP_SAFETY_CHANNELS.setNormalMode, async (event, mode: unknown) => {
    assert(event.sender)
    await guard.change({ normalMode: mode }, 'user')
    return guard.state()
  })
  ipcMain.handle(DESKTOP_SAFETY_CHANNELS.untrust, (event, program: unknown) => {
    assert(event.sender)
    return guard.untrust(program)
  })
  ipcMain.handle(DESKTOP_SAFETY_CHANNELS.showFile, async (event) => {
    assert(event.sender)
    const file = guard.state().filePath
    // 文件不存在时先写一份当前设置，便于用户打开编辑。
    if (!fs.existsSync(file)) await guard.discardExternal()
    if (!fs.existsSync(file)) return false
    shell.showItemInFolder(file)
    return true
  })
  ipcMain.handle(DESKTOP_SAFETY_CHANNELS.acceptExternal, (event) => {
    assert(event.sender)
    return guard.acceptExternal()
  })
  ipcMain.handle(DESKTOP_SAFETY_CHANNELS.discardExternal, (event) => {
    assert(event.sender)
    return guard.discardExternal()
  })
}
