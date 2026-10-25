import { t as __t } from '../../lib/i18n'
/**
 * systemInfo — 系统信息 + 应用启动工具
 *
 * 跨平台能力:
 * - get_system_info    → 系统信息 (os 模块，跨平台)
 * - open_application   → 启动应用 (客户端能力)
 * - get_active_windows → 列出窗口 (平台适配)
 * - activate_window    → 切换窗口 (平台适配)
 *
 * 系统查询使用 Node.js 原生能力；窗口列表允许只读命令降级。
 * 应用启动与窗口激活必须委托已注入的客户端能力，缺少提供者时拒绝执行。
 *
 * @module packages/backend/src/tools/systemInfo
 */

import type { BuiltinTool } from '../index'
import { execSync } from 'node:child_process'
import os from 'node:os'
import { createLogger } from '../../lib/logger'

const logger = createLogger('SystemInfo')

// ── 窗口管理提供者抽象 ──

/** 窗口管理提供者接口 (可选) */
export interface WindowProvider {
  /** 获取活跃窗口列表 */
  getActiveWindows(): Promise<WindowInfo[]>
  /** 激活/置顶指定窗口 */
  activateWindow(target: string, context?: Parameters<BuiltinTool['execute']>[1]): Promise<string>
}

export interface WindowInfo {
  /** 进程名 */
  processName: string
  /** 窗口标题 */
  title: string
  /** 窗口句柄 (平台相关) */
  handle?: number
}

/** 工厂函数: 供 tools/index.ts 调用 (闭包内无模块级可变状态) */
let _windowProvider: WindowProvider | null = null

/** 设置 WindowProvider（仅供向后兼容，建议使用 createSystemInfoTools） */
export function setWindowProvider(provider: WindowProvider | null): void {
  _windowProvider = provider
}

/** 获取当前 WindowProvider (工具内部使用) */
export function getWindowProvider(): WindowProvider | null {
  return _windowProvider
}

// ── get_system_info ──

export const getSystemInfoTool: BuiltinTool = {
  name: 'get_system_info',

  async execute() {
    try {
      const totalMem = os.totalmem()
      const freeMem = os.freemem()
      const cpus = os.cpus()

      const info = {
        os: os.platform(),
        version: os.release(),
        arch: os.arch(),
        hostname: os.hostname(),
        uptime: `${Math.floor(os.uptime() / 3600)} 小时`,
        cpu: {
          model: cpus[0]?.model ?? '未知',
          cores: cpus.length,
        },
        memory: {
          total: `${(totalMem / 1024 / 1024 / 1024).toFixed(1)} GB`,
          free: `${(freeMem / 1024 / 1024 / 1024).toFixed(1)} GB`,
          used: `${((totalMem - freeMem) / 1024 / 1024 / 1024).toFixed(1)} GB`,
          usagePercent: `${(((totalMem - freeMem) / totalMem) * 100).toFixed(0)}%`,
        },
        homedir: os.homedir(),
      }

      return JSON.stringify({ success: true, system: info })
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      return JSON.stringify({ error: `获取系统信息失败: ${errMsg}` })
    }
  },
}

export interface ApplicationProvider {
  launch(
    appName: string,
    context?: Parameters<BuiltinTool['execute']>[1],
  ): Promise<{
    application: string
    mode: 'activated' | 'launched'
    targetType: 'window' | 'path' | 'aumid'
  }>
}

let _applicationProvider: ApplicationProvider | null = null

export function setApplicationProvider(provider: ApplicationProvider | null): void {
  _applicationProvider = provider
}

function errorResult(code: string, message: string): string {
  return JSON.stringify({ success: false, error: { code, message } })
}

// ── open_application ──

