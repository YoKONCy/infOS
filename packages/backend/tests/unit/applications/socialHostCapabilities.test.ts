import { describe, expect, it, vi } from 'vitest'
import { createSocialHostCapabilities } from '@infos/backend/applications/socialHostCapabilities'
import { ApplicationRealmManager } from '@infos/backend/applications/applicationRealm'
import { ToolRegistry } from '@infos/backend/services/agent/toolRegistry'
import { RegistryToolExecutor } from '@infos/backend/services/agent/toolExecutor'

function setup() {
  const tools = new ToolRegistry()
  const handler = vi.fn(async (_args, context) =>
    JSON.stringify({ success: true, scope: context.browserScope, agentId: context.agentId }),
  )
  for (const name of ['browser_status', 'browser_screenshot', 'terminal_execute'])
    tools.register(
      { name, description: name, parameters: { type: 'object', properties: {} } },
      handler,
    )
  const realms = new ApplicationRealmManager(tools)
  const realm = realms.register({
    realmId: 'social:test',
    appId: 'social',
    principalId: 'application:social',
    instanceId: 'test',
  })
  const executor = new RegistryToolExecutor(tools)
  executor.setApplicationRealmManager(realms)
  const authorize = vi.fn(async (origin) =>
    origin.senderId === 'owner' && origin.channelType === 'private' ? 'pero' : undefined,
  )
  const port = createSocialHostCapabilities({
    realmId: realm.descriptor.realmId,
    realms,
    tools,
    executor,
    authorize,
  })
  const origin = {
    platform: 'telegram',
    accountId: 'bot',
    channelType: 'private' as const,
    channelId: 'dm',
    senderId: 'owner',
    messageId: 'message',
  }
  const context = { callId: 'call', threadId: 'social-thread', enableVision: false }
  return { port, tools, realm, handler, origin, context }
}

describe('同一人格的社交宿主能力', () => {
  it('通过统一执行器调用宿主浏览器，保留人格与账号会话归属', async () => {
    const { port, origin, context, handler } = setup()
    expect((await port.describe(origin, false)).map((tool) => tool.function.name)).toEqual([
      'browser_status',
    ])
    const result = JSON.parse(await port.execute(origin, 'browser_status', {}, context))
    expect(result.agentId).toBe('pero')
    expect(JSON.parse(result.scope.profileId)).toEqual(['pero', 'telegram', 'bot'])
    expect(JSON.parse(result.scope.sessionId)).toEqual(['pero', 'telegram', 'bot', 'private', 'dm'])
    expect(handler).toHaveBeenCalledOnce()
  })

  it('主人身份变化、未开启视觉或越界工具都在执行前拒绝', async () => {
    const { port, origin, context, handler } = setup()
    await expect(
      port.execute({ ...origin, senderId: 'stranger' }, 'browser_status', {}, context),
    ).rejects.toThrow('SOCIAL_HOST_CAPABILITY_DENIED')
    await expect(port.execute(origin, 'terminal_execute', {}, context)).rejects.toThrow(
      'SOCIAL_HOST_CAPABILITY_DENIED',
    )
    await expect(port.execute(origin, 'browser_screenshot', {}, context)).rejects.toThrow(
      'SOCIAL_HOST_CAPABILITY_DENIED',
    )
    expect(handler).not.toHaveBeenCalled()
  })

  it('提供者离线和 Realm 注销后不能继续使用旧授权', async () => {
    const { port, tools, realm, origin, context, handler } = setup()
    tools.unregister('browser_status')
    await expect(port.execute(origin, 'browser_status', {}, context)).rejects.toThrow(
      'SOCIAL_HOST_CAPABILITY_DENIED',
    )
    await realm.dispose()
    const output = await port.execute(
      origin,
      'browser_screenshot',
      {},
      { ...context, enableVision: true },
    )
    expect(JSON.parse(output).success).toBe(false)
    expect(handler).not.toHaveBeenCalled()
  })
})
