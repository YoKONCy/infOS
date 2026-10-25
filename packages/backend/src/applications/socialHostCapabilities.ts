import { agentAccountKey, agentConversationKey } from '@infos/shared'
import type { SocialHostCapabilityPort, TaskOrigin } from '@infos/shared'
import type { ToolRegistry } from '../services/agent/toolRegistry'
import type { RegistryToolExecutor } from '../services/agent/toolExecutor'
import type { ApplicationRealmManager } from './applicationRealm'

const BROWSER_TOOLS = [
  'browser_open_url',
  'browser_click',
  'browser_type',
  'browser_scroll',
  'browser_back',
  'browser_get_content',
  'browser_search',
  'browser_screenshot',
  'browser_page_image',
  'browser_wait',
  'browser_tabs',
  'browser_interact',
  'browser_query_dom',
  'browser_dialog',
  'browser_network',
  'browser_download',
  'browser_emulate',
  'browser_status',
]
const VISION_TOOLS = new Set(['browser_screenshot', 'browser_page_image'])

/** 同一人格通过宿主能力工作；每次调用重新核验主人账号，浏览器按账号和会话绑定。 */
export function createSocialHostCapabilities(input: {
  realmId: string
  realms: ApplicationRealmManager
  tools: ToolRegistry
  executor: RegistryToolExecutor
  authorize(origin: TaskOrigin): Promise<string | undefined>
  activity?(agentId: string): Promise<unknown[]>
}): SocialHostCapabilityPort {
  input.realms.grantHostTools(input.realmId, BROWSER_TOOLS)
  const allowed = (name: string, vision: boolean) =>
    BROWSER_TOOLS.includes(name) && (vision || !VISION_TOOLS.has(name)) && input.tools.has(name)
  return {
    async activity(origin) {
      const agentId = await input.authorize(origin)
      return agentId ? ((await input.activity?.(agentId)) ?? []) : []
    },
    async describe(origin, vision) {
      if (!(await input.authorize(origin))) return []
      return input.tools
        .getDefinitions('application')
        .filter((tool) => allowed(tool.name, vision))
        .map((tool) => ({
          type: 'function' as const,
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters ?? { type: 'object', properties: {} },
          },
        }))
    },
    async execute(origin, name, args, context) {
      context.signal?.throwIfAborted()
      const agentId = await input.authorize(origin)
      if (!agentId || !allowed(name, context.enableVision))
        throw new Error('SOCIAL_HOST_CAPABILITY_DENIED')
      const identity = { agentId, ...origin }
      const result = await input.executor.execute(name, args, 'application', {
        agentId,
        realmId: input.realmId,
        channel: 'application',
        threadId: context.threadId,
        sessionId: agentConversationKey(identity),
        interactionMode: 'work',
        executionMode: 'manual',
        browserScope: {
          profileId: agentAccountKey(identity),
          sessionId: agentConversationKey(identity),
        },
        inlineImages: context.enableVision,
        toolCallId: context.callId,
        signal: context.signal,
        executionId: context.executionId as import('@infos/shared').KernelExecutionId | undefined,
        processId: context.processId as import('@infos/shared').KernelProcessId | undefined,
      })
      if (result.isError) return JSON.stringify({ success: false, error: result.output })
      try {
        const value = JSON.parse(result.output)
        if (Array.isArray(value.screenshots))
          value.images = value.screenshots.flatMap((image: { dataUri?: string }) =>
            typeof image.dataUri === 'string' ? [image.dataUri] : [],
          )
        delete value.screenshots
        return JSON.stringify(value)
      } catch {
        return result.output
      }
    },
  }
}
