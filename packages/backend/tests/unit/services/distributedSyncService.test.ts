import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync, gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { DistributedSyncService, type FullSyncManifest } from '../../../src/services/distributed/distributedSyncService'

const roots: string[] = []
const temporaryRoot = fileURLToPath(new URL('../../../../../TEMP/', import.meta.url))

function root() {
  const value = path.join(temporaryRoot, `infos-distributed-${randomUUID()}`)
  roots.push(value)
  return value
}

function decryptPayload(bytes: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
  decipher.setAuthTag(bytes.subarray(12, 28))
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()])
}

function decryptBundle(bytes: Buffer, key: Buffer) {
  const payload = decryptPayload(bytes, key)
  if (!payload.subarray(0, 8).equals(Buffer.from('INFOSS3\n')))
    return JSON.parse(payload.toString()) as { manifest: FullSyncManifest; files: Record<string, string> }
  // 小样例独立按传输格式读取；大文件回归用例直接走生产端流式校验。
  const raw = gunzipSync(payload.subarray(8))
  const length = raw.readUInt32BE(0)
  const manifest = JSON.parse(raw.subarray(4, 4 + length).toString()) as FullSyncManifest
  let offset = 4 + length
  const files: Record<string, string> = {}
  for (const descriptor of manifest.files) {
    files[descriptor.path] = raw.subarray(offset, offset + descriptor.sizeBytes).toString('base64')
    offset += descriptor.sizeBytes
  }
  return { manifest, files }
}

function encryptPayload(value: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const bytes = Buffer.concat([cipher.update(value), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), bytes])
}

