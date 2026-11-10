import { t as __t } from '../../lib/i18n'
/**
 * shell — 角色查看并操控 infOS 外壳（阶段 3）
 *
 * - `shell_layout`：窗口清单、显示器、可摘出页面、当前主题（只含 infOS 自己的窗口）
 * - `shell_window`：摘出、合回、移动、缩放、复位、置顶 / 透明度、聚焦、恢复默认布局、撤回上一次布局改动
 * - `shell_theme`：列出、读取、写入、切换、删除自定义主题
 * - `shell_card`：角色设计的桌面卡片（阶段 4）：创建、整页更新、列出、读取、收藏、打开、关闭、删除
 * - `shell_fence`：桌面收纳框（预制件，见 fence.ts）
 *
 * 只在桌面频道提供（聊天与工作模式均可），后台任务不能使用；Electron 未连接时工具不提供，
 * 调用时也会返回“仅桌面版可用”。这些工具只操作 infOS 自身，不经过审批，
 * 也不受「桌面操作」总开关约束。结果写明改了什么、原来是什么，便于角色向用户说明。
 *
 * @see .docs/P03_DESKTOP_SHELL.md 阶段 3、阶段 4
 * @module packages/backend/src/tools/shell
 */

import {
  DESKTOP_CARD_LIMITS,
  isCustomThemeId,
  isDesktopCardHtml,
  isDesktopCardId,
  isDetachablePage,
  type DesktopShellOperation,
  type MainPageId,
} from '@infos/shared'
import type { BuiltinTool } from '../index'
import type { ToolContext } from '../../services/agent/toolRegistry'
import type { ThemeAssetInput, ThemeService } from '../../services/theme/themeService'
import { shellHomeInput } from './homeScope'

export const SHELL_TOOL_NAMES = [
  'shell_layout',
  'shell_window',
  'shell_theme',
  'shell_card',
  'shell_fence',
] as const

export interface ShellToolDeps {
  /** 调用 Electron desktop.shell 能力。 */
  invoke(operation: DesktopShellOperation, input: unknown, ctx: ToolContext): Promise<unknown>
  /** 是否有在线的桌面客户端提供外壳能力。 */
  isAvailable(): boolean
  themes: Pick<ThemeService, 'list' | 'readSource' | 'write' | 'remove'>
}

let deps: ShellToolDeps | null = null

/** 由容器注入能力运行时与主题服务。 */
export function setShellToolDeps(value: ShellToolDeps | null): void {
  deps = value && {
    ...value,
    invoke: (operation, input, context) =>
      value.invoke(operation, shellHomeInput(operation, input, context), context),
  }
}

const CATALOG = 'server.desktopShell'
export const text = (source: string, args: unknown[] = []) => __t(CATALOG, source, args)

/** 参数错误：直接把说明返回给角色。 */
class ShellArgumentError extends Error {}

export const argumentError = (source: string, args: unknown[] = []) =>
  new ShellArgumentError(text(source, args))

type ToolResult = Record<string, unknown>

export async function run(
  ctx: ToolContext,
  body: (current: ShellToolDeps) => Promise<ToolResult>,
): Promise<string> {
  if (ctx.taskId || (ctx.channel && ctx.channel !== 'desktop'))
    return JSON.stringify({
      success: false,
      error: text('外壳工具只能在桌面对话中使用，后台任务和其他频道不能调整窗口或主题'),
    })
  if (!deps || !deps.isAvailable())
    return JSON.stringify({
      success: false,
      error: text('外壳工具只能在 infOS 桌面版中使用，当前没有连接桌面客户端'),
    })
  try {
    return JSON.stringify({ success: true, ...(await body(deps)) })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return JSON.stringify({
      success: false,
      error: error instanceof ShellArgumentError ? message : text('外壳操作失败：{0}', [message]),
    })
  }
}

interface LayoutSnapshot {
  theme?: { mode?: string; custom?: string | null }
}

// ── shell_layout ──

export const shellLayoutTool: BuiltinTool = {
  name: 'shell_layout',
  allowedSources: ['desktop'],
  chatEnabled: true,
  async execute(_args, ctx) {
    return run(ctx, async (current) => ({
      layout: await current.invoke('layout', {}, ctx),
    }))
  },
}

// ── shell_window ──

const WINDOW_ACTIONS = [
  'detach',
  'attach',
  'move',
  'resize',
  'set',
  'focus',
  'recover',
  'reset',
  'undo',
] as const
type WindowAction = (typeof WINDOW_ACTIONS)[number]

function readNumber(args: Record<string, unknown>, key: string, required: boolean) {
  const value = args[key]
  if (value === undefined && !required) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw argumentError('参数 {0} 必须是数字', [key])
  return value
}

