import { createHash } from 'node:crypto'
import type { AppManager } from './appManager'
import type { BackgroundTaskRepository } from '../repositories/backgroundTask.repo'
import type { DelegatedTaskExecutor } from '../services/task/backgroundTaskService'
import { t as __t } from '../lib/i18n'

const socialTurnId = (id: string) =>
  `social:command:${createHash('sha256').update(id).digest('hex')}`

/** 后台任务持有交付关系，社交运行时持有平台操作；重启后只查询原委派。 */
export function createSocialTaskExecutor(
  commands: Pick<AppManager, 'executeCommand'>,
  persistence: Pick<BackgroundTaskRepository, 'update'>,
): DelegatedTaskExecutor {
  return {
    async run(task, signal, execution) {
      const input = task.metadata.socialInput as Record<string, unknown>
      const previous = await commands
        .executeCommand({
          appId: 'social',
          hostAgentId: task.agentId,
          action: 'get_task',
          input: { task_id: socialTurnId(task.id) },
          signal,
          execution,
        })
        .catch(() => undefined)
      if (
        !previous?.output?.taskId &&
        (task.metadata.socialDispatchAttempted || task.lifecycle.segments > 0)
      )
        return {
          outcome: 'blocked',
          summary: __t(
            'server.task',
            '原社交委派记录已丢失或暂不可读取；已停止重新派发，请先核验实际发送结果。',
          ),
        }
      if (!previous?.output?.taskId)
        await persistence.update(
          task.id,
          {
            metadataJson: JSON.stringify({ ...task.metadata, socialDispatchAttempted: true }),
          },
          task.revision,
        )
      signal.throwIfAborted()
      const result = previous?.output?.taskId
        ? previous
        : await commands.executeCommand({
            appId: 'social',
            hostAgentId: task.agentId,
            action: 'chat_in_group',
            input,
            correlationId: task.id,
            signal,
            execution,
          })
      return result.status === 'waiting'
        ? {
            outcome: 'wait',
            summary: result.summary,
            wakeAt: new Date(Date.now() + 15_000).toISOString(),
          }
        : {
            outcome: result.status === 'completed' ? 'deliver' : 'failed',
            summary: `${result.summary}\n${JSON.stringify(result.output ?? {}, null, 2)}`,
          }
    },
    async cancel(task) {
      await commands.executeCommand({
        appId: 'social',
        hostAgentId: task.agentId,
        action: 'cancel_task',
        input: { task_id: socialTurnId(task.id) },
      })
    },
  }
}
