import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execSync } from 'node:child_process'
import os from 'node:os'
import {
  activateWindowTool,
  setWindowProvider,
  type WindowProvider,
} from '@infos/backend/tools/systemInfo'
import { getLocale, setLocale } from '@infos/backend/lib/i18n'

// 测试仅验证数据分派，所有命令执行均拦截，禁止操作真实桌面或运行注入文本。
vi.mock('node:child_process', () => ({
  execSync: vi.fn(() => {
    throw new Error('测试禁止执行系统命令')
  }),
}))

const context = {
  agentId: 'pero',
  threadId: 'window-test',
  sessionId: 'window-test',
  source: 'desktop',
  channel: 'desktop',
  signal: new AbortController().signal,
}
let previousLocale: ReturnType<typeof getLocale>

beforeEach(() => {
  previousLocale = getLocale()
  setWindowProvider(null)
  vi.clearAllMocks()
})
afterEach(() => {
  setWindowProvider(null)
  setLocale(previousLocale)
  vi.restoreAllMocks()
})

async function execute(target: unknown) {
  const result = await activateWindowTool.execute({ target }, context)
  return JSON.parse(typeof result === 'string' ? result : result.output)
}

function createProvider(): WindowProvider {
  return {
    getActiveWindows: vi.fn().mockResolvedValue([]),
    activateWindow: vi.fn().mockResolvedValue('已激活目标窗口'),
  }
}

describe('activate_window 客户端能力边界', () => {
  it.each(['win32', 'darwin', 'linux'] as const)(
    '%s 缺少提供者时拒绝执行，不启动 Shell',
    async (platform) => {
      vi.spyOn(os, 'platform').mockReturnValue(platform)
      const result = await execute('窗口 $() `文本` "引号"; & |')
      expect(result).toMatchObject({
        success: false,
        error: { code: 'WINDOW_ACTIVATION_UNAVAILABLE' },
      })
      expect(execSync).not.toHaveBeenCalled()
    },
  )

  it.each(['win32', 'darwin', 'linux'] as const)(
    '%s 提供者失败也不得回退到 Shell',
    async (platform) => {
      vi.spyOn(os, 'platform').mockReturnValue(platform)
      const provider = createProvider()
      vi.mocked(provider.activateWindow).mockRejectedValue(
        new Error('CAPABILITY_UNAVAILABLE: 客户端离线'),
      )
      setWindowProvider(provider)
      const result = await execute('目标窗口')
      expect(result).toMatchObject({ success: false, error: { code: 'WINDOW_ACTIVATION_FAILED' } })
      expect(result.error.message).toContain('CAPABILITY_UNAVAILABLE')
      expect(provider.activateWindow).toHaveBeenCalledWith('目标窗口', context)
      expect(execSync).not.toHaveBeenCalled()
    },
  )

  it.each(['萌动链接：PeroperoChat！', 'Project (开发) — "Editor"', '窗口 $() `文本` "引号"; & |'])(
    '窗口名作为原始数据转交客户端：%s',
    async (target) => {
      const provider = createProvider()
      setWindowProvider(provider)
      expect(await execute(`  ${target}  `)).toEqual({ success: true, message: '已激活目标窗口' })
      expect(provider.activateWindow).toHaveBeenCalledWith(target, context)
      expect(execSync).not.toHaveBeenCalled()
    },
  )

  it.each([undefined, null, '', '   ', 42, true, [], {}])(
    '缺失、空白或非字符串名称返回参数错误：%j',
    async (target) => {
      const provider = createProvider()
      setWindowProvider(provider)
      expect(await execute(target)).toMatchObject({
        success: false,
        error: { code: 'WINDOW_TARGET_REQUIRED' },
      })
      expect(provider.activateWindow).not.toHaveBeenCalled()
      expect(execSync).not.toHaveBeenCalled()
    },
  )

  it.each([
    ['zh-CN', '窗口切换能力不可用，请连接支持窗口操作的客户端'],
    ['zh-TW', '視窗切換功能無法使用，請連線至支援視窗操作的用戶端'],
    [
      'en-US',
      'Window activation is unavailable. Connect a client that supports window operations.',
    ],
  ] as const)('%s 能力不可用提示本地化，错误码保持不变', async (locale, message) => {
    setLocale(locale)
    expect(await execute('目标窗口')).toEqual({
      success: false,
      error: { code: 'WINDOW_ACTIVATION_UNAVAILABLE', message },
    })
  })
})
