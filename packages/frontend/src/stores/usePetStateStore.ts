import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { agentApi } from '../api/modules/agentApi'
import { DEFAULT_CHARACTER_STATE, type CharacterState } from '@infos/shared'

export type PetStatusState = CharacterState

/** 共享状态按角色缓存，会话选择仅决定请求来源。 */
export const usePetStateStore = defineStore('petState', () => {
  const states = ref<Record<string, PetStatusState>>({})
  const activeAgentId = ref('pero')
  const selectedThreads = ref<Record<string, string>>({})
  const loading = ref<Record<string, boolean>>({})
  const errors = ref<Record<string, string>>({})
  const requests = new Map<string, Promise<void>>()
  const refreshedAt = new Map<string, number>()
  const serverRevisions = new Map<string, number>()
  const fields = ['mood', 'vibe', 'mind'] as const
  const knownFields = ref<Record<string, Array<(typeof fields)[number]>>>({})
  const revisions = new Map<string, Record<(typeof fields)[number], number>>()

  function threadFor(agentId: string): string {
    return selectedThreads.value[agentId] ?? ''
  }
  function scopeKey(agentId: string, _threadId = threadFor(agentId)): string {
    return agentId
  }
  function stateFor(agentId: string, threadId = threadFor(agentId)): PetStatusState {
    return states.value[scopeKey(agentId, threadId)] ?? DEFAULT_CHARACTER_STATE
  }
  function hasState(agentId: string, threadId = threadFor(agentId)): boolean {
    return fields.every((field) => knownFields.value[scopeKey(agentId, threadId)]?.includes(field))
  }
  const activeState = computed(() => stateFor(activeAgentId.value))

  function apply(
    agentId: string,
    update: Partial<PetStatusState>,
    threadId = threadFor(agentId),
    revision?: number,
  ): void {
    if (!agentId) return
    const key = scopeKey(agentId, threadId)
    if (typeof revision === 'number') {
      if (revision < (serverRevisions.get(key) ?? 0)) return
      serverRevisions.set(key, revision)
    }
    const provided = fields.filter((field) => typeof update[field] === 'string')
    if (!provided.length) return
    knownFields.value[key] = [...new Set([...(knownFields.value[key] ?? []), ...provided])]
    const current = stateFor(agentId, threadId)
    const versions = revisions.get(key) ?? { mood: 0, vibe: 0, mind: 0 }
    for (const field of provided) versions[field]++
    revisions.set(key, versions)
    states.value = {
      ...states.value,
      [key]: { ...current, ...Object.fromEntries(provided.map((field) => [field, update[field]])) },
    }
  }

  /** 请求和推送都携带固定会话身份，切换期间返回的旧 HTTP 响应不能污染新会话。 */
  async function refresh(
    agentId: string,
    force = false,
    threadId = threadFor(agentId),
  ): Promise<void> {
    if (!agentId) return
    const key = scopeKey(agentId, threadId)
    const pending = requests.get(key)
    if (pending) return pending
    if (!force && Date.now() - (refreshedAt.get(key) ?? 0) < 5_000) return
    const before = { ...(revisions.get(key) ?? { mood: 0, vibe: 0, mind: 0 }) }
    loading.value[key] = true
    delete errors.value[key]
    const request = (async () => {
      try {
        const response = await agentApi.getPetState(agentId, threadId || undefined)
        if (!response.data || fields.some((field) => typeof response.data?.[field] !== 'string'))
          throw new Error('角色状态响应不完整')
        if (response.data.threadId !== undefined && (response.data.threadId ?? '') !== threadId)
          throw new Error('角色状态响应的会话标识不匹配')
        const update: Partial<PetStatusState> = {}
        const current = revisions.get(key)
        for (const field of fields)
          if ((current?.[field] ?? 0) === before[field]) update[field] = response.data[field]
        apply(agentId, update, threadId, response.data.revision)
        refreshedAt.set(key, Date.now())
      } catch {
        errors.value[key] = '角色状态暂时无法读取，请稍后重试'
      } finally {
        loading.value[key] = false
      }
    })()
    requests.set(key, request)
    try {
      await request
    } finally {
      requests.delete(key)
    }
  }

  function selectThread(agentId: string, threadId: string): void {
    selectedThreads.value = { ...selectedThreads.value, [agentId]: threadId }
    void refresh(agentId, true, threadId)
  }

  async function load(agentId: string, threadId?: string): Promise<void> {
    activeAgentId.value = agentId
    if (threadId !== undefined)
      selectedThreads.value = { ...selectedThreads.value, [agentId]: threadId }
    await refresh(agentId, true)
  }

  function applyPush(payload: Record<string, unknown>): void {
    if (typeof payload.agentId !== 'string' || typeof payload.threadId !== 'string') return
    apply(
      payload.agentId,
      {
        mood: typeof payload.mood === 'string' ? payload.mood : undefined,
        vibe: typeof payload.vibe === 'string' ? payload.vibe : undefined,
        mind: typeof payload.mind === 'string' ? payload.mind : undefined,
      },
      payload.threadId,
      typeof payload.revision === 'number' ? payload.revision : undefined,
    )
  }

  return {
    activeAgentId,
    activeState,
    stateFor,
    hasState,
    loading,
    errors,
    apply,
    load,
    refresh,
    threadFor,
    scopeKey,
    selectThread,
    applyPush,
  }
})
