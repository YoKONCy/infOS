/**
 * @file 桌面护栏用到的「宿主核实过的事实」：控件名、点击点下方的控件、跨步骤按住的键、浏览器里的 infOS 网页端。
 *
 * - 这些事实都来自系统（UIA、OCR、窗口信息），由主进程在动作前填写，模型传的同名参数一律丢掉：
 *   后端工具只放行清单里的参数，`prepareHandsInput` 也会先删掉 `__hostFacts`、`refText` 再填。
 * - 按住的键：`key_down` 记下、`key_up` 松开、5 秒后自动作废（桥接的按住上限约 2 秒，这里只会更严）。
 * - 浏览器里打开的 infOS 网页端属于禁区：按窗口标题或地址栏的值识别。
 *
 * @platform ELECTRON
 */

import { desktopAppCategory } from '../../../packages/shared/src/desktopSensitive'
import {
  isModifierKey,
  normalizeKeyName,
  splitHotkey,
} from '../../../packages/shared/src/desktopSafetyNormalize'

/** 主进程在动作前附上的事实（模型不能填写）。 */
export interface DesktopHostFacts {
  /** 点击点下方控件及其外层按钮的名字、AutomationId（UIA ElementFromPoint）。 */
  pointLabels?: string[]
  /** 点击点下方顶层窗口的标题。 */
  pointWindowTitle?: string
  /** 观察里地址栏的当前值（浏览器）。 */
  addressValues?: string[]
  /** 跨程序拖动的终点窗口（windowAt 读到的，不是观察的那个程序）。 */
  drop?: DropWindow
}

/** 拖动终点所在的窗口（系统读取）。 */
export interface DropWindow {
  program: string
  title: string
  windowClass?: string
  windowId?: string
  pid: number
}

/** 读取主进程附上的事实；不是对象或字段类型不对时当作没有。 */
export function readHostFacts(value: unknown): DesktopHostFacts {
  if (!value || typeof value !== 'object') return {}
  const raw = value as Record<string, unknown>
  const strings = (item: unknown) =>
    Array.isArray(item)
      ? item.filter((entry): entry is string => typeof entry === 'string' && !!entry.trim())
      : undefined
  return {
    pointLabels: strings(raw.pointLabels),
    pointWindowTitle: typeof raw.pointWindowTitle === 'string' ? raw.pointWindowTitle : undefined,
    addressValues: strings(raw.addressValues),
    drop: readDrop(raw.drop),
  }
}

function readDrop(value: unknown): DropWindow | undefined {
  const raw = value as Partial<DropWindow> | undefined
  if (!raw || typeof raw.program !== 'string' || !raw.program || typeof raw.pid !== 'number')
    return undefined
  return {
    program: raw.program,
    title: typeof raw.title === 'string' ? raw.title : '',
    pid: raw.pid,
    ...(typeof raw.windowClass === 'string' ? { windowClass: raw.windowClass } : {}),
    ...(typeof raw.windowId === 'string' ? { windowId: raw.windowId } : {}),
  }
}

/** 目标控件的名字来源：UIA 控件名与 AutomationId、OCR 编号文字、点击点下方的控件。 */
export function controlNamesOf(input: Record<string, unknown>, facts: DesktopHostFacts): string[] {
  const element = input.element as { name?: unknown; automationId?: unknown } | undefined
  const names = [
    element?.name,
    element?.automationId,
    input.refText,
    ...(facts.pointLabels ?? []),
  ].filter((item): item is string => typeof item === 'string' && !!item.trim())
  return [...new Set(names.map((name) => name.trim().slice(0, 120)))].slice(0, 8)
}

/** 跨步骤按住的键（规范名）。 */
export class HeldKeyTracker {
  private readonly keys = new Map<string, number>()
  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 5_000,
  ) {}

  /** 当前按住的键。 */
  current(): string[] {
    const now = this.now()
    for (const [key, expiry] of this.keys) if (expiry <= now) this.keys.delete(key)
    return [...this.keys.keys()]
  }

  /** 动作发出前记录：key_down 记下，key_up 松开；其他动作不变。 */
  track(input: Record<string, unknown>): void {
    const action = String(input.action ?? '')
    const keys = splitHotkey(typeof input.text === 'string' ? input.text : '')
    if (action === 'key_down')
      for (const key of keys) this.keys.set(normalizeKeyName(key), this.now() + this.ttlMs)
    if (action === 'key_up') for (const key of keys) this.keys.delete(normalizeKeyName(key))
  }

  /** 只有修饰键才会和后续按键组成组合键。 */
  modifiers(): string[] {
    return this.current().filter(isModifierKey)
  }

  clear(): void {
    this.keys.clear()
  }
}

/** infOS 网页端的标题特征（前端的 document.title 形如「页面 - PeroperoChat」）。 */
const INFOS_TITLE = /peroperochat|\binfos\b/i

/**
 * 浏览器里打开的 infOS 网页端：按窗口标题或地址栏识别。
 * origins 是 infOS 后端与网页端的来源（如 http://localhost:9120）。
 */
export function isInfosWebPage(
  program: string,
  title: string | undefined,
  facts: DesktopHostFacts,
  origins: string[],
): boolean {
  if (desktopAppCategory(program) !== 'browser') return false
  if (INFOS_TITLE.test(title ?? '') || INFOS_TITLE.test(facts.pointWindowTitle ?? '')) return true
  const hosts = origins
    .map((origin) => {
      try {
        const url = new URL(origin)
        return url.host.toLowerCase()
      } catch {
        return ''
      }
    })
    .filter(Boolean)
  const loopback = hosts.flatMap((host) => {
    const port = host.split(':')[1]
    return port ? [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`] : [host]
  })
  return (facts.addressValues ?? []).some((value) => {
    const text = value.trim().toLowerCase()
    return [...hosts, ...loopback].some((host) => text.includes(host))
  })
}
