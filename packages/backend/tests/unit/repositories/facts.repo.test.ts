import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDrizzleConnection, closeDrizzleConnection } from '@infos/backend/database'
import { factMemoryOperations, factObjects, factRecords } from '@infos/backend/database/schema'
import { MemoryStoreRegistry } from '@infos/backend/repositories/storeRegistry'
import { FactsRepository } from '@infos/backend/repositories/facts.repo'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = join(tmpdir(), `infos-facts-${Date.now()}-${Math.random()}`)
  roots.push(root)
  mkdirSync(root, { recursive: true })
  const db = createDrizzleConnection(join(root, 'infos.db'))
  const resolver = {
    resolve(alias: string) {
      return alias === '@data' ? root : join(root, alias.replace('@data/', ''))
    },
  }
  const stores = new MemoryStoreRegistry(resolver as never, 4)
  return { db, stores, repo: new FactsRepository(db, stores) }
}

describe('事实的归档还原', () => {
  it('自动召回匹配对象和别名，只返回有效事实，无关问题不取零分候选', async () => {
    const { db, stores, repo } = fixture()
    try {
      expect(repo.hasActiveFacts()).toBe(false)
      const old = await repo.write({
        standardName: '小林',
        aliases: ['林同学'],
        statement: '喜欢红茶',
        observedAt: '2026-10-25T01:00:00Z',
        createdByAgentId: 'pero',
      })
      expect(repo.hasActiveFacts()).toBe(true)
      expect(repo.recall('林同学喜欢什么饮料？').map((item) => item.id)).toContain(old.id)
      expect(repo.recall('量子纠缠与宇宙膨胀的关系')).toEqual([])
      const current = await repo.supersede(old.objectId, old.id, {
        statement: '喜欢绿茶',
        observedAt: old.observedAt,
        createdByAgentId: 'pero',
      })
      expect(repo.recall('小林的饮料偏好').map((item) => item.id)).toEqual([current.id])
      await repo.retractFact(current.id)
      expect(repo.hasActiveFacts()).toBe(false)
      expect(repo.recall('小林的偏好')).toEqual([])
    } finally {
      stores.closeAll()
      closeDrizzleConnection(db)
    }
  })
  it('撤回后还原同一记录，保留原始时间、来源与记录者，恢复查询', async () => {
    const { db, stores, repo } = fixture()
    try {
      const fact = await repo.write({
        standardName: '小林',
        statement: '喜欢红茶',
        source: '对话',
        createdByAgentId: 'pero',
        observedAt: '2026-10-21T04:00:00.000Z',
      })
      await repo.retractFact(fact.id, 'retract-before-restore')
      expect((await repo.query('小林')).exactMatch?.activeFacts).toEqual([])
      await repo.restoreFact(fact.id, 'restore-once')
      expect((await repo.query('小林')).exactMatch?.activeFacts).toEqual([fact])
      await repo.retractFact(fact.id, 'retract-after-restore')
      await repo.restoreFact(fact.id, 'restore-once')
      expect((await repo.query('小林')).exactMatch?.activeFacts).toEqual([])
      await repo.restoreFact(fact.id, 'restore-again')
      await repo.retractFact(fact.id, 'retract-before-restore')
      expect((await repo.query('小林')).exactMatch?.activeFacts).toEqual([fact])
    } finally {
      stores.closeAll()
      closeDrizzleConnection(db)
    }
  })

  it('版本替代不能还原，永久删除后连旧还原操作也不能重建记录', async () => {
    const { db, stores, repo } = fixture()
    try {
      const old = await repo.write({
        standardName: '偏好',
        statement: '红茶',
        observedAt: '2026-10-21T04:00:00.000Z',
        createdByAgentId: 'pero',
      })
      const current = await repo.supersede(old.objectId, old.id, {
        statement: '绿茶',
        observedAt: old.observedAt,
        createdByAgentId: 'pero',
      })
      await expect(repo.restoreFact(old.id)).rejects.toThrow('ARCHIVE_RESTORE_CONFLICT')
      await repo.retractFact(current.id)
      await repo.restoreFact(current.id, 'restore-before-delete')
      await repo.deleteFact(current.id)
      await expect(repo.restoreFact(current.id)).rejects.toThrow('ARCHIVE_RESTORE_NOT_FOUND')
      await expect(repo.restoreFact(current.id, 'restore-before-delete')).rejects.toThrow(
        'ARCHIVE_RESTORE_NOT_FOUND',
      )
      expect((await repo.query('偏好')).exactMatch?.activeFacts).toEqual([])
    } finally {
      stores.closeAll()
      closeDrizzleConnection(db)
    }
  })

  it('TDB 写入中断可重试，但稍后的永久遗忘标记阻止还原重放', async () => {
    const { db, stores, repo } = fixture()
    try {
      const fact = await repo.write({
        standardName: '行程',
        statement: '周五复盘',
        observedAt: '2026-10-21T04:00:00.000Z',
        createdByAgentId: 'pero',
      })
      await repo.retractFact(fact.id)
      const store = stores.getSharedStore('facts')
      const update = vi.spyOn(store, 'updatePayload').mockImplementationOnce(() => {
        throw new Error('模拟磁盘故障')
      })
      await expect(repo.restoreFact(fact.id, 'restore-failure')).rejects.toThrow('模拟磁盘故障')
      update.mockRestore()
      await repo.restoreFact(fact.id)
      await repo.restoreFact(fact.id, 'restore-failure')
      expect((await repo.query('行程')).exactMatch?.activeFacts).toEqual([fact])
      repo.setPrivacyPolicy(
        {
          deleted: (_kind: string, id: string) => id === fact.id,
          assertPayload: () => {
            throw new Error('已永久遗忘')
          },
        } as never,
        vi.fn(),
      )
      await expect(repo.restoreFact(fact.id)).rejects.toThrow('ARCHIVE_RESTORE_NOT_FOUND')
      await expect(repo.restoreFact(fact.id, 'restore-failure')).rejects.toThrow('已永久遗忘')
    } finally {
      stores.closeAll()
      closeDrizzleConnection(db)
    }
  })
})

