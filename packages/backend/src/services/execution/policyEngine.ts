/**
 * policyEngine — 领域服务
 *
 * 封装本领域的核心职责与外部依赖，向上层提供可预测的调用契约。
 * 非直观的状态转换、失败恢复与安全边界应在本模块内完成，避免泄漏实现细节。
 */
import type { ToolPermission } from '../../capabilities/types'
import { t } from '../../lib/i18n'

export interface BrowserIntentPolicyInput {
  summary: string
  origin: string
  sideEffect: 'read' | 'local-change' | 'external-change' | 'commit' | 'irreversible'
  resourceSummary?: string
  reversible: boolean
  expectedEffects?: unknown[]
}

export interface ToolPolicyContext {
  agentId: string
  channel: string
  sessionId: string
  threadId: string
  taskId?: string
  toolName: string
  args: Record<string, unknown>
  permission?: ToolPermission
}

export type ApprovalRiskLevel = 'low' | 'medium' | 'high' | 'critical'

export type PolicyDecision =
  | { action: 'allow' }
  | { action: 'deny'; code: string; reason: string }
  | { action: 'require_approval'; reason: string; riskLevel: ApprovalRiskLevel }

const CONTENT_FIELDS = new Set([
  'content',
  'data',
  'code',
  'command',
  'query',
  'old_text',
  'new_text',
])

/** 即使 capabilities.yaml 未显式配置，也必须审批的高风险终端命令。 */
const HIGH_RISK_COMMAND_PATTERNS = [
  /\brm\s+-[^\n]*r[^\n]*f\b/i,
  /\bRemove-Item\b[^\n]*(?:-Recurse[^\n]*-Force|-Force[^\n]*-Recurse)/i,
  /\b(?:format|shutdown|reboot)\b/i,
  /\bcurl\b[^\n|]*\|\s*(?:sh|bash|zsh|powershell|pwsh)\b/i,
  /\bgit\s+(?:reset\s+--hard|clean\s+-[^\n]*f)/i,
]

function auditCommand(command: string): { allowed: boolean; risk: string; reason: string } {
  const normalized = command.trim().toLowerCase()
  const rules: Array<{ pattern: RegExp; risk: string; reason: string }> = [
    {
      pattern:
        /(?:rm\s+-(?:rf|fr)[^\n]*(?:\s\/\s*$)|remove-item[^\n]*(?:\sc:[\\/])[^\n]*(?:-recurse[^\n]*-force|-force[^\n]*-recurse)|remove-item[^\n]*(?:-recurse[^\n]*-force|-force[^\n]*-recurse)[^\n]*\sc:[\\/])/i,
      risk: 'critical',
      reason: '检测到递归删除根目录',
    },
    { pattern: /\b(?:format|format\.com)\s/i, risk: 'critical', reason: '检测到磁盘格式化' },
    { pattern: /\bdel\s+\/(?:s\s+\/q|q\s+\/s)\b/i, risk: 'high', reason: '检测到静默批量删除' },
    {
      pattern: /\bgit\s+(?:reset\s+--hard|clean\s+-[^\n]*f)/i,
      risk: 'high',
      reason: '检测到破坏性Git操作',
    },
    {
      pattern:
        /\b(?:curl|wget|invoke-webrequest)\b[^\n]*(?:\|\s*(?:sh|bash|zsh|powershell|pwsh)|invoke-expression)/i,
      risk: 'high',
      reason: '检测到远程脚本下载后直接执行',
    },
    { pattern: /\breg\s+(?:add|delete)\b/i, risk: 'high', reason: '检测到注册表修改' },
    {
      pattern: /\b(?:shutdown|reboot|restart-computer)\b/i,
      risk: 'medium',
      reason: '检测到系统关机或重启操作',
    },
  ]
  const match = rules.find((rule) => rule.pattern.test(normalized))
  return match
    ? { allowed: false, risk: match.risk, reason: match.reason }
    : { allowed: true, risk: 'safe', reason: '未发现危险模式' }
}

