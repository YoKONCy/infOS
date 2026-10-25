import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { DebugWorkspace } from '@infos/backend/services/debug/debugWorkspace'
import { runDebugScript } from '@infos/backend/services/debug/debugScriptRunner'

const base = path.resolve('TEMP/runtime-debug')
let root: string
beforeEach(async () => {
  await mkdir(base, { recursive: true })
  root = await mkdtemp(path.join(base, 'boundary-'))
})
afterEach(async () => {
  if (!root.startsWith(base + path.sep)) throw new Error('测试清理路径越界')
  await rm(root, { recursive: true, force: true })
})
const invoke = async (method: string, args: unknown[]) => ({ method, args })
describe('调试脚本与文件边界', () => {
  it('Worker 支持 await、Node 内置模块和 SDK；捕获有界输出', async () => {
    const result = await runDebugScript({
      filename: path.join(root, 'run.cjs'),
      timeoutMs: 3000,
      invoke,
      code: 'console.log("x".repeat(12000)); return { node: require("node:path").sep, api: await debug.files.read("sample.ts") }',
    })
    expect(result).toMatchObject({
      result: { node: path.sep, api: { method: 'files.read', args: ['sample.ts'] } },
    })
    expect((result as any).output.length).toBeLessThanOrEqual(8000)
  })
  it('超时可终止死循环，取消会终止挂起 Worker', async () => {
    await expect(
      runDebugScript({
        filename: path.join(root, 'run.cjs'),
        timeoutMs: 100,
        invoke,
        code: 'while (true) {}',
      }),
    ).rejects.toThrow('DEBUG_SCRIPT_TIMEOUT')
    const controller = new AbortController()
    const pending = runDebugScript({
      filename: path.join(root, 'run.cjs'),
      timeoutMs: 3000,
      invoke,
      signal: controller.signal,
      code: 'await new Promise(() => {});',
    })
    setTimeout(() => controller.abort(), 50)
    await expect(pending).rejects.toThrow('DEBUG_CANCELLED')
  })
  it('返回值超限时报告稳定错误，SDK 异常能被脚本捕获', async () => {
    await expect(
      runDebugScript({
        filename: path.join(root, 'run.cjs'),
        timeoutMs: 3000,
        invoke,
        code: 'return "x".repeat(129000)',
      }),
    ).rejects.toThrow('DEBUG_RESULT_LIMIT')
    expect(
      await runDebugScript({
        filename: path.join(root, 'run.cjs'),
        timeoutMs: 3000,
        invoke: () => {
          throw new Error('FIXTURE_ERROR')
        },
        code: 'try { await debug.inspect() } catch (e) { return e.message }',
      }),
    ).toMatchObject({ result: expect.stringContaining('FIXTURE_ERROR') })
  })
  it('文件助手拒绝越界和符号链接，嵌套路径不在外部创建目录', async () => {
    const workspace = new DebugWorkspace(path.join(root, 'workspace'))
    await mkdir(workspace.root)
    await workspace.write('nested/test.ts', 'export const ok: boolean = true')
    await expect(workspace.write('../outside.txt', 'x')).rejects.toThrow('PACKAGE_PATH_INVALID')
    const outside = path.join(root, 'outside')
    await mkdir(outside)
    await symlink(outside, path.join(workspace.root, 'link'), 'junction')
    await expect(workspace.write('link/should-not-exist/file.ts', 'x')).rejects.toThrow(
      'DEBUG_PATH_DENIED',
    )
    await expect(readFile(path.join(outside, 'should-not-exist/file.ts'))).rejects.toThrow()
    await expect(workspace.list()).rejects.toThrow('DEBUG_PATH_DENIED')
  })
  it('拒绝覆盖编译输出冲突，工作区检查不假称完整类型检查', async () => {
    const workspace = new DebugWorkspace(path.join(root, 'workspace'))
    await mkdir(workspace.root)
    await workspace.write('entry.ts', 'export const value: number = "仅验证语法"')
    expect((await workspace.check()).ok).toBe(true)
    await writeFile(path.join(workspace.root, 'entry.js'), 'export const value = 1')
    await expect(workspace.stage(path.join(root, 'releases'))).rejects.toThrow(
      'DEBUG_OUTPUT_CONFLICT',
    )
  })
})
