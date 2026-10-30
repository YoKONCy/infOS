import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getVersion: () => '1.0.0',
    getPath: (name: string) => (name === 'temp' ? 'C:\\Temp' : 'C:\\App'),
    isPackaged: true,
    quit: vi.fn(),
  },
  BrowserWindow: { getAllWindows: () => [] },
  net: { fetch: vi.fn() },
}))

vi.mock('../utils/env', () => ({
  isDev: false,
  isPackaged: true,
  isPortable: false,
  paths: {
    cache: 'C:\\Cache',
    exe: 'C:\\Program Files\\infOS\\infOS.exe',
  },
}))

vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { classifyReleaseChannel, compareVersions } from './updater'

describe('Updater Release版本合同', () => {
  beforeEach(() => vi.clearAllMocks())

  it('应识别正式版、RC、Alpha、Beta与Hotfix标签', () => {
    expect(classifyReleaseChannel('v1.2.0')).toBe('stable')
    expect(classifyReleaseChannel('v1.2.0-rc1')).toBe('rc')
    expect(classifyReleaseChannel('v1.2.0-alpha.3')).toBe('alpha')
    expect(classifyReleaseChannel('v1.2.0-beta2')).toBe('beta')
    expect(classifyReleaseChannel('v1.2.1-hotfix1')).toBe('hotfix')
  })

  it('稳定版应高于同版本预发布，Hotfix应高于同基础稳定版', () => {
    expect(compareVersions('1.2.0', '1.2.0-rc1')).toBeGreaterThan(0)
    expect(compareVersions('1.2.0-rc2', '1.2.0-rc1')).toBeGreaterThan(0)
    expect(compareVersions('1.2.0-rc10', '1.2.0-rc2')).toBeGreaterThan(0)
    expect(compareVersions('1.3.0-alpha1', '1.2.9')).toBeGreaterThan(0)
    expect(compareVersions('2.0.0', '1.99.99')).toBeGreaterThan(0)
    expect(compareVersions('1.2.0-hotfix1', '1.2.0')).toBeGreaterThan(0)
    expect(compareVersions('1.2.0-hotfix2', '1.2.0-hotfix1')).toBeGreaterThan(0)
    expect(compareVersions('1.2.1', '1.2.0-hotfix9')).toBeGreaterThan(0)
    expect(compareVersions('1.2.0', 'v1.2.0')).toBe(0)
  })
})
