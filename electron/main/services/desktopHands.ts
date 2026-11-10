/**
 * @file 「手」的接入点：capabilityProvider 在把键鼠动作交给 desktopControl 之前、之后各调一次。
 *
 * - 动作前（prepareHandsInput）：把元素编号（ref）换成控件或坐标；按坐标的鼠标动作先看点击点下方
 *   实际是哪个窗口，不属于观察的那个程序就不发出（审批也按观察的程序问，不能落到别的程序上）。
 * - 动作后（finishHandsResult）：每步回读——用控件回读、`expect` 与前后画面核对真实结果（desktopVerify.ts），
 *   结果里给出 `verify`（做成了 / 没做成及原因和建议 / 可能没生效）。
 * - 审批、禁区、高危名单、用户接管、取消仍全部由 desktopControl.execute 与它的护栏负责，这里不另开通路。
 *
 * @platform ELECTRON
 * @see .docs/B02_DESKTOP_AUTOMATION.md
 */

import type { DesktopWindowInfo } from '@infos/shared'
import type { DesktopCaller } from './desktopControl'
import { applyElementRef, type RefTarget } from './desktopHandsRef'
import { findObservation } from './desktopObservationIndex'
import { mouseArguments } from './desktopActionFollowUp'
import { windowsDesktop } from './windowsDesktop'
import { frameDifference } from './desktopFrame'
import { judgeAction, verifyMessage, type ActionExpect } from './desktopVerify'
import type { DropWindow } from './desktopGuardFacts'

/** 落在某个点上的鼠标动作（mouse_up 用当前光标位置，move 不改变任何东西）。 */
const POINT_ACTIONS = [
  'click',
  'double_click',
  'triple_click',
  'right_click',
  'drag',
  'scroll',
  'mouse_down',
]

/** 修饰键加点击：只收 ctrl / alt / shift，只用于点击、滚动和拖动。 */
const MODIFIERS = /^(ctrl|control|alt|shift)(\+(ctrl|control|alt|shift))*$/i
const MODIFIER_ACTIONS = ['click', 'double_click', 'triple_click', 'right_click', 'scroll', 'drag']

/** 按键补全的参数核对：桥接在移动鼠标之后才解析它们，所以必须在发出前拦下。 */
function checkMouseOptions(input: Record<string, unknown>, action: string): void {
  if (input.button !== undefined && !['left', 'right', 'middle'].includes(String(input.button)))
    throw new Error('DESKTOP_BUTTON_INVALID: 鼠标键只能是 left、right、middle')
  if (
    input.modifiers !== undefined &&
    (typeof input.modifiers !== 'string' ||
      !MODIFIERS.test(input.modifiers) ||
      !MODIFIER_ACTIONS.includes(action))
  )
    throw new Error(
      'DESKTOP_HOTKEY_INVALID: modifiers 只能是 ctrl、alt、shift 的组合，且只用于点击、滚动和拖动',
    )
}

export interface PreparedHands {
  input: Record<string, unknown>
  target?: RefTarget
  /** expect.window 时动作前已有的窗口（windowId 与标题），只认动作后新出现的。 */
  windowsBefore?: string[]
}

/** 点击点下方控件（桥接 windowAt 附带，UIA ElementFromPoint）的名字与 AutomationId。 */
interface PointElement {
  labels?: unknown
}

const windowKey = (window: { windowId: string; title: string }) =>
  `${window.windowId}\u0000${window.title}`

/** 点击点下方的窗口不属于观察的程序时的错误（动作没有发出）。 */
export function pointOtherWindowError(window: DesktopWindowInfo | null | undefined): Error {
  const who = window
    ? `${window.processName}「${window.title.slice(0, 60)}」，windowId ${window.windowId}`
    : '没有窗口'
  return new Error(
    `DESKTOP_POINT_OTHER_WINDOW: 点击点下方是另一个程序的窗口（${who}），没有发出输入。要操作它请传这个 windowId 重新观察；否则换一个没被挡住的位置。`,
  )
}