describe('事实的人工修订', () => {
  it('保留原记录者、观察时间与历史关系，人工修改单独留痕并支持重试', async () => {
    const { db, stores, repo } = fixture()
    try {
      const old = await repo.write({
        standardName: '小林',
        statement: '偏好红茶',
        observedAt: '2026-10-21T04:00:00.000Z',
        source: '对话',
        createdByAgentId: 'pero',
      })
      const input = {
        statement: '偏好乌龙茶',
        source: '用户核实',
        confidence: 0.9,
        operationId: 'manual-fact',
      }
      const edited = await repo.editFact(old.id, input)
      expect(edited).toMatchObject({
        objectId: old.objectId,
        createdByAgentId: 'pero',
        observedAt: old.observedAt,
        statement: input.statement,
        source: input.source,
        confidence: 0.9,
      })
      expect((await repo.query('小林')).exactMatch?.activeFacts.map((fact) => fact.id)).toEqual([
        edited.id,
      ])
      expect((await repo.archive()).items[0]?.historicalFacts).toContainEqual(
        expect.objectContaining({ id: old.id, statement: old.statement, supersededBy: edited.id }),
      )
      const audit = (await db.select().from(factMemoryOperations)).find(
        (item) => item.operationId === input.operationId,
      )!
      expect(JSON.parse(audit.payloadJson).manualEdit).toMatchObject({
        actor: 'user',
        previousId: old.id,
      })
      expect((await repo.editFact(old.id, input)).id).toBe(edited.id)
      await repo.retractFact(edited.id)
      await expect(repo.editFact(old.id, input)).rejects.toThrow('ARCHIVE_EDIT_CONFLICT')
      expect((await repo.query('小林')).exactMatch?.activeFacts).toEqual([])
    } finally {
      stores.closeAll()
      closeDrizzleConnection(db)
    }
  })

  it('并发修改旧事实只能生成一条有效替代记录', async () => {
    const { db, stores, repo } = fixture()
    try {
      const old = await repo.write({
        standardName: '计划',
        statement: '周一复盘',
        observedAt: '2026-10-21T04:00:00.000Z',
        createdByAgentId: 'pero',
      })
      const results = await Promise.allSettled([
        repo.editFact(old.id, { statement: '周二复盘', operationId: 'manual-fact-a' }),
        repo.editFact(old.id, { statement: '周三复盘', operationId: 'manual-fact-b' }),
      ])
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      expect((await repo.query('计划')).exactMatch?.activeFacts).toHaveLength(1)
      expect(await db.select().from(factRecords)).toHaveLength(2)
    } finally {
      stores.closeAll()
      closeDrizzleConnection(db)
    }
  })

  it('人工修订中断后再撤回，重放不会重新激活新旧事实', async () => {
    const { db, stores, repo } = fixture()
    try {
      const old = await repo.write({
        standardName: '计划',
        statement: '周一复盘',
        observedAt: '2026-10-21T04:00:00.000Z',
        createdByAgentId: 'pero',
      })
      const store = stores.getSharedStore('facts')
      const commit = vi.spyOn(store, 'commitTransaction').mockImplementationOnce(() => {
        throw new Error('模拟提交中断')
      })
      await expect(
        repo.editFact(old.id, { statement: '周二复盘', operationId: 'manual-interrupted' }),
      ).rejects.toThrow('模拟提交中断')
      commit.mockRestore()
      const replacement = (await repo.archive()).items[0]!.activeFacts[0]!
      await expect(repo.retractFact(replacement.id, 'manual-retract')).rejects.toThrow(
        'TDB节点不存在',
      )
      await repo.replayPending()
      await repo.replayPending()
      expect((await repo.query('计划')).exactMatch?.activeFacts).toEqual([])
      expect((await repo.archive()).items[0]?.retractedFacts).toContainEqual(
        expect.objectContaining({ id: replacement.id, status: 'retracted' }),
      )
    } finally {
      stores.closeAll()
      closeDrizzleConnection(db)
    }
  })
})

