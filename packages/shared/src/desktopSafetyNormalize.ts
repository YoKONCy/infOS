/** 桌面操作护栏的归一化：程序名、快捷键与路径。 */

import { DESKTOP_SAFETY_LIMITS } from './desktopSafetyModel'

// ─── 归一化 ─────────────────────────────────────────

/** 程序名：取文件名、小写、去掉 `.exe`。`C:\\Windows\\System32\\cmd.exe`、`CMD`、`cmd.exe` 都是 `cmd`。 */
export function normalizeProgramName(value: string): string {
  const base = value.trim().split(/[\\/]/).pop() ?? ''
  return base.toLowerCase().replace(/\.exe$/, '')
}

const PROGRAM_PATTERN = /^[\p{L}\p{N} _.()+&-]+$/u

export function isProgramEntry(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= DESKTOP_SAFETY_LIMITS.text &&
    PROGRAM_PATTERN.test(value.trim())
  )
}

/**
 * 按键别名 → 规范名。覆盖桥接（windowsDesktopSource / windowsDesktopHandsSource 的 KeyCode、ExtraKeyCode）
 * 接受的所有左右修饰键写法，以及常见的其他平台写法：Meta、Cmd、Super、OS 都算 Win。
 */
const KEY_ALIASES: Record<string, string> = {
  control: 'ctrl',
  ctl: 'ctrl',
  leftctrl: 'ctrl',
  leftcontrol: 'ctrl',
  rightctrl: 'ctrl',
  rightcontrol: 'ctrl',
  lctrl: 'ctrl',
  rctrl: 'ctrl',
  lcontrol: 'ctrl',
  rcontrol: 'ctrl',
  controlleft: 'ctrl',
  controlright: 'ctrl',
  option: 'alt',
  opt: 'alt',
  leftalt: 'alt',
  rightalt: 'alt',
  lalt: 'alt',
  ralt: 'alt',
  altleft: 'alt',
  altright: 'alt',
  altgr: 'alt',
  leftshift: 'shift',
  rightshift: 'shift',
  lshift: 'shift',
  rshift: 'shift',
  shiftleft: 'shift',
  shiftright: 'shift',
  meta: 'win',
  cmd: 'win',
  command: 'win',
  super: 'win',
  windows: 'win',
  os: 'win',
  leftwin: 'win',
  rightwin: 'win',
  lwin: 'win',
  rwin: 'win',
  leftsuper: 'win',
  rightsuper: 'win',
  leftmeta: 'win',
  rightmeta: 'win',
  metaleft: 'win',
  metaright: 'win',
  leftcmd: 'win',
  rightcmd: 'win',
  leftwindows: 'win',
  rightwindows: 'win',
  escape: 'esc',
  del: 'delete',
  return: 'enter',
  numpadenter: 'enter',
  kpenter: 'enter',
  numenter: 'enter',
}
const MODIFIER_ORDER = ['ctrl', 'alt', 'shift', 'win']

/** 单个按键名的规范形式（小写、去空白、统一别名）。 */
export function normalizeKeyName(value: string): string {
  const key = value.replace(/\s+/g, '').toLowerCase()
  return KEY_ALIASES[key] ?? key
}

/** 拆分快捷键：`Ctrl++` 这种以加号结尾的写法把最后的加号当作 plus 键。 */
export function splitHotkey(value: string): string[] {
  const raw = value.replace(/\s+/g, '')
  const plusKey = raw === '+' || raw.endsWith('++')
  const keys = raw.split('+').filter(Boolean).map(normalizeKeyName)
  if (plusKey) keys.push('plus')
  return [...new Set(keys)]
}

/**
 * 快捷键：小写、统一别名、去重、修饰键按固定顺序。
 * `Control+Shift+Escape`、`shift+ctrl+esc`、`RightCtrl+Shift+Esc` 都是 `ctrl+shift+esc`；
 * `RightWin+R`、`LeftSuper+R`、`Meta+R` 都是 `win+r`；`Enter+Ctrl` 与 `Control+Return` 都是 `ctrl+enter`。
 */
export function normalizeHotkey(value: string): string {
  const keys = splitHotkey(value)
  const modifiers = MODIFIER_ORDER.filter((key) => keys.includes(key))
  const rest = keys.filter((key) => !MODIFIER_ORDER.includes(key)).sort()
  return [...modifiers, ...rest].join('+')
}

/** 是不是修饰键（规范名）。 */
export function isModifierKey(key: string): boolean {
  return MODIFIER_ORDER.includes(normalizeKeyName(key))
}

/** 统一分隔符、去掉末尾分隔符；Windows 不区分大小写。 */
export function canonicalPath(value: string, windows: boolean): string {
  let result = value.replace(/\\/g, '/')
  if (windows) result = result.replace(/^\/\/\?\/UNC\//i, '//').replace(/^\/\/\?\//, '')
  result = result.replace(/\/{2,}/g, '/')
  // 解析 . 与 ..，避免 C:/Windows/../Windows 绕过
  const parts: string[] = []
  for (const part of result.split('/')) {
    if (part === '.' || (part === '' && parts.length > 0)) continue
    if (part === '..') {
      if (parts.length > 1) parts.pop()
      continue
    }
    parts.push(windows ? part.replace(/[ .]+$/, '') : part)
  }
  result = parts.join('/') || '/'
  return windows ? result.toLowerCase() : result
}
