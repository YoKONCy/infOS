import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createAgentRouter } from '@infos/backend/routers/agent.router'
import { disposeExecutionOwner } from '@infos/backend/tools/productivityRuntimeHolder'

vi.mock('@infos/backend/tools/productivityRuntimeHolder', () => ({
  disposeExecutionOwner: vi.fn(),
}))
beforeEach(() => {
  vi.mocked(disposeExecutionOwner).mockReset()
})

describe('角色删除后的维护回收', () => {
  it('规范化角色 ID，并在角色移除之后回收后台维护', async () => {
    const order: string[] = []
    const deleteAgent = vi.fn(() => {
      order.push('delete')
    })
    const cleanupDeletedAgent = vi.fn(async () => {
      order.push('cleanup')
    })
    const router = createAgentRouter({
      agentManager: { deleteAgent },
      cleanupDeletedAgent,
    } as never)
    expect((await router.request('http://test/LIN', { method: 'DELETE' })).status).toBe(200)
    expect(deleteAgent).toHaveBeenCalledWith('lin')
    expect(cleanupDeletedAgent).toHaveBeenCalledWith('lin')
    expect(order).toEqual(['delete', 'cleanup'])
    expect(disposeExecutionOwner).toHaveBeenCalledWith({ agentId: 'lin' }, false, true)
  })

  it('删除被拒绝时不取消维护；终端回收失败也不能跳过记忆回收', async () => {
    const deleteAgent = vi.fn<() => void>(() => {
      throw new Error('不能删除当前活跃的 Agent')
    })
    const cleanupDeletedAgent = vi.fn(async () => {})
    const router = createAgentRouter({
      agentManager: { deleteAgent },
      cleanupDeletedAgent,
    } as never)
    router.onError((_error, context) => context.json({ code: 'UNPROCESSABLE' }, 422))
    await router.request('http://test/pero', { method: 'DELETE' })
    expect(cleanupDeletedAgent).not.toHaveBeenCalled()
    deleteAgent.mockImplementation(() => {})
    vi.mocked(disposeExecutionOwner).mockRejectedValue(new Error('终端回收失败'))
    await router.request('http://test/lin', { method: 'DELETE' })
    expect(cleanupDeletedAgent).toHaveBeenCalledWith('lin')
  })
})
