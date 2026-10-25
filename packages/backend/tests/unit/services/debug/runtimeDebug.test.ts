import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { unzipSync, strFromU8 } from 'fflate'
import { RuntimeDebugService } from '@infos/backend/services/debug/runtimeDebugService'
import { PackageRegistry, PackageRuntime } from '@infos/backend/packages'

const base = path.resolve('TEMP/runtime-debug')
let root: string, debug: RuntimeDebugService, runtime: PackageRuntime
let thread: {
  id: string
  agentId: string
  channel: string
  interactionMode: string
  purpose: string
  status: string
}
beforeEach(async () => {
  await mkdir(base, { recursive: true })
  root = await mkdtemp(path.join(base, 'session-'))
  runtime = new PackageRuntime(new PackageRegistry())
  thread = {
    id: 'thread-a',
    agentId: 'pero',
    channel: 'desktop',
    interactionMode: 'work',
    purpose: 'conversation',
    status: 'active',
  }
  debug = new RuntimeDebugService({
    root: path.join(root, 'debug'),
    appRoot: root,
    dataRoot: root,
    logsRoot: path.join(root, 'logs'),
    getThread: async (id) => (id === thread.id ? thread : null),
    runtime,
    snapshot: () => ({ ready: true }),
  })
})
afterEach(async () => {
  await debug.shutdown()
  await runtime.shutdown()
  vi.restoreAllMocks()
  if (!root.startsWith(base + path.sep)) throw new Error('测试清理路径越界')
  await rm(root, { recursive: true, force: true })
})
const run = (code?: string, approved = true) =>
  debug.execute({ threadId: thread.id, agentId: thread.agentId, code, approved }) as Promise<any>
const write = (content: string) =>
  run('await debug.files.write("fix.ts", ' + JSON.stringify(content) + ');')
const prepare = () => run('return await debug.load({id: "fix", entry: "fix.ts", kind: "tool"})')
describe('调试仅准备候选，不热加载', () => {
  it('默认关闭，仅普通桌面工作会话可启用；脚本仍需审批', async () => {
    await expect(run()).rejects.toThrow('DEBUG_DISABLED')
    thread.interactionMode = 'chat'
    await expect(debug.setEnabled(thread.id, true)).rejects.toThrow('DEBUG_WORK_MODE_REQUIRED')
    thread.interactionMode = 'work'
    thread.channel = 'group'
    await expect(debug.setEnabled(thread.id, true)).rejects.toThrow('DEBUG_THREAD_UNAVAILABLE')
    thread.channel = 'desktop'
    await debug.setEnabled(thread.id, true)
    expect((await run(undefined, false)).sdk.resources.checkout).toContain(
      'debug.resources.checkout',
    )
    await expect(run('return 1', false)).rejects.toThrow('DEBUG_APPROVAL_REQUIRED')
  })
  it('准备带顶层副作用的模块也不执行，不调用运行时激活入口', async () => {
    await debug.setEnabled(thread.id, true)
    const activation = vi.spyOn(runtime, 'activateContribution')
    await write(
      'throw new Error("该模块绝不能在准备阶段执行"); export const definition = {name: "probe"};',
    )
    expect((await prepare()).result).toMatchObject({ activated: false, manualApplyRequired: true })
    expect(activation).not.toHaveBeenCalled()
    expect((await debug.getStatus(thread.id)).loaded).toEqual([])
    expect((await debug.getStatus(thread.id)).prepared).toHaveLength(1)
  })
  it('恢复只改变候选记录；语法错误不替换已有候选', async () => {
    await debug.setEnabled(thread.id, true)
    await write('export const version: number = 1')
    await prepare()
    const first = (await debug.getStatus(thread.id)).prepared![0]!.digest
    await write('export const version: number = 2')
    await prepare()
    expect((await run('return await debug.recover("fix")')).result.restoredPrevious).toBe(true)
    expect((await debug.getStatus(thread.id)).prepared![0]!.digest).toBe(first)
    await write('export const = ;')
    await expect(prepare()).rejects.toThrow('DEBUG_CHECK_FAILED')
    expect((await debug.getStatus(thread.id)).prepared![0]!.digest).toBe(first)
  })
  it('checkout 备份原文件，修改候选不影响运行目录；不开放应用 RPC', async () => {
    await mkdir(path.join(root, 'skills'))
    await writeFile(path.join(root, 'skills', 'SKILL.md'), '原版')
    await debug.setEnabled(thread.id, true)
    const candidate = (await run('return await debug.resources.checkout("skills")')).result
    await writeFile(path.join(candidate.candidateDirectory, 'SKILL.md'), '修改版')
    expect(await readFile(path.join(root, 'skills', 'SKILL.md'), 'utf8')).toBe('原版')
    await expect(
      run('return await debug.resources.apply(' + JSON.stringify(candidate.id) + ')'),
    ).rejects.toThrow('DEBUG_INTERFACE_UNKNOWN')
  })
  it('导出只是 ZIP，关闭和重新开启都不自动加载历史候选', async () => {
    await debug.setEnabled(thread.id, true)
    await write('export const version = 1')
    await prepare()
    const exported = (await run('return await debug.export({name: "诊断候选", version: "1.0.0"})'))
      .result
    const files = unzipSync(await readFile(exported.archive))
    expect(JSON.parse(strFromU8(files['manifest.json']!)).contributions).toHaveLength(1)
    expect(exported.installed).toBe(false)
    await debug.close(thread.id)
    await debug.setEnabled(thread.id, true)
    expect((await debug.getStatus(thread.id)).prepared).toEqual([])
  })
  it('回退准备记录后导出对应旧快照，不混入工作区里的新内容', async () => {
    await debug.setEnabled(thread.id, true)
    await write('export const version = 1')
    await prepare()
    await write('export const version = 2')
    await prepare()
    await run('await debug.recover("fix")')
    const exported = (await run('return await debug.export({name: "恢复候选"})')).result
    const files = unzipSync(await readFile(exported.archive))
    const manifest = JSON.parse(strFromU8(files['manifest.json']!))
    expect(strFromU8(files[manifest.contributions[0].entry]!)).toContain('version = 1')
  })
})
