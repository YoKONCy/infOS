import Database from 'better-sqlite3'
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { closeDrizzleConnection, createDrizzleConnection } from '@infos/backend/database'
import { MemoryStoreRegistry } from '@infos/backend/repositories/storeRegistry'
import type { PathResolver } from '@infos/backend/core/pathResolver'
import { removeObsoleteRetrievalState } from '@infos/backend/services/maintenance/obsoleteRetrievalState'

const temporaryPaths: string[] = []

function resolver(root: string): PathResolver {
  return {
    resolve: (alias: string) => join(root, alias.replace(/^@data\/?/, '')),
  } as PathResolver
}

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('旧长记忆链路清理', () => {
  it('退役检索状态按受管路径清理，工作区同名文件与目录链接按原归属保存', () => {
    const root = join(process.env.PERO_DATA_DIR!, `obsolete-retrieval-${Date.now()}`)
    temporaryPaths.push(root)
    const data = join(root, 'data')
    const retired = ['agent_pero/rnn_desktop.bin', 'agent_nana/rnn_group.bin',
      'shared/rnn_proj.bin', 'shared/rnn_output.bin', 'shared/rnn_mingru.bin']
    const retained = ['agent_pero/memory.tdb', 'agent_pero/workspace/rnn_desktop.bin',
      'shared/rnn_custom.bin', 'principals/pero/workspace/rnn_mingru.bin', 'outside/rnn_desktop.bin']
    for (const relative of [...retired, ...retained]) {
      const file = join(data, relative)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, relative)
    }
    symlinkSync(join(data, 'outside'), join(data, 'agent_link'), 'junction')
    removeObsoleteRetrievalState(data)
    for (const relative of retired) expect(existsSync(join(data, relative))).toBe(false)
    for (const relative of retained) expect(existsSync(join(data, relative))).toBe(true)
  })

  it('既有 SQLite 连接时应物理删除全部旧记忆表', () => {
    const root = join(tmpdir(), `infos-legacy-db-${Date.now()}-${Math.random()}`)
    temporaryPaths.push(root)
    mkdirSync(root, { recursive: true })
    const databasePath = join(root, 'infos.db')

    const initialized = createDrizzleConnection(databasePath)
    closeDrizzleConnection(initialized)

    const sqlite = new Database(databasePath)
    sqlite.exec(`
      CREATE TABLE memory_nodes (id INTEGER PRIMARY KEY);
      CREATE TABLE canonical_memories (id TEXT PRIMARY KEY);
      CREATE TABLE memory_candidates (id TEXT PRIMARY KEY);
      CREATE TABLE entity_cooccurrences (id INTEGER PRIMARY KEY);
      CREATE TABLE maintenance_records (id INTEGER PRIMARY KEY);
      CREATE TABLE trivium_sync_tasks (id INTEGER PRIMARY KEY);
    `)
    sqlite.close()

    const db = createDrizzleConnection(databasePath)
    try {
      const client = (db as unknown as { $client: Database.Database }).$client
      const oldTables = client
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('memory_nodes','canonical_memories','memory_candidates','entity_cooccurrences','maintenance_records','trivium_sync_tasks')",
        )
        .all()

      expect(oldTables).toEqual([])
    } finally {
      closeDrizzleConnection(db)
    }
  })

  it('升级清理应删除旧 main/diary TDB 及旁路文件并保留新版库', () => {
    const root = join(tmpdir(), `infos-legacy-tdb-${Date.now()}-${Math.random()}`)
    temporaryPaths.push(root)
    const agentRoot = resolver(root).resolve('@data/agent_pero')
    mkdirSync(agentRoot, { recursive: true })
    for (const file of ['main.tdb', 'main.tdb.wal', 'diary.tdb', 'diary.tdb.text', 'memory.tdb']) {
      writeFileSync(join(agentRoot, file), file)
    }

    new MemoryStoreRegistry(resolver(root), 8).removeLegacyStores()

    expect(existsSync(join(agentRoot, 'memory.tdb'))).toBe(true)
    for (const file of ['main.tdb', 'main.tdb.wal', 'diary.tdb', 'diary.tdb.text']) {
      expect(existsSync(join(agentRoot, file))).toBe(false)
    }
  })
})
