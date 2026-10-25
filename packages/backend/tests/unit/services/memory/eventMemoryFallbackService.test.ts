import { afterEach, describe, expect, it, vi } from 'vitest'
import { tokenCounter } from '@infos/backend/services/tokenizer/tokenCounter'
import { MemoryBackgroundControl } from '@infos/backend/services/memory/memoryBackgroundControl'
import { MemoryAgentScope } from '@infos/backend/services/memory/memoryAgentScope'
import {
  EventMemoryFallbackService,
  type EventMemoryFallbackOptions,
} from '@infos/backend/services/memory/eventMemoryFallbackService'
import type { EventNoteDraftInput } from '@infos/shared'

afterEach(() => vi.restoreAllMocks())

function rounds(count: number) {
  return Array.from({ length: count * 2 }, (_, index) => ({
    id: index + 1,
    threadId: 'thread-1',
    role: index % 2 ? 'assistant' : 'user',
    content: `第${Math.floor(index / 2) + 1}轮${index % 2 ? '回复' : '问题'}`,
    rawContent: null,
    pairId: `pair-${Math.floor(index / 2) + 1}`,
    senderId: null,
    agentId: 'pero',
    metadataJson: '{}',
    scorerStatus: 'pending',
    revision: 0,
    timestamp: new Date(2026, 9, 21, 12, 0, index).toISOString(),
    status: 'active',
  }))
}

const draft: EventNoteDraftInput = {
  narrative: '主人和我约好了，以后每周一起复盘。',
  importance: 6,
  affect: { tones: ['期待'], valence: 7, arousal: 4 },
}

function fixture(options: EventMemoryFallbackOptions = {}, drafts: EventNoteDraftInput[] = []) {
  let now = new Date(2026, 9, 21, 12).getTime()
  let messages = rounds(1)
  const timers = new Map<string, number>()
  const coverage = new Set<string>()
  const operations = new Map<string, { payload: unknown }>()
  const repo = {
    readTimer: vi.fn(async (key: string) => timers.get(key) ?? 0),
    checkpointTimer: vi.fn(async (key: string, value: number) => {
      timers.set(key, value)
    }),
    resetTimer: vi.fn(async (key: string) => {
      timers.set(key, 0)
    }),
    advanceTimer: vi.fn(async (key: string, delta: number) => {
      const value = (timers.get(key) ?? 0) + delta
      timers.set(key, value)
      return value
    }),
    memoryScheduleTime: vi.fn(async (key: string) => timers.get(`schedule:${key}`) ?? 0),
    setMemoryScheduleTime: vi.fn(async (key: string, value: number) => {
      timers.set(`schedule:${key}`, value)
    }),
    coveredPairIds: vi.fn(async () => new Set(coverage)),
    claimCoverageRange: vi.fn().mockResolvedValue(true),
    releaseCoverageClaim: vi.fn(),
    renewCoverageClaim: vi.fn(),
    commitCoverageUnderClaim: vi.fn(async (value: { pairIds: string[] }) => {
      value.pairIds.forEach((id) => coverage.add(id))
    }),
    findOperation: vi.fn(async (id: string) => operations.get(id)),
    createOperation: vi.fn(async (id: string, _agent: string, _kind: string, payload: unknown) => {
      if (operations.has(id)) return false
      operations.set(id, { payload })
      return true
    }),
    markOperationCommitted: vi.fn(),
  }
  const threads = {
    getThread: vi.fn().mockResolvedValue({ id: 'thread-1', agentId: 'pero', status: 'active' }),
    listThreads: vi.fn().mockResolvedValue({
      items: [{ id: 'thread-1', agentId: 'pero', channel: 'desktop' }],
      total: 1,
    }),
    latestMemoryMessageId: vi.fn(async () => Math.max(0, ...messages.map((m) => m.id))),
    queryMemoryMessagesThrough: vi.fn(async (_thread: string, fence: number) =>
      messages.filter((m) => m.id <= fence),
    ),
    findMessagesByPairIds: vi.fn(async (_thread: string, pairs: string[]) =>
      messages.filter((m) => pairs.includes(m.pairId)),
    ),
  }
  const extractor = { extract: vi.fn().mockResolvedValue(drafts) }
  const create = vi.fn(async (_input: unknown, id: string) => ({ id }))
  const restart = () =>
    new EventMemoryFallbackService(
      repo as never,
      threads as never,
      { create } as never,
      extractor,
      {
        intervalSeconds: 60,
        safeInputTokens: 24_000,
        now: () => new Date(now),
        ...options,
      },
    )
  const service = restart()
  const advance = (seconds: number) => {
    now += seconds * 1000
  }
  const online = async (seconds: number, current = service, agents = ['pero']) => {
    while (seconds > 0) {
      const step = Math.min(30, seconds)
      advance(step)
      await current.checkpointRuntime(agents)
      seconds -= step
    }
  }
  return {
    service,
    repo,
    threads,
    extractor,
    create,
    timers,
    coverage,
    advance,
    online,
    restart,
    setMessages: (value: ReturnType<typeof rounds>) => {
      messages = value
    },
  }
}

