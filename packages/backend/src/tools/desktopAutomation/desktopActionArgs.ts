/**
 * 桌面自动化扩展参数：白名单取参、等待/预期/按键校验、客户端错误归类与直通通道工具。
 *
 * automation_execute 的基础校验留在 index.ts；这里只放扩展动作需要的参数规则，
 * 由 index.ts 调用，保持工具名、注册顺序与返回结构不变。
 *
 * @module packages/backend/src/tools/desktopAutomation/desktopActionArgs
 */
import type { BuiltinTool } from '../index'
import type { DesktopAutomationProvider } from './index'

/** 与 index.ts 的 failure 保持同一结构。 */
function failure(code: string, message: string, notDispatched = false): string {
  return JSON.stringify({
    success: false,
    error: { code, message, ...(notDispatched ? { dispatched: false } : {}) },
  })
}
function finite(args: Record<string, unknown>, keys: string[]): boolean {
  return keys.every((key) => typeof args[key] === 'number' && Number.isFinite(args[key]))
}

const MODIFIERS = /^(ctrl|control|alt|shift)(\+(ctrl|control|alt|shift))*$/i

/**
 * 工具边界按清单白名单取参数：title、command、window、refText、element、__hostFacts 这类
 * 宿主专用或说明性的字段一律丢掉，模型不能借它们往确认通知里写字，也不能冒充宿主事实。
 */
export const EXECUTE_FIELDS = [
  'action',
  'x',
  'y',
  'x2',
  'y2',
  'coordinateSpace',
  'text',
  'message',
  'observationId',
  'elementId',
  'ref',
  'direction',
  'amount',
  'button',
  'modifiers',
  'includeElements',
  'expect',
  'timeoutMs',
  'until',
  'settleTimeoutMs',
]
const DIRECT_FIELDS = ['action', 'text', 'key', 'times', 'url']
export function pickArgs(args: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  return Object.fromEntries(
    fields.filter((key) => args[key] !== undefined).map((key) => [key, args[key]]),
  )
}

/** 动作后核对的预期：text（文字出现）、gone（文字消失）、window（出现某个标题的窗口）。 */
function validExpect(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entries = Object.entries(value)
  return (
    entries.length > 0 &&
    entries.every(
      ([key, item]) =>
        ['text', 'gone', 'window'].includes(key) &&
        typeof item === 'string' &&
        !!item.trim() &&
        item.length <= 200,
    )
  )
}

/** 等待条件：window / text / gone，至少一项；不合法返回 null。 */
export function readUntil(value: unknown): { window?: string; text?: string; gone?: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const entries = Object.entries(value)
  const valid =
    entries.length > 0 &&
    entries.every(
      ([key, item]) =>
        ['window', 'text', 'gone'].includes(key) &&
        typeof item === 'string' &&
        !!item.trim() &&
        item.length <= 200,
    )
  return valid ? (value as { window?: string; text?: string; gone?: string }) : null
}

/**
 * automation_execute 的扩展选项校验：settleTimeoutMs、button、modifiers、expect。
 * 合法时返回 null，否则返回工具失败结果。
 */
export function validateExecuteOptions(
  action: string,
  args: Record<string, unknown>,
): string | null {
  if (
    args.settleTimeoutMs !== undefined &&
    (!finite(args, ['settleTimeoutMs']) ||
      (args.settleTimeoutMs as number) < 200 ||
      (args.settleTimeoutMs as number) > 5000)
  )
    return failure('DESKTOP_SETTLE_INVALID', 'settleTimeoutMs 必须在 200–5000 毫秒之间', true)
  // 按键补全：中键、修饰键加点击（只收 ctrl / alt / shift）。
  if (args.button !== undefined && !['left', 'right', 'middle'].includes(String(args.button)))
    return failure('DESKTOP_BUTTON_INVALID', '鼠标键只能是 left、right、middle', true)
  if (
    args.modifiers !== undefined &&
    (typeof args.modifiers !== 'string' ||
      !MODIFIERS.test(args.modifiers) ||
      !['click', 'double_click', 'triple_click', 'right_click', 'scroll', 'drag'].includes(action))
  )
    return failure(
      'DESKTOP_HOTKEY_INVALID',
      'modifiers 只能是 ctrl、alt、shift 的组合（如 ctrl+shift），且只用于点击、滚动和拖动',
      true,
    )
  if (args.expect !== undefined && !validExpect(args.expect))
    return failure(
      'DESKTOP_EXPECT_INVALID',
      'expect 只能包含 text、gone、window（字符串，200 字以内）',
      true,
    )
  return null
}

