import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryStoreRegistry } from '@infos/backend/repositories/storeRegistry'
import {
  databaseFormat,
  triviumFiles,
  upgradeBackupPath,
} from '@infos/backend/repositories/triviumFiles'

const roots: string[] = []
const temporaryRoot = fileURLToPath(new URL('../../../../../TEMP/', import.meta.url))

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('MemoryStoreRegistry维度联动', () => {
  function fixture(dimension: number) {
    const root = join(temporaryRoot, `infos-index-rebuild-${Date.now()}-${Math.random()}`)
    roots.push(root)
    mkdirSync(root, { recursive: true })
    const resolver = {
      resolve: (alias: string) =>
        alias === '@data' ? root : join(root, alias.slice('@data/'.length)),
    }
    return new MemoryStoreRegistry(resolver as never, dimension)
  }

  it('首次写入真实 v9 文件组前保留完整备份，迁移 v10 后保留向量、正文与关系', () => {
    const registry = fixture(4)
    const target = registry.resolveAgentStorePath('pero', 'main')
    const root = join(target, '../..')
    const saved = JSON.parse(
      readFileSync(new URL('../../fixtures/trivium/v9-f32.json', import.meta.url), 'utf8'),
    ) as { files: Record<string, string> }
    const originals = new Map(
      Object.entries(saved.files).map(([name, value]) => [
        name,
        gunzipSync(Buffer.from(value, 'base64')),
      ]),
    )
    mkdirSync(join(root, 'agent_pero'), { recursive: true })
    for (const [name, bytes] of originals) writeFileSync(join(root, 'agent_pero', name), bytes)
    expect(databaseFormat(target)).toBe(9)
    try {
      const store = registry.getAgentStore('pero', 'main')
      expect(store.nodeCount()).toBe(2)
      expect(Array.from(store.get(1)!.vector)).toEqual([1, 0, 0, 0])
      expect(store.get(1)?.payload).toMatchObject({ content: '升级前记忆' })
      expect(store.getEdge(2, 1, 'involves')).toMatchObject({
        weight: 0.75,
        metadata: { source: '旧版关系' },
      })
      registry.closeAll()
      expect(databaseFormat(target)).toBe(10)
      const backupRoot = upgradeBackupPath(root, target)
      const backups = readdirSync(backupRoot)
      expect(backups).toHaveLength(1)
      for (const [name, bytes] of originals)
        expect(readFileSync(join(backupRoot, backups[0]!, name))).toEqual(bytes)
      expect(
        JSON.parse(readFileSync(join(backupRoot, backups[0]!, 'backup.json'), 'utf8')),
      ).toMatchObject({ targetVersion: '0.9.0-beta.4', format: 9 })
    } finally {
      registry.closeAll()
    }
  })

  it('切换维度保留社交摘要、关键词和关系，并重建零向量', () => {
    const registry = fixture(768)
    try {
      const store = registry.getAgentStore('pero', 'social')
      store.insertWithId(1, Array(768).fill(0), {
        type: 'event',
        content: '一起研究蓝莓',
        timestamp: 10,
      })
      store.insertWithId(2, Array(768).fill(0), { type: 'feature', content: '蓝莓' })
      store.indexText(1, '一起研究蓝莓')
      store.indexKeyword(2, '蓝莓')
      store.link(2, 1, 'memory_edge', 0.8)
      expect(registry.listStoredAgentIds()).toContain('pero')
      registry.resetAllForDimension(1536)
      const rebuilt = registry.getAgentStore('pero', 'social')
      expect(rebuilt.dim()).toBe(1536)
      expect(rebuilt.nodeCount()).toBe(2)
      expect(rebuilt.get(1)?.payload).toMatchObject({ content: '一起研究蓝莓', timestamp: 10 })
      expect(rebuilt.get(1)?.vector).toHaveLength(1536)
      expect(rebuilt.getEdge(2, 1, 'memory_edge')?.weight).toBeCloseTo(0.8)
      expect(
        rebuilt.searchHybrid(Array(1536).fill(0), '蓝莓', 5, 1, 0, 0).map((hit) => hit.id),
      ).toContain(1)
    } finally {
      registry.closeAll()
    }
  })

  it('激活3072维保留1536维文件，显式重建后才替换实际维度', () => {
    const registry = fixture(1536)
    const source = registry.resolveAgentStorePath('pero', 'social')
    try {
      registry
        .getAgentStore('pero', 'social')
        .insertWithId(1, Array(1536).fill(0), { type: 'event', content: '需要保留的社交摘要' })
      registry.setDimension(3072)
      expect(registry.getDimension()).toBe(3072)
      expect(registry.describeStore(source)).toMatchObject({ dimension: 1536, nodeCount: 1 })
      expect(readFileSync(`${source}.dimension`, 'utf8')).toBe('1536')
      registry.rebuildSocialStore('pero')
      const rebuilt = registry.getAgentStore('pero', 'social')
      expect(rebuilt.dim()).toBe(3072)
      expect(rebuilt.get(1)?.vector).toHaveLength(3072)
      expect(rebuilt.get(1)?.payload).toMatchObject({ content: '需要保留的社交摘要' })
      expect(registry.describeStore(source)).toMatchObject({ dimension: 3072, nodeCount: 1 })
    } finally {
      registry.closeAll()
    }
  })

  it('新库构建失败时保留原有图谱', () => {
    const registry = fixture(4)
    try {
      registry
        .getAgentStore('pero', 'social')
        .insertWithId(1, [0, 0, 0, 0], { content: '保留的记忆' })
      expect(() =>
        registry.replaceAgentStore('pero', 'social', () => {
          throw new Error('模拟构建失败')
        }),
      ).toThrow(
        expect.objectContaining({
          diagnostic: expect.objectContaining({
            phase: 'build',
            causes: [expect.objectContaining({ message: '模拟构建失败' })],
          }),
        }),
      )
      expect(registry.getAgentStore('pero', 'social').get(1)?.payload).toEqual({
        content: '保留的记忆',
      })
      expect(() => registry.rebuildSocialStore('../outside')).toThrow('角色 ID 格式无效')
    } finally {
      registry.closeAll()
    }
  })

  it('启动配置已变更时仍能读取旧维度社交库并迁移', () => {
    const registry = fixture(768)
    registry
      .getAgentStore('pero', 'social')
      .insertWithId(1, Array(768).fill(0), { type: 'event', content: '旧摘要' })
    const target = registry.resolveAgentStorePath('pero', 'social')
    registry.closeAll()
    const resolver = {
      resolve: (alias: string) =>
        alias === '@data'
          ? join(target, '../..')
          : join(target, '../..', alias.slice('@data/'.length)),
    }
    const upgraded = new MemoryStoreRegistry(resolver as never, 1536)
    try {
      expect(upgraded.rebuildSocialStore('pero')).toBe(1)
      expect(upgraded.getAgentStore('pero', 'social').get(1)?.payload).toMatchObject({
        content: '旧摘要',
      })
    } finally {
      upgraded.closeAll()
    }
  })

  it('应使用配置的768维创建Store并接受768维向量', () => {
    const root = join(temporaryRoot, `infos-store-dimension-${Date.now()}-${Math.random()}`)
    roots.push(root)
    mkdirSync(root, { recursive: true })
    const resolver = {
      resolve(alias: string) {
        if (alias === '@data') return root
        if (alias.startsWith('@data/')) return join(root, alias.slice('@data/'.length))
        throw new Error(`未处理路径: ${alias}`)
      },
    }
    const registry = new MemoryStoreRegistry(resolver as never, 768)
    const store = registry.getAgentStore('pero')

    expect(() => store.insertWithId(1, new Array(768).fill(0), { content: '测试' })).not.toThrow()
    expect(registry.getDimension()).toBe(768)
    registry.closeAll()
  })

  it('应统计现有Agent与共享Store的真实节点总数且不创建缺失Store', () => {
    const root = join(temporaryRoot, `infos-store-stats-${Date.now()}-${Math.random()}`)
    roots.push(root)
    mkdirSync(root, { recursive: true })
    const resolver = {
      resolve(alias: string) {
        if (alias === '@data') return root
        if (alias.startsWith('@data/')) return join(root, alias.slice('@data/'.length))
        throw new Error(`未处理路径: ${alias}`)
      },
    }
    const registry = new MemoryStoreRegistry(resolver as never, 4)
    registry.getAgentStore('pero').insertWithId(1, [1, 0, 0, 0], { kind: 'event_note' })
    registry.getAgentStore('pero').insertWithId(2, [0, 1, 0, 0], { kind: 'event_entity' })
    registry.getSharedStore('facts').insertWithId(3, [0, 0, 1, 0], { kind: 'fact' })

    expect(registry.countExistingNodes(['pero', 'nana'])).toBe(3)
    expect(existsSync(registry.resolveAgentStorePath('nana', 'main'))).toBe(false)
    registry.closeAll()
  })

  it('重置 Store 时清理完整文件组与历代升级备份，保留相邻文件', () => {
    const root = join(temporaryRoot, `infos-store-reset-${Date.now()}-${Math.random()}`)
    roots.push(root)
    mkdirSync(root, { recursive: true })
    const resolver = {
      resolve(alias: string) {
        if (alias === '@data') return root
        if (alias.startsWith('@data/')) return join(root, alias.slice('@data/'.length))
        throw new Error(`未处理路径: ${alias}`)
      },
    }
    const registry = new MemoryStoreRegistry(resolver as never, 4)
    const storePath = registry.resolveAgentStorePath('pero', 'main')
    mkdirSync(join(root, 'agent_pero'), { recursive: true })
    const suffixes = [
      '',
      '.vec',
      '.wal',
      '.lock',
      '.flush_ok',
      '.quiver',
      '.quiver.meta',
      '.text',
      '.text.meta',
      '.dimension',
      '.pidx',
      '.gidx',
      '.manifest.json',
      '.pld.1792345678900',
      '.pld.1792345678901',
      '.pld.1792345678901.tmp',
      '.publish',
      '.publish.0',
      '.publish.1',
      '.publish.2',
      '.publish.3',
      '.publish.4',
      '.publish.5',
      '.publish.6',
      '.publish.7',
      '.publish.8',
      '.publish.8.tmp',
      '.publish.0.tmp',
    ]
    for (const suffix of suffixes) writeFileSync(`${storePath}${suffix}`, '测试')
    writeFileSync(`${storePath}.notes.md`, '用户文档')
    const social = registry.resolveAgentStorePath('pero', 'social')
    writeFileSync(`${social}.pld.123`, '其他库')
    const backup = upgradeBackupPath(root, storePath)
    mkdirSync(backup, { recursive: true })
    writeFileSync(join(backup, '旧正文'), '待删除')
    const oldBackup = join(root, '.store-upgrades', '0.8.9', 'agent_pero', 'memory.tdb')
    mkdirSync(oldBackup, { recursive: true })
    writeFileSync(join(oldBackup, '旧正文'), '升级前版本的备份')
    const oldSocialBackup = join(root, '.store-upgrades', '0.8.9', 'agent_pero', 'social.tdb')
    mkdirSync(oldSocialBackup, { recursive: true })
    writeFileSync(join(oldSocialBackup, '社交正文'), '其他库的备份')
    const recovery = join(root, 'agent_pero', `.index-${randomUUID()}`, '.previous')
    mkdirSync(recovery, { recursive: true })
    writeFileSync(join(recovery, 'memory.tdb.pld.456'), '重建失败留下的正文')
    writeFileSync(join(recovery, 'social.tdb.pld.456'), '其他库的恢复文件')
    const removedAgentBackup = join(root, '.store-upgrades', '0.8.9', 'agent_removed', 'memory.tdb')
    mkdirSync(removedAgentBackup, { recursive: true })
    expect(registry.listStoredAgentIds()).toContain('removed')

    registry.resetAgentStore('pero', 'main')

    for (const suffix of suffixes) expect(existsSync(`${storePath}${suffix}`)).toBe(false)
    expect(existsSync(backup)).toBe(false)
    expect(existsSync(oldBackup)).toBe(false)
    expect(readFileSync(join(oldSocialBackup, '社交正文'), 'utf8')).toBe('其他库的备份')
    expect(readFileSync(`${storePath}.notes.md`, 'utf8')).toBe('用户文档')
    expect(existsSync(`${social}.pld.123`)).toBe(true)
    expect(existsSync(join(recovery, 'memory.tdb.pld.456'))).toBe(false)
    expect(readFileSync(join(recovery, 'social.tdb.pld.456'), 'utf8')).toBe('其他库的恢复文件')
  })

  it('文本预热失败向上传播并保留脏标记，后续请求可以重试', () => {
    const registry = fixture(4)
    try {
      const store = registry.getAgentStore('pero', 'main')
      const path = registry.resolveAgentStorePath('pero', 'main')
      registry.markTextIndexDirty(path)
      const build = vi
        .spyOn(Object.getPrototypeOf(store), 'buildTextIndex')
        .mockImplementationOnce(() => {
          throw new Error('模拟文本索引损坏')
        })
      expect(() => registry.ensureTextIndexReady('pero', 'desktop')).toThrow('模拟文本索引损坏')
      expect(registry.ensureTextIndexReady('pero', 'desktop')).toBe(store)
      expect(build).toHaveBeenCalledTimes(2)
      registry.ensureTextIndexReady('pero', 'desktop')
      expect(build).toHaveBeenCalledTimes(2)
    } finally {
      registry.closeAll()
    }
  })

  it('社交索引初始化失败关闭句柄，重试不会遗留 Writer 锁', () => {
    const registry = fixture(4)
    const base = registry.getAgentStore('pero', 'main')
    const build = vi
      .spyOn(Object.getPrototypeOf(base), 'buildTextIndex')
      .mockImplementationOnce(() => {
        throw new Error('模拟社交文本预热失败')
      })
    try {
      expect(() => registry.getAgentStore('pero', 'social')).toThrow('模拟社交文本预热失败')
      build.mockRestore()
      expect(() => registry.getAgentStore('pero', 'social')).not.toThrow()
    } finally {
      build.mockRestore()
      registry.closeAll()
    }
  })

  it('正文替换、重开和删除后复用 ID 不会召回旧文本', () => {
    const registry = fixture(4)
    try {
      let store = registry.getAgentStore('pero', 'main')
      const search = (text: string) =>
        store.searchHybrid([0, 0, 0, 0], text, 10, 0, 0.01, 0).map((hit) => hit.id)
      store.insertWithId(1, [1, 0, 0, 0], { content: '旧版正文' })
      store.indexText(1, 'obsoletealpha')
      store.indexText(1, 'currentbeta')
      expect(search('obsoletealpha')).not.toContain(1)
      expect(search('currentbeta')).toContain(1)
      registry.closeAll()
      store = registry.getAgentStore('pero', 'main')
      expect(search('obsoletealpha')).not.toContain(1)
      expect(search('currentbeta')).toContain(1)
      store.delete(1)
      store.insertWithId(1, [0, 1, 0, 0], { content: '复用 ID 的正文' })
      expect(search('currentbeta')).not.toContain(1)
      store.indexText(1, 'reusedgamma')
      expect(search('reusedgamma')).toContain(1)
    } finally {
      registry.closeAll()
    }
  })

  it('同步快照复制已刷新 Payload 文件组、冷 Store 与 SQLite，并允许继续写入', () => {
    const registry = fixture(4)
    const source = registry.resolveAgentStorePath('pero', 'main')
    const root = join(source, '../..')
    const snapshot = `${root}-snapshot`
    roots.push(snapshot)
    const clone = new MemoryStoreRegistry(
      {
        resolve: (alias: string) =>
          alias === '@data' ? snapshot : join(snapshot, alias.slice('@data/'.length)),
      } as never,
      4,
    )
    try {
      registry
        .getAgentStore('pero', 'social')
        .insertWithId(2, [0, 0, 0, 0], { content: '社交主存' })
      registry.closeAll()
      const store = registry.getAgentStore('pero', 'main')
      store.insertWithId(1, [1, 0, 0, 0], { content: '快照正文' })
      registry.captureSnapshot(snapshot, () => {
        mkdirSync(snapshot, { recursive: true })
        writeFileSync(join(snapshot, 'infos.db'), 'SQLite 同步副本')
      })
      expect(clone.getAgentStore('pero', 'main').get(1)?.payload).toEqual({ content: '快照正文' })
      expect(clone.getAgentStore('pero', 'social').get(2)?.payload).toEqual({ content: '社交主存' })
      const clonedPath = clone.resolveAgentStorePath('pero', 'main')
      expect(triviumFiles(clonedPath).some((file) => /\.pld\.\d+$/.test(file))).toBe(true)
      expect(readFileSync(join(snapshot, 'infos.db'), 'utf8')).toBe('SQLite 同步副本')
      store.insertWithId(3, [0, 1, 0, 0], { content: '快照后的写入' })
      expect(clone.getAgentStore('pero', 'main').get(3)).toBeNull()
      expect(() => registry.captureSnapshot(join(root, 'nested'), () => {})).toThrow('独立暂存目录')
    } finally {
      clone.closeAll()
      registry.closeAll()
    }
  })

  it('维度重置不递归删除工作区内同名数据库，并清理受管新版旁路文件', () => {
    const registry = fixture(4)
    const source = registry.resolveAgentStorePath('pero', 'main')
    const root = join(source, '../..')
    const userDirectory = join(root, 'principals', 'pero', 'workspace', 'agent_pero')
    mkdirSync(userDirectory, { recursive: true })
    writeFileSync(join(userDirectory, 'memory.tdb.pld.123'), '用户自己的数据')
    mkdirSync(join(root, 'agent_pero'), { recursive: true })
    writeFileSync(`${source}.pld.123`, '孤立的旧正文')
    try {
      registry.resetAllForDimension(8)
      expect(existsSync(`${source}.pld.123`)).toBe(false)
      expect(readFileSync(join(userDirectory, 'memory.tdb.pld.123'), 'utf8')).toBe('用户自己的数据')
      expect(readdirSync(join(root, 'agent_pero'))).toEqual([])
    } finally {
      registry.closeAll()
    }
  })
})
