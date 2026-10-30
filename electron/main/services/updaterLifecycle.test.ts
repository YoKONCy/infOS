import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  prepare: vi.fn(),
  quit: vi.fn(),
  version: '0.9.8',
  root: '',
  paths: { cache: '', exe: '', logs: '' },
}))
vi.mock('electron', () => ({
  app: {
    getVersion: () => mocks.version,
    getPath: (key: string) =>
      key === 'temp' ? path.join(mocks.root, '临时目录') : mocks.paths.exe,
    quit: mocks.quit,
  },
  net: { fetch: mocks.fetch },
  BrowserWindow: { getAllWindows: () => [] },
}))
vi.mock('../utils/env', () => ({
  isDev: false,
  isPackaged: true,
  isPortable: false,
  paths: mocks.paths,
}))
vi.mock('../utils/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('./updateInstaller', () => ({ prepareUpdateInstall: mocks.prepare }))

const payload = Buffer.from('INFOS-UPDATE-FIXTURE')
const rawRelease = {
  tag_name: 'v0.9.9',
  draft: false,
  assets: [
    {
      name: 'PeroperoChat.-Setup-0.9.9.exe',
      size: payload.length,
      digest: `sha256:${createHash('sha256').update(payload).digest('hex')}`,
      browser_download_url: 'https://github.com/YoKONCy/infOS/releases/download/v0.9.9/setup.exe',
    },
  ],
}
const temporaryRoot = process.env.INFOS_TEST_TEMP_ROOT ?? path.resolve('TEMP')
beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  vi.stubEnv('INFOS_LANGUAGE', 'zh-CN')
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('UPDATE_MUST_USE_ELECTRON_NETWORK')))
  vi.useFakeTimers({ toFake: ['setImmediate'] })
  mkdirSync(temporaryRoot, { recursive: true })
  mocks.root = mkdtempSync(path.join(temporaryRoot, 'client-updater-'))
  mocks.version = '0.9.8'
  mocks.paths.cache = path.join(mocks.root, '中文 用户 % & 目录', 'cache')
  mocks.paths.exe = path.join(mocks.root, '程序目录', '萌动链接.exe')
  mocks.paths.logs = path.join(mocks.root, '日志')
  mkdirSync(mocks.paths.cache, { recursive: true })
  mocks.fetch.mockImplementation(async (url: string) =>
    url.includes('api.github.com')
      ? new Response(JSON.stringify([rawRelease]))
      : new Response(new Uint8Array(payload), {
          headers: { 'content-length': String(payload.length) },
        }),
  )
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  rmSync(mocks.root, { recursive: true, force: true })
})

