/**
 * @file desktopControl 执行动作时的护栏调用与派发前收尾（从控制器拆出，保持主文件精简）。
 * @platform ELECTRON
 */

import type { DesktopCaller } from './desktopControl'
import type { Observation } from './desktopObserve'
import type { DesktopWindowInfo } from '@infos/shared'

/** prompted：刚弹过审批框或等过确认通知；consume：派发前用掉批准与后端许可；complete：派发后上报。 */
export interface DesktopGuardOutcome {
  prompted: boolean
  consume?: () => void | Promise<void>
  complete?: (result: 'success' | 'failed', detail?: string) => Promise<void>
}
/** 阶段 2 护栏：执行类动作前按目标程序分区与审批（见 desktopGuard.ts）；允许时返回，否则抛错。 */
export type DesktopActionGuard = (
  caller: DesktopCaller,
  target: {
    program: string
    title: string
    hotkey?: string
    windowId?: string
    pid?: number
    /** 目标窗口类名（系统读取），用于识别经典控制面板、对话框。 */
    windowClass?: string
  },
  input: Record<string, unknown>,
) => Promise<DesktopGuardOutcome | void>

/**
 * 等待不改变任何东西，不审批；移动鼠标平时不审批，执行模式「手动」时也要确认（悬停可能弹出菜单或预览，
 * 与「每个动作都点一次」一致）。其余动作按目标程序分区、走本机护栏与后端许可。
 * 控件信息、窗口类名、地址栏的值都取自本次观察（主进程读到的），不用模型传的值。
 */
export async function askDesktopGuard(
  guard: DesktopActionGuard | undefined,
  caller: DesktopCaller,
  operation: 'mouse' | 'keyboard' | 'element' | 'wait',
  input: Record<string, unknown>,
  observation: Observation,
  current: DesktopWindowInfo,
): Promise<DesktopGuardOutcome | undefined> {
  if (!guard || operation === 'wait') return undefined
  if (input.action === 'move' && caller.executionMode !== 'manual') return undefined
  const outcome = await guard(
    caller,
    {
      program: current.processName,
      windowId: current.windowId,
      pid: current.pid,
      title: current.title,
      ...(current.className ? { windowClass: current.className } : {}),
      hotkey:
        input.action === 'hotkey' || input.action === 'key_down'
          ? String(input.text ?? '')
          : undefined,
    },
    {
      ...input,
      operation,
      geometry: observation.geometry,
      bounds: observation.bounds,
      element:
        operation === 'element'
          ? observation.elements.find((element) => element.id === input.elementId)
          : undefined,
      __hostFacts: {
        ...(typeof input.__hostFacts === 'object' && input.__hostFacts ? input.__hostFacts : {}),
        addressValues: addressValues(observation),
      },
    },
  )
  return outcome ?? undefined
}

/** 浏览器地址栏的当前值（观察里名字像「地址」的输入框）：识别浏览器里打开的 infOS 网页端。 */
function addressValues(observation: Observation): string[] {
  return observation.elements
    .filter(
      (element) =>
        /edit|combobox/i.test(element.role) &&
        /address|地址|網址|url|location/i.test(element.name) &&
        typeof element.value === 'string' &&
        element.value.trim(),
    )
    .map((element) => element.value!.slice(0, 300))
    .slice(0, 3)
}

/**
 * 派发前：用掉本机批准并消费后端许可，然后立刻再核对取消、暂停与撤权。
 * 许可已消费但没派发时如实上报 failed。
 */
export async function beginDispatch(
  approval: DesktopGuardOutcome | undefined,
  assertAvailable: () => void,
): Promise<void> {
  await approval?.consume?.()
  try {
    assertAvailable()
  } catch (error) {
    void approval?.complete?.('failed', 'cancelled before dispatch')
    throw error
  }
}

/** 按 windowId 或标题找唯一的窗口（切换窗口用）；找不到或不唯一时报错，不猜。 */
export function uniqueWindow(windows: DesktopWindowInfo[], target: string): DesktopWindowInfo {
  const exact = windows.filter((window) => window.windowId === target || window.title === target)
  const matches = exact.length
    ? exact
    : windows.filter((window) => window.title.toLowerCase().includes(target.toLowerCase()))
  if (!target || matches.length !== 1)
    throw new Error('WINDOW_AMBIGUOUS: 请使用窗口列表中的 windowId 指定唯一窗口')
  return matches[0]!
}