describe('Agent 累计在线八小时补记', () => {
  it('已删除角色即使仍在调度快照里，也不能继续计时或调用补记模型', async () => {
    const f = fixture({ agents: new MemoryAgentScope(() => false) })
    await f.online(90)
    await f.service.tick(['pero'])
    expect(f.repo.advanceTimer).not.toHaveBeenCalled()
    expect(f.extractor.extract).not.toHaveBeenCalled()
  })

  it('补记模型执行期间删除角色时，中止提交且不进入失败重试', async () => {
    let exists = true
    const agents = new MemoryAgentScope(() => exists)
    const f = fixture({ agents }, [draft])
    await f.online(60)
    f.extractor.extract.mockImplementation(async () => {
      exists = false
      agents.invalidate('pero')
      return [draft]
    })
    await f.service.tick(['pero'])
    expect(f.extractor.extract).toHaveBeenCalledOnce()
    expect(f.create).not.toHaveBeenCalled()
    expect(f.repo.commitCoverageUnderClaim).not.toHaveBeenCalled()
    expect(f.repo.releaseCoverageClaim).toHaveBeenCalledOnce()
    expect(f.repo.setMemoryScheduleTime).not.toHaveBeenCalled()
    expect(f.service.hasPendingWork).toBe(false)
  })

  it('八小时之前再多轮数、再长正文和日界都不能提前触发', async () => {
    const f = fixture({ intervalSeconds: 8 * 60 * 60, safeInputTokens: 500 })
    f.setMessages(rounds(100))
    await f.service.tick(['pero'])
    await f.online(8 * 60 * 60 - 30)
    await f.service.tick(['pero'])
    expect(f.extractor.extract).not.toHaveBeenCalled()
    await f.online(30)
    await f.service.tick(['pero'])
    expect(f.extractor.extract).toHaveBeenCalled()
    expect(f.coverage.size).toBe(100)
  })

  it('关机和进程重启保留累计值，但离线十二小时不能推进计时', async () => {
    const f = fixture({ intervalSeconds: 8 * 60 * 60 })
    await f.online(4 * 60 * 60)
    f.advance(12 * 60 * 60)
    const restarted = f.restart()
    await restarted.tick(['pero'])
    expect(f.timers.get('background-runtime:pero')).toBe(4 * 60 * 60)
    expect(f.extractor.extract).not.toHaveBeenCalled()
    await f.online(4 * 60 * 60, restarted)
    await restarted.tick(['pero'])
    expect(f.extractor.extract).toHaveBeenCalledOnce()
  })

  it('系统挂起的大间隔不算在线运行，恢复后从原累计值接续', async () => {
    const f = fixture()
    await f.online(30)
    f.advance(6 * 60 * 60)
    await f.service.tick(['pero'])
    expect(f.timers.get('background-runtime:pero')).toBe(30)
    expect(f.extractor.extract).not.toHaveBeenCalled()
    await f.online(30)
    await f.service.tick(['pero'])
    expect(f.extractor.extract).toHaveBeenCalledOnce()
  })

  it('主动记录只排除对应轮次，不重置独立的八小时计时', async () => {
    const f = fixture()
    f.setMessages(rounds(2))
    await f.online(30)
    f.coverage.add('pair-1')
    await f.repo.resetTimer('agent-silence:pero')
    await f.online(30)
    await f.service.tick(['pero'])
    expect(f.extractor.extract).toHaveBeenCalledOnce()
    expect(
      f.extractor.extract.mock.calls[0]![0].messages.map((m: { pairId: string }) => m.pairId),
    ).toEqual(['pair-2', 'pair-2'])
    expect(f.timers.get('background-runtime:pero')).toBe(60)
  })

  it('返回空事件也持久标记已审阅，后续周期不会重复调用模型', async () => {
    const f = fixture()
    await f.online(60)
    await f.service.tick(['pero'])
    expect(f.repo.commitCoverageUnderClaim).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'reviewed_no_event' }),
      expect.any(String),
    )
    await f.online(60)
    await f.restart().tick(['pero'])
    expect(f.extractor.extract).toHaveBeenCalledOnce()
  })

  it('补记只处理周期边界前的消息，执行期间的新消息留给下一周期', async () => {
    const f = fixture()
    f.extractor.extract.mockImplementationOnce(async () => {
      f.setMessages(rounds(2))
      return []
    })
    await f.online(60)
    await f.service.tick(['pero'])
    expect(f.coverage).toEqual(new Set(['pair-1']))
    await f.service.tick(['pero'])
    expect(f.extractor.extract).toHaveBeenCalledOnce()
    await f.online(60)
    await f.service.tick(['pero'])
    expect(f.coverage).toEqual(new Set(['pair-1', 'pair-2']))
  })

  it('容量不足时自动拆成多批，所有正文按序保留且超长单轮最后才提交覆盖', async () => {
    vi.spyOn(tokenCounter, 'countTokens').mockImplementation((text) => text.length)
    const f = fixture({ safeInputTokens: 320, capacityRatio: 1 })
    const messages = rounds(3)
    messages[0]!.content = '甲😀乙'.repeat(150)
    f.setMessages(messages)
    f.extractor.extract.mockImplementation(
      async (input: { messages: Array<{ pairId: string }> }) => {
        if (input.messages.some((m) => m.pairId === 'pair-1'))
          expect(f.coverage.has('pair-1')).toBe(false)
        return []
      },
    )
    await f.online(60)
    await f.service.tick(['pero'])
    const batches = f.extractor.extract.mock.calls.map(
      ([input]) => input.messages as typeof messages,
    )
    expect(batches.length).toBeGreaterThan(1)
    for (const batch of batches) {
      expect(batch.reduce((n, m) => n + m.content.length + 48, 0)).toBeLessThanOrEqual(320)
      for (const m of batch) expect(m.content).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/)
    }
    for (const source of messages) {
      expect(
        batches
          .flat()
          .filter((m) => m.role === source.role && m.pairId === source.pairId)
          .map((m) => m.content)
          .join(''),
      ).toBe(source.content)
    }
    expect(f.coverage.size).toBe(3)
  })

  it('模型和人格预留参与输入预算，容量不合格时保留待处理周期', async () => {
    const f = fixture({ safeInputTokens: 0, getModelConfig: async () => null })
    await f.online(60)
    await f.service.tick(['pero'])
    expect(f.extractor.extract).not.toHaveBeenCalled()
    expect(f.service.hasPendingWork).toBe(true)
    expect(f.timers.get('background-reviewed-runtime:pero')).toBeUndefined()
  })

  it('相同正文的不同分片分别缓存，重启续接只复用已完成位置的结果', async () => {
    vi.spyOn(tokenCounter, 'countTokens').mockImplementation((text) => text.length)
    const f = fixture({ safeInputTokens: 320, capacityRatio: 1 })
    const messages = rounds(1)
    messages[0]!.content = '甲😀乙'.repeat(150)
    f.setMessages(messages)
    f.extractor.extract
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('第二片段请求中断'))
    await f.online(60)
    await f.service.tick(['pero'])
    expect(f.extractor.extract).toHaveBeenCalledTimes(2)
    expect(f.extractor.extract.mock.calls[0]![0].messages).toEqual(
      f.extractor.extract.mock.calls[1]![0].messages,
    )
    expect(f.coverage.size).toBe(0)
    f.advance(5 * 60)
    await f.restart().tick(['pero'])
    expect(f.extractor.extract).toHaveBeenCalledTimes(4)
    expect(f.coverage).toEqual(new Set(['pair-1']))
  })

  it('未收到完整回复的轮次不会标记已审阅，回复到达后下周期再补记', async () => {
    const f = fixture()
    f.setMessages(rounds(1).slice(0, 1))
    await f.online(60)
    await f.service.tick(['pero'])
    expect(f.extractor.extract).not.toHaveBeenCalled()
    f.setMessages(rounds(1))
    await f.online(60)
    await f.service.tick(['pero'])
    expect(f.extractor.extract).toHaveBeenCalledOnce()
  })

  it('写入失败后的重启重用模型结果，并保留失败退避', async () => {
    const f = fixture({}, [draft])
    f.create.mockRejectedValueOnce(new Error('磁盘暂不可写'))
    await f.online(60)
    await f.service.tick(['pero'])
    expect(f.extractor.extract).toHaveBeenCalledOnce()
    const restarted = f.restart()
    await restarted.tick(['pero'])
    expect(f.create).toHaveBeenCalledOnce()
    f.advance(5 * 60)
    await restarted.tick(['pero'])
    expect(f.extractor.extract).toHaveBeenCalledOnce()
    expect(f.coverage).toEqual(new Set(['pair-1']))
  })

  it('覆盖占用冲突不调用模型，也不能把本周期错误结算为完成', async () => {
    const f = fixture()
    f.repo.claimCoverageRange.mockResolvedValue(false)
    await f.online(60)
    await f.service.tick(['pero'])
    expect(f.extractor.extract).not.toHaveBeenCalled()
    expect(f.service.hasPendingWork).toBe(true)
    expect(f.timers.has('background-reviewed-runtime:pero')).toBe(false)
  })

  it('后台开关关闭和角色停用期间暂停计时，恢复后不会清零', async () => {
    const background = new MemoryBackgroundControl()
    const f = fixture({ background })
    await f.online(30)
    background.setEnabled(false)
    await f.online(120)
    expect(f.timers.get('background-runtime:pero')).toBe(30)
    background.setEnabled(true)
    await f.service.checkpointRuntime(['pero'])
    await f.online(30)
    await f.service.tick(['pero'])
    expect(f.extractor.extract).toHaveBeenCalledOnce()
  })

  it('关闭后台时迟到模型结果不能写入或提交覆盖', async () => {
    const background = new MemoryBackgroundControl()
    const f = fixture({ background })
    f.extractor.extract.mockImplementationOnce(async () => {
      background.setEnabled(false)
      return [draft]
    })
    await f.online(60)
    await f.service.tick(['pero'])
    expect(f.create).not.toHaveBeenCalled()
    expect(f.coverage.size).toBe(0)
    expect(f.repo.releaseCoverageClaim).toHaveBeenCalledOnce()
  })

  it('提炼期间编辑来源会放弃旧结果，不把改动后的消息误标为已补记', async () => {
    const f = fixture()
    f.extractor.extract.mockImplementationOnce(async () => {
      const changed = rounds(1)
      changed[0]!.content = '刚修改的问题'
      changed[0]!.revision++
      f.setMessages(changed)
      return [draft]
    })
    await f.online(60)
    await f.service.tick(['pero'])
    expect(f.create).not.toHaveBeenCalled()
    expect(f.coverage.size).toBe(0)
    expect(f.service.hasPendingWork).toBe(true)
  })
})
