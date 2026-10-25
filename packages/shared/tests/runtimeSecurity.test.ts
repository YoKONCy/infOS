import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  meetsMinimum,
  runtimeIssues,
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
  it('新版 Electron 仍内嵌旧 Node 时不能通过发布检查', () => {
    expect(runtimeIssues({ electron: '44.9.3', node: '24.22.0' }, '44.9.3')).toContainEqual({
      code: 'UNSAFE_NODE_RUNTIME',
      detail: '24.22.0',
    })
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
