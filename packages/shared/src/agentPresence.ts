/** 同一人格的账号与会话身份；平台账号不是独立人格。 */
export interface AgentAccountIdentity {
  agentId: string
  platform: string
  accountId: string
}

export interface AgentConversationIdentity extends AgentAccountIdentity {
  channelType: 'private' | 'group'
  channelId: string
}

export function agentAccountKey(identity: AgentAccountIdentity): string {
  return JSON.stringify([identity.agentId, identity.platform, identity.accountId])
}

export function agentConversationKey(identity: AgentConversationIdentity): string {
  return JSON.stringify([
    identity.agentId,
    identity.platform,
    identity.accountId,
    identity.channelType,
    identity.channelId,
  ])
}

export interface AgentBrowserScope {
  profileId: string
  sessionId: string
}

/** 宿主签发的能力端口；身份来自规范入站消息，不接受模型声明。 */
export interface SocialHostCapabilityPort {
  activity?(origin: import('./types/task-lifecycle.types').TaskOrigin): Promise<unknown[]>
  describe(
    origin: import('./types/task-lifecycle.types').TaskOrigin,
    enableVision: boolean,
  ): Promise<
    Array<{
      type: 'function'
      function: { name: string; description: string; parameters: Record<string, unknown> }
    }>
  >
  execute(
    origin: import('./types/task-lifecycle.types').TaskOrigin,
    name: string,
    args: Record<string, unknown>,
    context: {
      callId: string
      threadId: string
      enableVision: boolean
      executionId?: string
      processId?: string
      signal?: AbortSignal
    },
  ): Promise<string>
}

/** 浏览器导航会改变本会话页面，只有稳定观察允许并行与自动重试。 */
export function isAgentBrowserRead(name: string, args: Record<string, unknown>): boolean {
  return (
    [
      'browser_status',
      'browser_get_content',
      'browser_screenshot',
      'browser_page_image',
      'browser_query_dom',
    ].includes(name) ||
    (name === 'browser_network' && (args.action === undefined || args.action === 'query'))
  )
}
