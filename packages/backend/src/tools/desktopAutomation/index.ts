import type { BuiltinTool } from '../index'
import {
  createDesktopDirectTool,
  desktopFailure,
  EXECUTE_FIELDS,
  pickArgs,
  readUntil,
  validateExecuteOptions,
} from './desktopActionArgs'

export { pickArgs } from './desktopActionArgs'

export interface DesktopAutomationProvider {
  execute(
    args: Record<string, unknown>,
    context: Parameters<BuiltinTool['execute']>[1],
  ): Promise<unknown>
  getMousePosition(): Promise<{ x: number; y: number }>
  /** 直通通道（剪贴板、媒体键、默认浏览器打开网址）；旧客户端没有。 */
  direct?(
    args: Record<string, unknown>,
    context: Parameters<BuiltinTool['execute']>[1],
  ): Promise<unknown>
}
let provider: DesktopAutomationProvider | null = null
export function setDesktopAutomationProvider(value: DesktopAutomationProvider | null): void {
  provider = value
}

function failure(code: string, message: string, notDispatched = false): string {
  return JSON.stringify({
    success: false,
    error: { code, message, ...(notDispatched ? { dispatched: false } : {}) },
  })
}
function finite(args: Record<string, unknown>, keys: string[]): boolean {
  return keys.every((key) => typeof args[key] === 'number' && Number.isFinite(args[key]))
}

/** 参数验证留在工具边界；坐标、控制权与实际输入由客户端统一处理。 */
export const automationExecuteTool: BuiltinTool = {
  name: 'automation_execute',
  async execute(args, context) {
    if (!provider) return failure('DESKTOP_AUTOMATION_UNAVAILABLE', '桌面自动化服务未初始化', true)
    const action = String(args.action ?? '')
    const actions = [
      'invoke',
      'set_value',
      'toggle',
      'select',
      'expand',
      'collapse',
      'move',
      'click',
      'double_click',
      'triple_click',
      'right_click',
      'drag',
      'scroll',
      'type',
      'hotkey',
      'key_down',
      'key_up',
      'mouse_down',
      'mouse_up',
      'wait',
      'notification',
    ]
    if (!actions.includes(action))
      return failure('DESKTOP_ACTION_UNSUPPORTED', '不支持的桌面操作', true)
    // 带 until 的等待：等窗口出现不需要观察；等文字要用观察确定是哪个窗口。
    const until = action === 'wait' && args.until !== undefined ? readUntil(args.until) : undefined
    if (until === null)
      return failure(
        'DESKTOP_WAIT_INVALID',
        'until 只能包含 window、text、gone（字符串，200 字以内）',
        true,
      )
    if (
      action !== 'notification' &&
      !(until && !until.text && !until.gone) &&
      (typeof args.observationId !== 'string' || !args.observationId.trim())
    )
      return failure('DESKTOP_OBSERVATION_STALE', '请先观察桌面并提供 observationId', true)
    // 按元素编号操作：编号只在它所属的那次观察里有效，由客户端换成控件或坐标。
    const byRef = args.ref !== undefined && args.ref !== null
    if (byRef && !(Number.isInteger(args.ref) && (args.ref as number) >= 1))
      return failure('DESKTOP_ELEMENT_REF_INVALID', 'ref 是元素图里的编号（正整数）', true)
    if (
      !byRef &&
      ['invoke', 'set_value', 'toggle', 'select', 'expand', 'collapse'].includes(action) &&
      !args.elementId
    )
      return failure('DESKTOP_ELEMENT_REQUIRED', '请提供本次观察中的 elementId', true)
    if (
      [
        'move',
        'click',
        'double_click',
        'triple_click',
        'right_click',
        'drag',
        'mouse_down',
      ].includes(action) ||
      (action === 'scroll' && !args.elementId)
    ) {
      const keys = byRef ? [] : ['x', 'y']
      if (!finite(args, action === 'drag' ? [...keys, 'x2', 'y2'] : keys))
        return failure('DESKTOP_COORDINATE_INVALID', '请提供有限的截图坐标', true)
    }
    if (
      ['type', 'set_value', 'hotkey', 'key_down', 'key_up'].includes(action) &&
      (typeof args.text !== 'string' || (action !== 'set_value' && !args.text))
    )
      return failure('DESKTOP_TEXT_REQUIRED', '请提供输入文本或按键组合', true)
    const optionsInvalid = validateExecuteOptions(action, args)
    if (optionsInvalid) return optionsInvalid
    try {
      return JSON.stringify(await provider.execute(pickArgs(args, EXECUTE_FIELDS), context))
    } catch (error) {
      return desktopFailure(error)
    }
  },
}

export const getMousePositionTool: BuiltinTool = {
  name: 'get_mouse_position',
  async execute() {
    if (!provider) return failure('DESKTOP_AUTOMATION_UNAVAILABLE', '桌面自动化服务未初始化', true)
    try {
      const position = await provider.getMousePosition()
      return Number.isFinite(position.x) && Number.isFinite(position.y)
        ? JSON.stringify({ success: true, position })
        : failure('DESKTOP_COORDINATE_INVALID', '客户端返回了无效鼠标坐标', true)
    } catch (error) {
      return failure(
        'DESKTOP_MOUSE_POSITION_FAILED',
        error instanceof Error ? error.message : String(error),
      )
    }
  },
}

/** 直通通道：不需要观察；客户端同样走桌面护栏（禁区、审批、执行模式、后端许可）。 */
export const desktopDirectTool: BuiltinTool = createDesktopDirectTool(() => provider)