describe('FactsRepository共享事实库', () => {
  it('应创建对象与事实，并通过标准名和别名精确查询', async () => {
    const { db, stores, repo } = fixture()
    const fact = await repo.write({
      standardName: '特里维姆数据库',
      aliases: ['TDB'],
      statement: '当前版本是0.8.2',
      observedAt: '2026-08-27T10:00:00.000Z',
      createdByAgentId: 'pero',
    })

    const result = await repo.query('tdb')
    expect(result.exactMatch?.objectId).toBe(fact.objectId)
    expect(result.exactMatch?.activeFacts[0]?.statement).toBe('当前版本是0.8.2')
    expect(stores.getSharedStore('facts').nodeCount()).toBe(2)

    stores.closeAll()
    closeDrizzleConnection(db)
  })

  it('精确失败后应返回最多5个文本候选并要求Agent选择', async () => {
    const { db, stores, repo } = fixture()
    const names = ['苹果公司', '苹果手机', '苹果电脑', '苹果商店', '苹果系统', '苹果配件']
    await db.insert(factObjects).values(
      names.map((standardName, index) => ({
        id: `object-${index}`,
        tdbId: index + 1,
        standardName,
        normalizedName: standardName,
        aliasesJson: '[]',
        createdAt: '2026-08-27T10:00:00.000Z',
      })),
    )
    await repo.rebuildStore()
    const result = await repo.query('苹果')
    expect(result.exactMatch).toBeUndefined()
    expect(result.requiresSelection).toBe(true)
    expect(result.candidates).toHaveLength(5)

    stores.closeAll()
    closeDrizzleConnection(db)
  })

  it('同一operationId重放不得创建重复事实，并可从SQLite重建共享TDB', async () => {
    const { db, stores, repo } = fixture()
    const input = {
      standardName: 'TriviumDB',
      aliases: ['TDB'],
      statement: '当前版本是0.8.2',
      observedAt: '2026-08-27T10:00:00.000Z',
      createdByAgentId: 'pero',
      operationId: 'fact-write-idempotent',
    }
    const first = await repo.write(input)
    const replayed = await repo.write({ ...input, statement: '这条输入不应覆盖原事实' })
    expect(replayed.id).toBe(first.id)
    expect(stores.getSharedStore('facts').nodeCount()).toBe(2)

    await repo.rebuildStore()
    const store = stores.getSharedStore('facts')
    expect(store.nodeCount()).toBe(2)
    const nodes = store
      .allNodeIds()
      .map((id) => store.get<{ id?: string; kind?: string }>(id)?.payload)
    expect(nodes).toContainEqual(expect.objectContaining({ id: first.id, kind: 'fact' }))
    const result = await repo.query('TDB')
    expect(result.exactMatch?.activeFacts).toContainEqual(expect.objectContaining({ id: first.id }))

    stores.closeAll()
    closeDrizzleConnection(db)
  })

  it('查询必须以TDB为权威并返回确定性对象事实路径', async () => {
    const { db, stores, repo } = fixture()
    const fact = await repo.write({
      standardName: '路径对象',
      statement: '路径事实',
      observedAt: '2026-08-27T10:00:00.000Z',
      createdByAgentId: 'pero',
    })
    await db.delete(factRecords)

    const result = await repo.query('路径对象')
    expect(result.exactMatch?.activeFacts).toContainEqual(expect.objectContaining({ id: fact.id }))
    expect(result.paths).toContainEqual({
      nodes: [
        expect.objectContaining({ id: fact.objectId, kind: 'fact_object' }),
        expect.objectContaining({ id: fact.id, kind: 'fact' }),
      ],
      edges: [expect.objectContaining({ fromId: fact.objectId, toId: fact.id, label: 'has_fact' })],
    })

    stores.closeAll()
    closeDrizzleConnection(db)
  })

  it('取代、删除和别名操作应支持operationId幂等重放', async () => {
    const { db, stores, repo } = fixture()
    const old = await repo.write({
      standardName: '幂等对象',
      statement: '旧事实',
      observedAt: '2026-08-26T10:00:00.000Z',
      createdByAgentId: 'pero',
    })
    const replacement = await repo.supersede(old.objectId, old.id, {
      statement: '新事实',
      observedAt: '2026-08-27T10:00:00.000Z',
      createdByAgentId: 'pero',
      operationId: 'supersede-idempotent',
    })
    const replayed = await repo.supersede(old.objectId, old.id, {
      statement: '不得创建的事实',
      observedAt: '2026-08-28T10:00:00.000Z',
      createdByAgentId: 'pero',
      operationId: 'supersede-idempotent',
    })
    expect(replayed.id).toBe(replacement.id)

    await repo.addAlias(old.objectId, 'IDEM', 'alias-idempotent')
    await repo.addAlias(old.objectId, '不得覆盖', 'alias-idempotent')
    expect((await repo.query('IDEM')).exactMatch?.objectId).toBe(old.objectId)

    await repo.deleteFact(replacement.id, 'delete-idempotent')
    await repo.deleteFact(replacement.id, 'delete-idempotent')
    expect((await repo.query('幂等对象')).exactMatch?.activeFacts).toEqual([])
    expect(await db.select().from(factMemoryOperations)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operationId: 'supersede-idempotent', status: 'committed' }),
        expect.objectContaining({ operationId: 'alias-idempotent', status: 'committed' }),
        expect.objectContaining({ operationId: 'delete-idempotent', status: 'committed' }),
      ]),
    )

    stores.closeAll()
    closeDrizzleConnection(db)
  })

  it('TDB提交失败时应保留SQLite备份和failed操作，恢复后可重放提交', async () => {
    const { db, stores, repo } = fixture()
    const store = stores.getSharedStore('facts')
    const failure = vi.spyOn(store, 'commitTransaction').mockImplementationOnce(() => {
      throw new Error('注入TDB提交失败')
    })

    await expect(
      repo.write({
        standardName: '故障对象',
        statement: '故障事实',
        observedAt: '2026-08-27T10:00:00.000Z',
        createdByAgentId: 'pero',
        operationId: 'write-failure',
      }),
    ).rejects.toThrow('注入TDB提交失败')

    expect(await db.select().from(factRecords)).toHaveLength(1)
    expect(await db.select().from(factMemoryOperations)).toContainEqual(
      expect.objectContaining({ operationId: 'write-failure', status: 'failed', attempts: 1 }),
    )

    failure.mockRestore()
    await repo.replayPending()
    expect((await repo.query('故障对象')).exactMatch?.activeFacts).toHaveLength(1)
    expect(await db.select().from(factMemoryOperations)).toContainEqual(
      expect.objectContaining({ operationId: 'write-failure', status: 'committed' }),
    )

    stores.closeAll()
    closeDrizzleConnection(db)
  })

  it('取代、删除和别名的TDB失败应保留failed操作并可恢复重放', async () => {
    const { db, stores, repo } = fixture()
    const old = await repo.write({
      standardName: '恢复对象',
      statement: '旧值',
      observedAt: '2026-08-26T10:00:00.000Z',
      createdByAgentId: 'pero',
    })
    const store = stores.getSharedStore('facts')

    const supersedeFailure = vi.spyOn(store, 'commitTransaction').mockImplementationOnce(() => {
      throw new Error('取代提交失败')
    })
    await expect(
      repo.supersede(old.objectId, old.id, {
        statement: '新值',
        observedAt: '2026-08-27T10:00:00.000Z',
        createdByAgentId: 'pero',
        operationId: 'supersede-failure',
      }),
    ).rejects.toThrow('取代提交失败')
    supersedeFailure.mockRestore()
    await repo.replayPending()
    const replacement = (await repo.query('恢复对象')).exactMatch?.activeFacts[0]
    expect(replacement?.statement).toBe('新值')

    const aliasFailure = vi.spyOn(store, 'updatePayload').mockImplementationOnce(() => {
      throw new Error('别名提交失败')
    })
    await expect(repo.addAlias(old.objectId, '恢复别名', 'alias-failure')).rejects.toThrow(
      '别名提交失败',
    )
    aliasFailure.mockRestore()
    await repo.replayPending()
    expect((await repo.query('恢复别名')).exactMatch?.objectId).toBe(old.objectId)

    const deleteFailure = vi.spyOn(store, 'delete').mockImplementationOnce(() => {
      throw new Error('删除提交失败')
    })
    await expect(repo.deleteFact(replacement!.id, 'delete-failure')).rejects.toThrow('删除提交失败')
    deleteFailure.mockRestore()
    await repo.replayPending()
    expect((await repo.query('恢复对象')).exactMatch?.activeFacts).toEqual([])

    expect(await db.select().from(factMemoryOperations)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operationId: 'supersede-failure',
          status: 'committed',
          attempts: 1,
        }),
        expect.objectContaining({ operationId: 'alias-failure', status: 'committed', attempts: 1 }),
        expect.objectContaining({
          operationId: 'delete-failure',
          status: 'committed',
          attempts: 1,
        }),
      ]),
    )

    stores.closeAll()
    closeDrizzleConnection(db)
  })

  it('SQLite准备失败时不得触碰TDB', async () => {
    const { db, stores, repo } = fixture()
    const first = await repo.write({
      standardName: 'SQLite边界',
      statement: '第一条',
      observedAt: '2026-08-27T10:00:00.000Z',
      createdByAgentId: 'pero',
      operationId: 'shared-operation',
    })
    const store = stores.getSharedStore('facts')
    const nodeCount = store.nodeCount()

    await expect(
      repo.supersede(first.objectId, first.id, {
        statement: '不得提交',
        observedAt: '2026-08-28T10:00:00.000Z',
        createdByAgentId: 'pero',
        operationId: 'shared-operation',
      }),
    ).rejects.toThrow(Error)

    expect(store.nodeCount()).toBe(nodeCount)
    expect((await repo.query('SQLite边界')).exactMatch?.activeFacts.map((fact) => fact.id)).toEqual(
      [first.id],
    )

    stores.closeAll()
    closeDrizzleConnection(db)
  })

  it('用户撤回事实时应退出检索并保留TDB节点与关系边', async () => {
    const { db, stores, repo } = fixture()
    const fact = await repo.write({
      standardName: '保留关系对象',
      statement: '需要撤回的事实',
      observedAt: '2026-08-27T10:00:00.000Z',
      createdByAgentId: 'pero',
    })
    const store = stores.getSharedStore('facts')
    const objectNode = store
      .allNodeIds()
      .find((id) => store.get<{ kind?: string; id?: string }>(id)?.payload.id === fact.objectId)!
    const factNode = store
      .allNodeIds()
      .find((id) => store.get<{ kind?: string; id?: string }>(id)?.payload.id === fact.id)!

    await repo.retractFact(fact.id, 'retract-fact')

    expect((await repo.query('保留关系对象')).exactMatch?.activeFacts).toEqual([])
    expect((await repo.archive()).items[0]?.retractedFacts).toContainEqual(
      expect.objectContaining({ id: fact.id, status: 'retracted' }),
    )
    expect(store.contains(factNode)).toBe(true)
    expect(store.get<{ status?: string }>(factNode)?.payload.status).toBe('retracted')
    expect(store.getEdges(objectNode)).toContainEqual(
      expect.objectContaining({ targetId: factNode, label: 'has_fact' }),
    )

    stores.closeAll()
    closeDrizzleConnection(db)
  })

  it('档案浏览应按对象聚合当前与历史事实并支持全文过滤', async () => {
    const { db, stores, repo } = fixture()
    const old = await repo.write({
      standardName: '知识对象',
      aliases: ['资料对象'],
      statement: '旧知识内容',
      observedAt: '2026-08-26T10:00:00.000Z',
      createdByAgentId: 'pero',
    })
    const current = await repo.supersede(old.objectId, old.id, {
      statement: '当前知识内容',
      observedAt: '2026-08-27T10:00:00.000Z',
      createdByAgentId: 'pero',
    })

    const archive = await repo.archive('资料对象')
    expect(archive.stats).toEqual({
      objectCount: 1,
      activeFactCount: 1,
      historicalFactCount: 1,
      retractedFactCount: 0,
    })
    expect(archive.items[0]).toMatchObject({
      standardName: '知识对象',
      aliases: ['资料对象'],
      activeFacts: [expect.objectContaining({ id: current.id, statement: '当前知识内容' })],
      historicalFacts: [expect.objectContaining({ id: old.id, supersededBy: current.id })],
    })
    expect((await repo.archive('当前知识')).items).toHaveLength(1)
    expect((await repo.archive('不存在')).items).toHaveLength(0)

    stores.closeAll()
    closeDrizzleConnection(db)
  })

  it('显式取代应更新active事实并建立双向取代边', async () => {
    const { db, stores, repo } = fixture()
    const old = await repo.write({
      standardName: 'TDB',
      statement: '版本是0.8.1',
      observedAt: '2026-08-26T10:00:00.000Z',
      createdByAgentId: 'pero',
    })
    const replacement = await repo.supersede(old.objectId, old.id, {
      statement: '版本是0.8.2',
      observedAt: '2026-08-27T10:00:00.000Z',
      createdByAgentId: 'nana',
    })
    const result = await repo.query('TDB')

    expect(result.exactMatch?.activeFacts.map((fact) => fact.id)).toEqual([replacement.id])
    const store = stores.getSharedStore('facts')
    const nodes = store
      .allNodeIds()
      .map((id) => ({ id, payload: store.get(id)?.payload as { id?: string } }))
    const oldNode = nodes.find((node) => node.payload.id === old.id)!
    const newNode = nodes.find((node) => node.payload.id === replacement.id)!
    expect(store.getEdge(oldNode.id, newNode.id, 'superseded_by')).not.toBeNull()
    expect(store.getEdge(newNode.id, oldNode.id, 'supersedes')).not.toBeNull()

    stores.closeAll()
    closeDrizzleConnection(db)
  })
})