describe('Windows 更新的下载与安装交接', () => {
  it('安装助手准备失败时不退出应用，保留已校验的原安装包并显示重试状态', async () => {
    const service = await import('./updater')
    await service.checkForUpdates()
    const downloaded = await service.downloadUpdate('v0.9.9')
    expect(readFileSync(downloaded.downloadedPath!)).toEqual(payload)
    mocks.prepare.mockRejectedValue(new Error('UPDATE_HELPER_TIMEOUT'))
    expect(await service.installUpdate()).toBe(false)
    expect(mocks.quit).not.toHaveBeenCalled()
    expect(service.getUpdateState()).toMatchObject({ phase: 'error', canInstall: true })
    expect(service.getUpdateState().message).toContain('应用未退出')
    expect(readFileSync(downloaded.downloadedPath!)).toEqual(payload)
    expect(
      JSON.parse(readFileSync(path.join(mocks.paths.cache, 'client-update-install.json'), 'utf8')),
    ).toMatchObject({ status: 'failed', version: '0.9.9' })
  })

  it('助手确认就绪后才退出；取消退出会取消本次安装并保留安装入口', async () => {
    const service = await import('./updater')
    await service.checkForUpdates()
    await service.downloadUpdate()
    const cancelPath = path.join(mocks.paths.cache, 'cancel')
    let acknowledge!: (value: unknown) => void
    mocks.prepare.mockImplementation(
      () =>
        new Promise((resolve) => {
          acknowledge = resolve
        }),
    )
    const installing = service.installUpdate()
    await vi.waitFor(() => expect(mocks.prepare).toHaveBeenCalled())
    expect(service.getUpdateState().phase).toBe('installing')
    expect(mocks.quit).not.toHaveBeenCalled()
    acknowledge({
      id: 'attempt',
      child: Object.assign(new EventEmitter(), { exitCode: null, signalCode: null }),
      cancelPath,
      logPath: mocks.paths.logs,
    })
    expect(await installing).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.quit).toHaveBeenCalledOnce()
    await service.cancelUpdateInstall()
    expect(readFileSync(cancelPath, 'utf8')).toBe('')
    expect(service.getUpdateState()).toMatchObject({ phase: 'downloaded', canInstall: true })
    expect(service.getUpdateState().message).toContain('已取消退出与本次安装')
  })

  it('网络失败且缓存没有更新时报告失败，不把旧的空列表显示为已是最新', async () => {
    const service = await import('./updater')
    mocks.fetch.mockResolvedValueOnce(new Response('[]'))
    expect((await service.checkForUpdates()).phase).toBe('up-to-date')
    mocks.fetch.mockRejectedValueOnce(new Error('network unavailable'))
    await expect(service.checkForUpdates()).rejects.toThrow('network unavailable')
    expect(service.getUpdateState().phase).toBe('error')
    expect(service.getUpdateState().message).toContain('检查更新失败')
  })

  it('下载缺少字节时拒绝安装，不能仅凭 HTTP 成功状态把包标记为可安装', async () => {
    const service = await import('./updater')
    await service.checkForUpdates()
    mocks.fetch.mockResolvedValueOnce(
      new Response(new Uint8Array(payload.subarray(0, payload.length - 1))),
    )
    await expect(service.downloadUpdate()).rejects.toThrow('更新包大小')
    expect(service.getUpdateState()).toMatchObject({ phase: 'error', canInstall: false })
    expect(await service.installUpdate()).toBe(false)
    expect(mocks.prepare).not.toHaveBeenCalled()
  })

  it('在线检查失败时明确展示非空缓存，不伪装成本次检查成功', async () => {
    const service = await import('./updater')
    await service.checkForUpdates()
    mocks.fetch.mockRejectedValueOnce(new Error('offline'))
    const cached = await service.checkForUpdates()
    expect(cached.phase).toBe('available')
    expect(cached.message).toBe('无法在线检查，当前显示缓存的 1 个更新版本')
    expect(service.getCachedReleases().map((release) => release.tagName)).toEqual(['v0.9.9'])
  })

  it('重新检查不会丢失已下载的包，安装前发现包被修改仍拒绝退出', async () => {
    const service = await import('./updater')
    await service.checkForUpdates()
    const downloaded = await service.downloadUpdate()
    await service.checkForUpdates()
    expect(service.getUpdateState()).toMatchObject({
      phase: 'downloaded',
      canInstall: true,
      selectedTag: 'v0.9.9',
    })
    writeFileSync(downloaded.downloadedPath!, Buffer.alloc(payload.length, 0))
    expect(await service.installUpdate()).toBe(false)
    expect(service.getUpdateState().canInstall).toBe(false)
    expect(mocks.prepare).not.toHaveBeenCalled()
    expect(mocks.quit).not.toHaveBeenCalled()
  })

  it('安装回执不能替代当前运行版本：仍运行旧版时报告未完成，真正启动新版后才显示成功', async () => {
    writeFileSync(
      path.join(mocks.paths.cache, 'client-update-install.json'),
      JSON.stringify({
        format: 1,
        id: 'attempt',
        version: '0.9.9',
        status: 'installed',
        logPath: mocks.paths.logs,
      }),
    )
    const old = await import('./updater')
    expect(old.getUpdateState().phase).toBe('error')
    expect(old.getUpdateState().message).toContain('当前仍为 0.9.8')
    mocks.version = '0.9.9'
    vi.resetModules()
    const updated = await import('./updater')
    expect(updated.getUpdateState().message).toContain('已完成更新，当前版本为 0.9.9')
  })
})
