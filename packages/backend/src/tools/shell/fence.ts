/**
 * shell_fence — Agent 建立和整理桌面收纳框（预制件 fence）
 *
 * 收纳框是 infOS 内置的「受信任卡片」：把桌面上的程序、文件、文件夹以路径引用收在半透明框里，
 * 不移动、不复制、不删除用户文件。经 Electron `desktop.shell` 的 `prefab` 操作执行。
 *
 * - 身份：沿用卡片工具的身份注入，`__homeScope` 由运行上下文写入，模型参数里的同名字段被丢弃；
 * - 能做：list、desktop（只读列出桌面图标）、create、update、add、remove、reorder、arrange、delete；
 * - 不能做：启动框里的程序（请走桌面动作授权）、隐藏桌面原图标（只能由用户在卡片页操作）。
 *
 * @see .docs/P11_DESKTOP_PREFABS.md
 * @module packages/backend/src/tools/shell/fence
 */

import {
  FENCE_ICON_SIZES,
  FENCE_LAYOUTS,
  FENCE_LIMITS,
  FENCE_SORTS,
  isDesktopCardId,
  isFenceBackgroundOpacity,
  normalizeFencePath,
} from '@infos/shared'
import type { BuiltinTool } from '../index'
import { argumentError, run, text } from './index'

export const FENCE_ACTIONS = [
  'list',
  'desktop',
  'create',
  'update',
  'add',
  'remove',
  'reorder',
  'arrange',
  'delete',
] as const
type FenceAction = (typeof FENCE_ACTIONS)[number]

function readFenceId(value: unknown, field = 'fenceId'): string {
  if (!isDesktopCardId(value))
    throw argumentError('参数 {0} 无效：{1}', [field, String(value ?? '')])
  return value
}

function readPaths(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > FENCE_LIMITS.items)
    throw argumentError('paths 必须是 1 到 {0} 个本机绝对路径', [FENCE_LIMITS.items])
  return value.map((item) => {
    const path = normalizeFencePath(item)
    if (!path)
      throw argumentError('路径无效（只接受本机绝对路径，不接受网络路径）：{0}', [String(item)])
    return path
  })
}

function pick(
  args: Record<string, unknown>,
  input: Record<string, unknown>,
  key: string,
  check: (value: unknown) => boolean,
): void {
  if (args[key] === undefined) return
  if (!check(args[key])) throw argumentError('参数 {0} 无效：{1}', [key, String(args[key])])
  input[key] = args[key]
}

const isBoolean = (value: unknown) => typeof value === 'boolean'
const isNumber = (value: unknown) => typeof value === 'number' && Number.isFinite(value)
const isTitle = (value: unknown) =>
  typeof value === 'string' && !!value.trim() && value.length <= 60

/**
 * 校验 shell_fence 参数并转换为 Electron `prefab` 操作的输入；只放行已知字段，
 * 身份字段（`__homeScope`、`createdBy`）一律不从模型参数读取。导出供单元测试。
 */
export function parseFenceArgs(args: Record<string, unknown>): Record<string, unknown> {
  const action = args.action as FenceAction
  if (!FENCE_ACTIONS.includes(action))
    throw argumentError('不支持的操作：{0}', [String(args.action ?? '')])
  const input: Record<string, unknown> = { kind: 'fence', action }
  if (action === 'list' || action === 'desktop') return input
  const options = () => {
    pick(args, input, 'iconSize', (v) => FENCE_ICON_SIZES.includes(v as never))
    pick(args, input, 'sort', (v) => FENCE_SORTS.includes(v as never))
    pick(args, input, 'collapsed', isBoolean)
    pick(args, input, 'alwaysOnTop', isBoolean)
    pick(args, input, 'backgroundOpacity', isFenceBackgroundOpacity)
  }
  if (action === 'create') {
    if (!isTitle(args.title)) throw argumentError('请提供收纳框标题 title（60 字以内）')
    input.title = args.title
    for (const key of ['x', 'y', 'width', 'height']) pick(args, input, key, isNumber)
    if ((input.x === undefined) !== (input.y === undefined))
      throw argumentError('收纳框位置需要同时提供 x 与 y')
    if (args.paths !== undefined) input.paths = readPaths(args.paths)
    if (args.folder !== undefined) input.folder = readPaths([args.folder])[0]
    options()
    return input
  }
  if (action === 'arrange') {
    const ids = args.fenceIds
    if (!Array.isArray(ids) || !ids.length || ids.length > 50)
      throw argumentError('arrange 需要 fenceIds（1 到 50 个收纳框 ID）')
    input.fenceIds = ids.map((id) => readFenceId(id, 'fenceIds'))
    pick(args, input, 'layout', (v) => FENCE_LAYOUTS.includes(v as never))
    for (const key of ['x', 'y']) pick(args, input, key, isNumber)
    if ((input.x === undefined) !== (input.y === undefined))
      throw argumentError('起点需要同时提供 x 与 y')
    pick(args, input, 'gap', (v) => isNumber(v) && (v as number) >= 0 && (v as number) <= 200)
    pick(args, input, 'columns', (v) => isNumber(v) && (v as number) >= 1 && (v as number) <= 20)
    return input
  }
  input.fenceId = readFenceId(args.fenceId)
  if (action === 'update') {
    pick(args, input, 'title', isTitle)
    options()
    if (args.folder !== undefined)
      input.folder = args.folder === null ? null : readPaths([args.folder])[0]
    if (Object.keys(input).length === 3)
      throw argumentError(
        'update 需要 title、collapsed、alwaysOnTop、iconSize、sort、backgroundOpacity 或 folder',
      )
  } else if (action === 'add' || action === 'remove' || action === 'reorder')
    input.paths = readPaths(args.paths)
  return input
}

const FENCE_MESSAGES: Record<FenceAction, string> = {
  list: '这是全部收纳框；items 是框里引用的路径，fromFolder 表示来自映射的文件夹',
  desktop: '这是桌面上的图标（只读列出）；分组前先和用户确认想怎么分',
  create: '已新建收纳框 {0}；框里只引用路径，不移动用户文件',
  update: '已修改收纳框 {0}；previous 为修改前的状态',
  add: '已把项目加入收纳框 {0}（只是引用）；skipped 为跳过的路径及原因',
  remove: '已从收纳框 {0} 移出项目；文件本身没有任何改动',
  reorder: '已重新排列收纳框 {0} 的项目（改为手动排序）',
  arrange: '已把收纳框排成一组；skipped 为贴在桌面上或未打开、没有移动的框',
  delete: '已删除收纳框 {0}；框里引用的文件没有任何改动',
}

export const shellFenceTool: BuiltinTool = {
  name: 'shell_fence',
  allowedSources: ['desktop'],
  chatEnabled: true,
  async execute(args, ctx) {
    return run(ctx, async (current) => {
      const input = parseFenceArgs(args)
      const action = input.action as FenceAction
      const result = (await current.invoke('prefab', input, ctx)) as Record<string, unknown>
      const fence = result.fence as { fenceId?: string } | undefined
      const id = String(fence?.fenceId ?? input.fenceId ?? '')
      return { action, ...result, message: text(FENCE_MESSAGES[action], [id]) }
    })
  },
}
