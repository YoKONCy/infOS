import { t as __t } from '../../lib/i18n'
import {
  isUnansweredAgentInput,
  type AgentInputService,
} from '../../services/execution/agentInputService'
import type { BuiltinTool } from '..'
import { getAgentInputQuestions } from '@infos/shared'
import { toolFailure } from '../../services/execution/toolResult'

let service: AgentInputService | null = null

export function setAgentInputService(value: AgentInputService): void {
  service = value
}

export const askUserTool: BuiltinTool = {
  name: 'ask_user',
  async execute(args, ctx) {
    if (ctx.conversation) return toolFailure('CONTINUOUS_CONVERSATION_REQUIRED',
      __t('server.conversation', '请通过 conversation 发表问题并保存等待事项'))
    if (!service) throw new Error('Agent求助服务尚未初始化')
    const options = Array.isArray(args.options)
      ? args.options.map((value) => {
          const option =
            value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
          return {
            id: String(option.id ?? ''),
            label: String(option.label ?? ''),
            description: typeof option.description === 'string' ? option.description : undefined,
          }
        })
      : []
    const request = service.create({
      agentId: ctx.agentId,
      channel: ctx.channel,
      sessionId: ctx.sessionId,
      threadId: ctx.threadId,
      taskId: ctx.taskId,
      questions: args.questions,
      question: String(args.question ?? ''),
      context: typeof args.context === 'string' ? args.context : undefined,
      options,
      allowFreeText: args.allow_free_text !== false,
      required: args.required === true,
    })
    if (ctx.taskId) {
      return {
        ok: true,
        output: JSON.stringify({ pending: true, inputId: request.id }),
        shouldTerminate: true,
      }
    }
    const resolved = await service.waitForResolution(request.id, ctx.signal)
    if (resolved.status === 'pending') {
      return {
        ok: true,
        output: JSON.stringify({
          pending: true,
          inputId: request.id,
          message: resolved.responseMessage,
        }),
        shouldTerminate: true,
      }
    }
    if (resolved.status === 'answered') {
      return JSON.stringify({
        answered: true,
        answers: (resolved.answers ?? []).map((answer) => ({
          ...answer,
          question: getAgentInputQuestions(resolved).find(
            (question) => question.id === answer.questionId,
          )?.question,
          selectedOptions: getAgentInputQuestions(resolved)
            .find((question) => question.id === answer.questionId)
            ?.options.filter((option) => answer.selectedOptionIds.includes(option.id))
            .map((option) => option.label),
        })),
        selectedOptionIds: resolved.selectedOptionIds,
        ...(resolved.responseMessage ? { message: resolved.responseMessage } : {}),
      })
    }
    if (resolved.status === 'skipped') {
      return JSON.stringify({
        answered: false,
        skipped: true,
        ...(isUnansweredAgentInput(resolved)
          ? {
              message: __t(
                'server.tools',
                '{0}可在原任务授权范围内采用合理假设继续，或跳过相关部分；不要反复提问，未回应不代表同意。',
                [resolved.responseMessage],
              ),
            }
          : {}),
      })
    }
    return JSON.stringify({
      answered: false,
      cancelled: true,
      message: resolved.responseMessage ?? __t('server.tools', '用户回答请求已取消。'),
    })
  },
}
