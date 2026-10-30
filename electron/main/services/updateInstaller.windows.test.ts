import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { prepareUpdateInstall, type UpdateInstallInput } from './updateInstaller'

let root = ''
const temporaryRoot = process.env.INFOS_TEST_TEMP_ROOT ?? path.resolve('TEMP')
beforeEach(async () => {
  await mkdir(temporaryRoot, { recursive: true })
  root = await mkdtemp(path.join(temporaryRoot, 'windows-update-'))
})
afterEach(async ({ task }) => {
  const directory = path.join(root, '助手目录')
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory() && /^install-[a-f0-9-]+$/.test(entry.name))
      await writeFile(path.join(directory, entry.name, 'cancel'), '').catch(() => {})
  }
  await writeFile(path.join(root, 'cache', 'receipt.json.owner'), 'finished', 'utf8').catch(() => {})
  // 真实进程失败时保留 TEMP 现场，不能把最需要的启动日志随夹具删除。
  if (task.result?.state !== 'fail')
    await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
})
function input(): UpdateInstallInput {
  return {
    version: '0.9.9',
    deployment: 'installed',
    downloadPath: path.join(root, '中文 % & ! 目录', 'installer.exe'),
    executable: path.join(root, '程序目录', '萌动链接.exe'),
    temporaryRoot: path.join(root, '助手目录'),
    receiptPath: path.join(root, 'cache', 'receipt.json'),
    logDirectory: path.join(root, '日志'),
    parentPid: process.pid,
    messages: {
      started: '开始更新',
      finished: '更新完成',
      failed: '更新失败：{0}',
      failedNotice: '更新未完成，日志：{0}',
      failedTitle: '更新失败',
    },
  }
}

describe('真实 Windows 更新助手的安全交接', () => {
  it.runIf(process.platform === 'win32')('启动宿主退出后助手仍响应取消，不随 Node 作业被回收', async () => {
    const requested = input()
    await mkdir(path.dirname(requested.downloadPath), { recursive: true })
    await writeFile(requested.downloadPath, '禁止执行的安装夹具')
    const host = path.join(root, 'launcher.mjs')
    const moduleUrl = pathToFileURL(path.resolve('electron/main/services/updateInstaller.ts')).href
    await writeFile(host, [
      `const loaded = await import(${JSON.stringify(moduleUrl)})`,
      'const prepare = loaded.prepareUpdateInstall ?? loaded.default.prepareUpdateInstall',
      "const request = JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8'))",
      'const prepared = await prepare(request)',
      'console.log(JSON.stringify({ id: prepared.id, cancelPath: prepared.cancelPath }))',
      'process.exit(0)',
    ].join('\n'))
    const { stdout } = await promisify(execFile)(process.execPath, [
      '--import', 'tsx', host, Buffer.from(JSON.stringify(requested)).toString('base64'),
    ], { windowsHide: true, timeout: 20_000 })
    const prepared = JSON.parse(stdout.trim()) as { id: string; cancelPath: string }
    try {
      expect(JSON.parse(await readFile(requested.receiptPath, 'utf8')))
        .toMatchObject({ id: prepared.id, status: 'waiting' })
      await writeFile(prepared.cancelPath, '')
      await expect.poll(async () => JSON.parse(await readFile(requested.receiptPath, 'utf8')).status, {
        timeout: 5000,
      }).toBe('cancelled')
    } finally {
      await writeFile(prepared.cancelPath, '').catch(() => {})
      await delay(100)
    }
  }, 30_000)

  it.runIf(process.platform === 'win32')('中文路径下真实启动、写回就绪，取消后退出且不执行安装包', async () => {
    const requested = input()
    await mkdir(path.dirname(requested.downloadPath), { recursive: true })
    // 宿主始终存活并主动取消，文件仅用于前置存在性检查，不能被执行。
    await writeFile(requested.downloadPath, '禁止执行的安装夹具')
    const prepared = await prepareUpdateInstall(requested)
    try {
      const waiting = JSON.parse(await readFile(requested.receiptPath, 'utf8'))
      expect(waiting).toMatchObject({ id: prepared.id, version: '0.9.9', status: 'waiting' })
      await writeFile(prepared.cancelPath, '')
      const deadline = Date.now() + 5000
      while (prepared.child.exitCode === null && prepared.child.signalCode === null && Date.now() < deadline)
        await delay(25)
      expect(prepared.child.exitCode).toBe(0)
      expect(JSON.parse(await readFile(requested.receiptPath, 'utf8')))
        .toMatchObject({ id: prepared.id, status: 'cancelled' })
      expect(await readFile(requested.downloadPath, 'utf8')).toBe('禁止执行的安装夹具')
    } finally {
      await writeFile(prepared.cancelPath, '').catch(() => {})
      if (prepared.child.exitCode === null && prepared.child.signalCode === null) {
        prepared.child.kill()
        await new Promise<void>((resolve) => prepared.child.once('exit', () => resolve()))
      }
    }
  }, 25_000)

  it.runIf(process.platform === 'win32')('原包不存在时真实助手返回失败回执，不能发出可安装的就绪确认', async () => {
    const requested = input()
    await expect(prepareUpdateInstall(requested)).rejects.toMatchObject({
      message: 'UPDATE_HELPER_EXITED',
      logPath: expect.stringContaining('helper.log'),
    })
    const receipt = JSON.parse(await readFile(requested.receiptPath, 'utf8'))
    expect(receipt).toMatchObject({
      version: '0.9.9', status: 'failed', errorCode: 'UPDATE_PACKAGE_MISSING',
    })
  }, 25_000)
})
