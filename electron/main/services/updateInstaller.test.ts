import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { prepareUpdateInstall, type UpdateInstallInput } from './updateInstaller'

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
let root = ''
const temporaryRoot = process.env.INFOS_TEST_TEMP_ROOT ?? path.resolve('TEMP')
beforeEach(async () => {
  vi.resetAllMocks()
  await mkdir(temporaryRoot, { recursive: true })
  root = await mkdtemp(path.join(temporaryRoot, 'update-helper-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
function input(): UpdateInstallInput {
  return {
    version: '0.9.9',
    deployment: 'installed',
    downloadPath: path.join(root, '中文 用户 % & ! 目录', 'installer.exe'),
    executable: path.join(root, '应用 程序', '萌动链接.exe'),
    temporaryRoot: path.join(root, '系统 临时目录'),
    receiptPath: path.join(root, 'cache', 'install.json'),
    logDirectory: path.join(root, 'logs'),
    parentPid: 1234,
    messages: {
      started: '开始更新',
      finished: '更新完成',
      failed: '更新失败：{0}',
      failedNotice: '更新安装未完成，日志：{0}',
      failedTitle: '更新失败',
    },
  }
}
function processBoundary() {
  const child = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    signalCode: null,
    unref: vi.fn(),
  })
  let settings: Record<string, string> | null = null
  let scriptBytes: Buffer | null = null
  mocks.spawn.mockImplementation((_command: string, args: string[]) => {
    queueMicrotask(() => {
      child.emit('spawn')
      const encodedBootstrap = args[args.length - 1]!.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/)![1]!
      const bootstrap = Buffer.from(encodedBootstrap, 'base64').toString('utf16le')
      const helperPath = bootstrap.slice(3, -1).replace(/''/g, "'")
      void readFile(helperPath)
        .then((bytes) => {
          scriptBytes = bytes
          const text = bytes.toString('utf16le')
          const encoded = text.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/)![1]!
          settings = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))
        })
        .catch((error) => child.emit('error', error))
    })
    return child
  })
  return { child, settings: () => settings, scriptBytes: () => scriptBytes }
}

describe('Unicode 更新助手的交接边界', () => {
  it('中文及特殊字符路径按原值传递，错误就绪编号不能使助手被视为接手成功', async () => {
    const boundary = processBoundary()
    const requested = input()
    let accepted = false
    const preparation = prepareUpdateInstall(requested).then((value) => {
      accepted = true
      return value
    })
    await vi.waitFor(() => expect(boundary.settings()).not.toBeNull())
    const settings = boundary.settings()!
    expect(settings.downloadPath).toBe(requested.downloadPath)
    expect(settings.executable).toBe(requested.executable)
    expect(boundary.scriptBytes()!.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfe]))
    await writeFile(settings.readyPath!, 'another-attempt')
    await delay(250)
    expect(accepted).toBe(false)
    await writeFile(settings.readyPath!, settings.id!)
    expect(await preparation).toMatchObject({ id: settings.id, cancelPath: settings.cancelPath })
  })

  it('助手在接手前退出时留下取消标记和诊断路径，阻止迟到的旧助手覆盖结果', async () => {
    const boundary = processBoundary()
    const preparation = prepareUpdateInstall(input())
    const rejected = expect(preparation).rejects.toMatchObject({
      message: 'UPDATE_HELPER_EXITED',
      logPath: expect.stringContaining('helper.log'),
    })
    await vi.waitFor(() => expect(boundary.settings()).not.toBeNull())
    const settings = boundary.settings()!
    boundary.child.exitCode = 1
    boundary.child.emit('exit', 1)
    await rejected
    expect(await readFile(settings.cancelPath!, 'utf8')).toBe('')
    expect(await readFile(settings.ownerPath!, 'utf8')).toBe(settings.id + '.cancelled')
  })
})
