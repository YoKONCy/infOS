import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { CloudSnapshotStore, type SteamCloudFiles } from './cloudSnapshotStore'

const fixture = vi.hoisted(() => ({
  root: '',
  remote: false,
  cloud: null as SteamCloudFiles | null,
  capture: vi.fn(),
  stage: vi.fn(),
  choice: vi.fn(),
}))
vi.mock('electron', () => ({ dialog: { showMessageBox: fixture.choice } }))
vi.mock('../utils/env', () => ({
  paths: {
    get data() {
      return fixture.root
    },
  },
}))
vi.mock('../utils/i18n', () => ({ t: (_module: string, source: string) => source }))
vi.mock('../utils/logger', () => ({ logger: { warn: vi.fn() } }))
vi.mock('../utils/clientCredential', () => ({ getClientCredential: () => 'fixture-local-token' }))
vi.mock('./clientConnection', () => ({ isRemoteConnection: () => fixture.remote }))
vi.mock('./steam', () => ({
  IS_STEAM: () => true,
  getSteamUser: () => ({ steamId: '76561198000000001' }),
  getSteamCloudApi: () => fixture.cloud,
}))
vi.mock('./cloudSync', () => ({
  cloudSyncService: { captureSnapshot: fixture.capture, stageSnapshot: fixture.stage },
}))
import { SteamCloudAutoSave, cloudDataFingerprint, isCloudSaveChange } from './cloudAutoSave'

let manager: SteamCloudAutoSave
let files: Map<string, string>
const ACCOUNT = '76561198000000001'
beforeEach(async () => {
  vi.clearAllMocks()
  const temporary = path.resolve('TEMP')
  await mkdir(temporary, { recursive: true })
  fixture.root = await mkdtemp(path.join(temporary, 'steam-cloud-auto-'))
  fixture.remote = false
  fixture.capture.mockResolvedValue(Buffer.from('initial complete snapshot'))
  fixture.stage.mockResolvedValue('restored-snapshot-id')
  fixture.choice.mockResolvedValue({ response: 2 })
  files = new Map()
  fixture.cloud = {
    isEnabledForApp: () => true,
    readFile: (name) => files.get(name) ?? '',
    fileExists: (name) => files.has(name),
    writeFile: (name, content) => {
      files.set(name, content)
      return true
    },
    listFiles: () => [...files.keys()].map((name) => ({ name })),
    deleteFile: (name) => files.delete(name),
  }
  manager = new SteamCloudAutoSave(fixture.root)
})
afterEach(async () => {
  await manager.stopAndSave()
  vi.unstubAllGlobals()
  await rm(fixture.root, { recursive: true, force: true })
})

const storage = () => new CloudSnapshotStore(fixture.root, ACCOUNT, () => fixture.cloud)

