import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  backupLegacyStore,
  databaseFormat,
  isTriviumFile,
  managedStoreBase,
  upgradeBackupPath,
} from '@infos/backend/repositories/triviumFiles'

const temporaryRoot = fileURLToPath(new URL('../../../../../TEMP/', import.meta.url))
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('TriviumDB 文件组与升级副本', () => {
  it('精确识别动态 Payload、属性索引与 manifest，不匹配相似文件名', () => {
    for (const suffix of [
      '',
      '.vec',
      '.pld.123',
      '.pld.456.tmp',
      '.pidx',
      '.gidx',
      '.manifest.json',
      '.publish',
      '.publish.tmp',
      '.publish.0',
      '.publish.1',
      '.publish.2',
      '.publish.2.tmp',
    ])
      expect(isTriviumFile(`memory.tdb${suffix}`, 'memory.tdb')).toBe(true)
    for (const suffix of [
      '2',
      '.notes.md',
      '.pld.bad',
      '.pld.123.zip',
      '.pidx.backup',
      '.publish.3',
      '.publish.notes',
    ])
      expect(isTriviumFile(`memory.tdb${suffix}`, 'memory.tdb')).toBe(false)
    expect(managedStoreBase('agent_pero/memory.tdb.pld.123')).toBe('agent_pero/memory.tdb')
    expect(managedStoreBase('knowledge/facts.tdb.pidx')).toBe('knowledge/facts.tdb')
    expect(managedStoreBase('principals/pero/workspace/agent_pero/memory.tdb')).toBeNull()
  })

  it('完整复制旧文件组、按摘要复用并拒绝损坏的已有备份', () => {
    const root = path.join(temporaryRoot, `trivium-backup-${randomUUID()}`)
    roots.push(root)
    const source = path.join(root, 'agent_pero', 'memory.tdb')
    mkdirSync(path.dirname(source), { recursive: true })
    // 此用例只验证文件组复制；真实引擎共享锁由注册表负责。
    const header = Buffer.from([0x54, 0x56, 0x44, 0x42, 7, 0])
    writeFileSync(source, header)
    writeFileSync(`${source}.vec`, '向量制品')
    writeFileSync(`${source}.wal`, 'WAL 制品')
    writeFileSync(`${source}.lock`, '')
    writeFileSync(`${source}.vec.tmp`, '未提交制品')
    expect(databaseFormat(source)).toBe(7)
    expect(databaseFormat(`${source}-missing`)).toBeNull()
    const backup = backupLegacyStore(root, source, 7)
    expect(backup.startsWith(`${upgradeBackupPath(root, source)}${path.sep}`)).toBe(true)
    expect(readFileSync(path.join(backup, 'memory.tdb'))).toEqual(header)
    expect(readFileSync(path.join(backup, 'memory.tdb.vec'), 'utf8')).toBe('向量制品')
    expect(existsSync(path.join(backup, 'memory.tdb.vec.tmp'))).toBe(false)
    expect(JSON.parse(readFileSync(path.join(backup, 'backup.json'), 'utf8'))).toMatchObject({
      targetVersion: '0.8.11',
      format: 7,
      source: path.join('agent_pero', 'memory.tdb'),
    })
    expect(backupLegacyStore(root, source, 7)).toBe(backup)
    writeFileSync(path.join(backup, 'memory.tdb.vec'), '损坏')
    expect(() => backupLegacyStore(root, source, 7)).toThrow('备份校验失败')
    expect(readFileSync(source)).toEqual(header)
  })
})
