import { t as __t } from '../../lib/i18n'
/**
 * desktopSafety — 桌面操作护栏的角色工具（阶段 2）
 *
 * - `desktop_plan`：多步桌面任务开始前列出要用的程序与用途，用户一次批准覆盖本次任务的普通区程序；
 *   高危区与禁区不在预批范围内。
 * - `desktop_safety`：读取分区设置；收紧（追加禁区 / 高危区、撤销信任、调严普通区模式）立即生效；
 *   放宽（信任、移出追加的条目、调松模式）由客户端弹出原生确认框，用户同意后生效；
 *   `disable` 关闭「桌面操作」总开关（只能关闭，不能打开）。
 *
 * 判断与审批都在 Electron 客户端完成（desktop.environment/control），后端只校验参数并转发。
 *
 * @see .docs/P03_DESKTOP_SHELL.md 阶段 2
 * @module packages/backend/src/tools/desktopSafety
 */

import { normalizeDesktopSafetyChange } from '@infos/shared'
import type { BuiltinTool } from '../index'
import type { ToolContext } from '../../services/agent/toolRegistry'

export interface DesktopSafetyProvider {
  /** 调用 desktop.environment/control（带调用者身份）。 */
  control(input: Record<string, unknown>, ctx: ToolContext): Promise<unknown>
  isAvailable(): boolean
}

let provider: DesktopSafetyProvider | null = null

export function setDesktopSafetyProvider(value: DesktopSafetyProvider | null): void {
  provider = value
}

const text = (source: string, args: unknown[] = []) => __t('server.desktopShell', source, args)

function failure(code: string, message: string): string {
  return JSON.stringify({ success: false, error: { code, message, dispatched: false } })
}

async function forward(input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  if (!provider || !provider.isAvailable())
    return failure('DESKTOP_AUTOMATION_UNAVAILABLE', text('当前没有连接 infOS 桌面客户端'))
  try {
    return JSON.stringify(await provider.control(input, ctx))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const separator = message.indexOf(':')
    return failure(
      separator > 0 ? message.slice(0, separator) : 'DESKTOP_SAFETY_FAILED',
      separator > 0 ? message.slice(separator + 1).trim() : message,
    )
  }
}

export const desktopPlanTool: BuiltinTool = {
  name: 'desktop_plan',
  async execute(args, ctx) {
    const programs = args.programs
    if (!Array.isArray(programs) || !programs.length || programs.length > 20)
      return failure('DESKTOP_PLAN_INVALID', text('programs 需要 1–20 个程序名'))
    if (!programs.every((item) => typeof item === 'string' && item.trim()))
      return failure('DESKTOP_PLAN_INVALID', text('programs 需要 1–20 个程序名'))
    return forward(
      {
        action: 'plan',
        programs: programs.map((item: string) => item.trim()),
        purpose: typeof args.purpose === 'string' ? args.purpose.slice(0, 300) : '',
      },
      ctx,
    )
  },
}

export const desktopSafetyTool: BuiltinTool = {
  name: 'desktop_safety',
  async execute(args, ctx) {
    const action = String(args.action ?? 'get')
    if (action === 'get') return forward({ action: 'safety' }, ctx)
    if (action === 'disable') return forward({ action: 'disable' }, ctx)
    if (action === 'change') {
      const change = normalizeDesktopSafetyChange(args.change)
      if (!change || !Object.keys(change).length)
        return failure('DESKTOP_SAFETY_INVALID', text('change 参数无效'))
      return forward({ action: 'safety', change }, ctx)
    }
    return failure('DESKTOP_SAFETY_INVALID', text('不支持的操作：{0}', [action]))
  },
}
