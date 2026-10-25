import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  interactWithSocialTool,
  setSocialInteractionManager,
} from '@infos/backend/tools/appInteraction'
import { setTaskToolRuntime } from '@infos/backend/tools/taskControl/runtime'

afterEach(() => {
  setTaskToolRuntime(undefined)
  setSocialInteractionManager(null as never)
})

describe('跨平台社交委派工具', () => {
  const context = {
    agentId: 'pero',
    threadId: 'origin',
    sessionId: 'origin',
    source: 'desktop',
    channel: 'desktop',
    toolCallId: 'call',
  }
  it('平台与账号进入持久任务入口，不因多个连接而隐式选择', async () => {
    const delegateSocial = vi.fn(async () => ({ accepted: true, taskId: 'task' }))
    setTaskToolRuntime({ delegateSocial } as never)
    setSocialInteractionManager({} as never)
    const input = { group_id: 'topic', platform: 'telegram', account_id: 'bot', intent: '汇报结果' }
    const output = JSON.parse(String(await interactWithSocialTool.execute(input, context)))
    expect(output).toMatchObject({ success: true, accepted: true, taskId: 'task' })
    expect(delegateSocial).toHaveBeenCalledWith(input, context)
  })
  it('兼容直接委派时等待仍表示已受理，不伪报完成或失败', async () => {
    const executeCommand = vi.fn(async () => ({ status: 'waiting', summary: '等待群消息' }))
    setSocialInteractionManager({ executeCommand } as never)
    const output = JSON.parse(
      String(
        await interactWithSocialTool.execute(
          { group_id: 'topic', platform: 'telegram', account_id: 'bot' },
          context,
        ),
      ),
    )
    expect(output).toMatchObject({ success: true, status: 'waiting' })
    expect(executeCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { group_id: 'topic', platform: 'telegram', account_id: 'bot' },
      }),
    )
  })
})
