import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { writeAtomicJsonSync } from '@infos/backend/lib/atomicJson'

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual, renameSync: vi.fn(actual.renameSync) }
})
const base = path.resolve('TEMP')
let directory: string
let file: string
beforeEach(async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  vi.mocked(renameSync).mockReset().mockImplementation(actual.renameSync)
  mkdirSync(base, { recursive: true })
  directory = mkdtempSync(path.join(base, 'atomic-credentials-'))
  file = path.join(directory, 'client-access.json')
  writeAtomicJsonSync(file, { revision: 1, devices: ['原设备'] })
})
afterEach(() => {
  vi.restoreAllMocks()
  const relative = path.relative(base, directory)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error('测试清理路径越界')
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

describe('同步凭据原子写入', () => {
  it('短暂占用后提交完整新凭据，不留下中间文件', () => {
    vi.mocked(renameSync)
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('文件占用'), { code: 'EPERM' })
      })
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('文件占用'), { code: 'EBUSY' })
      })
    writeAtomicJsonSync(file, { revision: 2, devices: ['原设备', '新设备'] })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      revision: 2,
      devices: ['原设备', '新设备'],
    })
    expect(readdirSync(directory)).toEqual(['client-access.json'])
  })

  it('永久错误立即上报，保留旧凭据并清理暂存内容', () => {
    const failure = Object.assign(new Error('磁盘不可用'), { code: 'EIO' })
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw failure
    })
    assertFailedSave(failure)
  })

  it('持续占用达到有界重试后上报，不能伪装成写入成功', () => {
    vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out')
    const failure = Object.assign(new Error('持续占用'), { code: 'EACCES' })
    vi.mocked(renameSync).mockImplementation(() => {
      throw failure
    })
    assertFailedSave(failure)
  })
})

function assertFailedSave(failure: Error) {
  expect(() => writeAtomicJsonSync(file, { revision: 2, devices: ['新设备'] })).toThrow(failure)
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ revision: 1, devices: ['原设备'] })
  expect(readdirSync(directory)).toEqual(['client-access.json'])
}
