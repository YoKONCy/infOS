import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { DistributedSyncService } from '../../../src/services/distributed/distributedSyncService'

const roots: string[] = []
const temporaryRoot = fileURLToPath(new URL('../../../../../TEMP/', import.meta.url))

function root() {
  const value = path.join(temporaryRoot, `infos-distributed-${randomUUID()}`)
  roots.push(value)
  return value
}

function decryptBundle(bytes: Buffer, key: Buffer) {
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
  decipher.setAuthTag(bytes.subarray(12, 28))
  return JSON.parse(
    Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString(),
  ) as {
    manifest: {
      snapshotId: string
      sourceServerId: string
      bundleVersion: number
      triviumVersion: string
      triviumFormat: number
      files: Array<{ path: string }>
    }
    files: Record<string, string>
  }
}

function encryptBundle(value: unknown, key: Buffer): Buffer {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const bytes = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(value))), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), bytes])
}

afterEach(async () => {
  for (const value of roots.splice(0)) await rm(value, { recursive: true, force: true })
})

describe('DistributedSyncService 完整快照', () => {
  it('应同步全部用户数据并排除机器身份和运行时瞬态', async () => {
    const dataDir = path.join(root(), 'data')
    await mkdir(path.join(dataDir, 'principals', 'pero', 'workspace'), { recursive: true })
    await mkdir(path.join(dataDir, 'skills', 'demo'), { recursive: true })
    await mkdir(path.join(dataDir, 'logs'), { recursive: true })
    await mkdir(path.join(dataDir, 'kernel'), { recursive: true })
    await mkdir(path.join(dataDir, '.store-upgrades', '0.8.9'), { recursive: true })
    await writeFile(path.join(dataDir, '.store-upgrades', '0.8.9', '旧正文'), '不得同步')
    await writeFile(path.join(dataDir, 'principals', 'pero', 'workspace', 'note.md'), '工作区')
    await writeFile(path.join(dataDir, 'skills', 'demo', 'skill.md'), '技能')
    await writeFile(path.join(dataDir, 'config.json'), '{"apiKey":"secret"}')
    await writeFile(path.join(dataDir, 'gateway_token.json'), 'machine-token')
    await writeFile(path.join(dataDir, 'kernel', 'nodes.json'), 'machine-node')
    await writeFile(path.join(dataDir, 'logs', 'runtime.log'), 'log')
    const backup = vi.fn(async (target: string) => writeFile(target, 'sqlite-snapshot'))
    const service = new DistributedSyncService(
      dataDir,
      { $client: { backup } } as never,
      'server-a',
    )
    const key = randomBytes(32)

    const bundle = decryptBundle(await service.createEncryptedSnapshot(key.toString('base64')), key)
    const paths = bundle.manifest.files.map((item) => item.path)

    expect(paths).toContain('infos.db')
    expect(paths).toContain('config.json')
    expect(paths).toContain('skills/demo/skill.md')
    expect(paths).toContain('principals/pero/workspace/note.md')
    expect(paths).not.toContain('gateway_token.json')
    expect(paths).not.toContain('kernel/nodes.json')
    expect(paths).not.toContain('logs/runtime.log')
    expect(paths.some((file) => file.startsWith('.store-upgrades/'))).toBe(false)
    expect(bundle.manifest).toMatchObject({
      bundleVersion: 2,
      triviumVersion: '0.9.0-beta.4',
      triviumFormat: 10,
    })
  })

  it('仅打包协调器冻结的数据库文件组，不能混入之后变化的旁路文件', async () => {
    const dataDir = path.join(root(), 'data')
    await mkdir(path.join(dataDir, 'agent_pero'), { recursive: true })
    await writeFile(path.join(dataDir, 'agent_pero', 'memory.tdb'), '正在变化的主库')
    await writeFile(path.join(dataDir, 'agent_pero', 'memory.tdb.pld.999'), '正在变化的正文')
    const run = vi.fn((target: string) => writeFileSync(target, 'SQLite 冻结副本'))
    const prepare = vi.fn(() => ({ run }))
    const captureSnapshot = vi.fn((destination: string, sqlite: () => void) => {
      sqlite()
      mkdirSync(path.join(destination, 'agent_pero'), { recursive: true })
      writeFileSync(path.join(destination, 'agent_pero', 'memory.tdb'), '冻结主库')
      writeFileSync(path.join(destination, 'agent_pero', 'memory.tdb.pld.123'), '冻结正文')
    })
    const service = new DistributedSyncService(
      dataDir,
      { $client: { prepare } } as never,
      'server-a',
      { captureSnapshot },
    )
    const key = randomBytes(32)
    const bundle = decryptBundle(await service.createEncryptedSnapshot(key.toString('base64')), key)
    expect(prepare).toHaveBeenCalledWith('VACUUM INTO ?')
    expect(captureSnapshot).toHaveBeenCalledOnce()
    expect(Buffer.from(bundle.files['agent_pero/memory.tdb.pld.123']!, 'base64').toString()).toBe(
      '冻结正文',
    )
    expect(bundle.files['agent_pero/memory.tdb.pld.999']).toBeUndefined()
    expect(Buffer.from(bundle.files['infos.db']!, 'base64').toString()).toBe('SQLite 冻结副本')
  })

  it('缺少协调器时拒绝导出受管数据库，避免复制不一致 generation', async () => {
    const dataDir = path.join(root(), 'data')
    await mkdir(path.join(dataDir, 'agent_pero'), { recursive: true })
    await writeFile(path.join(dataDir, 'agent_pero', 'memory.tdb'), '数据库')
    const backup = vi.fn(async (target: string) => writeFile(target, 'sqlite'))
    const service = new DistributedSyncService(
      dataDir,
      { $client: { backup } } as never,
      'server-a',
    )
    await expect(
      service.createEncryptedSnapshot(randomBytes(32).toString('base64')),
    ).rejects.toThrow('Store 快照协调器')
  })

  it('接收 v9、v10 和旧版快照，但拒绝未来的 v11 数据库格式', async () => {
    const base = root()
    const dataDir = path.join(base, 'data')
    const service = new DistributedSyncService(dataDir, {} as never, 'server-target')
    const key = randomBytes(32)
    const manifest = {
      bundleVersion: 2,
      schemaVersion: 1,
      snapshotId: randomUUID(),
      sourceServerId: 'server-source',
      appVersion: 'test',
      triviumFormat: 11,
      createdAt: new Date().toISOString(),
      files: [],
      totalBytes: 0,
    }
    await expect(
      service.stageEncryptedSnapshot(
        encryptBundle({ manifest, files: {} }, key),
        key.toString('base64'),
        'server-source',
      ),
    ).rejects.toThrow('请先升级应用')
    for (const triviumFormat of [9, 10]) {
      const compatibleService = new DistributedSyncService(
        path.join(root(), 'data'),
        {} as never,
        'server-target',
      )
      await expect(
        compatibleService.stageEncryptedSnapshot(
          encryptBundle(
            {
              manifest: { ...manifest, snapshotId: randomUUID(), triviumFormat },
              files: {},
            },
            key,
          ),
          key.toString('base64'),
          'server-source',
        ),
      ).resolves.toMatchObject({ bundleVersion: 2, triviumFormat })
    }
    await expect(
      service.stageEncryptedSnapshot(
        encryptBundle(
          {
            manifest: { ...manifest, bundleVersion: 1, triviumFormat: undefined },
            files: {},
          },
          key,
        ),
        key.toString('base64'),
        'server-source',
      ),
    ).resolves.toMatchObject({ bundleVersion: 1 })
  })

  it('应在重启边界原子应用并保留当前机器身份', async () => {
    const base = root()
    const sourceDir = path.join(base, 'source')
    const targetDir = path.join(base, 'target')
    await mkdir(path.join(sourceDir, 'skills'), { recursive: true })
    await writeFile(path.join(sourceDir, 'skills', 'source.md'), '来源数据')
    const backup = vi.fn(async (target: string) => {
      const database = new Database(target)
      try {
        database.exec(
          "CREATE TABLE snapshot_data(value TEXT); INSERT INTO snapshot_data VALUES ('来源数据库')",
        )
      } finally {
        database.close()
      }
    })
    const source = new DistributedSyncService(
      sourceDir,
      { $client: { backup } } as never,
      'server-source',
    )
    const key = randomBytes(32)
    const encrypted = await source.createEncryptedSnapshot(key.toString('base64'))
    const bundle = decryptBundle(encrypted, key)

    await mkdir(path.join(targetDir, 'distributed'), { recursive: true })
    await mkdir(path.join(targetDir, 'kernel'), { recursive: true })
    await writeFile(path.join(targetDir, 'gateway_token.json'), 'target-token')
    await writeFile(path.join(targetDir, 'kernel', 'nodes.json'), 'target-node')
    await writeFile(
      path.join(targetDir, 'distributed', 'server-credentials.key'),
      key.toString('base64'),
    )
    const syncRoot = path.join(base, '.infos-sync')
    await mkdir(syncRoot, { recursive: true })
    await writeFile(path.join(syncRoot, 'pending.bundle'), encrypted)
    await writeFile(
      path.join(syncRoot, 'pending.json'),
      JSON.stringify({ snapshotId: bundle.manifest.snapshotId, sourceServerId: 'server-source' }),
    )

    await expect(DistributedSyncService.applyPending(targetDir)).resolves.toBe(true)
    await expect(readFile(path.join(targetDir, 'skills', 'source.md'), 'utf8')).resolves.toBe(
      '来源数据',
    )
    await expect(readFile(path.join(targetDir, 'gateway_token.json'), 'utf8')).resolves.toBe(
      'target-token',
    )
    await expect(readFile(path.join(targetDir, 'kernel', 'nodes.json'), 'utf8')).resolves.toBe(
      'target-node',
    )

    const target = new DistributedSyncService(
      targetDir,
      { $client: { backup } } as never,
      'server-target',
    )
    await writeFile(path.join(targetDir, 'skills', 'source.md'), '同步后修改')
    await expect(target.stageRollback()).resolves.toBe(true)
    await expect(DistributedSyncService.applyPending(targetDir)).resolves.toBe(true)
    await expect(readFile(path.join(targetDir, 'gateway_token.json'), 'utf8')).resolves.toBe(
      'target-token',
    )
    await expect(readFile(path.join(targetDir, 'skills', 'source.md'), 'utf8')).rejects.toThrow()
  })
})
