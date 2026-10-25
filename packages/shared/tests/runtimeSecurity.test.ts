import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const {
  meetsMinimum,
  runtimeIssues,
  runtimeWarnings,
  reportRuntimeWarnings,
  probeElectron,
} = require('../../../scripts/runtime-security.cjs')
const policy = require('../../../scripts/runtime-security-policy.json')

describe('运行时安全发布边界', () => {
  it.each(['22.23.4', '24.22.1', '26.12.1', '24.22.2'])(
    '允许已经达到补丁基线的 Node %s',
    (version) => {
      expect(meetsMinimum(version, policy.nodeMinimums)).toBe(true)
    },
  )
  it.each([
    '22.23.3',
    '24.22.0',
    '24.11.1',
    '26.12.0',
    '20.99.0',
    '28.0.0',
    '24.22.1-rc.1',
    'invalid',
  ])('拒绝未修复、未知或预发布 Node %s', (version) => {
    expect(meetsMinimum(version, policy.nodeMinimums)).toBe(false)
  })
  it('稳定 Electron 按内嵌基线放行，但保留独立 Node 基线差异', () => {
    const versions = { electron: '44.9.3', node: '24.22.0' }
    expect(runtimeIssues(versions, '44.9.3')).toEqual([])
    expect(runtimeWarnings(versions, '44.9.3')).toEqual([
      {
        code: 'ELECTRON_NODE_BELOW_STANDALONE_BASELINE',
        version: '24.22.0',
        minimum: '24.22.1',
      },
    ])
    expect(runtimeIssues({ node: '24.22.0' })).toContainEqual({
      code: 'UNSAFE_NODE_RUNTIME',
      detail: '24.22.0',
    })
  })
  it.each(['24.21.0', '22.23.4', '26.12.1', '24.22.0-rc.1', 'invalid'])(
    '拒绝低于内嵌基线或未审阅的 Node %s',
    (node) => {
      expect(runtimeIssues({ electron: '44.9.3', node }, '44.9.3')).toContainEqual({
        code: 'UNSAFE_NODE_RUNTIME',
        detail: node,
      })
    },
  )
  it.each(['44.9.2', '44.9.3-beta.1', '46.0.0-alpha.1'])(
    '仍拒绝过旧或预发布 Electron %s',
    (electron) => {
      expect(runtimeIssues({ electron, node: '24.22.1' }, electron)).toContainEqual({
        code: 'UNSUPPORTED_ELECTRON_RUNTIME',
        detail: electron,
      })
    },
  )
  it('实际补丁达到独立基线时不再报告差异', () => {
    expect(runtimeWarnings({ electron: '44.9.3', node: '24.22.1' }, '44.9.3')).toEqual([])
    expect(runtimeWarnings({ node: '24.22.0' })).toEqual([])
  })
  it('内嵌版本差异通过脚本词条记录，未达到基线仍有提示', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await reportRuntimeWarnings({ electron: '44.9.3', node: '24.22.0' }, '44.9.3')
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('24.22.0'))
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('24.22.1'))
    } finally {
      warn.mockRestore()
    }
  })
  it('即使 Node 已修复也不能用错版本的 Electron 打包', () => {
    expect(runtimeIssues({ electron: '43.8.3', node: '24.22.1' }, '44.9.3')).toContainEqual({
      code: 'ELECTRON_VERSION_MISMATCH',
      detail: '43.8.3/44.9.3',
    })
  })
  it('版本匹配且实际内嵌 Node 已修复时允许继续', () => {
    expect(runtimeIssues({ electron: '44.9.3', node: '24.22.1' }, '44.9.3')).toEqual([])
  })
  it('探测实际可执行文件时清除继承的 Node 注入选项', () => {
    const original = process.env.NODE_OPTIONS
    try {
      process.env.NODE_OPTIONS = '--require=INFOS_MUST_NOT_LOAD_THIS_MODULE'
      expect(probeElectron(process.execPath).node).toBe(process.versions.node)
    } finally {
      if (original === undefined) delete process.env.NODE_OPTIONS
      else process.env.NODE_OPTIONS = original
    }
  })
})
