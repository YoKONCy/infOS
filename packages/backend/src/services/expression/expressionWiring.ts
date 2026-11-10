/**
 * 表达层在应用容器中的装配：创建服务与后台学习，并把内部事件流接到表达层观察。
 */
import type { Database } from 'better-sqlite3'
import { t as __t } from '../../lib/i18n'
import type { createLogger } from '../../lib/logger'
import type { LifecycleScope } from '../../kernel'
import type { PackageHookBus } from '../../packages'
import type { ContextCompiler } from '../context/contextCompiler'
import type { HomeService } from '../home/homeService'
import type { LlmService } from '../llm/llmService'
import type { ModelRoleResolver } from '../llm/modelRoles'
import type { MdpEngine } from '../prompt/mdpEngine'
import { ExpressionLearning } from './learning'
import { ExpressionService } from './service'
import { ExpressionStore } from './store'

export function createExpression(deps: {
  sqlite: Database
  home: HomeService
  contextCompiler: ContextCompiler
  modelRoles: ModelRoleResolver
  llmService: LlmService
  mdpEngine: MdpEngine
  packageHookBus: PackageHookBus
  lifecycle: LifecycleScope
  logger: ReturnType<typeof createLogger>
}) {
  const { sqlite, home, contextCompiler, modelRoles, llmService, mdpEngine, packageHookBus } = deps
  const { lifecycle: kernelLifecycle, logger } = deps
  const expression = new ExpressionService(
    new ExpressionStore(sqlite),
    (agentId, from) => home.activity.query({ agentId, from, pageSize: 100 }).items,
  )
  contextCompiler.setExpressionService(expression)
  expression.learning = new ExpressionLearning(expression.store, async (input, signal) => {
    const config = await modelRoles.bind('expression_learning')()
    if (!config) throw new Error('EXPRESSION_MODEL_NOT_CONFIGURED')
    return llmService.chatText(
      config,
      [
        { role: 'system', content: mdpEngine.render('tasks/expression_learning', {}) },
        { role: 'user', content: JSON.stringify(input) },
      ],
      {
        temperature: 0.1,
        maxTokens: 4000,
        signal,
        usageContext: { agentId: input.agentId, purpose: 'memory' },
      },
    )
  })
  expression.store.onMark = (mark) => {
    // 标记已保存成功；后台故障不得改变管理接口的成功结果。
    try {
      // 写入层已去重；用户确认新原文修订时，同样正文也建立新的学习依据。
      expression.learning?.enqueue('mark', mark.agentId, mark.id, true)
    } catch {
      logger.warn(__t('logs.agent', '表达手册学习失败，聊天不受影响'))
    }
  }
  expression.store.onRelearn = (mark) => void expression.learning?.relearn(mark.agentId, mark.id)
  expression.store.learningStatus = (agentId) => expression.learning!.status(agentId)
  expression.store.onLearnNow = (agentId) => void expression.learning?.learnNow(agentId)
  expression.learning.start()
  kernelLifecycle.defer(() => {
    expression.learning?.stop()
  })
  // 内部事件先给表达层观察，再交给插件钩子。
  const internalFlow = {
    async emitHook<T>(event: string, data: T): Promise<T> {
      expression.observe(event, data)
      return packageHookBus.emitHook(event, data)
    },
  }
  return { expression, internalFlow }
}
