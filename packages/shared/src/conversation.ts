/** 交流消息与执行分别持有身份，来源固定到消息修订。 */
export interface ConversationSource {
  messageId: number
  revision: number
}

export interface ConversationPublication {
  id: string
  content: string
  spokenReply?: string
  respondsTo?: string[]
}

/** 一项待回应问题保存来源消息与后续接续要点。 */
export interface ConversationWait {
  id: string
  question: string
  continuation: string
  messageIds: number[]
  expiresAt?: string
}

/** 由宿主为主线执行提供，工具的角色、会话和代次由运行时固定。 */
export interface ConversationActions {
  assertCurrent(): void
  publish(publication: ConversationPublication): Promise<{ messageId: number }>
  wait(items: ConversationWait[]): Promise<Array<{ id: string }>>
  resolve(ids: string[]): Promise<void>
}

export function conversationSourceKey(message: { id: number; revision?: number | null }): string {
  return `message:${message.id}@${message.revision ?? 1}`
}
