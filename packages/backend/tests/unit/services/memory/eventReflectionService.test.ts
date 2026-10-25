import { describe, expect, it, vi } from 'vitest'
import type { EventNote } from '@infos/shared'
import { MemoryAgentScope } from '@infos/backend/services/memory/memoryAgentScope'
import {
  EventReflectionService,
  type ReflectionDecision,
  type EventReflectionModel,
} from '@infos/backend/services/memory/eventReflectionService'

const decision: ReflectionDecision = { links: [], removeLinks: [], archive: false }
function note(id: string): EventNote {
  return {
    id,
    agentId: 'pero',
    narrative: `事件${id}`,
    eventAt: '2026-10-17T12:00:00.000Z',
    createdAt: '2026-10-17T12:00:00.000Z',
    importance: 6,
    affect: { tones: [], valence: 5, arousal: 0 },
    participants: [],
    places: [],
    objects: [],
    topics: [],
    origin: {
      mode: 'background',
      threadId: 'thread-1',
      pairIds: [id],
      messageIds: [],
      channel: 'desktop',
    },
    status: 'active',
  }
}

function fixture(agents?: MemoryAgentScope) {
  const main = note('main')
  const candidate = note('candidate')
  const notes = new Map([
    [main.id, main],
    [candidate.id, candidate],
  ])
  const task = { id: 'reflection:pero:main', agentId: 'pero', eventId: main.id }
  const forgotten = new Set<string>()
  const findOperation = vi.fn(
    async () => undefined as { status: string; payload: unknown } | undefined,
  )
  const repo = {
    findById: vi.fn(async (id: string) => notes.get(id)),
    findOperation,
    isMemoryForgotten: vi.fn((event: EventNote) => forgotten.has(event.id)),
    discardReflectionDecision: vi.fn(async () => {
      findOperation.mockResolvedValue(undefined)
    }),
    retryReflectionTask: vi.fn(async () => {}),
    createOperation: vi.fn(async () => true),
    markOperationCommitted: vi.fn(async () => {}),
    pendingReflectionTasks: vi.fn(async () => [task]),
    completeReflectionTask: vi.fn(async () => {}),
    failReflectionTask: vi.fn(async () => {}),
  }
  const memory = {
    query: vi.fn(async () => [...notes.values()]),
    addRelation: vi.fn(async () => {}),
    removeRelation: vi.fn(async () => {}),
    archive: vi.fn(async () => {}),
    revise: vi.fn(async () => main),
  }
  let busy = false
  const model = { reflect: vi.fn<EventReflectionModel['reflect']>().mockResolvedValue(decision) }
  const service = new EventReflectionService(memory as never, {} as never, model, repo as never, {
    agents,
    canMaintain: () => !busy,
  })
  return {
    main,
    candidate,
    notes,
    task,
    repo,
    memory,
    model,
    service,
    forgotten,
    setBusy: (value: boolean) => {
      busy = value
    },
  }
}