function encryptBundle(value: unknown, key: Buffer): Buffer {
  return encryptPayload(Buffer.from(JSON.stringify(value)), key)
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
    await writeFile(path.join(dataDir, 'client-language.txt'), 'zh-CN')
    await writeFile(path.join(dataDir, 'principals', 'pero', 'workspace', 'client-language.txt'), '用户的语言资料')
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
    expect(paths).toContain('principals/pero/workspace/client-language.txt')
    expect(paths).not.toContain('client-language.txt')
    expect(paths).not.toContain('gateway_token.json')
    expect(paths).not.toContain('kernel/nodes.json')
    expect(paths).not.toContain('logs/runtime.log')
    expect(paths.some((file) => file.startsWith('.store-upgrades/'))).toBe(false)
    expect(bundle.manifest).toMatchObject({
      bundleVersion: 3,
      triviumVersion: '0.9.0',
      triviumFormat: 10,
    })
  })

  it('大于旧 Base64 字符串上限的单个文件可以完整导出并暂存', async () => {
    const dataDir = path.join(root(), 'source')
    await mkdir(path.join(dataDir, 'assets'), { recursive: true })
    const file = await open(path.join(dataDir, 'assets', 'large.bin'), 'wx')
    // 384 MiB 加一字节转成 Base64 后超过 Node 原先的 0x1fffffe8 字符上限。
    const size = 384 * 1024 * 1024 + 1
    try {
      await file.truncate(size)
      await file.write(Buffer.from('文件头'), 0, Buffer.byteLength('文件头'), 0)
      await file.write(Buffer.from('文件尾'), 0, Buffer.byteLength('文件尾'), size - Buffer.byteLength('文件尾'))
    } finally {
      await file.close()
    }
    const source = new DistributedSyncService(
      dataDir,
      { $client: { backup: async (target: string) => writeFile(target, 'sqlite-snapshot') } } as never,
      'server-large',
    )
    const key = randomBytes(32)
    const encrypted = await source.createEncryptedSnapshot(key.toString('base64'))
    const target = new DistributedSyncService(path.join(root(), 'target'), {} as never, 'server-target')
    const manifest = await target.stageEncryptedSnapshot(encrypted, key.toString('base64'), 'server-large')
    expect(manifest.files.find((descriptor) => descriptor.path === 'assets/large.bin')?.sizeBytes).toBe(size)
    expect(manifest.totalBytes).toBe(size + Buffer.byteLength('sqlite-snapshot'))
    expect(await target.pending()).toEqual({ snapshotId: manifest.snapshotId, sourceServerId: 'server-large' })
  }, 60_000)

  it.each(['checksum', 'truncated', 'trailing'])('拒绝不完整或被篡改的二进制快照：%s', async (damage) => {
    const dataDir = path.join(root(), 'source')
    await mkdir(dataDir, { recursive: true })
    const source = new DistributedSyncService(
      dataDir,
      { $client: { backup: async (target: string) => writeFile(target, 'sqlite-snapshot') } } as never,
      'server-source',
    )
    const key = randomBytes(32)
    const payload = decryptPayload(await source.createEncryptedSnapshot(key.toString('base64')), key)
    let raw: Buffer = gunzipSync(payload.subarray(8))
    if (damage === 'checksum') raw[raw.length - 1] = raw[raw.length - 1]! ^ 1
    if (damage === 'truncated') raw = raw.subarray(0, raw.length - 1)
    if (damage === 'trailing') raw = Buffer.concat([raw, Buffer.from('额外正文')])
    const target = new DistributedSyncService(path.join(root(), 'target'), {} as never, 'server-target')
    const encrypted = encryptPayload(Buffer.concat([Buffer.from('INFOSS3\n'), gzipSync(raw)]), key)
    await expect(target.stageEncryptedSnapshot(encrypted, key.toString('base64'))).rejects.toThrow(
      damage === 'checksum' ? 'SYNC_FILE_CHECKSUM_MISMATCH' :
        damage === 'truncated' ? 'SYNC_BUNDLE_INCOMPLETE' : 'SYNC_BUNDLE_TRAILING_DATA',
    )
    expect(await target.pending()).toBeNull()
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

  it('取消异步捕获后清理暂存区，释放导出占用并允许下次重试', async () => {
    const dataDir = path.join(root(), 'data')
    const controller = new AbortController()
    let capturedSignal: AbortSignal | undefined
    const capture = vi.fn(async (destination: string, signal?: AbortSignal) => {
      capturedSignal = signal
      await writeFile(path.join(destination, 'infos.db'), '部分捕获内容')
      controller.abort(new Error('用户取消'))
      signal?.throwIfAborted()
    })
    const service = new DistributedSyncService(dataDir, {} as never, 'server-a', undefined, capture)
    const key = randomBytes(32).toString('base64')
    await expect(service.createEncryptedSnapshot(key, controller.signal)).rejects.toThrow('用户取消')
    expect(capturedSignal).toBe(controller.signal)
    expect(await readdir(path.join(dataDir, '.backup-state/work'))).toEqual([])
    capture.mockImplementation(async (destination) => {
      await writeFile(path.join(destination, 'infos.db'), '完整重试内容')
    })
    await expect(service.createEncryptedSnapshot(key)).resolves.toBeInstanceOf(Buffer)
    expect(await readdir(path.join(dataDir, '.backup-state/work'))).toEqual([])
  })

  it('已有导出进行时拒绝重叠请求，保留原导出的完整内容', async () => {
    const dataDir = path.join(root(), 'data')
    let enter!: () => void
    let release!: () => void
    const entered = new Promise<void>((resolve) => { enter = resolve })
    const released = new Promise<void>((resolve) => { release = resolve })
    const capture = async (destination: string) => {
      enter()
      await released
      await writeFile(path.join(destination, 'infos.db'), '原导出的数据库')
    }
    const service = new DistributedSyncService(dataDir, {} as never, 'server-a', undefined, capture)
    const key = randomBytes(32)
    const exporting = service.createEncryptedSnapshot(key.toString('base64'))
    try {
      await entered
      await expect(service.createEncryptedSnapshot(key.toString('base64'))).rejects.toMatchObject({
        code: 'RESOURCE_BUSY',
      })
    } finally {
      release()
      const bundle = decryptBundle(await exporting, key)
      expect(Buffer.from(bundle.files['infos.db']!, 'base64').toString()).toBe('原导出的数据库')
    }
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

  it.each(['binary', 'legacy-v1', 'legacy-v2'])('应在重启边界原子应用并保留当前机器身份：%s', async (format) => {
    const base = root()
    const sourceDir = path.join(base, 'source')
    const targetDir = path.join(base, 'target')
    await mkdir(path.join(sourceDir, 'skills'), { recursive: true })
    await writeFile(path.join(sourceDir, 'skills', 'source.md'), '来源数据')
    const binary = Buffer.alloc(600 * 1024).fill(Buffer.from([0, 255, 194]))
    await writeFile(path.join(sourceDir, 'binary.dat'), binary)
    await writeFile(path.join(sourceDir, 'empty.dat'), Buffer.alloc(0))
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
    let encrypted = await source.createEncryptedSnapshot(key.toString('base64'))
    const bundle = decryptBundle(encrypted, key)
    if (format !== 'binary') {
      const language = Buffer.from('en-US')
      bundle.files['client-language.txt'] = language.toString('base64')
      bundle.manifest.files.push({ path: 'client-language.txt', sizeBytes: language.length,
        sha256: createHash('sha256').update(language).digest('hex') })
      bundle.manifest.totalBytes += language.length
      bundle.manifest.bundleVersion = format === 'legacy-v1' ? 1 : 2
      encrypted = encryptBundle(bundle, key)
    }

    await mkdir(path.join(targetDir, 'distributed'), { recursive: true })
    await mkdir(path.join(targetDir, 'kernel'), { recursive: true })
    await writeFile(path.join(targetDir, 'gateway_token.json'), 'target-token')
    await writeFile(path.join(targetDir, 'client-language.txt'), 'zh-CN')
    await writeFile(path.join(targetDir, 'kernel', 'nodes.json'), 'target-node')
    await writeFile(
      path.join(targetDir, 'distributed', 'server-credentials.key'),
      key.toString('base64'),
    )
    const target = new DistributedSyncService(
      targetDir,
      { $client: { backup } } as never,
      'server-target',
    )
    if (format === 'binary') {
      await target.stageEncryptedSnapshot(encrypted, key.toString('base64'), 'server-source')
    } else {
      const syncRoot = path.join(base, '.infos-sync')
      await mkdir(syncRoot, { recursive: true })
      await writeFile(path.join(syncRoot, 'pending.bundle'), encrypted)
      await writeFile(
        path.join(syncRoot, 'pending.json'),
        JSON.stringify({ snapshotId: bundle.manifest.snapshotId, sourceServerId: 'server-source' }),
      )
    }

    await expect(DistributedSyncService.applyPending(targetDir)).resolves.toBe(true)
    await expect(readFile(path.join(targetDir, 'skills', 'source.md'), 'utf8')).resolves.toBe(
      '来源数据',
    )
    await expect(readFile(path.join(targetDir, 'binary.dat'))).resolves.toEqual(binary)
    await expect(readFile(path.join(targetDir, 'empty.dat'))).resolves.toHaveLength(0)
    await expect(readFile(path.join(targetDir, 'client-language.txt'), 'utf8')).resolves.toBe('zh-CN')
    await expect(readFile(path.join(targetDir, 'gateway_token.json'), 'utf8')).resolves.toBe(
      'target-token',
    )
    await expect(readFile(path.join(targetDir, 'kernel', 'nodes.json'), 'utf8')).resolves.toBe(
      'target-node',
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