/** 客户端抛出的桌面错误 → 工具失败结果；动作确定没有发出的错误码标注 dispatched: false。 */
export function desktopFailure(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  const separator = text.indexOf(':')
  const code = separator > 0 ? text.slice(0, separator) : 'DESKTOP_AUTOMATION_FAILED'
  const notDispatched = [
    'DESKTOP_WAITING',
    'DESKTOP_USER_BUSY',
    'DESKTOP_DISABLED',
    'DESKTOP_OBSERVATION_STALE',
    'DESKTOP_ELEMENT_STALE',
    'DESKTOP_INPUT_MONITOR_UNAVAILABLE',
    // 阶段 2 护栏：禁区、用户拒绝、批准后需重新观察，动作都没有发出。
    'DESKTOP_FORBIDDEN',
    'DESKTOP_APPROVAL_DENIED',
    'DESKTOP_APPROVED_REOBSERVE',
    // 按 windowId 操作：整屏观察、切换前台失败、目标权限更高或已关闭，动作都没有发出。
    'DESKTOP_WINDOW_REQUIRED',
    'DESKTOP_FOCUS_DENIED',
    'DESKTOP_TARGET_ELEVATED',
    'DESKTOP_WINDOW_GONE',
    // 「手」：编号无效、点击点下方是别的程序，动作都没有发出。
    'DESKTOP_ELEMENT_REF_INVALID',
    'DESKTOP_POINT_OTHER_WINDOW',
    'DESKTOP_PATTERN_UNSUPPORTED',
    'DESKTOP_EXPECT_INVALID',
    'DESKTOP_BUTTON_INVALID',
    'DESKTOP_HOTKEY_INVALID',
    // 等待没有发出任何输入。
    'DESKTOP_WAIT_INVALID',
    'DESKTOP_WAIT_TIMEOUT',
    // 直通通道：网址、剪贴板参数不合法或内容受保护，什么都没做。
    'DESKTOP_URL_INVALID',
    'DESKTOP_CLIPBOARD_PROTECTED',
    'DESKTOP_TEXT_REQUIRED',
    'DESKTOP_TEXT_TOO_LONG',
    'DESKTOP_ACTION_UNSUPPORTED',
    // 家的后端许可：未获批准、确认过期、后端不可用、缺少会话、许可不符或已用过，动作都没有发出。
    'DESKTOP_APPROVAL_EXPIRED',
    'DESKTOP_HOME_UNAVAILABLE',
    'DESKTOP_HOME_SCOPE_REQUIRED',
    'DESKTOP_PERMIT_MISMATCH',
    'DESKTOP_PERMIT_REPLAY',
  ].includes(code)
  return failure(code, separator > 0 ? text.slice(separator + 1).trim() : text, notDispatched)
}

const DIRECT_ACTIONS = ['clipboard_read', 'clipboard_write', 'media_key', 'open_url']
const MEDIA_KEYS = ['play_pause', 'next', 'previous', 'stop', 'volume_up', 'volume_down', 'mute']

/** 直通通道：不需要观察；客户端同样走桌面护栏（禁区、审批、执行模式、后端许可）。 */
export function createDesktopDirectTool(
  getProvider: () => DesktopAutomationProvider | null,
): BuiltinTool {
  return {
    name: 'desktop_direct',
    async execute(args, context) {
      const provider = getProvider()
      if (!provider?.direct)
        return failure('DESKTOP_AUTOMATION_UNAVAILABLE', '桌面客户端不支持直通通道', true)
      const action = String(args.action ?? '')
      if (!DIRECT_ACTIONS.includes(action))
        return failure(
          'DESKTOP_ACTION_UNSUPPORTED',
          `action 只能是 ${DIRECT_ACTIONS.join('、')}`,
          true,
        )
      if (action === 'clipboard_write' && typeof args.text !== 'string')
        return failure('DESKTOP_TEXT_REQUIRED', '请提供要放进剪贴板的文字', true)
      if (action === 'media_key' && !MEDIA_KEYS.includes(String(args.key)))
        return failure('DESKTOP_HOTKEY_INVALID', `key 只能是 ${MEDIA_KEYS.join('、')}`, true)
      if (action === 'open_url' && !/^https?:\/\//i.test(String(args.url ?? '').trim()))
        return failure('DESKTOP_URL_INVALID', '只能打开 http:// 或 https:// 开头的网址', true)
      try {
        return JSON.stringify(await provider.direct(pickArgs(args, DIRECT_FIELDS), context))
      } catch (error) {
        return desktopFailure(error)
      }
    },
  }
}
