/**
 * @file 「手」：按元素编号操作（「点 7 号」）。纯函数，不依赖 Electron，便于单独测试。
 *
 * - 编号只在它所属的那次观察里有效：`ref` 必须和同一次观察的 `observationId` 一起给，
 *   编号来自那次观察的元素图（`elementMap`），见 desktopElementMap.resolveElementRef。
 * - 按元素定位优先，坐标作为退路：条目是本次观察里登记过的 UIA 控件、且动作有对应的控件操作时，
 *   改写成按控件操作（`elementId`）；否则取框中心点按坐标操作（截图坐标）。
 * - 输入类动作（type、hotkey 等）不接受编号：先点中输入框，再在新观察上输入。
 *
 * 参考 clawdcursor 按 `{element_id, snapshot_id}` 操作的做法（MIT，见 THIRD_PARTY_NOTICES.md）。
 *
 * @platform ELECTRON
 * @see .docs/B02_DESKTOP_AUTOMATION.md 按元素编号操作
 */

import { resolveElementRef, type ElementMapEntry } from './desktopElementMap'

/** 只能按控件执行的动作。 */
const ELEMENT_ONLY = ['set_value', 'expand', 'collapse']
/** 有控件就按控件执行、没有就点框中心的动作。 */
const ELEMENT_OR_CLICK = ['invoke', 'toggle', 'select']
/** 按坐标执行的鼠标动作（编号换成框中心点）。 */
const POINT_ACTIONS = [
  'click',
  'double_click',
  'triple_click',
  'right_click',
  'move',
  'drag',
  'scroll',
  'mouse_down',
]
/** 控件操作对应的 UIA 模式名（元素图 patterns 里的写法）。 */
const PATTERN_OF: Record<string, string> = {
  invoke: 'invoke',
  click: 'invoke',
  set_value: 'value',
  toggle: 'toggle',
  select: 'select',
  expand: 'expand',
  collapse: 'expand',
  scroll: 'scroll',
}

export interface RefObservation {
  id: string
  elementMap: ElementMapEntry[]
  /** 本次观察登记过的 UIA 控件编号（可直接按控件操作）。 */
  elements: { id: string }[]
}

/** 动作结果里回报给模型的目标说明。 */
export interface RefTarget {
  ref: number
  role: string
  text: string
  /** uia：按控件操作；point：按框中心点的坐标操作。 */
  method: 'uia' | 'point'
}

const refError = (text: string) => new Error(`DESKTOP_ELEMENT_REF_INVALID: ${text}`)

/** 读取 `ref`：只接受正整数；没给时返回 undefined。 */
export function readRef(input: Record<string, unknown>): number | undefined {
  if (input.ref === undefined || input.ref === null) return undefined
  const value = typeof input.ref === 'string' ? Number(input.ref.trim()) : input.ref
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1)
    throw refError('ref 是元素图里的编号（正整数）')
  return value
}

/**
 * 把带 `ref` 的动作改写成按控件或按坐标的动作。没有 `ref` 时原样返回。
 * `observation` 必须是 `input.observationId` 指向的那次观察（由调用方按编号和归属取回）。
 */
export function applyElementRef(
  observation: RefObservation | undefined,
  input: Record<string, unknown>,
): { input: Record<string, unknown>; target?: RefTarget } {
  const ref = readRef(input)
  if (ref === undefined) return { input }
  if (typeof input.observationId !== 'string' || !input.observationId.trim())
    throw refError('元素编号只在它所属的那次观察里有效，请同时提供那次的 observationId')
  if (!observation || observation.id !== input.observationId)
    throw new Error('DESKTOP_OBSERVATION_STALE: 请先观察桌面，再引用本次 observationId 操作')
  if (input.elementId !== undefined || input.x !== undefined || input.y !== undefined)
    throw refError('ref 与 elementId、坐标只能给一种')
  if (!observation.elementMap.length)
    throw refError('这次观察没有元素图：请加 includeElements: true 重新观察，再按编号操作')
  const action = String(input.action ?? '')
  const { entry, elementId, point } = resolveElementRef(observation.elementMap, ref)
  const registered = !!elementId && observation.elements.some((item) => item.id === elementId)
  const pattern = PATTERN_OF[action]
  const supports = registered && !!pattern && (entry.patterns ?? []).includes(pattern)
  const { ref: _ref, ...rest } = input
  const describe = (method: RefTarget['method']): RefTarget => ({
    ref,
    role: entry.role,
    text: entry.text.slice(0, 80),
    method,
  })
  // 控件操作：有对应模式就按控件执行（不依赖焦点和坐标，最稳）。
  if (supports && (ELEMENT_ONLY.includes(action) || ELEMENT_OR_CLICK.includes(action)))
    return { input: { ...rest, elementId }, target: describe('uia') }
  // 点按钮、链接这类带 invoke 的控件：按控件「调用」，比点坐标稳。
  if (supports && action === 'click' && input.button === undefined && !input.modifiers)
    return { input: { ...rest, action: 'invoke', elementId }, target: describe('uia') }
  if (supports && action === 'scroll')
    return { input: { ...rest, elementId }, target: describe('uia') }
  if (ELEMENT_ONLY.includes(action))
    throw new Error(
      `DESKTOP_PATTERN_UNSUPPORTED: ${ref} 号（${entry.role}）不支持 ${action}，请换用点击或输入`,
    )
  // 坐标退路：取框中心点（截图坐标）。
  if (POINT_ACTIONS.includes(action) || ELEMENT_OR_CLICK.includes(action)) {
    const fallback = ELEMENT_OR_CLICK.includes(action) ? { action: 'click' } : {}
    return {
      input: { ...rest, ...fallback, x: point.x, y: point.y, coordinateSpace: 'screenshot' },
      target: describe('point'),
    }
  }
  throw refError(`${action} 不能按编号执行：先点中目标（ref），再在新的观察上输入`)
}