/** 动作前：换算编号、核对点击点下方的窗口。 */
export async function prepareHandsInput(
  input: Record<string, unknown>,
  caller: DesktopCaller,
): Promise<PreparedHands> {
  const observation = findObservation(input.observationId, caller)
  // refText、__hostFacts、dropPid 只能由主进程填写：模型传来的一律丢掉。
  const { refText: _refText, __hostFacts: _facts, dropPid: _dropPid, ...clean } = input
  const { input: next, target } = applyElementRef(observation, clean)
  const action = String(next.action ?? '')
  checkMouseOptions(next, action)
  const expect = readExpect(next.expect)
  // 要核对文字出现或消失，动作后的观察需要带元素图。
  if (expect?.text || expect?.gone) next.includeElements = true
  const pointLabels: string[] = []
  let pointWindowTitle: string | undefined
  let drop: DropWindow | undefined
  if (observation && !next.elementId && POINT_ACTIONS.includes(action)) {
    const point = await mouseArguments(observation, next)
    const points = [{ x: point.x, y: point.y }]
    if (action === 'drag') points.push({ x: point.x2!, y: point.y2! })
    for (const [index, item] of points.entries()) {
      const { window, element } = await windowsDesktop.request<{
        window: DesktopWindowInfo | null
        element?: PointElement | null
      }>('windowAt', item, caller.signal)
      // 拖动的终点可以在另一个程序的窗口里（把文件拖进聊天窗口）：记下终点窗口，交给护栏核对
      // 终点程序（禁区、授权、确认），桥接派发时按这个进程核对终点。起点仍必须在观察的程序里。
      if (window && window.pid !== observation.window.pid && action === 'drag' && index === 1) {
        drop = {
          program: window.processName,
          title: window.title,
          pid: window.pid,
          windowId: window.windowId,
          ...(window.className ? { windowClass: window.className } : {}),
        }
        continue
      }
      if (!window || window.pid !== observation.window.pid) throw pointOtherWindowError(window)
      // 点击点下方的控件名交给护栏分类（点的是不是「发送」「付款」）；读不到就当认不出。
      if (index === 0) {
        pointWindowTitle = window.title
        if (Array.isArray(element?.labels))
          for (const label of element.labels)
            if (typeof label === 'string' && label.trim()) pointLabels.push(label.slice(0, 120))
      }
    }
  }
  // 编号对应的文字交给护栏分类（点的是不是「发送」「付款」），桥接不使用它。
  if (target?.text) next.refText = target.text
  next.__hostFacts = {
    ...(pointLabels.length ? { pointLabels } : {}),
    ...(pointWindowTitle !== undefined ? { pointWindowTitle } : {}),
    ...(drop ? { drop } : {}),
  }
  // 桥接按这个进程核对拖动终点；只由主进程填写。
  if (drop) next.dropPid = drop.pid
  let windowsBefore: string[] | undefined
  if (expect?.window)
    try {
      windowsBefore = (await windowsDesktop.windows()).map(windowKey)
    } catch {
      windowsBefore = undefined
    }
  return { input: next, ...(target ? { target } : {}), ...(windowsBefore ? { windowsBefore } : {}) }
}

/** 读取并校验 `expect`：只收 text / gone / window 三个字符串，各不超过 200 字。 */
export function readExpect(value: unknown): ActionExpect | undefined {
  if (value === undefined || value === null) return undefined
  const invalid = () =>
    new Error('DESKTOP_EXPECT_INVALID: expect 只能包含 text、gone、window（字符串，200 字以内）')
  if (typeof value !== 'object' || Array.isArray(value)) throw invalid()
  const result: ActionExpect = {}
  for (const [key, item] of Object.entries(value)) {
    if (!['text', 'gone', 'window'].includes(key)) throw invalid()
    if (typeof item !== 'string' || !item.trim() || item.length > 200) throw invalid()
    result[key as keyof ActionExpect] = item.trim()
  }
  return Object.keys(result).length ? result : undefined
}

/** 动作后：注明按哪个编号定位的，并核对这一步做成了没有。 */
export async function finishHandsResult(
  prepared: PreparedHands,
  result: unknown,
  caller: DesktopCaller,
): Promise<unknown> {
  if (!result || typeof result !== 'object') return result
  const value = { ...(result as Record<string, unknown>) }
  if (prepared.target) value.target = prepared.target
  const action = String(prepared.input.action ?? '')
  if (action === 'wait' || action === 'move') return value
  const expect = readExpect(prepared.input.expect)
  const before = findObservation(prepared.input.observationId, caller)
  const after = findObservation(value.observationId, caller)
  const comparable =
    before &&
    after &&
    before.scope === after.scope &&
    before.window.windowId === after.window.windowId &&
    before.fingerprint.length === after.fingerprint.length
  // 没读到元素图（UIA 失败、无障碍树没建好、元素图为空）就不给文字：「已消失」不能凭空判断。
  const texts =
    after && prepared.input.includeElements === true && after.elementMap.length
      ? [
          after.window.title,
          ...after.elementMap.flatMap((entry) => [entry.text, entry.value ?? '']),
        ].filter(Boolean)
      : undefined
  const textsComplete = !!texts && after?.elementsTruncated !== true
  // 只认动作之后新出现（或标题变了）的窗口；动作前没记下窗口列表就不给结论。
  let windows: string[] | undefined
  if (expect?.window && prepared.windowsBefore)
    try {
      const before = new Set(prepared.windowsBefore)
      windows = (await windowsDesktop.windows())
        .filter((window) => !before.has(windowKey(window)))
        .map((window) => window.title)
    } catch {
      windows = undefined
    }
  const verify = judgeAction({
    action,
    text: typeof prepared.input.text === 'string' ? prepared.input.text : undefined,
    receipt: value.actionReceipt as Parameters<typeof judgeAction>[0]['receipt'],
    expect,
    frameDiff: comparable ? frameDifference(before.fingerprint, after.fingerprint) : undefined,
    texts,
    textsComplete,
    windows,
  })
  return { ...value, verify, message: verifyMessage(verify) }
}
