import path from 'node:path'
import type { BuiltinTool } from '../index'
import type { HomeService } from '../../services/home/homeService'
import type { ToolContext } from '../../services/agent/toolRegistry'
import { HomeError, homeMessage, homeOutcomeMessage } from '../../services/home/homeErrors'
import { withHomeConfirmation } from '../../services/home/homeConfirmWait'
import {
  homeCardSchema,
  homeDeclarationSchema,
  homeFileSchema,
  homeMapSchema,
  homeScopeSchema,
  homeShelfSchema,
} from '../../services/home/homeSchemas'
import {
  homeCardCommand,
  homeFileCommand,
  homeMapCommand,
  homeShelfCommand,
} from '../../services/home/homeCommands'
import { toolFailure, toolSuccess } from '../../services/execution/toolResult'
import { resolveExecutionSession } from '../productivityRuntimeHolder'
import { deleteForAgent } from '../../services/home/homeNativeDelete'

let service: HomeService | undefined
export function setHomeService(value?: HomeService) {
  service = value
}
export function homeToolScope(ctx: ToolContext) {
  return homeScopeSchema.parse({
    agentId: ctx.agentId,
    sessionId: ctx.threadId,
    taskId: ctx.taskId ?? ctx.pairId,
  })
}
/** 需要确认时这次调用就地等用户；拒绝、超时、取消、冲突变成带路径和操作标识的 HomeError。 */
function confirming<T>(home: HomeService, ctx: ToolContext, attempt: () => T | Promise<T>) {
  return withHomeConfirmation(
    home,
    { signal: ctx.signal, backgroundTask: !!ctx.taskId, onStatus: ctx.onExecutionStatus },
    attempt,
  )
}
/**
 * 旧写入、编辑工具的整段操作（含文件锁）放进 attempt：确认在锁里抛出、锁释放后才开始等，
 * 批准后重新进锁、重新读文件。桌面以外的通道没有家的保险，直接跑。
 */
export function withLegacyHomeConfirmation<T>(ctx: ToolContext, attempt: () => Promise<T>) {
  return service && ctx.channel === 'desktop' ? confirming(service, ctx, attempt) : attempt()
}
export function homeToolFailure(error: unknown) {
  const code = error instanceof HomeError ? error.code : 'HOME_INVALID'
  const data = error instanceof HomeError ? error.data : undefined
  // 用户拒绝、超时、取消、冲突：模型只拿到一句话，错误码留在结构化结果里。
  const outcome = homeOutcomeMessage(code, data)
  const operationId = (data as { operationId?: string } | undefined)?.operationId
  if (outcome) return toolFailure(code, outcome, { operationId })
  const result = toolFailure(code, homeMessage(code))
  // 其余错误保留结构化错误码，不能从译文猜测状态。
  result.output = JSON.stringify({ error: { code, message: homeMessage(code) }, detail: data })
  return result
}
function createTool(
  name: string,
  operation: (home: HomeService, args: Record<string, unknown>, ctx: ToolContext) => unknown,
): BuiltinTool {
  return {
    name,
    allowedSources: ['desktop'],
    async execute(args, ctx) {
      try {
        ctx.signal?.throwIfAborted()
        if (!service) throw new HomeError('HOME_UNAVAILABLE')
        if (ctx.channel !== 'desktop') throw new HomeError('HOME_DENIED')
        const home = service
        return toolSuccess(
          JSON.stringify(await confirming(home, ctx, () => operation(home, args, ctx))),
        )
      } catch (error) {
        return homeToolFailure(error)
      }
    },
  }
}
export const homeDeclareTool = createTool('home_declare', (home, args, ctx) => {
  const input = homeDeclarationSchema.parse(args)
  return home.authorization.declare(homeToolScope(ctx), input.paths, input.apps, true)
})
export const homeFilesTool = createTool('home_files', (home, args, ctx) => {
  const input = homeFileSchema.parse(args)
  // 她删除用户文件：优先 Windows 回收站，失败回退后端回收区（homeNativeDelete）。
  if (input.action === 'delete')
    return deleteForAgent(home, homeToolScope(ctx), input.path, ctx.signal)
  return homeFileCommand(home, homeToolScope(ctx), input)
})
export const homeShelfTool = createTool('home_shelf', (home, args, ctx) =>
  homeShelfCommand(home, homeToolScope(ctx), homeShelfSchema.parse(args), 'agent'),
)
export const homeMapTool = createTool('home_map', (home, args, ctx) =>
  homeMapCommand(home, homeToolScope(ctx), homeMapSchema.parse(args)),
)
export const homeCardTool = createTool('home_card', (home, args, ctx) =>
  homeCardCommand(home, homeToolScope(ctx), homeCardSchema.parse(args)),
)
export const HOME_TOOLS = [homeDeclareTool, homeFilesTool, homeShelfTool, homeMapTool, homeCardTool]

export async function beginLegacyHomeWrite(
  ctx: ToolContext,
  input: string,
  content: Buffer,
  append = false,
) {
  if (!service || ctx.channel !== 'desktop') return undefined
  const session = await resolveExecutionSession(ctx)
  return service.files.prepareLegacy(
    homeToolScope(ctx),
    path.resolve(session.workspaceRoot, input.replace(/^@principal[\\/]/i, '')),
    content,
    append,
  )
}
export function finishLegacyHomeWrite(
  ctx: ToolContext,
  checkpoint?: import('@infos/shared').HomeCheckpoint,
) {
  if (service && checkpoint) service.files.finishLegacy(homeToolScope(ctx), checkpoint)
}
export function abandonLegacyHomeWrite(
  ctx: ToolContext,
  checkpoint?: import('@infos/shared').HomeCheckpoint,
) {
  if (service && checkpoint) service.files.abandonLegacy(homeToolScope(ctx), checkpoint)
}
export async function recycleLegacyHomeFile(args: Record<string, unknown>, ctx: ToolContext) {
  try {
    if (!service) throw new HomeError('HOME_UNAVAILABLE')
    if (ctx.channel !== 'desktop') throw new HomeError('HOME_DENIED')
    const session = await resolveExecutionSession(ctx)
    const file = path.resolve(
      session.workspaceRoot,
      String(args.file_path ?? '').replace(/^@principal[\\/]/i, ''),
    )
    const home = service
    return toolSuccess(
      JSON.stringify(
        await confirming(home, ctx, () =>
          deleteForAgent(home, homeToolScope(ctx), file, ctx.signal),
        ),
      ),
    )
  } catch (error) {
    return homeToolFailure(error)
  }
}