/** 页面参数：接受页面 ID 或 `panel:<页面 ID>`。 */
export function readPage(value: unknown): MainPageId {
  const page = typeof value === 'string' ? value.replace(/^panel:/, '') : value
  if (!isDetachablePage(page))
    throw argumentError('页面不存在或不能摘出：{0}', [String(value ?? '')])
  return page
}

/** 窗口目标：`main`、页面 ID、`panel:<页面 ID>` 或 `card:<卡片 ID>`。 */
export function readTarget(value: unknown): string {
  if (value === 'main') return 'main'
  if (value === undefined || value === '') throw argumentError('请指定目标窗口 target')
  if (typeof value === 'string' && value.startsWith('card:')) {
    if (!isDesktopCardId(value.slice(5))) throw argumentError('卡片 ID 无效：{0}', [value])
    return value
  }
  return `panel:${readPage(value)}`
}

/** 校验 shell_window 参数并转换为 Electron 操作；导出供单元测试。 */
export function parseWindowArgs(
  args: Record<string, unknown>,
):
  | { operation: 'reset' | 'undo'; input: Record<string, never> }
  | { operation: 'detach'; input: { pageId: MainPageId }; bounds?: Record<string, number> }
  | { operation: 'attach'; input: { pageId: MainPageId } }
  | { operation: 'setWindow'; input: Record<string, unknown> } {
  const action = args.action as WindowAction
  if (!WINDOW_ACTIONS.includes(action))
    throw argumentError('不支持的操作：{0}', [String(args.action ?? '')])
  if (action === 'reset' || action === 'undo') return { operation: action, input: {} }
  if (action === 'detach' || action === 'attach') {
    const pageId = readPage(args.page ?? args.target)
    if (action === 'attach') return { operation: 'attach', input: { pageId } }
    const bounds: Record<string, number> = {}
    for (const key of ['x', 'y', 'width', 'height']) {
      const value = readNumber(args, key, false)
      if (value !== undefined) bounds[key] = value
    }
    return {
      operation: 'detach',
      input: { pageId },
      ...(Object.keys(bounds).length ? { bounds } : {}),
    }
  }
  const target = readTarget(args.target ?? args.page)
  if (action === 'move')
    return {
      operation: 'setWindow',
      input: { target, bounds: { x: readNumber(args, 'x', true), y: readNumber(args, 'y', true) } },
    }
  if (action === 'resize')
    return {
      operation: 'setWindow',
      input: {
        target,
        bounds: {
          width: readNumber(args, 'width', true),
          height: readNumber(args, 'height', true),
        },
      },
    }
  if (action === 'focus') return { operation: 'setWindow', input: { target, focus: true } }
  // 复位：退出全屏/最大化，恢复默认大小并居中在工作区内。
  if (action === 'recover') return { operation: 'setWindow', input: { target, recover: true } }
  const input: Record<string, unknown> = { target }
  if (args.alwaysOnTop !== undefined) {
    if (typeof args.alwaysOnTop !== 'boolean')
      throw argumentError('参数 {0} 必须是布尔值', ['alwaysOnTop'])
    input.alwaysOnTop = args.alwaysOnTop
  }
  const opacity = readNumber(args, 'opacity', false)
  if (opacity !== undefined) {
    if (opacity < 0.4 || opacity > 1) throw argumentError('透明度必须在 0.4 到 1 之间')
    input.opacity = opacity
  }
  if (args.desktopLayer !== undefined) {
    if (typeof args.desktopLayer !== 'boolean')
      throw argumentError('参数 {0} 必须是布尔值', ['desktopLayer'])
    input.desktopLayer = args.desktopLayer
  }
  if (Object.keys(input).length === 1)
    throw argumentError('set 需要 alwaysOnTop、opacity 或 desktopLayer')
  return { operation: 'setWindow', input }
}

export const shellWindowTool: BuiltinTool = {
  name: 'shell_window',
  allowedSources: ['desktop'],
  chatEnabled: true,
  async execute(args, ctx) {
    return run(ctx, async (current) => {
      const parsed = parseWindowArgs(args)
      const result = (await current.invoke(parsed.operation, parsed.input, ctx)) as ToolResult
      // 摘出时带了位置：摘出后再按同一套修正规则移动到指定位置。
      if (parsed.operation === 'detach' && parsed.bounds && result.changed) {
        const placed = (await current.invoke(
          'setWindow',
          // amendLast：与摘出合并为一次改动，undo 一次撤回整个“摘出带位置”。
          { target: `panel:${parsed.input.pageId}`, bounds: parsed.bounds, amendLast: true },
          ctx,
        )) as ToolResult
        result.window = placed.current
      }
      return {
        action: args.action,
        ...result,
        message: !result.changed
          ? text('没有变化：目标已是请求的状态')
          : parsed.operation === 'undo'
            ? text('已撤回上一次窗口改动；previous 为撤回前的布局，remaining 为还可撤回的次数')
            : [
                text('已完成 {0}；previous 为修改前的状态，可据此向用户说明', [
                  String(args.action),
                ]),
                // 全屏或最大化的窗口会先还原再移动，提示角色向用户说明。
                ...(Array.isArray(result.restoredFrom) && result.restoredFrom.length
                  ? [
                      text(
                        '窗口原本处于全屏、最大化或最小化状态（{0}），已先还原为普通窗口再调整',
                        [result.restoredFrom.join(', ')],
                      ),
                    ]
                  : []),
              ].join(' '),
      }
    })
  },
}

