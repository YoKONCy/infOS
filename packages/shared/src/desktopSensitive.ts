/**
 * 桌面动作的敏感程度判断（宿主与后端共用同一份）：发消息、付款、系统设置、终端命令每次都问。
 *
 * 多层判断，宁可多问，不可漏问：
 * 1. 按程序：终端、系统设置程序里的任何动作；UWP 设置窗口、经典控制面板按标题归到系统设置。
 * 2. 按键：先统一成规范形式（别名、左右修饰键、顺序），并带上跨步骤按住的修饰键；
 *    Win+R、Win+X 等系统入口归终端，Win+I、Ctrl+Shift+Esc 等归系统设置。
 * 3. 按控件：控件名、AutomationId、OCR 编号文字、点击点下方控件的名字，规范化后按「包含」匹配付款、发送词。
 * 4. 按应用类别兜底：浏览器、即时通讯、邮件、系统外壳里，会「提交」的动作一律敏感——
 *    回车（含 Ctrl/Shift/Alt 加回车）、文字里任何位置带换行、认不出目标控件的坐标点击、提交确认删除类控件。
 *    系统外壳（资源管理器地址栏、运行框、开始菜单搜索）里的提交按终端命令处理。
 * 5. 浏览器外部协议对话框（「要打开此应用吗」）里的「打开 / 允许」按系统设置（借道打开应用）处理。
 *
 * 输入只用宿主核实过的事实（意图参数里的 program、title、windowClass、controlNames 等），
 * 模型自报的说明不参与判断。
 *
 * @see .docs/home/authorization.md 桌面动作共用判断
 */

import { normalizeHotkey, normalizeKeyName, splitHotkey } from './desktopSafetyNormalize'
import {
  BROWSER_PROGRAMS,
  CONTROL_PANEL_TITLES,
  MAIL_PROGRAMS,
  MESSAGING_PROGRAMS,
  OPEN_WORDS,
  PAY_WORDS,
  PROTOCOL_DIALOG_HINTS,
  RUN_DIALOG_TITLES,
  SEND_WORDS,
  SETTINGS_FRAME_TITLES,
  SETTINGS_HOTKEYS,
  SETTINGS_PROGRAMS,
  SHELL_PROGRAMS,
  SUBMIT_WORDS,
  TERMINAL_HOTKEYS,
  TERMINAL_PROGRAMS,
} from './desktopSensitiveLists'

export type DesktopRiskAction = 'app' | 'send' | 'pay' | 'settings' | 'terminal'
export type DesktopAppCategory = 'browser' | 'messaging' | 'mail' | 'shell'

/** 为什么要问（宿主核实过的依据，确认通知里照此说明）。 */
export type DesktopRiskReason =
  | 'terminal-program'
  | 'settings-program'
  | 'control-panel'
  | 'terminal-hotkey'
  | 'settings-hotkey'
  | 'protocol-dialog'
  | 'pay-control'
  | 'send-control'
  | 'submit-control'
  | 'submit-key'
  | 'newline'
  | 'unknown-click'

export interface DesktopRisk {
  action: DesktopRiskAction
  reason?: DesktopRiskReason
}

/** 判断所需的事实；都来自宿主（系统、UIA、OCR），不是模型自报的。 */
export interface DesktopRiskFacts {
  program: string
  title?: string
  windowClass?: string
  action: string
  /** type / set_value 的文字，或 hotkey / key_down 的按键。 */
  text?: string
  /** 跨步骤按住还没松开的键（规范名）。 */
  heldKeys?: string[]
  /** 点击时一起按下的修饰键（ctrl+shift）。 */
  modifiers?: string
  /** 目标控件的名字、AutomationId、OCR 文字、点击点下方控件的名字。 */
  controlNames?: string[]
  /** 点击点下方顶层窗口的标题（对话框可能是单独的窗口）。 */
  pointWindowTitle?: string
  /** 跨程序拖动的终点程序与窗口标题（系统读取）。 */
  dropProgram?: string
  dropTitle?: string
}

const CLICKS = [
  'click',
  'double_click',
  'triple_click',
  'invoke',
  'toggle',
  'select',
  'mouse_down',
  'mouse_up',
]
const KEYS = ['hotkey', 'key_down']

/** 程序名：小写 exe 文件名。 */
export function exeName(program: string): string {
  const name = (program ?? '').trim().toLowerCase().split(/[\\/]/).at(-1) ?? ''
  return name.endsWith('.exe') ? name : `${name}.exe`
}

