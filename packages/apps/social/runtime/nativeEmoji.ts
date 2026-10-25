import type { Attachment } from './types'

/** 平台原生表情由所属适配器解析，通用运行时只传递受会话约束的来源引用。 */
export interface NativeEmojiScope {
  platform?: string
  agentId: string
  accountId: string
  channelId: string
  channelType: 'private' | 'group'
  signal?: AbortSignal
}

export interface NativeEmojiProvider {
  resolve(scope: NativeEmojiScope, reference: string): Promise<Attachment>
}
