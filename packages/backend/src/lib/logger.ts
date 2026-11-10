import { t as __t } from './i18n'
import { perceptionReadOnly, redactPerception } from '../services/conversation/perceptionContext'
/**
 * 日志工具
 *
 * 基于 consola 封装带模块标签的 logger 实例。
 * 同时支持终端输出 + 文件持久化 (08_LOGGING_SPEC.md)。
 *
 * 日志文件存放在 $PERO_DATA_DIR/logs/ 下，
 * 按天轮转、单文件 5MB 上限、14 天自动清理。
 *
 * 更深入的集成 (Electron IPC 转发 / Docker 采集)
 * 留到对应阶段实现。
 *
 * @module packages/backend/src/lib/logger
 */

import { createConsola, type ConsolaReporter, type LogObject } from 'consola'
import { LOG_LEVEL, getDataDir } from './env'
import { LogFileTransport, formatLogLine, type LogFileConfig } from './logFileTransport'
import path from 'node:path'

// ─────────────────────────────────────────────
// 文件 Transport (全局单例)
// ─────────────────────────────────────────────

/** 文件 Transport 实例 (懒初始化) */
let fileTransport: LogFileTransport | null = null

/**
 * 初始化日志文件持久化
 *
 * 在 app 启动时调用一次，之后所有 logger 实例自动写入文件。
 * 如果不调用此函数，日志只输出到终端。
 *
 * @param config - 日志文件配置 (可选，默认使用 $PERO_DATA_DIR/logs)
 */
export function initLogFile(config?: Partial<LogFileConfig>): void {
  const logDir = config?.logDir ?? path.join(getDataDir(), 'logs')

  fileTransport = new LogFileTransport({
    logDir,
    maxFileSize: config?.maxFileSize,
    retentionDays: config?.retentionDays,
    prefix: config?.prefix,
  })

  // 用 console.log 而不是 logger 避免循环
  console.log(__t('logs.lib', '[infOS] 日志文件已启用: {0}', [fileTransport.getLogPath()]))
}

/** 获取文件 Transport (给外部查询日志路径用) */
export function getLogFileTransport(): LogFileTransport | null {
  return fileTransport
}

// ─────────────────────────────────────────────
// 文件 Reporter (consola 插件)
// ─────────────────────────────────────────────

/** consola 文件持久化 reporter */
const fileReporter: ConsolaReporter = {
  log(logObj: LogObject) {
    if (!fileTransport) return

    // 提取 tag
    const tag = logObj.tag ?? ''

    // 提取消息文本
    const message = logObj.args
      .map((arg) => {
        if (typeof arg === 'string') return arg
        if (arg instanceof Error) return arg.message
        return ''
      })
      .filter(Boolean)
      .join(' ')

    // 提取结构化参数 (非字符串、非 Error)
    const structuredArgs = logObj.args.filter(
      (arg) => typeof arg !== 'string' && !(arg instanceof Error) && arg != null,
    )

    const line = formatLogLine(logObj.level, tag, message, structuredArgs)
    fileTransport.write(line)
  },
}

// ─────────────────────────────────────────────
// Logger 工厂
// ─────────────────────────────────────────────

import { sseReporter } from './logBroadcaster'

// ── 动态日志级别管理 ──
// 初始级别来自 env.ts 的 LOG_LEVEL：
//   dev 模式默认 debug(4)，release 默认 info(3)，PERO_LOG_LEVEL 环境变量可覆盖。
// 启动后可调用 setLogLevel() 应用用户配置（system.logLevel），实现动态调整。
let currentLogLevel = LOG_LEVEL

/** 所有已创建的 consola 实例（setLogLevel 遍历更新 level） */
const activeLoggers = new Set<{ level: number }>()

/** 日志级别标签 → consola 数字级别 */
const LEVEL_LABEL_TO_NUM: Record<string, number> = {
  fatal: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
  trace: 5,
}

/**
 * 解析日志级别标签为 consola 数字级别
 *
 * 支持: fatal/error/warn/info/debug/trace（大小写不敏感）
 *
 * @param label 日志级别标签（如 "debug"）
 * @returns 合法级别数字 (0-5)；非法标签返回 null
 */
export function parseLogLevel(label: string): number | null {
  const num = LEVEL_LABEL_TO_NUM[label.trim().toLowerCase()]
  return num ?? null
}

/** 获取当前日志级别（consola 数字级别，0=fatal ... 5=trace） */
export function getLogLevel(): number {
  return currentLogLevel
}

/**
 * 动态设置所有 logger 实例的日志级别
 *
 * 使用场景：
 * - 启动时应用用户配置 system.logLevel（覆盖 dev=debug / release=info 默认行为）
 * - Dashboard 保存日志级别设置后即时生效（无需重启）
 *
 * @param level consola 数字级别 (0=fatal ... 5=trace)
 */
export function setLogLevel(level: number): void {
  currentLogLevel = level
  for (const instance of activeLoggers) {
    instance.level = level
  }
}

/**
 * 创建带模块标签的 logger 实例
 *
 * 自动同时输出到终端 (consola 默认) 和日志文件 (如已初始化)。
 *
 * @param module - 模块名称，用于日志标签
 * @example
 * ```ts
 * const logger = createLogger('MemoryService')
 * logger.info('记忆创建成功', { id: 42 })
 * ```
 */
export function createLogger(module: string) {
  const instance = createConsola({
    level: currentLogLevel,
  }).withTag(module)

  // 注册到活跃实例集合，支持 setLogLevel 动态调整级别
  activeLoggers.add(instance)

  // 追加文件持久化 reporter（不覆盖默认终端输出）
  instance.addReporter(fileReporter)

  // 追加 SSE 广播 reporter（Dashboard 终端实时日志）
  instance.addReporter(sseReporter)

  // 感知调用链不输出正文或供应商异常；调度器在链外记录类别、次数和结果。
  return new Proxy(instance, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver)
      if (typeof key === 'string' && ['log', 'info', 'debug', 'trace', 'warn', 'error', 'fatal', 'success', 'verbose'].includes(key) && typeof value === 'function')
        return (...args: unknown[]) => { if (!perceptionReadOnly()) return value.apply(target, redactPerception(args)) }
      return value
    },
  })
}

/** 根 logger（不带模块标签） */
export const logger = createLogger('infOS')
