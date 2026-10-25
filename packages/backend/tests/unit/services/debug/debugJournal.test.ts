import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import path from 'node:path'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
const mocks = vi.hoisted(() => ({ rename: vi.fn() }))
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  rename: mocks.rename,
}))
import { writeAtomicJson as writeDebugRecord } from '@infos/backend/lib/atomicJson'
const base = path.resolve('TEMP/runtime-debug')
let root: string
beforeEach(async () => {
  mocks.rename.mockReset()
  await mkdir(base, { recursive: true })
  root = await mkdtemp(path.join(base, 'journal-'))
})
afterEach(async () => {
  if (!root.startsWith(base + path.sep)) throw new Error('测试清理路径越界')
  await rm(root, { recursive: true, force: true })
})
describe('调试记录的 Windows 文件占用恢复', () => {
  it('短暂 EPERM 时重试替换，不先删除上一个正常记录', async () => {
    const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const file = path.join(root, 'state.json')
    await writeFile(file, '{"enabled":true}')
    let count = 0
    mocks.rename.mockImplementation(async (temporary, target) => {
      expect(await readFile(target, 'utf8')).toBe('{"enabled":true}')
      if (++count <= 2) throw Object.assign(new Error('模拟短暂占用'), { code: 'EPERM' })
      return original.rename(temporary, target)
    })
    await writeDebugRecord(file, { enabled: false })
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ enabled: false })
    expect(mocks.rename).toHaveBeenCalledTimes(3)
    expect(await readdir(root)).toEqual(['state.json'])
  })
  it('永久错误不无限重试，保留旧记录并清理临时文件', async () => {
    const file = path.join(root, 'state.json')
    await writeFile(file, '原记录')
    mocks.rename.mockRejectedValue(Object.assign(new Error('模拟不可恢复错误'), { code: 'EROFS' }))
    await expect(writeDebugRecord(file, { enabled: false })).rejects.toThrow('模拟不可恢复错误')
    expect(await readFile(file, 'utf8')).toBe('原记录')
    expect(await readdir(root)).toEqual(['state.json'])
    expect(mocks.rename).toHaveBeenCalledOnce()
  })
})
