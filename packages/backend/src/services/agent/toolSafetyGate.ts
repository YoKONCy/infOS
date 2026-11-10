import { t as __t } from '../../lib/i18n'
/**
 * Tool Safety Gate — 工具执行器的高危与禁区判定
 *
 * 与桌面护栏共用 safety-lists.draft.json：判断一次工具调用是否落入凭据禁区，
 * 或属于任何执行模式都必须由用户本人逐次确认的高危操作。
 * 由 RegistryToolExecutor 在审批前调用，本模块不做审批与执行。
 *
 * @module packages/backend/src/services/agent/toolSafetyGate
 */

import os from 'node:os'
import path from 'node:path'
import { isHighRiskToolCall, isForbiddenToolCall, type HighRiskReason } from '@infos/shared'
import { resolveSafetyFilePaths, toolPathArguments } from '../execution/safetyPath'
import { planReadOnlyTerminal } from '../execution/readOnlyTerminal'
import { resolveExecutionSession } from '../../tools/productivityRuntimeHolder'
import type { ToolRegistry } from './toolRegistry'
import type { ToolExecutionResult } from './reactLoop'

/** 高危操作的审批说明（展示在审批卡上，告诉用户为什么一定要他确认）。 */
const HIGH_RISK_REASONS: Record<HighRiskReason, string> = {
  terminal: '工具 {0} 会执行终端命令，任何执行模式下都需要你确认',
  script: '工具 {0} 会执行脚本或代码，任何执行模式下都需要你确认',
  'delete-outside-workspace': '工具 {0} 要删除工作区外的文件，任何执行模式下都需要你确认',
  'sensitive-path':
    '工具 {0} 要改动系统敏感位置（hosts、开机启动项、环境变量、证书、系统目录等），任何执行模式下都需要你确认',
  'path-unresolved': '工具 {0} 的目标路径无法可靠解析，需要你确认',
  'draft-invalid': '安全名单无效，工具 {0} 需要你确认',
}

/** 高危操作展示在审批卡上的说明。 */
export function highRiskApprovalReason(reason: HighRiskReason, name: string): string {
  return __t('server.agent', HIGH_RISK_REASONS[reason], [name])
}

/**
 * 禁区或无法审批时直接返回的工具失败结果；可以继续审批流程时返回 undefined。
 * 高危操作必须交给用户确认，审批服务不可用时不能执行。
 */
export function toolSafetyBlockedResult(
  risk: HighRiskReason | 'forbidden-resource' | null,
  approvalAvailable: boolean,
  startTime: number,
): ToolExecutionResult | undefined {
  if (risk === 'forbidden-resource')
    return {
      output: JSON.stringify({
        code: 'DESKTOP_FORBIDDEN',
        message: __t('server.agent', '凭据库属于禁区，工具未执行'),
      }),
      durationMs: Date.now() - startTime,
      isError: true,
      shouldTerminate: false,
    }
  if (risk && !approvalAvailable)
    return {
      output: JSON.stringify({
        code: 'APPROVAL_UNAVAILABLE',
        message: __t('server.agent', '该工具调用需要用户审批，但审批服务当前不可用'),
      }),
      durationMs: Date.now() - startTime,
      isError: true,
      shouldTerminate: false,
    }
  return undefined
}

/** 只读终端授权的目标文件是否落入凭据禁区。 */
export function isForbiddenReadOnlyTerminalTarget(target: string): boolean {
  return isForbiddenToolCall(
    {
      toolName: 'read_file',
      args: {},
      readOnlyTerminal: true,
      runtimeScoped: false,
      deleteOutsideWorkspace: false,
      fileTarget: target,
    },
    { platform: process.platform, env: process.env, home: os.homedir() },
  )
}

/** 本次调用是否为高危操作（见 packages/shared/src/desktopSafety.ts 的 isHighRiskToolCall）。 */
export async function resolveToolSafetyRisk(
  registry: Pick<ToolRegistry, 'getDefinition' | 'isRuntimeScoped'>,
  name: string,
  args: Record<string, unknown>,
  input: {
    /** 是否属于设备只读工具（read_file、list_directory 等）。 */
    deviceRead: boolean
    readOnlyTerminal: boolean
    deleteOutsideWorkspace: boolean
    session: { agentId: string; threadId: string; channel: string; taskId?: string }
  },
): Promise<HighRiskReason | 'forbidden-resource' | null> {
  let fileTargets: string[] | undefined
  let pathUnresolved = false
  const readPlan = ['terminal_execute', 'terminal_create'].includes(name)
    ? planReadOnlyTerminal(args)
    : null
  // 确定性只读查询也不能借宿主读取凭据库；这里只解析已识别的查询，不推测任意脚本。
  if (readPlan?.pipelines.some(({ query }) => query.kind !== 'pwd')) {
    try {
      const session = await resolveExecutionSession(input.session)
      const cwd = path.resolve(
        session.workspaceRoot,
        String(args.cwd || '.').replace(/^@principal[\\/]/i, ''),
      )
      fileTargets = []
      for (const { query } of readPlan.pipelines) {
        if (query.kind === 'pwd') continue
        const resolved = await resolveSafetyFilePaths(path.resolve(cwd, query.path))
        fileTargets.push(...resolved.paths)
        pathUnresolved ||= resolved.unresolved
      }
    } catch {
      pathUnresolved = true
    }
  }
  const paths = toolPathArguments(args, registry.getDefinition(name)?.parameters)
  if (paths.length) {
    fileTargets ??= []
    try {
      const session = await resolveExecutionSession(input.session)
      for (const { value } of paths) {
        const target = path.resolve(session.workspaceRoot, value.replace(/^@principal[\\/]/i, ''))
        const resolved = await resolveSafetyFilePaths(target)
        fileTargets.push(...resolved.paths)
        pathUnresolved ||= resolved.unresolved
      }
    } catch {
      fileTargets.push(...paths.map(({ value }) => value))
      pathUnresolved = true
    }
  }
  const call = {
    toolName: name,
    args,
    readOnlyTerminal: input.readOnlyTerminal,
    runtimeScoped: registry.isRuntimeScoped(name),
    deleteOutsideWorkspace: input.deleteOutsideWorkspace,
    fileTargets,
    // home_files 的读、列、搜和 read_file 同样算「看」：禁区照拦，系统目录不升级成审批。
    fileAction:
      input.deviceRead ||
      (name === 'home_files' && ['read', 'list', 'search'].includes(String(args.action)))
        ? ('read' as const)
        : name === 'delete_file'
          ? ('delete' as const)
          : ('write' as const),
    pathUnresolved,
  }
  const context = { platform: process.platform, env: process.env, home: os.homedir() }
  if (isForbiddenToolCall(call, context)) return 'forbidden-resource'
  return isHighRiskToolCall(call, context)
}
