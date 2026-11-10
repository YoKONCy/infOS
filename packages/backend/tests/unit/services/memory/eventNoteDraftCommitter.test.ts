import { describe, expect, it, vi } from 'vitest'
import { EventNoteDraftCommitter } from '@infos/backend/services/memory/eventNoteDraftCommitter'
import type { ToolCallRecord } from '@infos/backend/services/pipeline/types'

function fixture() {
  const eventMemory = { create: vi.fn(), revise: vi.fn() }
  const eventRepo = {
    findOperation: vi.fn().mockResolvedValue(null),
    claimCoverageRange: vi.fn().mockResolvedValue(true),
    releaseCoverageClaim: vi.fn(),
  }
  const threads = { getThread: vi.fn().mockResolvedValue({ threadKind: 'side' }), conversations: { get: vi.fn() }, findMessagesByPairIds: vi.fn().mockResolvedValue([{ id: 1, revision: 1 }, { id: 2, revision: 1 }]) }
  const committer = new EventNoteDraftCommitter(
    eventMemory as never,
    eventRepo as never,
    threads as never,
  )
  const params = {
    agentId: 'pero',
    threadId: 'thread-1',
    pairId: 'pair-1',
    channel: 'desktop',
    assistantMessageId: 2,
    assistantTimestamp: '2026-10-22T04:00:00.000Z',
  }
  return { committer, eventMemory, eventRepo, params }
}

function call(name: string, narrative: string, isError = false): ToolCallRecord {
  return {
    name,
    args: {
      targetId: 'note-1',
      narrative,
      importance: 6,
      affect: { tones: [], valence: 5, arousal: 0 },
    },
    isError,
    callId: `call-${name}`,
    result: isError ? '请重写' : '已接受',
    durationMs: 1,
  }
}

describe('主动记事提交时的视角边界', () => {
  it.each(['write_event_note', 'revise_event_note'])('拒绝绕过工具校验的 %s 草稿', async (name) => {
    const { committer, eventMemory, eventRepo, params } = fixture()
    await expect(
      committer.commit({ ...params, toolCalls: [call(name, '用户告诉助手下周要搬家。')] }),
    ).rejects.toThrow('事件记叙视角不符合要求')
    expect(eventRepo.claimCoverageRange).not.toHaveBeenCalled()
    expect(eventMemory.create).not.toHaveBeenCalled()
    expect(eventMemory.revise).not.toHaveBeenCalled()
  })

  it.each(['write_event_note', 'revise_event_note'])(
    '跳过 %s 的失败调用，仅提交重写后的草稿',
    async (name) => {
      const { committer, eventMemory, eventRepo, params } = fixture()
      const narrative = '我得知主人下周要搬家。'
      await committer.commit({
        ...params,
        toolCalls: [call(name, '主人下周要搬家。', true), call(name, narrative)],
      })
      const input = expect.objectContaining({ narrative, agentId: 'pero' })
      if (name === 'write_event_note') {
        expect(eventMemory.create).toHaveBeenCalledExactlyOnceWith(
          input,
          'event-note:pero:thread-1:pair-1:write:new:0',
          { coverageOwnerId: 'active:desktop:pero:thread-1:2:0' },
        )
        expect(eventMemory.revise).not.toHaveBeenCalled()
      } else {
        expect(eventMemory.revise).toHaveBeenCalledExactlyOnceWith(
          'note-1',
          input,
          'event-note:pero:thread-1:pair-1:revise:note-1:0',
          { coverageOwnerId: 'active:desktop:pero:thread-1:2:0' },
        )
        expect(eventMemory.create).not.toHaveBeenCalled()
      }
      expect(eventRepo.releaseCoverageClaim).toHaveBeenCalledWith('active:desktop:pero:thread-1:2:0')
    },
  )
})