// ── shell_theme ──

const THEME_ACTIONS = ['list', 'read', 'write', 'apply', 'delete'] as const
type ThemeAction = (typeof THEME_ACTIONS)[number]

function readThemeId(value: unknown): string {
  if (!isCustomThemeId(value)) throw argumentError('主题 ID 无效：{0}', [String(value ?? '')])
  return value
}

/** write 的资源参数：只检查结构，路径、类型、大小与 base64 由 ThemeService 校验。 */
export function readThemeAssets(args: Record<string, unknown>): {
  assets: ThemeAssetInput[]
  removeAssets: string[]
} {
  const { assets = [], removeAssets = [] } = args
  if (
    !Array.isArray(assets) ||
    !assets.every(
      (item) =>
        !!item &&
        typeof item === 'object' &&
        typeof (item as ThemeAssetInput).path === 'string' &&
        typeof (item as ThemeAssetInput).base64 === 'string',
    )
  )
    throw argumentError('assets 必须是 {path, base64} 对象的数组')
  if (!Array.isArray(removeAssets) || !removeAssets.every((item) => typeof item === 'string'))
    throw argumentError('removeAssets 必须是路径字符串数组')
  return {
    assets: (assets as ThemeAssetInput[]).map(({ path, base64 }) => ({ path, base64 })),
    removeAssets: removeAssets as string[],
  }
}

async function currentTheme(current: ShellToolDeps, ctx: ToolContext): Promise<string | null> {
  const layout = (await current.invoke('layout', {}, ctx)) as LayoutSnapshot
  return layout.theme?.custom ?? null
}

async function requireTheme(current: ShellToolDeps, id: string) {
  const theme = (await current.themes.list()).find((item) => item.id === id)
  if (!theme) throw argumentError('主题不存在：{0}', [id])
  return theme
}

export const shellThemeTool: BuiltinTool = {
  name: 'shell_theme',
  allowedSources: ['desktop'],
  chatEnabled: true,
  async execute(args, ctx) {
    return run(ctx, async (current) => {
      const action = args.action as ThemeAction
      if (!THEME_ACTIONS.includes(action))
        throw argumentError('不支持的操作：{0}', [String(args.action ?? '')])
      if (action === 'list')
        return {
          action,
          current: await currentTheme(current, ctx),
          themes: await current.themes.list(),
        }
      if (action === 'read') {
        const themeId = readThemeId(args.themeId)
        return { action, themeId, ...(await current.themes.readSource(themeId)) }
      }
      if (action === 'write') {
        const themeId = readThemeId(args.themeId)
        if (typeof args.css !== 'string' || !args.css.trim())
          throw argumentError('write 需要 css（theme.css 全文）')
        if (args.manifest !== undefined && (typeof args.manifest !== 'object' || !args.manifest))
          throw argumentError('manifest 必须是对象')
        const options = readThemeAssets(args)
        const before = await current.themes.readSource(themeId).catch(() => null)
        const { theme, created, assets, removedAssets } = await current.themes.write(
          themeId,
          args.manifest,
          args.css,
          options,
        )
        // 每条说明都是完整句子，按需追加资源文件的写入与删除情况。
        const message = [
          created
            ? text('已新建主题 {0}；用 apply 切换后生效', [themeId])
            : text('已覆盖主题 {0}；如正在使用，用 apply 重新应用', [themeId]),
          ...(assets.length
            ? [text('已写入资源文件：{0}', [assets.map((item) => item.path).join(', ')])]
            : []),
          ...(removedAssets.length
            ? [text('已删除资源文件：{0}', [removedAssets.join(', ')])]
            : []),
        ].join(' ')
        return {
          action,
          themeId,
          created,
          theme,
          assets,
          removedAssets,
          previous: before
            ? { manifest: before.manifest, cssLength: before.css.length }
            : { exists: false },
          message,
        }
      }
      if (action === 'apply') {
        const themeId = args.themeId === '' || args.themeId === undefined ? '' : args.themeId
        if (themeId !== '') await requireTheme(current, readThemeId(themeId))
        const result = (await current.invoke('applyTheme', { themeId }, ctx)) as ToolResult
        return {
          action,
          ...result,
          message: themeId
            ? text('已切换到主题 {0}；previous 为原来的主题（空表示默认外观）', [themeId])
            : text('已恢复默认外观；previous 为原来的主题'),
        }
      }
      const themeId = readThemeId(args.themeId)
      await requireTheme(current, themeId)
      const wasApplied = (await currentTheme(current, ctx)) === themeId
      if (wasApplied) await current.invoke('applyTheme', { themeId: '' }, ctx)
      await current.themes.remove(themeId)
      return {
        action,
        themeId,
        deleted: true,
        previous: { applied: wasApplied },
        message: wasApplied
          ? text('已删除主题 {0}；它原本正在使用，已恢复默认外观', [themeId])
          : text('已删除主题 {0}', [themeId]),
      }
    })
  },
}

