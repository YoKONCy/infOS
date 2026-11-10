/**
 * 桌面动作在确认通知与本机审批框里的说明：只列主进程或后端核实过的事实。
 *
 * - 动作类型、目标应用（进程名）、窗口标题（系统读到的，空就是「（无标题）」）、控件名（UIA / OCR 读到的）、
 *   将要输入的文字原文（标「将输入：」）、规范化后的按键、网址、为什么每次都问。
 * - 不显示模型自报的 text（点击类动作）、command、title、window 之类的字段：意图参数本身已按白名单生成
 *   （homeDesktopPermit.desktopIntentParameters），这里再按动作只取该显示的字段，双重保险。
 *
 * 参考 OWASP「Lies-in-the-Loop」：确认框的内容不能由 Agent 决定。
 */

import { t as __t } from '../utils/i18n'
import { desktopAppCategory } from '../../../packages/shared/src/desktopSensitive'

const ui = (text: string, args?: unknown[]) => __t('electron.ui.home', text, args)

const ACTION_LABELS: Record<string, string> = {
  click: '点击',
  double_click: '双击',
  triple_click: '三击',
  right_click: '右键点击',
  invoke: '点按控件',
  toggle: '切换开关',
  select: '选中',
  expand: '展开',
  collapse: '收起',
  set_value: '填入文字',
  type: '输入文字',
  hotkey: '按键',
  key_down: '按住按键',
  key_up: '松开按键',
  scroll: '滚动',
  drag: '拖动',
  mouse_down: '按下鼠标',
  mouse_up: '松开鼠标',
  move: '移动鼠标',
  launch: '启动程序',
  activate: '切换窗口',
  clipboard_read: '读取剪贴板',
  clipboard_write: '写入剪贴板',
  media_key: '媒体键',
  open_url: '打开网址',
}

const RISK_LABELS: Record<string, string> = {
  'terminal-program': '这是终端或能执行命令的程序',
  'settings-program': '这是系统设置类程序',
  'control-panel': '这是控制面板',
  'terminal-hotkey': '这个按键会打开「运行」或终端入口',
  'settings-hotkey': '这个按键会打开系统设置或任务管理器',
  'protocol-dialog': '可能是浏览器「要打开此应用吗」的确认，会拉起别的程序',
  'pay-control': '控件名像付款按钮',
  'send-control': '控件名像发送按钮',
  'submit-control': '控件名像提交、确认或删除按钮',
  'submit-key': '在这个应用里按回车等于提交或发送',
  newline: '文字里带换行，在这个应用里等于按回车',
  'unknown-click': '认不出点的是哪个控件，可能是发送或提交',
}

const TEXT_ACTIONS = ['type', 'set_value', 'clipboard_write']
const KEY_ACTIONS = ['hotkey', 'key_down', 'key_up']
const CLICK_ACTIONS = [
  'click',
  'double_click',
  'triple_click',
  'right_click',
  'drag',
  'mouse_down',
  'move',
  'scroll',
]

const clip = (value: string, max: number) =>
  value.length > max ? `${value.slice(0, max)}…` : value
/** 换行显示成 ⏎，让用户看得出文字里有回车。 */
const visible = (value: string) => value.replace(/\r\n|\r|\n/g, '⏎')

/** 动作名（翻译后）。 */
export function desktopActionLabel(action: string): string {
  return ACTION_LABELS[action] ? ui(ACTION_LABELS[action]) : action
}

/** 「为什么每次都问」的说明；没有就返回 undefined。 */
export function desktopRiskText(risk: unknown): string | undefined {
  return typeof risk === 'string' && RISK_LABELS[risk] ? ui(RISK_LABELS[risk]) : undefined
}

/** 桌面意图参数 → 说明行。只读白名单字段。 */
export function desktopFactLines(parameters: Record<string, unknown>): string[] {
  const action = typeof parameters.action === 'string' ? parameters.action : ''
  const str = (key: string) =>
    typeof parameters[key] === 'string' ? (parameters[key] as string) : undefined
  const num = (key: string) =>
    typeof parameters[key] === 'number' && Number.isFinite(parameters[key])
      ? (parameters[key] as number)
      : undefined
  const lines: string[] = []
  if (action) lines.push(ui('动作：{0}', [desktopActionLabel(action)]))
  // 直通通道没有目标窗口：不显示「窗口」行（网址单独一行）。
  const direct = ['clipboard_read', 'clipboard_write', 'media_key', 'open_url', 'launch'].includes(
    action,
  )
  if (str('program') !== undefined && !direct) {
    const title = str('title')?.trim()
    lines.push(ui('窗口：{0}', [title ? clip(title, 80) : ui('（无标题）')]))
  }
  const names = Array.isArray(parameters.controlNames)
    ? (parameters.controlNames as unknown[]).filter(
        (item): item is string => typeof item === 'string',
      )
    : []
  if (names.length) lines.push(ui('控件：{0}', [clip(names.join('、'), 120)]))
  else if (CLICK_ACTIONS.includes(action) || ['invoke', 'toggle', 'select'].includes(action)) {
    const x = num('x'),
      y = num('y')
    if (x !== undefined && y !== undefined)
      lines.push(ui('位置：({0}, {1})，认不出是哪个控件', [Math.round(x), Math.round(y)]))
  }
  const text = str('text')
  if (TEXT_ACTIONS.includes(action) && text !== undefined)
    lines.push(ui('将输入：{0}', [clip(visible(text), 200) || ui('（空）')]))
  if (KEY_ACTIONS.includes(action)) {
    const keys = str('keys') ?? text
    if (keys) lines.push(ui('按键：{0}', [clip(keys, 60)]))
  }
  if (Array.isArray(parameters.heldKeys) && parameters.heldKeys.length)
    lines.push(ui('已按住：{0}', [(parameters.heldKeys as unknown[]).map(String).join('+')]))
  const url = str('url')
  if (action === 'open_url' && url) lines.push(ui('网址：{0}', [clip(url, 160)]))
  const key = str('key')
  if (action === 'media_key' && key) lines.push(ui('媒体键：{0} ×{1}', [key, num('times') ?? 1]))
  const target = str('target')
  if (action === 'launch' && target) lines.push(ui('启动：{0}', [clip(target, 160)]))
  const dropProgram = str('dropProgram')
  if (action === 'drag' && dropProgram) {
    const what = names.length ? clip(names.join('、'), 60) : ui('（认不出的内容）')
    const where = str('dropTitle')?.trim() || ui('（无标题）')
    lines.push(ui('拖动：把「{0}」拖到 {1}「{2}」', [what, dropProgram, clip(where, 60)]))
    lines.push(ui('终点程序：{0}', [dropProgram]))
    if (desktopAppCategory(dropProgram) && desktopAppCategory(dropProgram) !== 'shell')
      lines.push(ui('终点能发送消息：拖进去不会发送，之后的发送仍会每次确认'))
  }
  const risk = desktopRiskText(parameters.risk)
  if (risk) lines.push(ui('为什么每次都问：{0}', [risk]))
  return lines
}
