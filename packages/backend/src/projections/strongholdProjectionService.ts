import type {
  ConversationSurfaceDescriptor,
  MarkdownSurfaceProps,
  StrongholdMessageProjection,
  StrongholdProjectionSnapshot,
  SurfaceId,
  SurfaceNodeId,
} from '@infos/shared'
import type { GroupChatService } from '../services/stronghold/groupChatService'
import { tokenCounter } from '../services/tokenizer/tokenCounter'
import type { StrongholdLifeService } from '../services/stronghold/strongholdLifeService'

/** 据点房间领域事实到 committed Surface 的可重建投影。 */
export class StrongholdProjectionService {
  constructor(private readonly groupChat: GroupChatService, private readonly life?: StrongholdLifeService) {}

  async getSnapshot(roomId: string, limit = 100): Promise<StrongholdProjectionSnapshot> {
    const room = await this.groupChat.getRoom(roomId)
    if (!room) throw new Error(`据点房间不存在: ${roomId}`)
    const [rows, members] = await Promise.all([
      this.groupChat.getHistory(roomId, limit),
      this.groupChat.getRoomMembers(roomId),
    ])
    const messages = rows.map<StrongholdMessageProjection>((row) => ({
      messageId: String(row.id),
      roomId: row.roomId,
      senderId: row.senderId,
      role: row.role as StrongholdMessageProjection['role'],
      content: row.content,
      pairId: row.pairId,
      timestamp: row.timestamp,
      outputTokens: row.role === 'assistant' ? tokenCounter.countTokens(row.content) : undefined,
      surfaceId: `stronghold-message:${row.id}` as SurfaceId,
    }))
    const surfaces = messages.map((message) => this.projectMessage(message))
    const revision = rows.at(-1)?.id ?? 0
    return {
      protocolVersion: 1,
      roomId,
      roomName: room.name,
      revision,
      generatedAt: new Date().toISOString(),
      members: members.map((member) => ({ agentId: member.agentId, role: member.role })),
      messages,
      surfaces,
      life: this.life?.snapshot(roomId),
    }
  }

  private projectMessage(message: StrongholdMessageProjection): ConversationSurfaceDescriptor {
    return {
      surfaceId: message.surfaceId,
      generation: `stronghold-message:${message.messageId}`,
      messageId: message.messageId,
      threadId: `stronghold:${message.roomId}`,
      principalId: message.senderId,
      revision: 1,
      sequence: 0,
      state: 'committed',
      nodes: message.content
        ? [
            {
              nodeId: `${message.surfaceId}:markdown` as SurfaceNodeId,
              kind: 'markdown',
              lifecycle: 'stable',
              revision: 1,
              props: {
                source: message.content,
                phase: 'committed',
              } satisfies MarkdownSurfaceProps,
            },
          ]
        : [],
    }
  }
}
