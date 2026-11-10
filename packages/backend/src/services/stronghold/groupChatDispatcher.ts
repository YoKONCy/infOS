/**
 * Group Chat Dispatcher — 群聊接话调度器
 *
 * 决定哪个 Agent 在群聊中接话。
 *
 * 规则选人，无模型判定。定向请求派发给接收者，用户普通发言优先接续最近交谈者。
 * 分享和普通角色发言积累亲历，邀请由发言执行中的结构化结果发起。
 *
 * 调度结果:
 *   - 返回 agent_id → 由调用方执行 AgentService.chat()
 *   - 返回 '@all' → 由调用方依次执行所有在场 Agent
 *   - 返回 null → 无人接话
 *
 * @module packages/backend/src/services/stronghold/groupChatDispatcher
 */

import type { GroupChatService } from './groupChatService'

// ── 类型 ──

type MessageRow = {
  senderId: string
  content: string
  role: string
  mentionsJson: string | null
}

/** 调度结果 */
export interface DispatchResult {
  /** 下一批发言Agent ID；@全体时由调用方展开全部成员。 */
  agentIds: string[]
  /** 调度理由 */
  reason: string
}

// ── Dispatcher ──

export class GroupChatDispatcher {
  constructor(private chatService: GroupChatService) {}

  /**
   * 决定下一个发言的 Agent
   *
   * @param roomId 群聊房间 ID
   * @param history 最近的聊天记录
   */
  async decideNextTurn(roomId: string, history: MessageRow[]): Promise<DispatchResult> {
    if (history.length === 0) {
      return { agentIds: [], reason: '没有消息历史' }
    }

    // 获取房间内的候选 Agent
    const candidates = await this.chatService.getCandidateAgents(roomId)
    if (candidates.length === 0) {
      return { agentIds: [], reason: '房间内没有可用 Agent' }
    }

    const lastMsg = history[history.length - 1]!
    if (lastMsg.role === 'system') return { agentIds: [], reason: '系统消息只更新场景记录' }

    // ─── Layer 1: 规则预筛 ───

    // 规则 A: 被 @mention → 必定回复
    const mentionResult = this.checkMentions(lastMsg, candidates)
    if (mentionResult) return mentionResult

    // 规则 B: 用户发言 → 只要房间内有候选 Agent，就必须有人回复。
    // 短消息（如“你好”“在吗”）同样是明确互动，不应随机静默。
    if (lastMsg.senderId === 'user') {
      const previous = [...history].reverse().find((message) => candidates.includes(message.senderId))
      return {
        agentIds: [previous?.senderId ?? candidates[0]!],
        reason: '用户发言，接续当前交谈者',
      }
    }

    return { agentIds: [], reason: '普通发言只更新亲历，等待定向请求' }
  }

  // ── 内部方法 ──

  /** 检查 @mention */
  private checkMentions(msg: MessageRow, candidates: string[]): DispatchResult | null {
    try {
      const mentions: string[] = msg.mentionsJson ? JSON.parse(msg.mentionsJson) : []

      // @全体成员：召唤房间内所有候选 Agent（agentId 使用哨兵值 '@all'，由路由层展开执行）
      if (mentions.includes('@all') && candidates.length > 0) {
        return { agentIds: ['@all'], reason: '被 @mention: 全体成员' }
      }

      const validMentions = [...new Set(mentions.filter((mention) => candidates.includes(mention)))]
      if (validMentions.length > 0) {
        return {
          agentIds: validMentions,
          reason: `被 @mention: ${validMentions.join('、')}`,
        }
      }
    } catch {
      // mentions 解析失败静默处理
    }
    return null
  }

}
