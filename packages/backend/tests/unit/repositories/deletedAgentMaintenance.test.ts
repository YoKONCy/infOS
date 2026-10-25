import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDrizzleConnection, closeDrizzleConnection } from '@infos/backend/database'
import { BackgroundTaskRepository } from '@infos/backend/repositories/backgroundTask.repo'
import { EventNoteRepository } from '@infos/backend/repositories/eventNote.repo'
import {
  eventMemoryDailyNoteTasks,
  eventMemoryReflectionTasks,
} from '@infos/backend/database/schema'

let db: ReturnType<typeof createDrizzleConnection>
beforeEach(() => {
  db = createDrizzleConnection(':memory:')
})
afterEach(() => closeDrizzleConnection(db))

async function seedTasks() {
  const repo = new BackgroundTaskRepository(db)
  for (const agentId of ['pero', 'lin']) {
    await repo.ensureResident({
      id: `resident_${agentId}`,
      agentId,
      threadId: `thread_${agentId}`,
      title: '记忆维护',
      instruction: '维护',
    })
    await repo.create({
      id: `history_${agentId}`,
      agentId,
      threadId: `history_thread_${agentId}`,
      title: '已完成任务',
      instruction: '保留历史',
      status: 'completed',
    })
  }
  return repo
}

describe('已删除角色的维护记录回收', () => {
  it('删除角色只移除对应常驻投影，重复回收幂等且保留普通历史', async () => {
    const repo = await seedTasks()
    await repo.deleteResidentsForAgent('lin')
    await repo.deleteResidentsForAgent('lin')
    expect((await repo.query({})).items.map((row) => row.id).sort()).toEqual([
      'history_lin',
      'history_pero',
      'resident_pero',
    ])
  })

  it('启动清理孤立常驻记录，角色列表为空时也不能误删普通历史', async () => {
    const repo = await seedTasks()
    await repo.pruneOrphanResidents(['pero'])
    expect(await repo.findById('resident_lin')).toBeNull()
    expect(await repo.findById('resident_pero')).not.toBeNull()
    await repo.pruneOrphanResidents([])
    expect((await repo.query({})).items.map((row) => row.id).sort()).toEqual([
      'history_lin',
      'history_pero',
    ])
  })

  it('关闭孤立维护队列，保留现存角色队列与已登记的日记文件清单', async () => {
    const repo = new EventNoteRepository(db)
    for (const agentId of ['pero', 'lin']) {
      await repo.enqueueReflectionTask({
        id: `reflection_${agentId}`,
        agentId,
        eventId: `event_${agentId}`,
      })
      await repo.ensureDailyNoteTask({
        id: `diary_${agentId}`,
        agentId,
        date: '2026-10-25',
        sourceIncomplete: false,
      })
      await repo.recordDailyNoteFile(`diary_${agentId}`, '2026-10-25.md')
    }
    await repo.retireOrphanBackgroundWork(['pero'])
    expect(
      db
        .select()
        .from(eventMemoryReflectionTasks)
        .all()
        .map((task) => task.agentId),
    ).toEqual(['pero'])
    expect(await repo.dailyNoteTask('lin', '2026-10-25')).toMatchObject({
      status: 'exhausted',
      nextAttemptAt: null,
      writtenFiles: ['2026-10-25.md'],
    })
    expect(await repo.dailyNoteTask('pero', '2026-10-25')).toMatchObject({ status: 'pending' })
    await repo.retireAgentBackgroundWork('pero')
    expect(db.select().from(eventMemoryReflectionTasks).all()).toEqual([])
    expect(db.select().from(eventMemoryDailyNoteTasks).all()).toHaveLength(2)
  })

  it('无角色时关闭全部维护队列，已完成日记仍保留原状态与文件清单', async () => {
    const repo = new EventNoteRepository(db)
    await repo.enqueueReflectionTask({ id: 'orphan-reflection', agentId: 'lin', eventId: 'event' })
    await repo.ensureDailyNoteTask({
      id: 'completed-diary',
      agentId: 'lin',
      date: '2026-10-24',
      sourceIncomplete: false,
    })
    await repo.completeDailyNoteTask('completed-diary', ['2026-10-24.md'])
    await repo.retireOrphanBackgroundWork([])
    expect(db.select().from(eventMemoryReflectionTasks).all()).toEqual([])
    expect(await repo.dailyNoteTask('lin', '2026-10-24')).toMatchObject({
      status: 'completed',
      writtenFiles: ['2026-10-24.md'],
    })
  })
})