export const openApplicationTool: BuiltinTool = {
  name: 'open_application',

  async execute(args, context) {
    const appName = (args.app_name as string)?.trim()
    if (!appName) return errorResult('APPLICATION_NAME_REQUIRED', '请提供应用程序名称')
    if (
      /^(?:resource:)?(?:https?:|file:|workspace:|attachment:)/i.test(appName) ||
      /\.html?(?:[?#].*)?$/i.test(appName)
    ) {
      return errorResult(
        'BROWSER_TOOL_REQUIRED',
        '这是网页或文件预览目标，请先直接调用 expand_advanced_tools，下一轮使用 browser_open_url；url 可以传网址、工作区 HTML 相对路径或 workspace: 引用。本工具只负责启动已安装的应用，不用于验证网页效果。',
      )
    }
    if (!_applicationProvider) {
      return errorResult(
        'APPLICATION_LAUNCH_UNAVAILABLE',
        '应用启动能力不可用，请连接 Electron 客户端',
      )
    }

    logger.info(__t('logs.tools', '请求客户端打开应用: {0}', [appName]))
    try {
      const result = await _applicationProvider.launch(appName, context)
      return JSON.stringify({
        success: true,
        application: result.application,
        mode: result.mode,
        targetType: result.targetType,
        message:
          result.mode === 'activated'
            ? __t('server.tools', '已切换到正在运行的应用: {0}', [result.application])
            : __t('server.tools', '已启动应用: {0}', [result.application]),
      })
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err)
      const separator = text.indexOf(':')
      const code = separator > 0 ? text.slice(0, separator) : 'APPLICATION_LAUNCH_FAILED'
      const message = separator > 0 ? text.slice(separator + 1).trim() : text
      logger.error(__t('logs.tools', '打开应用失败: {0}', [text]))
      return errorResult(code, message)
    }
  },
}

// ── get_active_windows ──

export const getActiveWindowsTool: BuiltinTool = {
  name: 'get_active_windows',

  async execute() {
    // 优先使用注入的 WindowProvider
    if (_windowProvider) {
      try {
        const windows = await _windowProvider.getActiveWindows()
        return JSON.stringify({
          success: true,
          windows: windows.map((w: WindowInfo) => `[${w.processName}] ${w.title}`),
          total: windows.length,
        })
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        return JSON.stringify({ error: `获取窗口列表失败: ${errMsg}` })
      }
    }

    // 降级: 使用 shell 命令
    const platform = os.platform()

    try {
      let output: string

      if (platform === 'win32') {
        // Windows: tasklist 获取进程列表 (非真正窗口列表，但聊胜于无)
        output = execSync(
          'powershell -Command "Get-Process | Where-Object {$_.MainWindowTitle -ne \'\'} | Select-Object ProcessName, MainWindowTitle | Format-Table -AutoSize"',
          { timeout: 5000, encoding: 'utf-8' },
        )
      } else if (platform === 'darwin') {
        output = execSync(
          'osascript -e \'tell application "System Events" to get name of every process whose visible is true\'',
          { timeout: 5000, encoding: 'utf-8' },
        )
      } else {
        output = execSync('wmctrl -l 2>/dev/null || echo "wmctrl 未安装"', {
          timeout: 5000,
          encoding: 'utf-8',
        })
      }

      return JSON.stringify({
        success: true,
        output: output.trim().slice(0, 5000),
      })
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      return JSON.stringify({ error: `获取窗口列表失败: ${errMsg}` })
    }
  },
}

// ── activate_window ──

export const activateWindowTool: BuiltinTool = {
  name: 'activate_window',

  async execute(args, context) {
    const target = typeof args.target === 'string' ? args.target.trim() : ''
    if (!target) {
      return errorResult('WINDOW_TARGET_REQUIRED', __t('server.tools', '请提供窗口名称'))
    }

    // 窗口名称只作为数据传给客户端；缺少提供者时不得降级为本机 Shell 或脚本。
    const provider = _windowProvider
    if (!provider) {
      return errorResult(
        'WINDOW_ACTIVATION_UNAVAILABLE',
        __t('server.tools', '窗口切换能力不可用，请连接支持窗口操作的客户端'),
      )
    }

    try {
      const result = await provider.activateWindow(target, context)
      return JSON.stringify({ success: true, message: result })
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      return errorResult(
        'WINDOW_ACTIVATION_FAILED',
        __t('server.tools', '切换窗口失败: {0}', [errMsg]),
      )
    }
  },
}
