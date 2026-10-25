import { describe, expect, it, vi } from 'vitest'
import { SOCIAL_BUSINESS_TOOLS } from '@infos/shared'
import { getBuiltinToolDefinitions } from '@infos/backend/tools'
import {
  interactWithSocialTool,
  setSocialInteractionManager,
} from '@infos/backend/tools/appInteraction'
import { isToolAllowedInInteractionMode } from '@infos/backend/tools/interactionMode'
import type { AppManager } from '@infos/backend/applications/appManager'
import { ToolRegistry, type ToolContext } from '@infos/backend/services/agent/toolRegistry'
import { SocialAppRuntime } from '@infos/social/runtime'
import manifest from '../../../../apps/social/app.manifest.json'

describe('主应用与社交应用的工具隔离', () => {
  it('主 Agent 不注册社交业务工具，聊天白名单也不开放这些工具', () => {
    const names = getBuiltinToolDefinitions().map((tool) => tool.name)
    const registry = new ToolRegistry()
    for (const name of SOCIAL_BUSINESS_TOOLS) {
      expect(names).not.toContain(name)
      expect(isToolAllowedInInteractionMode(name, 'chat', registry)).toBe(false)
    }
    expect(names).toContain('interact_with_social')
    expect(names).toContain('social_notify_owner')
  })

  it('应用清单向宿主声明任务委派、查询和取消动作，保留内部业务工具', () => {
    expect(manifest.actions.map((action) => action.name)).toEqual([
      'chat_in_group',
      'get_task',
      'cancel_task',
    ])
    expect(manifest.providesTools.map((tool) => tool.name)).toEqual(SOCIAL_BUSINESS_TOOLS)
  })

  it.each([...SOCIAL_BUSINESS_TOOLS, 'describe_social_tools'])(
    '应用运行时拒绝通过宿主命令直接调用 %s',
    async (action) => {
      const runtime = new SocialAppRuntime()
      const result = await runtime.executeCommand({
        correlationId: 'test-command',
        action,
        input: {},
        communicationBudget: 8,
      })
      expect(result).toMatchObject({
        correlationId: 'test-command',
        status: 'failed',
        summary: '不支持的社交动作',
      })
    },
  )

  it('联系社交助手只发送委派意图，不转发伪造的业务操作参数', async () => {
    const executeCommand = vi.fn(async () => ({ status: 'completed', output: { sent: false } }))
    setSocialInteractionManager({ executeCommand } as unknown as AppManager)
    const context: ToolContext = {
      agentId: 'pero',
      threadId: 'desktop-thread',
      sessionId: 'desktop-thread',
      channel: 'desktop',
      source: 'desktop',
    }
    await interactWithSocialTool.execute(
      { group_id: '123456', intent: '查看近况', action: 'kick', input: { user_id: '987654' } },
      context,
    )
    expect(executeCommand).toHaveBeenCalledOnce()
    expect(executeCommand).toHaveBeenCalledWith({
      appId: 'social',
      hostAgentId: 'pero',
      action: 'chat_in_group',
      input: { group_id: '123456', intent: '查看近况' },
      taskContext: {
        description: '查看近况',
        inputs: ['123456'],
        successCriteria: '社交Agent已读取目标群聊并完成本次参与判断',
      },
    })
  })
})
