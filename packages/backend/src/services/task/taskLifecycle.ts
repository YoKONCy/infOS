import { z } from 'zod'
import type { TaskLifecycle, TaskSegmentResult } from '@infos/shared'
import { AppError } from '../../lib/appError'

export const taskSegmentSchema = z
  .object({
    outcome: z.enum(['continue', 'wait', 'deliver', 'blocked', 'failed']),
    summary: z.string().trim().min(1).max(4000),
    wakeAt: z.string().datetime({ offset: true }).optional(),
    waitForTaskId: z.string().min(1).max(160).optional(),
    plan: z
      .array(z.object({ title: z.string().min(1).max(300), done: z.boolean() }))
      .max(20)
      .optional(),
    artifacts: z.array(z.string().min(1).max(1000)).max(20).optional(),
    evidence: z
      .array(
        z.object({
          toolCallId: z.string().min(1).max(160),
          description: z.string().min(1).max(500),
        }),
      )
      .max(20)
      .optional(),
  })
  .strict()

const lifecycleSchema = z.object({
  goal: z.string(),
  successCriteria: z.string(),
  plan: taskSegmentSchema.shape.plan.unwrap(),
  continuation: z.string(),
  wait: z
    .object({ kind: z.enum(['time', 'task', 'input', 'approval']), key: z.string().min(1) })
    .optional(),
  origin: z
    .object({
      platform: z.string().min(1),
      accountId: z.string().min(1),
      channelType: z.literal('private'),
      channelId: z.string().min(1),
      senderId: z.string().min(1),
      messageId: z.string().min(1),
    })
    .optional(),
  recovery: z.enum(['read_only', 'confirm']),
  deadline: z.string().datetime({ offset: true }).optional(),
  segments: z.number().int().nonnegative(),
  maxSegments: z.number().int().positive(),
  usage: z.object({
    llmCalls: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative(),
  }),
  maxLlmCalls: z.number().int().positive(),
  maxToolCalls: z.number().int().positive(),
  verification: z.enum(['unverified', 'reported', 'evidence_available']),
  evidence: taskSegmentSchema.shape.evidence.unwrap(),
  artifacts: taskSegmentSchema.shape.artifacts.unwrap(),
  pendingEffect: z
    .object({ executionId: z.string(), toolName: z.string(), callId: z.string() })
    .optional(),
  liveTerminalIds: z.array(z.string()).optional(),
})

export function parseTaskSegment(value: unknown): TaskSegmentResult {
  const parsed = taskSegmentSchema.safeParse(value)
  if (!parsed.success) throw new AppError('VALIDATION_ERROR', { message: '任务交接结果格式无效' })
  const result = parsed.data
  if (result.outcome === 'wait' && Number(!!result.wakeAt) + Number(!!result.waitForTaskId) !== 1)
    throw new AppError('VALIDATION_ERROR', { message: '等待任务需要且只能指定一个唤醒条件' })
  if (result.wakeAt && Date.parse(result.wakeAt) <= Date.now())
    throw new AppError('VALIDATION_ERROR', { message: '唤醒时间必须在未来' })
  return result
}

export function readTaskLifecycle(
  json: string | null | undefined,
  instruction: string,
): TaskLifecycle {
  const defaults: TaskLifecycle = {
    goal: instruction,
    successCriteria: '',
    plan: [],
    continuation: '',
    recovery: 'confirm',
    segments: 0,
    maxSegments: 48,
    usage: { llmCalls: 0, toolCalls: 0 },
    maxLlmCalls: 192,
    maxToolCalls: 768,
    verification: 'unverified',
    evidence: [],
    artifacts: [],
  }
  if (!json) return defaults
  // 生命周期由服务端写入；损坏数据拒绝执行，避免丢失授权和等待条件后从头重跑。
  try {
    return lifecycleSchema.parse({ ...defaults, ...JSON.parse(json) })
  } catch {
    throw new AppError('CONFLICT', { message: '任务状态记录损坏，请检查后恢复' })
  }
}

export function taskContext(
  lifecycle: TaskLifecycle,
  revision: number,
  externalPlan = false,
): string {
  const plan = externalPlan
    ? '通过 update_plan 实时维护，见行动计划上下文'
    : JSON.stringify(lifecycle.plan)
  return `【持久任务】\n目标：${lifecycle.goal}\n完成条件：${lifecycle.successCriteria || '按用户要求交付，无法确认的部分必须说明'}\n任务修订：${revision}\n当前计划：${plan}\n上次交接：${lifecycle.continuation || '首次执行'}\n产出引用：${JSON.stringify(lifecycle.artifacts)}\n受管终端：${JSON.stringify(lifecycle.liveTerminalIds ?? [])}\n已执行 ${lifecycle.segments}/${lifecycle.maxSegments} 段，模型调用 ${lifecycle.usage.llmCalls}/${lifecycle.maxLlmCalls}，工具调用 ${lifecycle.usage.toolCalls}/${lifecycle.maxToolCalls}\n请在本段结束时调用 finish_task，使用 task_result 提交 continue、wait、deliver、blocked 或 failed。等待必须给出 wakeAt 或 waitForTaskId；继续前重新读取现状，不重复已确认的副作用。子任务返回 accepted 仅代表受理，交付前必须等待并核对实际结果，不能在子任务仍运行时宣布整体完成。可用 manage_task 查询结果，或通过 waitForTaskId 交接等待。evidence 仅引用真实工具调用 ID，不能把自述当作验证。`
}