describe('事件关系维护与永久删除互斥', () => {
  it('已删除角色的排队任务直接收口，不调用模型或登记失败重试', async () => {
    const f = fixture(new MemoryAgentScope(() => false))
    await f.service.drain()
    expect(f.model.reflect).not.toHaveBeenCalled()
    expect(f.repo.completeReflectionTask).toHaveBeenCalledWith(f.task.id)
    expect(f.repo.failReflectionTask).not.toHaveBeenCalled()
    expect(f.service.validateAndRepair('pero')).toEqual({ valid: true, repaired: false })
  })

  it('角色删除后即使模型忽略取消并返回结果，也不能写入旧决策或修订', async () => {
    let exists = true
    const agents = new MemoryAgentScope(() => exists)
    const otherSignal = agents.signal('other')
    const f = fixture(agents)
    f.model.reflect.mockImplementation(async ({ signal }) => {
      exists = false
      agents.invalidate('pero')
      expect(signal?.aborted).toBe(true)
      return { ...decision, revision: { narrative: '已删除角色的迟到结果' } }
    })
    await f.service.drain()
    expect(f.repo.createOperation).not.toHaveBeenCalled()
    expect(f.memory.revise).not.toHaveBeenCalled()
    expect(f.repo.failReflectionTask).not.toHaveBeenCalled()
    expect(otherSignal.aborted).toBe(false)
    exists = true
    expect(agents.signal('pero').aborted).toBe(false)
  })

  it('来源已遗忘但事件行尚存时正常取消任务，不调用模型或进入错误退避', async () => {
    const { main, service, repo, model, forgotten } = fixture()
    forgotten.add(main.id)
    await service.drain()
    expect(model.reflect).not.toHaveBeenCalled()
    expect(repo.discardReflectionDecision).toHaveBeenCalledWith('pero', main.id)
    expect(repo.completeReflectionTask).toHaveBeenCalledOnce()
    expect(repo.failReflectionTask).not.toHaveBeenCalled()
  })

  it('候选 ID 仍在但来源已遗忘时，不传给模型且不写入持久决策', async () => {
    const { candidate, service, repo, model, forgotten } = fixture()
    forgotten.add(candidate.id)
    await service.drain()
    expect(model.reflect).toHaveBeenCalledWith(expect.objectContaining({ candidates: [] }))
    expect(JSON.stringify(repo.createOperation.mock.calls)).not.toContain(candidate.narrative)
    expect(repo.failReflectionTask).not.toHaveBeenCalled()
  })

  it('旧决策引用了遗忘候选时丢弃整个修订正文，按干净上下文重新决策', async () => {
    const { main, candidate, service, repo, model, memory, forgotten } = fixture()
    forgotten.add(candidate.id)
    repo.findOperation.mockResolvedValue({
      status: 'pending',
      payload: {
        event: main,
        candidates: [candidate],
        decision: { ...decision, revision: { narrative: '混入遗忘内容的旧修订' } },
      },
    })
    await service.drain()
    expect(repo.discardReflectionDecision).toHaveBeenCalledOnce()
    expect(model.reflect).toHaveBeenCalledWith(expect.objectContaining({ candidates: [] }))
    expect(memory.revise).not.toHaveBeenCalled()
    expect(JSON.stringify(repo.createOperation.mock.calls)).not.toContain('混入遗忘内容')
  })

  it('删除期间不启动维护，也不计为模型失败', async () => {
    const { service, setBusy, repo, model } = fixture()
    setBusy(true)
    await service.drain()
    expect(repo.pendingReflectionTasks).not.toHaveBeenCalled()
    expect(model.reflect).not.toHaveBeenCalled()
  })

  it('已删除主事件的旧持久决策不会被重放', async () => {
    const { main, candidate, notes, service, repo, model, memory } = fixture()
    notes.delete(main.id)
    repo.findOperation.mockResolvedValue({
      status: 'pending',
      payload: {
        event: main,
        candidates: [candidate],
        decision: { ...decision, links: [{ targetId: candidate.id, relation: 'same_topic' }] },
      },
    })
    await service.drain()
    expect(repo.completeReflectionTask).toHaveBeenCalledOnce()
    expect(repo.failReflectionTask).not.toHaveBeenCalled()
    expect(model.reflect).not.toHaveBeenCalled()
    expect(memory.addRelation).not.toHaveBeenCalled()
  })

  it('旧候选已删除时从最新库过滤，不再建立指向它的边', async () => {
    const { main, candidate, notes, service, repo, memory } = fixture()
    notes.delete(candidate.id)
    repo.findOperation.mockResolvedValue({
      status: 'pending',
      payload: {
        event: main,
        candidates: [candidate],
        decision: {
          ...decision,
          links: [{ targetId: candidate.id, relation: 'same_topic' }],
          removeLinks: [{ targetId: candidate.id, relation: 'same_event' }],
          archiveOverlaps: [candidate.id],
        },
      },
    })
    await service.drain()
    expect(memory.addRelation).not.toHaveBeenCalled()
    expect(memory.removeRelation).not.toHaveBeenCalled()
    expect(memory.archive).not.toHaveBeenCalled()
    expect(repo.failReflectionTask).not.toHaveBeenCalled()
  })

  it('模型返回前候选消失，不持久化其正文与决策引用', async () => {
    const { candidate, notes, service, repo, memory, model } = fixture()
    model.reflect.mockImplementationOnce(async () => {
      notes.delete(candidate.id)
      return {
        ...decision,
        links: [{ targetId: candidate.id, relation: 'same_topic' }],
        archiveOverlaps: [candidate.id],
      }
    })
    await service.drain()
    expect(repo.createOperation).toHaveBeenCalledWith(
      expect.any(String),
      'pero',
      'reflection_decision',
      expect.objectContaining({
        candidates: [],
        decision: expect.objectContaining({ links: [], archiveOverlaps: undefined }),
      }),
    )
    expect(JSON.stringify(repo.createOperation.mock.calls)).not.toContain(candidate.narrative)
    expect(memory.addRelation).not.toHaveBeenCalled()
    expect(repo.failReflectionTask).not.toHaveBeenCalled()
  })

  it('取消进行中的模型结果后不退避重试，尚存事件下轮可以正常处理', async () => {
    const { service, repo, model, memory } = fixture()
    let release!: () => void
    let started!: () => void
    const waiting = new Promise<void>((resolve) => {
      started = resolve
    })
    let signal: AbortSignal | undefined
    model.reflect.mockImplementationOnce(async (input: { signal?: AbortSignal }) => {
      signal = input.signal
      started()
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return decision
    })
    const draining = service.drain()
    await waiting
    service.invalidateForDeletion()
    release()
    await draining
    expect(signal?.aborted).toBe(true)
    expect(repo.createOperation).not.toHaveBeenCalled()
    expect(repo.completeReflectionTask).not.toHaveBeenCalled()
    expect(repo.failReflectionTask).not.toHaveBeenCalled()
    expect(memory.addRelation).not.toHaveBeenCalled()
    await service.drain()
    expect(repo.completeReflectionTask).toHaveBeenCalledOnce()
  })

  it('只保存事件本身，不夹带详情快照中的邻居正文', async () => {
    const { main, service, repo } = fixture()
    Object.assign(main, {
      previous: { ...note('deleted-neighbor'), narrative: '已删除的邻居正文' },
    })
    await service.drain()
    expect(JSON.stringify(repo.createOperation.mock.calls)).not.toContain('已删除的邻居正文')
    expect(repo.markOperationCommitted).toHaveBeenCalledOnce()
  })

  it('正常模型故障仍保留退避重试', async () => {
    const { service, repo, model } = fixture()
    model.reflect.mockRejectedValueOnce(new Error('模型暂时不可用'))
    await service.drain()
    expect(repo.failReflectionTask).toHaveBeenCalledWith(
      'reflection:pero:main',
      'Error: 模型暂时不可用',
    )
  })
})