/** 应用类别；不属于会「提交」的类别时返回 undefined。 */
export function desktopAppCategory(program: string): DesktopAppCategory | undefined {
  const name = exeName(program)
  if (BROWSER_PROGRAMS.has(name)) return 'browser'
  if (MESSAGING_PROGRAMS.has(name)) return 'messaging'
  if (MAIL_PROGRAMS.has(name)) return 'mail'
  if (SHELL_PROGRAMS.has(name)) return 'shell'
  return undefined
}

/**
 * 控件文字规范化：全角转半角（NFKC）、拆开驼峰与下划线、小写、合并空白。
 * 返回 [带空格的形式, 去掉所有空白和标点的形式]。
 */
export function normalizeLabel(value: string): [spaced: string, compact: string] {
  const spaced = value
    .normalize('NFKC')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_\-./\\:|]+/g, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
  const compact = spaced.replace(/[\s\p{P}\p{S}]+/gu, '')
  return [spaced, compact]
}

const ASCII = /^[a-z0-9 ]+$/
/** 词表「包含」匹配：中文直接比去空白后的文字；英文按词边界比（Sender 不算 send）。 */
export function matchWords(value: string, words: readonly string[]): boolean {
  if (!value) return false
  const [spaced, compact] = normalizeLabel(value)
  if (!compact) return false
  return words.some((word) => {
    if (!ASCII.test(word)) return compact.includes(word.replace(/\s+/g, ''))
    const pattern = word.split(' ').join('[^a-z0-9]*')
    return new RegExp(`(^|[^a-z0-9])${pattern}([^a-z0-9]|$)`).test(spaced)
  })
}

const titleHas = (title: string | undefined, words: readonly string[]) => {
  const [spaced, compact] = normalizeLabel(title ?? '')
  return words.some((word) => compact.includes(word.replace(/\s+/g, '')) || spaced.includes(word))
}
const titleIs = (title: string | undefined, words: readonly string[]) => {
  const [spaced] = normalizeLabel(title ?? '')
  return words.includes(spaced)
}

/** 这一步实际形成的按键组合（规范形式）：按住的键加上这次的键。 */
export function effectiveHotkey(facts: Pick<DesktopRiskFacts, 'text' | 'heldKeys'>): string {
  const keys = [...(facts.heldKeys ?? []).map(normalizeKeyName), ...splitHotkey(facts.text ?? '')]
  return normalizeHotkey(keys.join('+'))
}

/** 按键组合里有没有「提交」：回车（含各种修饰键加回车）。 */
const submitsByKey = (combo: string) => combo.split('+').includes('enter')

/** 在按住修饰键时输入文字，等于逐个按下组合键（先按住 Alt 再输入 s 就是 Alt+S）。 */
function typedCombos(facts: DesktopRiskFacts): string[] {
  const held = (facts.heldKeys ?? []).map(normalizeKeyName).filter((key) => key !== 'shift')
  if (!held.length || facts.action !== 'type') return []
  return [...(facts.text ?? '')].map((ch) =>
    normalizeHotkey([...held, /[\r\n]/.test(ch) ? 'enter' : ch === '+' ? 'plus' : ch].join('+')),
  )
}

/**
 * 判断一个桌面动作要归到哪一类；`app` 表示普通操作。
 * 跨程序拖动另看终点：终点是终端、系统设置时按终点归类；拖进聊天、邮件、浏览器本身不算发送
 * （之后的回车、点发送照样每次都问），确认里写清「把 X 拖到 Y」。
 */
export function classifyDesktopRisk(facts: DesktopRiskFacts): DesktopRisk {
  const source = classifySource(facts)
  if (source.action !== 'app' || !facts.dropProgram) return source
  const drop = classifySource({
    program: facts.dropProgram,
    title: facts.dropTitle,
    action: 'drop',
  })
  return drop.action === 'app' ? source : drop
}

