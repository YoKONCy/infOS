import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { Hono } from 'hono'
import { randomUUID, createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createDrizzleConnection, closeDrizzleConnection } from '@infos/backend/database'
import { MemoryStoreRegistry } from '@infos/backend/repositories/storeRegistry'
import {
  readBackupArchive,
  readBackupRows,
  writeBackupArchive,
} from '@infos/backend/services/backup/backupArchive'
import {
  BACKUP_STATE,
  atomicBackupJson,
  recoverBackupRestore,
  snapshotOfflineTree,
} from '@infos/backend/services/backup/backupStorage'
import { mergeBackupRecords, redactBackupRow } from '@infos/backend/services/backup/backupRecords'
import { BackupService } from '@infos/backend/services/backup/backupService'
import { createBackupRouter, isBackupDownloadRequest } from '@infos/backend/routers/backup.router'
import { createAuthMiddleware } from '@infos/backend/middleware/auth'
import type { BackupManifest, BackupRow } from '@infos/shared'

const directories: string[] = []
function directory() {
  const root = mkdtempSync(path.join(process.env.INFOS_TEST_TEMP_ROOT ?? tmpdir(), 'infos-backup-'))
  directories.push(root)
  return root
}
afterEach(() => {
  for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function withImportFixture(
  action: (input: {
    service: BackupService
    router: ReturnType<typeof createBackupRouter>
    archive: string
    live: Database.Database
    backupId: string
  }) => Promise<void>,
) {
  const root = directory(),
    source = path.join(root, 'source')
  mkdirSync(source)
  const snapshot = new Database(path.join(source, 'infos.db'))
  snapshot.exec("CREATE TABLE example(value TEXT); INSERT INTO example VALUES('备份内容')")
  snapshot.close()
  const bytes = readFileSync(path.join(source, 'infos.db'))
  const manifest: BackupManifest = {
    format: 'infos.backup',
    version: 1,
    id: randomUUID(),
    appVersion: '0.9.7',
    sourceServerId: 'source',
    createdAt: '2026-10-27T00:00:00Z',
    selection: {
      level: 'full',
      modules: ['settings'],
      agentIds: [],
      threadIds: [],
      documentIds: [],
      factIds: [],
      taskIds: [],
      includeSecrets: false,
    },
    tables: {},
    files: [
      {
        path: 'infos.db',
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    ],
    warnings: [],
  }
  const archive = path.join(root, 'backup.infos-backup')
  async function* records(): AsyncGenerator<{ table: string; row: BackupRow }> {
    // 完整包保留 SQLite 文件，不重复输出逻辑记录。
    yield* []
  }
  await writeBackupArchive(archive, manifest, source, records())
  const live = new Database(path.join(root, 'infos.db'))
  live.exec("CREATE TABLE example(value TEXT); INSERT INTO example VALUES('原有内容')")
  const service = new BackupService({
    dataDir: root,
    db: { $client: live },
    stores: {},
    agents: {},
    sourceServerId: 'target',
    assertIdle() {},
  } as never)
  try {
    await service.initialize()
    await action({
      service,
      router: createBackupRouter(service),
      archive,
      live,
      backupId: manifest.id,
    })
  } finally {
    await service.imports.shutdown()
    live.close()
  }
}

describe('数据备份与恢复的关键路径', () => {
  it('下载票据必须经过鉴权签发，文件只允许下载一次', async () => {
    const root = directory(),
      file = path.join(root, 'download.infos-backup')
    const bytes = Buffer.from('需要保护的备份正文')
    writeFileSync(file, bytes)
    // 文件服务是边界替身；实际路由、鉴权、票据消费和响应流参与验证。
    const service = {
      download: async () => ({ path: file, cleanup: async () => {} }),
    } as unknown as BackupService
    const app = new Hono(),
      auth = createAuthMiddleware({ token: 'permanent-device-secret' })
    app.use('*', (c, next) =>
      isBackupDownloadRequest(c.req.method, c.req.path) ? next() : auth(c, next),
    )
    app.route('/api/backups', createBackupRouter(service))
    const request = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: '' }),
    }
    expect((await app.request('/api/backups/example/download', request)).status).toBe(401)
    const issued = await app.request('/api/backups/example/download', {
      ...request,
      headers: { ...request.headers, Authorization: 'Bearer permanent-device-secret' },
    })
    expect(issued.status).toBe(200)
    const result = (await issued.json()) as { data: { url: string } }
    expect(result.data.url).toMatch(/^\/api\/backups\/downloads\/[a-f0-9]{64}$/)
    const download = await app.request(result.data.url)
    expect(download.status).toBe(200)
    expect(Buffer.from(await download.arrayBuffer())).toEqual(bytes)
    expect((await app.request(result.data.url)).status).toBe(404)
  })

  it('待导入预览丢失时保留原数据库并撤销失败计划，允许继续启动', async () => {
    const root = directory(),
      databaseFile = path.join(root, 'infos.db')
    const db = new Database(databaseFile)
    try {
      db.exec("CREATE TABLE preserved(value TEXT); INSERT INTO preserved VALUES('原有会话')")
    } finally {
      db.close()
    }
    const state = path.join(root, BACKUP_STATE)
    await atomicBackupJson(path.join(state, 'pending.json'), {
      ticket: randomUUID(),
      backupId: randomUUID(),
      policy: { conflict: 'replace', agentTargets: {} },
    })
    await BackupService.applyPending(root)
    const restored = new Database(databaseFile, { readonly: true })
    try {
      expect(restored.prepare('SELECT value FROM preserved').pluck().get()).toBe('原有会话')
    } finally {
      restored.close()
    }
    expect(existsSync(path.join(state, 'pending.json'))).toBe(false)
    expect(JSON.parse(readFileSync(path.join(state, 'last-import.json'), 'utf8')).status).toBe(
      'failed',
    )
  })

  it('加密包能完整读回跨分块附件与逻辑记录', async () => {
    const root = directory(),
      source = path.join(root, 'source'),
      restored = path.join(root, 'restored')
    mkdirSync(source)
    // 超过一个 256 KiB 分块，验证文件拼接，而非只验证文件头。
    const bytes = Buffer.concat([Buffer.alloc(300 * 1024, 0xab), Buffer.from('附件中文结尾')])
    writeFileSync(path.join(source, 'attachment.bin'), bytes)
    const manifest: BackupManifest = {
      format: 'infos.backup',
      version: 1,
      id: randomUUID(),
      appVersion: '0.9.6',
      sourceServerId: 'source',
      createdAt: '2026-10-25T00:00:00Z',
      selection: {
        level: 'content',
        modules: ['conversations'],
        agentIds: [],
        threadIds: [],
        documentIds: [],
        factIds: [],
        taskIds: [],
        includeSecrets: false,
      },
      tables: { configs: 1 },
      files: [
        {
          path: 'attachment.bin',
          size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      ],
      warnings: [],
    }
    async function* records() {
      yield { table: 'configs', row: { key: 'user.name', value: '佩诺菈' } }
    }
    const archive = path.join(root, 'backup.infos-backup')
    await writeBackupArchive(archive, manifest, source, records(), '备份口令-eight')
    await readBackupArchive(archive, restored, '备份口令-eight')
    expect(readFileSync(path.join(restored, 'files', 'attachment.bin'))).toEqual(bytes)
    const rows: BackupRow[] = []
    for await (const row of readBackupRows(restored, 'configs')) rows.push(row)
    expect(rows).toEqual([{ key: 'user.name', value: '佩诺菈' }])
    await expect(
      readBackupArchive(archive, path.join(root, 'wrong-password'), '错误口令'),
    ).rejects.toThrow()
    const controller = new AbortController()
    await expect(
      readBackupArchive(archive, path.join(root, 'cancelled'), '备份口令-eight', {
        signal: controller.signal,
        progress: ({ unpackedBytes }) => {
          if (unpackedBytes > 0) controller.abort()
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('上传响应先返回操作编号，后台校验完成后恢复预览，期间不改业务数据', async () => {
    await withImportFixture(async ({ service, router, archive, live, backupId }) => {
      const state = service.imports.begin(statSync(archive).size, '')
      const response = await router.request(`/imports/${state.id}/content`, {
        method: 'PUT',
        body: new Blob([new Uint8Array(readFileSync(archive))]),
      })
      expect(response.status).toBe(202)
      expect((await response.json()).data.phase).toBe('extracting')
      await vi.waitFor(() => expect(service.imports.get(state.id).phase).toBe('ready'), {
        timeout: 10_000,
      })
      const status = await router.request(`/imports/${state.id}`)
      expect((await status.json()).data.preview.manifest.id).toBe(backupId)
      expect(live.prepare('SELECT value FROM example').get()).toEqual({ value: '原有内容' })
    })
  })

  it('未开始上传的预约可取消，取消后释放唯一导入名额', async () => {
    await withImportFixture(async ({ service }) => {
      const cancelled = service.imports.begin(10, '')
      expect(() => service.imports.begin(10, '')).toThrow('BACKUP_BUSY')
      expect(service.imports.cancel(cancelled.id).phase).toBe('cancelled')
      expect(service.imports.active).toBe(false)
    })
  })

  it('分片中断回退到已确认位置，重试和丢失响应不重复写入备份', async () => {
    await withImportFixture(async ({ service, router, archive, backupId, live }) => {
      const bytes = readFileSync(archive)
      const state = service.imports.begin(bytes.length, '')
      expect(state.uploadChunkBytes).toBe(1024 ** 2)
      const split = 128
      const send = (start: number, end: number) =>
        router.request(`/imports/${state.id}/content`, {
          method: 'PUT',
          headers: { 'Content-Range': `bytes ${start}-${end - 1}/${bytes.length}` },
          body: new Blob([new Uint8Array(bytes.subarray(start, end))]),
        })
      expect((await send(0, split)).status).toBe(202)
      // 丢失首片响应后重发同一片，不能追加第二份内容。
      expect((await send(0, split)).status).toBe(202)
      const upload = path.join(service.root, 'work', `${state.id}.upload`)
      expect(readFileSync(upload)).toEqual(bytes.subarray(0, split))
      let reads = 0
      const interrupted = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (reads++ === 0) controller.enqueue(new Uint8Array(bytes.subarray(split, split + 16)))
          else controller.error(new Error('模拟代理中断上传'))
        },
      })
      await expect(
        service.imports.receive(state.id, interrupted, {
          offset: split,
          length: bytes.length - split,
          total: bytes.length,
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
      expect(service.imports.get(state.id)).toMatchObject({
        phase: 'uploading',
        receivedBytes: split,
      })
      expect(readFileSync(upload)).toEqual(bytes.subarray(0, split))
      expect((await send(split, bytes.length)).status).toBe(202)
      // 最终片的确认响应同样允许丢失；预览和原始业务数据不受重复请求影响。
      expect((await send(split, bytes.length)).status).toBe(202)
      await vi.waitFor(() => expect(service.imports.get(state.id).phase).toBe('ready'), {
        timeout: 10_000,
      })
      expect(service.imports.get(state.id).preview?.manifest.id).toBe(backupId)
      expect(live.prepare('SELECT value FROM example').get()).toEqual({ value: '原有内容' })
    })
  })

  it('分片间取消会清理已上传的暂存文件并释放导入名额', async () => {
    await withImportFixture(async ({ service, router, archive }) => {
      const bytes = readFileSync(archive)
      const state = service.imports.begin(bytes.length, '')
      const response = await router.request(`/imports/${state.id}/content`, {
        method: 'PUT',
        headers: { 'Content-Range': `bytes 0-15/${bytes.length}` },
        body: new Blob([new Uint8Array(bytes.subarray(0, 16))]),
      })
      expect(response.status).toBe(202)
      service.imports.cancel(state.id)
      await vi.waitFor(() => expect(service.imports.get(state.id).phase).toBe('cancelled'))
      expect(service.imports.active).toBe(false)
      expect(existsSync(path.join(service.root, 'work', `${state.id}.upload`))).toBe(false)
    })
  })

  it('不完整上传清理临时文件并保留原数据库', async () => {
    await withImportFixture(async ({ service, router, live }) => {
      const incomplete = service.imports.begin(100, '')
      const rejected = await router.request(`/imports/${incomplete.id}/content`, {
        method: 'PUT',
        body: new Blob(['不完整']),
      })
      expect(rejected.status).toBe(400)
      expect(service.imports.get(incomplete.id).phase).toBe('failed')
      expect(existsSync(path.join(service.root, 'work', `${incomplete.id}.upload`))).toBe(false)
      expect(live.prepare('SELECT value FROM example').get()).toEqual({ value: '原有内容' })
    })
  })

  it('取消服务端备份的预览时不删除原备份', async () => {
    await withImportFixture(async ({ service, archive }) => {
      const saved = service.imports.beginFile(archive, statSync(archive).size, '')
      service.imports.cancel(saved.id)
      await service.imports.shutdown()
      expect(existsSync(archive)).toBe(true)
    })
  })

  it('不同会话的整数消息 ID 相同也不会覆盖本机消息，附件会指向导入后的消息', () => {
    const db = createDrizzleConnection(path.join(directory(), 'infos.db'))
    const sqlite = (db as unknown as { $client: Database.Database }).$client
    try {
      sqlite.exec(
        "INSERT INTO threads(id,agent_id,title) VALUES ('local','pero','本机会话'); INSERT INTO thread_messages(id,thread_id,role,content,agent_id) VALUES (1,'local','user','本机正文','pero')",
      )
      const attachmentId = randomUUID()
      const tables = new Map<string, BackupRow[]>([
        ['threads', [{ id: 'imported', agent_id: 'pero', title: '导入会话' }]],
        [
          'thread_messages',
          [{ id: 1, thread_id: 'imported', role: 'user', content: '导入正文', agent_id: 'pero' }],
        ],
        [
          'message_attachments',
          [
            {
              id: attachmentId,
              thread_id: 'imported',
              message_id: 1,
              kind: 'image',
              original_name: '图片.png',
              mime_type: 'image/png',
              size_bytes: 4,
              sha256: 'a'.repeat(64),
              storage_key: `ab/${attachmentId}`,
            },
          ],
        ],
      ])
      mergeBackupRecords(sqlite, tables, { conflict: 'skip', agentTargets: {} }, randomUUID())
      expect(sqlite.prepare('SELECT content FROM thread_messages WHERE id=1').get()).toEqual({
        content: '本机正文',
      })
      expect(
        sqlite
          .prepare(
            'SELECT m.content,a.original_name FROM message_attachments a JOIN thread_messages m ON m.id=a.message_id WHERE a.id=?',
          )
          .get(attachmentId),
      ).toEqual({ content: '导入正文', original_name: '图片.png' })
    } finally {
      closeDrizzleConnection(db)
    }
  })

  it('停机快照包含尚未 checkpoint 的 WAL 提交', async () => {
    const root = directory(),
      source = path.join(root, 'data'),
      snapshot = path.join(source, BACKUP_STATE, 'work', 'snapshot')
    mkdirSync(source)
    const db = new Database(path.join(source, 'infos.db'))
    try {
      db.pragma('journal_mode = WAL')
      db.pragma('wal_autocheckpoint = 0')
      db.exec("CREATE TABLE notes(text TEXT); INSERT INTO notes VALUES ('只在 WAL 中的提交')")
      await snapshotOfflineTree(source, snapshot)
      const restored = new Database(path.join(snapshot, 'infos.db'), { readonly: true })
      try {
        expect(restored.prepare('SELECT text FROM notes').get()).toEqual({
          text: '只在 WAL 中的提交',
        })
      } finally {
        restored.close()
      }
    } finally {
      db.close()
    }
  })

  it('安装中断后回退旧文件并移除新增文件，保持卷根目录原位', async () => {
    const data = directory(),
      id = randomUUID()
    const rootInode = statSync(data).ino
    const restore = path.join(data, BACKUP_STATE, 'restore', id)
    mkdirSync(path.join(restore, 'previous'), { recursive: true })
    mkdirSync(path.join(restore, 'incoming'))
    writeFileSync(path.join(restore, 'previous', 'old.txt'), '覆盖前正文')
    writeFileSync(path.join(data, 'old.txt'), '尚未提交的新正文')
    writeFileSync(path.join(data, 'added.txt'), '未提交的新增文件')
    await atomicBackupJson(path.join(data, BACKUP_STATE, 'restore.json'), {
      phase: 'installing',
      directory: id,
      oldNames: ['old.txt'],
      newNames: ['old.txt', 'added.txt'],
    })
    await recoverBackupRestore(data)
    expect(readFileSync(path.join(data, 'old.txt'), 'utf8')).toBe('覆盖前正文')
    expect(existsSync(path.join(data, 'added.txt'))).toBe(false)
    expect(statSync(data).ino).toBe(rootInode)
  })

  it('社交摘要 ID 碰撞时保留双方正文与特征关系，重试不会重复导入', () => {
    const root = directory()
    const registry = new MemoryStoreRegistry(
      {
        resolve: (alias: string) =>
          alias === '@data' ? root : path.join(root, alias.replace('@data/', '')),
      } as never,
      4,
    )
    try {
      const store = registry.getAgentStore('pero', 'social')
      const featureId = 2 ** 31,
        sourceEventId = 7
      store.insertWithId(sourceEventId, [0, 0, 0, 0], {
        type: 'event',
        content: '本机摘要',
        agentId: 'pero',
      })
      store.insertWithId(featureId, [0, 0, 0, 0], { type: 'feature', content: '公园' })
      const rows = [
        {
          id: sourceEventId,
          payload_json: JSON.stringify({ type: 'event', content: '一起去公园', agentId: 'source' }),
          edges_json: '[]',
        },
        {
          id: featureId,
          payload_json: JSON.stringify({ type: 'feature', content: '公园' }),
          edges_json: JSON.stringify([
            { targetId: sourceEventId, label: 'memory_edge', weight: 1 },
          ]),
        },
      ]
      const importId = randomUUID()
      registry.importSocialBackup('pero', rows, 'duplicate', importId)
      const imported = registry.exportSocialBackup('pero')
      const event = imported.find((row) => JSON.parse(row.payload_json).content === '一起去公园')!
      expect(imported.some((row) => JSON.parse(row.payload_json).content === '本机摘要')).toBe(true)
      expect(JSON.parse(imported.find((row) => row.id === featureId)!.edges_json)).toContainEqual({
        targetId: event.id,
        label: 'memory_edge',
        weight: 1,
        metadata: null,
      })
      registry.importSocialBackup('pero', rows, 'duplicate', importId)
      expect(registry.exportSocialBackup('pero')).toHaveLength(imported.length)
    } finally {
      registry.closeAll()
    }
  })

  it('剔除凭据时保留 Token 预算和模型参数', () => {
    expect(
      redactBackupRow('ai_model_configs', {
        id: 1,
        api_key: '私密密钥',
        max_tokens: 8192,
        context_window_tokens: 32768,
      }),
    ).toEqual({ id: 1, api_key: '', max_tokens: 8192, context_window_tokens: 32768 })
  })
})