const TERMINAL_TOOLS = new Set(['terminal_execute', 'terminal_create'])
const BROWSER_SENSITIVE_TOOLS = new Set([
  'browser_type',
  'browser_evaluate',
  'browser_storage',
  'browser_emulate',
  'browser_network',
  'browser_interact',
  'browser_tabs',
  'browser_download',
  'browser_upload',
  'browser_dialog',
  'browser_plan_form',
  'browser_compile_capability',
])
const BROWSER_SENSITIVE_CLICK =
  /(?:购买|支付|提交|发送|删除|确认|授权|登录|sign\s*in|submit|pay|buy|delete|send)/i

/**
 * 本地执行器目前只能约束终端 cwd，不能在操作系统层隔离 Shell 对全盘文件的访问。
 * 因此任意命令执行必须逐次审批，不能仅依赖命令文本审计或路径参数检查。
 */
export const ALWAYS_APPROVE_EACH_CALL_TOOLS = new Set([
  'runtime_debug',
  'terminal_execute',
  'terminal_create',
  'terminal_write',
  'delete_file',
  'open_application',
  'activate_window',
])

/** 工具参数与审批策略引擎。 */
export class PolicyEngine {
  evaluate(context: ToolPolicyContext): PolicyDecision {
    const policy = context.permission?.paramPolicy
    if (policy?.maxContentLength !== undefined) {
      const fields: Array<[string, unknown]> = []
      const visit = (value: unknown): void => {
        if (Array.isArray(value)) {
          for (const item of value) visit(item)
          return
        }
        if (!value || typeof value !== 'object') return
        for (const [key, item] of Object.entries(value)) {
          if (CONTENT_FIELDS.has(key)) fields.push([key, item])
          if (item && typeof item === 'object') visit(item)
        }
      }
      visit(context.args)
      const total = fields.reduce(
        (sum, [, value]) => sum + (typeof value === 'string' ? value.length : 0),
        0,
      )
      if (total > policy.maxContentLength)
        return {
          action: 'deny',
          code: 'PARAM_TOO_LARGE',
          reason: `编辑内容合计长度 ${total} 超过上限 ${policy.maxContentLength}`,
        }
      for (const [key, value] of fields) {
        if (
          CONTENT_FIELDS.has(key) &&
          typeof value === 'string' &&
          value.length > policy.maxContentLength
        ) {
          return {
            action: 'deny',
            code: 'PARAM_TOO_LARGE',
            reason: `参数 ${key} 长度 ${value.length} 超过上限 ${policy.maxContentLength}`,
          }
        }
      }
    }

    const command =
      typeof context.args.command === 'string' ? context.args.command.trim() : undefined
    if (command && policy?.allowedCommands?.length) {
      const executable = this.firstCommandToken(command).toLowerCase()
      const allowed = policy.allowedCommands.some((item) => item.toLowerCase() === executable)
      if (!allowed) {
        return {
          action: 'deny',
          code: 'COMMAND_NOT_ALLOWED',
          reason: `命令 ${executable} 不在允许列表中`,
        }
      }
    }
    if (policy?.deniedPatterns?.length) {
      const serialized = JSON.stringify(context.args)
      for (const pattern of policy.deniedPatterns) {
        try {
          if (new RegExp(pattern, 'i').test(serialized)) {
            return {
              action: 'deny',
              code: 'PARAM_PATTERN_DENIED',
              reason: `参数命中禁止模式: ${pattern}`,
            }
          }
        } catch {
          return {
            action: 'deny',
            code: 'INVALID_POLICY',
            reason: `权限配置包含无效正则: ${pattern}`,
          }
        }
      }
    }

    // 仅用于审计展示，不把参数拼接后的文本交给 Shell 执行。
    const auditedCommand =
      command && Array.isArray(context.args.argv)
        ? [command, ...context.args.argv.map(String)].join(' ')
        : command
    if (auditedCommand && TERMINAL_TOOLS.has(context.toolName)) {
      const audit = auditCommand(auditedCommand)
      if (!audit.allowed) {
        return {
          action: 'require_approval',
          reason: `命令审计判定为 ${audit.risk} 风险：${audit.reason}`,
          riskLevel: audit.risk as ApprovalRiskLevel,
        }
      }
    }
    if (
      command &&
      TERMINAL_TOOLS.has(context.toolName) &&
      HIGH_RISK_COMMAND_PATTERNS.some((pattern) => pattern.test(auditedCommand ?? command))
    ) {
      return {
        action: 'require_approval',
        reason: '终端命令包含高风险或破坏性操作，需要用户确认',
        riskLevel: 'high',
      }
    }
    if (ALWAYS_APPROVE_EACH_CALL_TOOLS.has(context.toolName)) {
      if (context.toolName === 'runtime_debug' && !String(context.args.code ?? '').trim())
        return { action: 'allow' }
      const reason =
        context.toolName === 'runtime_debug'
          ? t('server.runtime-debug', '调试脚本具有本机 Node 权限，本次执行需要审批')
          : context.toolName === 'open_application'
            ? '启动或激活本机应用会改变用户桌面状态，需要用户确认'
            : context.toolName === 'activate_window'
              ? '切换本机窗口会改变用户当前桌面焦点，需要用户确认'
              : context.toolName === 'delete_file'
                ? '删除文件会永久移除服务端数据，需要用户确认'
                : `工具 ${context.toolName} 可执行系统操作，必须逐次由用户确认`
      return {
        action: 'require_approval',
        reason,
        riskLevel: 'medium',
      }
    }
    const browserIntent = context.args.intent as BrowserIntentPolicyInput | undefined
    if (browserIntent) {
      if (!/^https?:\/\//i.test(browserIntent.origin)) {
        return {
          action: 'deny',
          code: 'WEB_INTENT_ORIGIN_INVALID',
          reason: 'Browser Intent 必须绑定有效 Origin',
        }
      }
      if (['external-change', 'commit', 'irreversible'].includes(browserIntent.sideEffect)) {
        return {
          action: 'require_approval',
          reason: [
            `网页意图：${browserIntent.summary}`,
            `目标 Origin：${browserIntent.origin}`,
            `副作用：${browserIntent.sideEffect}`,
            browserIntent.resourceSummary ? `资源：${browserIntent.resourceSummary}` : '',
            `可回滚：${browserIntent.reversible ? '是' : '否'}`,
          ]
            .filter(Boolean)
            .join('；'),
          riskLevel: browserIntent.sideEffect === 'irreversible' ? 'high' : 'medium',
        }
      }
    }
    if (
      (context.toolName === 'browser_network' && context.args.action === 'query') ||
      (context.toolName === 'browser_storage' && context.args.action === 'get')
    ) {
      return { action: 'allow' }
    }
    if (
      BROWSER_SENSITIVE_TOOLS.has(context.toolName) ||
      (context.toolName === 'browser_click' &&
        BROWSER_SENSITIVE_CLICK.test(String(context.args.target ?? context.args.handle ?? '')))
    ) {
      return {
        action: 'require_approval',
        reason: `浏览器操作 ${context.toolName} 可能提交数据或产生外部副作用，需要用户确认`,
        riskLevel: 'medium',
      }
    }
    if (context.permission?.requiresApproval) {
      return {
        action: 'require_approval',
        reason: `工具 ${context.toolName} 的权限策略要求用户审批`,
        riskLevel: 'low',
      }
    }
    return { action: 'allow' }
  }

  private firstCommandToken(command: string): string {
    const trimmed = command.trim()
    const quoted = trimmed.match(/^["']([^"']+)["']/)
    if (quoted?.[1]) return quoted[1]
    return trimmed.split(/\s+/)[0] ?? ''
  }
}