function classifySource(facts: DesktopRiskFacts): DesktopRisk {
  const program = exeName(facts.program)
  const action = String(facts.action ?? '').toLowerCase()
  const title = facts.title ?? ''
  const windowClass = (facts.windowClass ?? '').toLowerCase()
  if (TERMINAL_PROGRAMS.has(program)) return { action: 'terminal', reason: 'terminal-program' }
  if (SETTINGS_PROGRAMS.has(program)) return { action: 'settings', reason: 'settings-program' }
  if (program === 'applicationframehost.exe' && titleIs(title, SETTINGS_FRAME_TITLES))
    return { action: 'settings', reason: 'settings-program' }
  if (
    program === 'explorer.exe' &&
    (windowClass === 'cabinetwclass' || !windowClass) &&
    titleHas(title, CONTROL_PANEL_TITLES)
  )
    return { action: 'settings', reason: 'control-panel' }

  const combos = KEYS.includes(action) ? [effectiveHotkey(facts)] : typedCombos(facts)
  const clicking = CLICKS.includes(action)
  for (const combo of combos) {
    if (TERMINAL_HOTKEYS.has(combo)) return { action: 'terminal', reason: 'terminal-hotkey' }
    if (SETTINGS_HOTKEYS.has(combo)) return { action: 'settings', reason: 'settings-hotkey' }
  }

  const category = desktopAppCategory(program)
  const labels = (facts.controlNames ?? []).filter(
    (label): label is string => typeof label === 'string' && !!label.trim(),
  )
  const labelHas = (words: readonly string[]) => labels.some((label) => matchWords(label, words))
  const shell = category === 'shell'
  // 外部协议对话框：浏览器里的「打开 / 允许」，或对话框提示文字出现在控件、对话框标题里。
  if (
    category === 'browser' &&
    (clicking || combos.some(submitsByKey)) &&
    (labelHas(OPEN_WORDS) ||
      labelHas(PROTOCOL_DIALOG_HINTS) ||
      titleHas(facts.pointWindowTitle, PROTOCOL_DIALOG_HINTS) ||
      windowClass === '#32770')
  )
    return { action: 'settings', reason: 'protocol-dialog' }
  if (clicking && labelHas(PAY_WORDS)) return { action: 'pay', reason: 'pay-control' }
  if (clicking && labelHas(SEND_WORDS))
    return { action: shell ? 'terminal' : 'send', reason: 'send-control' }
  if (!category) return { action: 'app' }

  // 会「提交」的应用：回车、换行、认不出的点击、提交确认类控件。
  const submit: DesktopRiskAction = shell ? 'terminal' : 'send'
  if (combos.some(submitsByKey)) return { action: submit, reason: 'submit-key' }
  if (
    (action === 'type' || action === 'set_value') &&
    /[\r\n]/.test(facts.text ?? '') &&
    (action === 'type' || shell)
  )
    return { action: submit, reason: 'newline' }
  // Alt+S、Ctrl+S（部分邮件、聊天软件的发送键）。
  if (
    (category === 'messaging' || category === 'mail') &&
    combos.some((combo) => combo === 'alt+s' || combo === 'ctrl+s')
  )
    return { action: 'send', reason: 'submit-key' }
  if (clicking && labelHas(SUBMIT_WORDS)) return { action: submit, reason: 'submit-control' }
  if (clicking && !labels.length) return { action: submit, reason: 'unknown-click' }
  // 运行框里的任何点击都可能是「确定」。
  if (shell && clicking && titleIs(title, RUN_DIALOG_TITLES))
    return { action: 'terminal', reason: 'submit-control' }
  return { action: 'app' }
}

/** 从后端绑定的意图参数里取出判断所需的事实（后端复核用，参数由宿主填写）。 */
export function desktopRiskFactsFromParameters(
  parameters: Record<string, unknown> | undefined,
  app?: string,
): DesktopRiskFacts {
  const value = parameters ?? {}
  const str = (key: string) => (typeof value[key] === 'string' ? (value[key] as string) : undefined)
  const list = (key: string) =>
    Array.isArray(value[key])
      ? (value[key] as unknown[]).filter((item): item is string => typeof item === 'string')
      : undefined
  return {
    program: str('program') ?? app ?? '',
    title: str('title'),
    windowClass: str('windowClass'),
    action: str('action') ?? '',
    text: str('text') ?? str('keys'),
    heldKeys: list('heldKeys'),
    modifiers: str('modifiers'),
    controlNames: list('controlNames'),
    pointWindowTitle: str('pointWindowTitle'),
    dropProgram: str('dropProgram'),
    dropTitle: str('dropTitle'),
  }
}

/** 动作归类的严格程度：后端只允许宿主给的归类与复核结果一样严或更严。 */
export function isSensitiveDesktopAction(action: string): boolean {
  return ['send', 'pay', 'settings', 'terminal'].includes(action)
}
