import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { CloudSnapshotStore, type SteamCloudFiles } from './cloudSnapshotStore'

const HEAD = 'infos/auto-v1/head.json'
const ACCOUNT = '76561198000000001'
let root: string
let enabled: boolean
let files: Map<string, string>
let api: SteamCloudFiles

beforeEach(async () => {
  const temporary = path.resolve('TEMP')
  await mkdir(temporary, { recursive: true })
  root = await mkdtemp(path.join(temporary, 'steam-cloud-store-'))
  files = new Map()
  enabled = true
  api = {
    isEnabledForApp: () => enabled,
    readFile: (name) => {
      const value = files.get(name)
      if (value === undefined) throw new Error('FIXTURE_FILE_MISSING')
      return value
    },
    writeFile: vi.fn((name, content) => {
      files.set(name, content)
      return true
    }),
    fileExists: (name) => files.has(name),
    listFiles: () => [...files.keys()].map((name) => ({ name })),
    deleteFile: (name) => files.delete(name),
  }
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('Steam 云存档持久化', () => {
  it('分块重组保留完整正文，提交清单后仍可读取上一代存档', async () => {
    // 八字节分块使短正文也跨块，检查末尾不足一块的数据。
    const store = new CloudSnapshotStore(root, ACCOUNT, () => api, 8)
    const state = await store.readState()
    const first = Buffer.from('first conversation: hello')
    await store.checkpoint(first, 'first-local-revision', state)
    await store.publish(state)
    const previous = store.current()!
    const latest = Buffer.from('second conversation: a reply and follow-up')
    await store.checkpoint(latest, 'second-local-revision', state)
    await store.publish(state)
    expect(await store.readRemote(store.current()!)).toEqual(latest)
    expect(await store.readRemote(store.previous()!)).toEqual(first)
    expect(store.previous()?.id).toBe(previous.id)
    expect(state.checkpoint?.pending).toBe(false)
    expect(state.fingerprint).toBe('second-local-revision')
  })

  it('新一代分块写入中断时不切换清单，旧正文仍可恢复', async () => {
    const store = new CloudSnapshotStore(root, ACCOUNT, () => api, 8)
    const state = await store.readState()
    const first = Buffer.from('the previous complete conversation')
    await store.checkpoint(first, 'before', state)
    await store.publish(state)
    const head = files.get(HEAD)
    const previous = store.current()!
    await store.checkpoint(
      Buffer.from('a newer conversation spanning several chunks'),
      'after',
      state,
    )
    const failedRevision = state.checkpoint!.snapshot.id
    api.writeFile = (name, content) => {
      if (name === `infos/auto-v1/${failedRevision}/0001.chunk`) return false
      files.set(name, content)
      return true
    }
    await expect(store.publish(state)).rejects.toThrow('STEAM_CLOUD_WRITE_FAILED')
    expect(files.get(HEAD)).toBe(head)
    expect(await store.readRemote(previous)).toEqual(first)
    expect((await store.readState()).checkpoint?.pending).toBe(true)
    api.writeFile = (name, content) => {
      files.set(name, content)
      return true
    }
    await store.publish(state)
    expect(await store.readRemote(store.current()!)).toEqual(
      Buffer.from('a newer conversation spanning several chunks'),
    )
    expect(await store.readRemote(store.previous()!)).toEqual(first)
  })

  it('断网检查点在进程重建后仍可重试，不依赖原进程的内存', async () => {
    const store = new CloudSnapshotStore(root, ACCOUNT, () => api, 8)
    const state = await store.readState()
    const expected = Buffer.from('saved locally before an unexpected process exit')
    await store.checkpoint(expected, 'offline-local-revision', state)
    enabled = false
    await expect(store.publish(state)).rejects.toThrow('STEAM_CLOUD_UNAVAILABLE')
    enabled = true
    // 新实例使用默认分块大小，重试仍遵循检查点中记录的分块尺寸。
    const restarted = new CloudSnapshotStore(root, ACCOUNT, () => api)
    const pending = await restarted.readState()
    expect(await restarted.readCheckpoint(pending.checkpoint!.snapshot)).toEqual(expected)
    await restarted.publish(pending)
    expect(await restarted.readRemote(restarted.current()!)).toEqual(expected)
    expect((await restarted.readState()).checkpoint?.pending).toBe(false)
  })

  it('另一设备已提交新代次时拒绝覆盖，并保留本机待传正文', async () => {
    const first = new CloudSnapshotStore(root, ACCOUNT, () => api, 8)
    const second = new CloudSnapshotStore(path.join(root, 'other-device'), ACCOUNT, () => api, 8)
    const firstState = await first.readState()
    const secondState = await second.readState()
    const local = Buffer.from('changes made on the second device')
    await second.checkpoint(local, 'local-change', secondState)
    await first.checkpoint(
      Buffer.from('new cloud save from the first device'),
      'cloud-change',
      firstState,
    )
    await first.publish(firstState)
    const head = files.get(HEAD)
    await expect(second.publish(secondState)).rejects.toThrow('STEAM_CLOUD_CONFLICT')
    expect(files.get(HEAD)).toBe(head)
    const pending = await second.readState()
    expect(pending.checkpoint?.pending).toBe(true)
    expect(await second.readCheckpoint(pending.checkpoint!.snapshot)).toEqual(local)
  })

  it('正文校验失败时不接受损坏云存档，上一代仍然可读', async () => {
    const store = new CloudSnapshotStore(root, ACCOUNT, () => api, 8)
    const state = await store.readState()
    const previous = Buffer.from('previous complete save')
    await store.checkpoint(previous, 'previous', state)
    await store.publish(state)
    await store.checkpoint(Buffer.from('current complete save'), 'current', state)
    await store.publish(state)
    const current = store.current()!
    files.set(
      `infos/auto-v1/${current.id}/0000.chunk`,
      `base64:${Buffer.alloc(8, 120).toString('base64')}`,
    )
    await expect(store.readRemote(current)).rejects.toThrow('STEAM_CLOUD_CHECKSUM_MISMATCH')
    const fallback = store.previous()!
    expect(await store.readRemote(fallback)).toEqual(previous)
    store.adoptPrevious(fallback)
    expect(await store.readRemote(store.current()!)).toEqual(previous)
  })

  it('本机检查点损坏时不会发布损坏正文或切换云端清单', async () => {
    const store = new CloudSnapshotStore(root, ACCOUNT, () => api, 8)
    const state = await store.readState()
    await store.checkpoint(Buffer.from('a complete local checkpoint'), 'local', state)
    await writeFile(
      path.join(store.directory, `${state.checkpoint!.snapshot.id}.bundle`),
      'truncated',
    )
    await expect(store.publish(state)).rejects.toThrow('STEAM_CLOUD_CHECKSUM_MISMATCH')
    expect(files.has(HEAD)).toBe(false)
    expect((await store.readState()).checkpoint?.pending).toBe(true)
  })

  it('旧版单文件存档可迁移，升级后保留旧正文作为上一代', async () => {
    const previous = Buffer.from('legacy complete snapshot')
    files.set('infos/full-snapshot.bundle', `base64:${previous.toString('base64')}`)
    const store = new CloudSnapshotStore(root, ACCOUNT, () => api, 8)
    const state = await store.readState()
    state.baseRevision = store.current()!.id
    await store.checkpoint(Buffer.from('new complete snapshot'), 'new', state)
    await store.publish(state)
    expect(await store.readRemote(store.previous()!)).toEqual(previous)
    expect(store.previous()?.legacy).toBe(true)
  })

  it('回收已退役代次时保留其他设备尚未提交的分块', async () => {
    const store = new CloudSnapshotStore(root, ACCOUNT, () => api, 8)
    const state = await store.readState()
    const foreign = 'infos/auto-v1/11111111-1111-4111-8111-111111111111/0000.chunk'
    files.set(foreign, 'base64:b3RoZXItZGV2aWNl')
    await store.checkpoint(Buffer.from('oldest snapshot'), 'oldest', state)
    await store.publish(state)
    const oldestId = store.current()!.id
    const previous = Buffer.from('previous complete snapshot')
    await store.checkpoint(previous, 'previous', state)
    await store.publish(state)
    const current = Buffer.from('current complete snapshot')
    await store.checkpoint(current, 'current', state)
    await store.publish(state)
    expect(files.get(foreign)).toBe('base64:b3RoZXItZGV2aWNl')
    expect(files.has(`infos/auto-v1/${oldestId}/0000.chunk`)).toBe(false)
    expect(await store.readRemote(store.current()!)).toEqual(current)
    expect(await store.readRemote(store.previous()!)).toEqual(previous)
  })
})