describe('Steam 自动云存档生命周期', () => {
  it('数据库 WAL 属于待保存修改，日志、缓存和设备身份不触发业务存档', () => {
    expect(isCloudSaveChange('infos.db-wal')).toBe(true)
    expect(isCloudSaveChange('agent_pero/memory.tdb')).toBe(true)
    expect(isCloudSaveChange('logs/infos.log')).toBe(false)
    expect(isCloudSaveChange('cloud-cache/steam-1/state.json')).toBe(false)
    expect(isCloudSaveChange('.backup-state/work/infos.db')).toBe(false)
    expect(isCloudSaveChange('kernel/node-identity.json')).toBe(false)
  })

  it('文件轮询检测已提交的 WAL 变化，同时忽略保存服务自己的检查点', async () => {
    await writeFile(path.join(fixture.root, 'infos.db-wal'), 'first committed record')
    const before = await cloudDataFingerprint(fixture.root)
    await writeFile(path.join(fixture.root, 'infos.db-wal'), 'first and second committed records')
    const changed = await cloudDataFingerprint(fixture.root)
    expect(changed).not.toBe(before)
    await mkdir(path.join(fixture.root, 'cloud-cache'), { recursive: true })
    await writeFile(path.join(fixture.root, 'cloud-cache', 'checkpoint'), 'not business data')
    expect(await cloudDataFingerprint(fixture.root)).toBe(changed)
  })
  it('退出前重新捕获最后的正文，而不是只复用启动时的检查点', async () => {
    await manager.prepareStartup()
    manager.start()
    await manager.saveNow()
    const final = Buffer.from('the final conversation committed before quitting')
    fixture.capture.mockResolvedValue(final)
    await manager.stopAndSave()
    const store = storage()
    expect(await store.readRemote(store.current()!)).toEqual(final)
    expect((await store.readState()).checkpoint?.pending).toBe(false)
  })

  it('云端不可用时退出仍留下完整的待传密文', async () => {
    fixture.cloud!.isEnabledForApp = () => false
    const expected = Buffer.from('local conversation retained while offline')
    fixture.capture.mockResolvedValue(expected)
    await manager.prepareStartup()
    manager.start()
    await manager.stopAndSave()
    const store = storage()
    const state = await store.readState()
    expect(state.checkpoint?.pending).toBe(true)
    expect(await store.readCheckpoint(state.checkpoint!.snapshot)).toEqual(expected)
    expect(files.size).toBe(0)
  })

  it('冲突选择暂不同步后继续保护本机正文，但不覆盖云端', async () => {
    await writeFile(path.join(fixture.root, 'infos.db'), 'existing local data')
    const store = storage()
    const state = await store.readState()
    await store.checkpoint(Buffer.from('another device cloud save'), 'different-device', state)
    await store.publish(state)
    // 删除本机回执，模拟首次接入云存档的已有用户。
    await rm(path.join(store.directory, 'state.json'))
    const originalHead = files.get('infos/auto-v1/head.json')
    const local = Buffer.from('the local conversation must stay recoverable')
    fixture.capture.mockResolvedValue(local)
    await manager.prepareStartup()
    manager.start()
    await manager.stopAndSave()
    const pending = await store.readState()
    expect(await store.readCheckpoint(pending.checkpoint!.snapshot)).toEqual(local)
    expect(files.get('infos/auto-v1/head.json')).toBe(originalHead)
    expect(manager.getStatus().phase).toBe('conflict')
  })

  it('远程模式不导出或写入本机业务存档', async () => {
    fixture.remote = true
    await manager.prepareStartup()
    manager.start()
    await manager.stopAndSave()
    expect(fixture.capture).not.toHaveBeenCalled()
    expect(files.size).toBe(0)
    expect(manager.getStatus().phase).toBe('disabled')
  })

  it('新设备先校验暂存，再重启后端并核对应用回执，最后才记录云端基线', async () => {
    const store = storage()
    const state = await store.readState()
    const expected = Buffer.from('cloud conversation restored on a new device')
    await store.checkpoint(expected, 'from-another-device', state)
    await store.publish(state)
    const cloudId = store.current()!.id
    await rm(path.join(store.directory, 'state.json'))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ data: { lastSync: { snapshotId: 'restored-snapshot-id' } } }),
      ),
    )
    await manager.prepareStartup()
    const restart = vi.fn(async () => {
      await writeFile(path.join(fixture.root, 'infos.db'), 'restored local database')
      return true
    })
    expect(await manager.restoreAtStartup(true, restart, new AbortController().signal)).toBe(true)
    expect(fixture.stage.mock.calls[0]?.[0]).toEqual(expected)
    const restored = await store.readState()
    expect(restored.baseRevision).toBe(cloudId)
    expect(restored.restoring).toBeUndefined()
    expect(restored.fingerprint).toBeTruthy()
  })

  it('暂存后的恢复回执不匹配时阻止进入主界面，不把暂存冒充恢复成功', async () => {
    const store = storage()
    const state = await store.readState()
    await store.checkpoint(Buffer.from('cloud snapshot awaiting application'), 'cloud', state)
    await store.publish(state)
    await rm(path.join(store.directory, 'state.json'))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ data: { lastSync: { snapshotId: 'unrelated-snapshot' } } }),
      ),
    )
    await manager.prepareStartup()
    expect(
      await manager.restoreAtStartup(true, async () => true, new AbortController().signal),
    ).toBe(false)
    expect((await store.readState()).restoring?.snapshotId).toBe('restored-snapshot-id')
  })

  it('复用外部后端时不暂存覆盖或强制重启，保留云端原存档', async () => {
    const store = storage()
    const state = await store.readState()
    const expected = Buffer.from('cloud save waiting for a privately managed backend')
    await store.checkpoint(expected, 'cloud', state)
    await store.publish(state)
    await rm(path.join(store.directory, 'state.json'))
    await manager.prepareStartup()
    const restart = vi.fn(async () => true)
    expect(await manager.restoreAtStartup(false, restart, new AbortController().signal)).toBe(true)
    expect(fixture.stage).not.toHaveBeenCalled()
    expect(restart).not.toHaveBeenCalled()
    expect(await store.readRemote(store.current()!)).toEqual(expected)
    expect(manager.getStatus().phase).toBe('conflict')
  })
})
