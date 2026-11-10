/**
 * flowStateService — 领域服务
 *
 * 封装本领域的核心职责与外部依赖，向上层提供可预测的调用契约。
 * 非直观的状态转换、失败恢复与安全边界应在本模块内完成，避免泄漏实现细节。
 */
import type { FlowStateRepository } from '../../repositories/flowState.repo'
import type { FlowStateRow } from '../../repositories/flowState.repo'
import type { ThreadService } from '../thread/threadService'
import { AppError } from '../../lib/appError'

export interface FlowStateInfo {
  threadId: string
  agentId: string
  currentGoal: string
  privateFacts: string
  revision: number
  updatedAt: string | null
}

/** 会话心流。角色主会话与据点共享，侧会话及 Realm 各自持有。 */
export class FlowStateService {
  constructor(
    private readonly repo: FlowStateRepository,
    private readonly threadService: ThreadService,
  ) {}

  async get(threadId: string, agentId: string): Promise<FlowStateInfo> {
    await this.assertScope(threadId, agentId)
    const row = await this.repo.get(threadId, agentId)
    return row ? this.toInfo(row) : this.empty(threadId, agentId)
  }

  async listByThread(threadId: string): Promise<FlowStateInfo[]> {
    const thread = await this.threadService.getThread(threadId)
    if (!thread) throw new AppError('NOT_FOUND', { message: '会话不存在' })
    return (await this.repo.listByThread(threadId)).map((row) => this.toInfo(row))
  }

  async update(input: {
    threadId: string
    agentId: string
    currentGoal?: string
    privateFacts?: string
    pairId?: string | null
    generation?: number
  }): Promise<FlowStateInfo> {
    await this.assertScope(input.threadId, input.agentId)
    if (input.currentGoal === undefined && input.privateFacts === undefined) {
      throw new AppError('INVALID_PARAMETER', { message: '至少需要更新当前目标或私有事实之一' })
    }
    const row = await this.repo.save({
      ...input,
      currentGoal: input.currentGoal === undefined ? undefined : this.normalize(input.currentGoal),
      privateFacts: input.privateFacts === undefined ? undefined : this.normalize(input.privateFacts),
    })
    return this.toInfo(row)
  }

  async clear(threadId: string, agentId: string): Promise<FlowStateInfo> {
    await this.assertScope(threadId, agentId)
    return this.toInfo(await this.repo.clear(threadId, agentId))
  }

  async rollbackPairs(threadId: string, pairIds: string[]): Promise<void> {
    await this.repo.rollbackPairs(threadId, pairIds)
  }

  async rollbackScene(roomId: string, pairId: string): Promise<void> {
    await this.repo.rollbackScene(roomId, pairId)
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.repo.deleteThread(threadId)
  }

  async getRealm(realmId: string, sessionId: string, agentId: string): Promise<FlowStateInfo> {
    const key = this.realmKey(realmId, sessionId)
    const row = await this.repo.get(key, agentId)
    return row ? this.toInfo(row) : this.empty(key, agentId)
  }

  async updateRealm(input: {
    realmId: string
    sessionId: string
    agentId: string
    currentGoal?: string
    privateFacts?: string
  }): Promise<FlowStateInfo> {
    const threadId = this.realmKey(input.realmId, input.sessionId)
    if (input.currentGoal === undefined && input.privateFacts === undefined) {
      throw new AppError('INVALID_PARAMETER', { message: '至少需要更新当前目标或私有事实之一' })
    }
    const before = await this.repo.get(threadId, input.agentId)
    return this.toInfo(
      await this.repo.save({
        threadId,
        agentId: input.agentId,
        currentGoal: this.normalize(input.currentGoal ?? before?.currentGoal ?? ''),
        privateFacts: this.normalize(input.privateFacts ?? before?.privateFacts ?? ''),
      }),
    )
  }

  private async assertScope(threadId: string, agentId: string): Promise<void> {
    const thread = await this.threadService.getThread(threadId)
    if (!thread) throw new AppError('NOT_FOUND', { message: '会话不存在' })
    // 据点传入角色自己的主会话，保留旧群聊 Thread 的参与者作用域。
    if (thread.channel !== 'group' && thread.agentId !== agentId) {
      throw new AppError('FORBIDDEN', { message: '不能访问其他 Agent 的会话心流' })
    }
  }

  private realmKey(realmId: string, sessionId: string): string {
    if (!realmId.trim() || !sessionId.trim()) {
      throw new AppError('INVALID_PARAMETER', { message: 'Realm与Session标识不能为空' })
    }
    return `realm:${realmId}:${sessionId}`
  }

  private normalize(value: string): string {
    return value.trim().slice(0, 8000)
  }

  private empty(threadId: string, agentId: string): FlowStateInfo {
    return {
      threadId,
      agentId,
      currentGoal: '',
      privateFacts: '',
      revision: 0,
      updatedAt: null,
    }
  }

  private toInfo(row: FlowStateRow): FlowStateInfo {
    return {
      threadId: row.threadId,
      agentId: row.agentId,
      currentGoal: row.currentGoal,
      privateFacts: row.privateFacts,
      revision: row.revision,
      updatedAt: row.updatedAt,
    }
  }
}
