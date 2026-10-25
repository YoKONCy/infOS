import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}))

const paths = vi.hoisted(() => ({ data: '' }))
vi.mock('../utils/env', () => ({ paths }))
vi.mock('../utils/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
import {
  syncNapCatConfig,
  getNapCatStatus,
  getInstalledNapCatVersion,
  NAPCAT_VERSION,
  resolveEntryPoint,
  startNapCat,
  stopNapCat,
} from './napcat'
import { NAPCAT_INSTALLATION_MARKER } from './napcatInstallation'
let directory = ''
let configDir = ''
beforeEach(() => {
  directory = mkdtempSync(join(process.env.INFOS_TEST_TEMP_ROOT ?? tmpdir(), 'infos-napcat-'))
  paths.data = directory
  configDir = join(directory, 'tools', 'NapCat', 'napcat', 'config')
})
afterEach(() => {
  vi.restoreAllMocks()
  if (dirname(directory) === (process.env.INFOS_TEST_TEMP_ROOT ?? tmpdir()))
    rmSync(directory, { recursive: true, force: true })
})

describe('NapCat 首次登录配置', () => {
  it('没有任何 QQ 配置时就准备默认反向 WS，不把默认文件误当成 QQ 账号', () => {
    expect(syncNapCatConfig()).toEqual({ accounts: [], changedAccounts: [] })
    const defaults = JSON.parse(readFileSync(join(configDir, 'onebot11.json'), 'utf8'))
    expect(defaults.network.websocketClients).toEqual([
      expect.objectContaining({
        name: 'infOS',
        enable: true,
        url: expect.stringMatching(/\/api\/social\/ws\?platform=qq$/),
      }),
    ])
    const saved = readFileSync(join(configDir, 'onebot11.json'), 'utf8')
    syncNapCatConfig()
    expect(readFileSync(join(configDir, 'onebot11.json'), 'utf8')).toBe(saved)
  })

  it('已有账号只修复 infOS 连接，保留其他连接及 napcat 账号文件', () => {
    mkdirSync(configDir, { recursive: true })
    const other = { name: '其他应用', url: 'ws://localhost:9000', token: '测试令牌', enable: true }
    writeFileSync(
      join(configDir, 'onebot11_10000001.json'),
      JSON.stringify({
        network: {
          websocketClients: [other, { name: 'infOS', url: 'ws://localhost:1', enable: false }],
        },
        parseMultMsg: true,
      }),
    )
    writeFileSync(join(configDir, 'napcat_10000001.json'), '{"consoleLog":true}')
    expect(syncNapCatConfig()).toEqual({ accounts: ['10000001'], changedAccounts: ['10000001'] })
    const config = JSON.parse(readFileSync(join(configDir, 'onebot11_10000001.json'), 'utf8'))
    expect(config.network.websocketClients[0]).toEqual(other)
    expect(config.network.websocketClients[1]).toMatchObject({ enable: true, name: 'infOS' })
    expect(config.parseMultMsg).toBe(true)
    expect(readFileSync(join(configDir, 'napcat_10000001.json'), 'utf8')).toBe(
      '{"consoleLog":true}',
    )
    expect(syncNapCatConfig().changedAccounts).toEqual([])
  })
})

describe('NapCat 版本更新', () => {
  function installed(version: string) {
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(directory, 'tools', 'NapCat', 'index.js'), '')
    writeFileSync(
      join(dirname(configDir), 'napcat.mjs'),
      `const napCatVersion = typeof env !== "undefined" && "${version}" || "1.0.0-dev";`,
    )
  }

  it('旧版本显示升级，当前版本与较新版本不会被降级', () => {
    installed('4.12.8')
    expect(getInstalledNapCatVersion()).toBe('4.12.8')
    expect(getNapCatStatus()).toMatchObject({
      updateAvailable: true,
      targetVersion: NAPCAT_VERSION,
    })
    installed(NAPCAT_VERSION)
    expect(getNapCatStatus().updateAvailable).toBe(false)
    installed('5.0.0')
    expect(getNapCatStatus().updateAvailable).toBe(false)
  })

  it('尚未安装时不显示更新入口', () => {
    expect(getInstalledNapCatVersion()).toBeNull()
    expect(getNapCatStatus().updateAvailable).toBe(false)
  })

  it('识别新版发行包压缩后的版本常量', () => {
    installed('4.12.8')
    writeFileSync(
      join(dirname(configDir), 'napcat.mjs'),
      `const sQ = {}, Vu = typeof sQ < "u" && "${NAPCAT_VERSION}" || "1.0.0-dev";`,
    )
    expect(getInstalledNapCatVersion()).toBe(NAPCAT_VERSION)
    expect(getNapCatStatus().updateAvailable).toBe(false)
  })

  it('安装中断时即使核心版本已更新也显示修复入口并阻止启动', async () => {
    installed(NAPCAT_VERSION)
    writeFileSync(join(directory, 'tools', 'NapCat', NAPCAT_INSTALLATION_MARKER), NAPCAT_VERSION)
    expect(getNapCatStatus().updateAvailable).toBe(true)
    await expect(startNapCat()).rejects.toThrow('上次安装未完成')
  })

  it('核心已经更新但官方插件遗留旧接口时仍显示修复入口', () => {
    installed(NAPCAT_VERSION)
    const plugin = join(directory, 'tools', 'NapCat', 'napcat', 'plugins', 'builtin', 'index.mjs')
    mkdirSync(dirname(plugin), { recursive: true })
    writeFileSync(
      plugin,
      'const plugin_onmessage = async (adapter, core, obCtx, event, actions, instance) => {};',
    )
    expect(getNapCatStatus().updateAvailable).toBe(true)
    writeFileSync(plugin, 'const plugin_onmessage = async (ctx, event) => {};')
    expect(getNapCatStatus().updateAvailable).toBe(false)
  })

  it('发行版使用包内 Node 并携带快速登录账号，旧 Shell 残留不会抢占入口', async () => {
    const root = join(directory, 'tools', 'NapCat')
    mkdirSync(join(root, 'napcat'), { recursive: true })
    for (const file of ['node.exe', 'wrapper.node', 'QQNT.dll', 'index.js', 'NapCat.Shell.exe'])
      writeFileSync(join(root, file), '程序文件')
    writeFileSync(join(root, 'napcat', 'napcat.mjs'), '程序文件')
    writeFileSync(join(root, 'package.json'), '{"version":"9.9.31-49738","buildVersion":"49738"}')
    const plan = await resolveEntryPoint(root, '10000001')
    expect(plan.cmd).toBe(join(root, 'node.exe'))
    expect(plan.args).toEqual(['index.js', '--qq', '10000001'])
    expect(plan.env).toMatchObject({
      NAPCAT_WRAPPER_PATH: join(root, 'wrapper.node'),
      NAPCAT_QQ_PACKAGE_INFO_PATH: join(root, 'package.json'),
      NAPCAT_QQ_VERSION_CONFIG_PATH: join(root, 'config.json'),
    })
  })

  it('停止请求取消尚未完成的启动，防止退出后迟到的启动继续创建进程', async () => {
    const root = join(directory, 'tools', 'NapCat')
    mkdirSync(join(root, 'napcat'), { recursive: true })
    for (const file of ['node.exe', 'wrapper.node', 'QQNT.dll', 'index.js'])
      writeFileSync(join(root, file), '程序文件')
    writeFileSync(join(root, 'napcat', 'napcat.mjs'), '程序文件')
    writeFileSync(join(root, 'package.json'), '{"version":"9.9.31-49738","buildVersion":"49738"}')
    vi.mocked(spawn).mockImplementation(() => {
      throw new Error('取消后不应创建进程')
    })
    const starting = startNapCat()
    const cancelled = expect(starting).rejects.toThrow('启动已取消')
    await stopNapCat()
    await cancelled
    expect(spawn).not.toHaveBeenCalled()
    expect(getNapCatStatus().running).toBe(false)
  })
})
