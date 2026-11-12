import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ApiResponse, CharacterState } from '@infos/shared'
import { DEFAULT_CHARACTER_STATE } from '@infos/shared'
import type { PetStateResponse } from '@infos/frontend/api/modules/agentApi'
import { usePetStateStore } from '@infos/frontend/stores/usePetStateStore'

const api = vi.hoisted(() => ({ getPetState: vi.fn() }))
vi.mock('@infos/frontend/api/modules/agentApi', () => ({ agentApi: api }))

function response(agentId: string, state: Partial<CharacterState>): ApiResponse<PetStateResponse> {
  return {
    code: 'OK',
    message: '获取成功',
    data: {
      agentId,
      ...DEFAULT_CHARACTER_STATE,
      ...state,
      clickMessages: {},
      idleMessages: [],
      backMessages: [],
      textExpiresAt: null,
      updatedAt: null,
    },
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}
beforeEach(() => {
  setActivePinia(createPinia())
  vi.resetAllMocks()
})

describe('角色状态按身份读取', () => {
  it('同一角色跨会话共享状态，并发读取合并为同一份快照', async () => {
    const store = usePetStateStore()
    const first = deferred<ApiResponse<PetStateResponse>>()
    const stateA = { mood: '期待', vibe: '安静', mind: '会话甲' }
    api.getPetState.mockReturnValueOnce(first.promise)
    const loading = store.load('pero', 'a')
    const switching = store.load('pero', 'b')
    first.resolve(response('pero', stateA))
    await Promise.all([loading, switching])
    expect(store.threadFor('pero')).toBe('b')
    expect(store.activeState).toMatchObject(stateA)
    expect(store.stateFor('pero', 'a')).toBe(store.stateFor('pero', 'b'))
    expect(api.getPetState).toHaveBeenCalledTimes(1)
    expect(api.getPetState).toHaveBeenCalledWith('pero', 'a')
  })

  it('撤回后的高修订状态不被旧推送覆盖，也不接受缺少会话的全局推送', () => {
    const store = usePetStateStore()
    store.applyPush({ agentId: 'pero', threadId: 'a', revision: 2, mood: '紧张' })
    store.applyPush({ agentId: 'pero', threadId: 'a', revision: 3, mood: '期待', mind: '已撤回' })
    store.applyPush({ agentId: 'pero', threadId: 'a', revision: 2, mood: '紧张' })
    store.applyPush({ agentId: 'pero', threadId: 'b', revision: 4, mood: '专注' })
    store.applyPush({ agentId: 'pero', revision: 100, mood: '不应接收' })
    expect(store.stateFor('pero', 'a')).toMatchObject({ mood: '专注', mind: '已撤回' })
    expect(store.stateFor('pero', 'b').mood).toBe('专注')
  })

  it('悬停其他角色不改变当前角色，也不覆盖当前角色状态', async () => {
    const store = usePetStateStore()
    store.activeAgentId = 'pero'
    store.apply('pero', { mood: '开心', vibe: '轻松', mind: '正在陪伴主人' })
    const nana = { mood: '专注', vibe: '安静', mind: '准备整理房间' }
    api.getPetState.mockResolvedValueOnce(response('nana', nana))
    await store.refresh('nana')
    expect(store.activeAgentId).toBe('pero')
    expect(store.stateFor('nana')).toEqual({ ...DEFAULT_CHARACTER_STATE, ...nana })
    expect(store.stateFor('pero').mind).toBe('正在陪伴主人')
  })

  it('同一角色的并发头像读取合并，短时重复悬停复用快照', async () => {
    const store = usePetStateStore(),
      pending = deferred<ApiResponse<PetStateResponse>>()
    const state = { mood: '开心', vibe: '活泼', mind: '想一起玩游戏' }
    api.getPetState.mockReturnValueOnce(pending.promise)
    const first = store.refresh('pero'),
      second = store.refresh('pero')
    expect(api.getPetState).toHaveBeenCalledTimes(1)
    expect(store.loading[store.scopeKey('pero')]).toBe(true)
    pending.resolve(response('pero', state))
    await Promise.all([first, second])
    await store.refresh('pero')
    expect(api.getPetState).toHaveBeenCalledTimes(1)
    expect(store.loading[store.scopeKey('pero')]).toBe(false)
    expect(store.stateFor('pero')).toEqual({ ...DEFAULT_CHARACTER_STATE, ...state })
    api.getPetState.mockResolvedValueOnce(response('pero', { ...state, mood: '期待' }))
    await store.refresh('pero', true)
    expect(api.getPetState).toHaveBeenCalledTimes(2)
    expect(store.stateFor('pero').mood).toBe('期待')
  })

  it('迟到的快照保留更新后的心情，同时补齐未被推送覆盖的其他字段', async () => {
    const store = usePetStateStore(),
      pending = deferred<ApiResponse<PetStateResponse>>()
    api.getPetState.mockReturnValueOnce(pending.promise)
    const loading = store.refresh('nana')
    store.apply('nana', { mood: '兴奋' })
    expect(store.hasState('nana')).toBe(false)
    pending.resolve(response('nana', { mood: '平静', vibe: '温柔', mind: '等主人回来' }))
    await loading
    expect(store.stateFor('nana')).toEqual({ ...DEFAULT_CHARACTER_STATE, mood: '兴奋', vibe: '温柔', mind: '等主人回来' })
    expect(store.hasState('nana')).toBe(true)
  })

  it('刷新失败保留缓存，重试成功后清除错误', async () => {
    const store = usePetStateStore()
    const cached = { mood: '安心', vibe: '放松', mind: '正在休息' }
    store.apply('pero', cached)
    api.getPetState.mockRejectedValueOnce(new Error('连接失败'))
    await store.refresh('pero', true)
    expect(store.stateFor('pero')).toEqual({ ...DEFAULT_CHARACTER_STATE, ...cached })
    expect(store.errors[store.scopeKey('pero')]).toContain('暂时无法读取')
    api.getPetState.mockResolvedValueOnce(response('pero', { ...cached, mind: '准备出门' }))
    await store.refresh('pero', true)
    expect(store.errors[store.scopeKey('pero')]).toBeUndefined()
    expect(store.stateFor('pero').mind).toBe('准备出门')
  })
})