// ── shell_card ──

const CARD_ACTIONS = [
  'list',
  'read',
  'create',
  'update',
  'save',
  'open',
  'close',
  'delete',
] as const
type CardAction = (typeof CARD_ACTIONS)[number]

function readCardId(value: unknown): string {
  if (!isDesktopCardId(value)) throw argumentError('卡片 ID 无效：{0}', [String(value ?? '')])
  return value
}

/** 校验 shell_card 参数并转换为 Electron `card` 操作的输入；导出供单元测试。 */
export function parseCardArgs(args: Record<string, unknown>): Record<string, unknown> {
  const action = args.action as CardAction
  if (!CARD_ACTIONS.includes(action))
    throw argumentError('不支持的操作：{0}', [String(args.action ?? '')])
  if (action === 'list') return { action }
  const html = () => {
    if (!isDesktopCardHtml(args.html))
      throw argumentError('html 为空或超过 {0}KB；图片请用 data URI 并压缩', [
        DESKTOP_CARD_LIMITS.html / 1024,
      ])
    return args.html
  }
  const name = () => {
    if (typeof args.name !== 'string' || !args.name.trim())
      throw argumentError('请提供卡片名称 name')
    return args.name
  }
  if (action === 'create') {
    const input: Record<string, unknown> = { action, name: name(), html: html() }
    const bounds: Record<string, number> = {}
    for (const key of ['x', 'y', 'width', 'height']) {
      const value = readNumber(args, key, false)
      if (value !== undefined) bounds[key] = value
    }
    if ((bounds.x === undefined) !== (bounds.y === undefined))
      throw argumentError('卡片位置需要同时提供 x 与 y')
    if (Object.keys(bounds).length) input.bounds = bounds
    if (args.alwaysOnTop !== undefined) {
      if (typeof args.alwaysOnTop !== 'boolean')
        throw argumentError('参数 {0} 必须是布尔值', ['alwaysOnTop'])
      input.alwaysOnTop = args.alwaysOnTop
    }
    return input
  }
  const cardId = readCardId(args.cardId)
  if (action === 'update') {
    const input: Record<string, unknown> = { action, cardId }
    if (args.name !== undefined) input.name = name()
    if (args.html !== undefined) input.html = html()
    if (Object.keys(input).length === 2) throw argumentError('update 需要 name 或 html')
    return input
  }
  if (action === 'save') {
    if (args.saved !== undefined && typeof args.saved !== 'boolean')
      throw argumentError('参数 {0} 必须是布尔值', ['saved'])
    return { action, cardId, saved: args.saved !== false }
  }
  return { action, cardId }
}

const CARD_MESSAGES: Record<CardAction, string> = {
  list: '这是全部卡片；open 为是否正在桌面上显示，saved 为是否已收藏',
  read: '这是卡片源码；console 为卡片最近的控制台错误，可据此修正',
  create: '已创建卡片 {0}（临时，关闭或退出后进「最近关闭」保留 7 天；用户想保留时用 save 收藏）',
  update: '已更新卡片 {0}，窗口已重新加载',
  save: '已更新卡片 {0} 的收藏状态',
  open: '已打开卡片 {0}',
  close: '已关闭卡片 {0}；未收藏的卡片进了「最近关闭」，7 天内可用 save 收藏捡回',
  delete: '已删除卡片 {0}',
}

export const shellCardTool: BuiltinTool = {
  name: 'shell_card',
  allowedSources: ['desktop'],
  chatEnabled: true,
  async execute(args, ctx) {
    return run(ctx, async (current) => {
      const input = parseCardArgs(args)
      const action = input.action as CardAction
      const result = (await current.invoke('card', input, ctx)) as ToolResult
      const card = result.card as { id?: string } | undefined
      const id = String(card?.id ?? input.cardId ?? '')
      return { action, ...result, message: text(CARD_MESSAGES[action], [id]) }
    })
  },
}
