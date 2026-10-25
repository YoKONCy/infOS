import { t as __t } from './i18n'
/**
 * @file 运行环境与路径检测
 * @description— 路径永远不能硬编码
 *              支持三种模式: 开发环境 / 发行版(安装包+Steam) / 便携版
 * @platform ELECTRON
 * @module electron/main/utils/env
 */

import path from 'node:path'
import fs from 'node:fs'
import { app } from 'electron'
import { isPackagedRuntime } from './runtimeMode'
import { stdioGuard } from './stdioGuard'

// ─── 便携模式检测 ──────────────────────────────────────────
// exe 同目录下存在 `.portable` 标记文件 → 便携模式
// 数据存储在 exe 同目录的 `data/` 中，不依赖 %APPDATA%
function detectPortableMode(exePath: string): boolean {
  try {
    const markerPath = path.join(path.dirname(exePath), '.portable')
    return fs.existsSync(markerPath)
  } catch {
    return false
  }
}

// ─── 环境标记 ────────────────────────────────────────────
export const isPackaged = isPackagedRuntime
export const isDev = !isPackaged
export const isPortable = isPackaged && detectPortableMode(app.getPath('exe'))

// ─── 用户数据根目录 ─────────────────────────────────────
function resolveUserData(): string {
  if (isPortable) {
    // 便携模式：用户根位于 exe 同级，业务数据写入其 data/ 子目录。
    const dir = path.dirname(app.getPath('exe'))
    if (process.env.INFOS_LOG_STDIO === '1')
      stdioGuard.write('stdout', () =>
        console.log(__t('electron.logs.utils', '[Env] 便携模式，用户根目录: {0}', [dir])),
      )
    return dir
  }

  if (isDev) {
    // 开发模式：Electron 与独立 Daemon 统一使用 ~/.infos。
    const devDir = path.join(app.getPath('home'), '.infos')
    stdioGuard.write('stdout', () =>
      console.log(__t('electron.logs.utils', '[Env] 开发模式，数据目录: {0}', [devDir])),
    )
    return devDir
  }

  // 标准安装版与 Steam 版使用系统 userData，卸载/更新不会删除业务数据。
  return app.getPath('userData')
}

const appUserData = resolveUserData()

/**
 * 业务数据目录必须与后端 PERO_DATA_DIR 完全一致。
 * 开发模式直接使用 ~/.infos；打包版使用 userData/data；便携版使用 exe/data。
 */
const appDataDir = isDev ? appUserData : path.join(appUserData, 'data')

// ─── 统一路径工厂 ───────────────────────────────────────
export const paths = {
  /** 用户数据根目录 */
  userData: appUserData,
  /** Electron 应用路径（asar 内） */
  app: app.getAppPath(),
  /** 可执行文件路径 */
  exe: app.getPath('exe'),
  /** 资源目录（生产环境为 resources/） */
  resources: process.resourcesPath,
  /** 与后端共享的业务数据目录 */
  data: appDataDir,
  /** 日志目录 */
  logs: path.join(appDataDir, 'logs'),
  /** 可写模型目录（本地导入/用户资源） */
  models: path.join(appDataDir, 'models'),
  /** 运行时缓存目录（可安全清理，不参与云同步） */
  cache: path.join(appDataDir, 'cache'),
} as const

/**
 * 系统默认的用户数据目录 (%APPDATA%/...)
 * 无论当前模式如何，始终指向系统目录
 * 用于 Logger 的双写: 开发模式日志同时存在于项目目录 + 系统目录
 */
export const systemUserData = app.getPath('userData')
