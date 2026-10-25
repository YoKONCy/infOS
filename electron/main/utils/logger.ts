/**
 * @file 主进程日志器
 * @description 文件与控制台独立降级；诊断输出失败不能中断应用。
 * @platform ELECTRON
 */
import fs from 'node:fs'
import path from 'node:path'
import { paths, isDev } from './env'
import { stdioGuard } from './stdioGuard'
import { translateDiagnostic } from '../../../packages/shared/src/i18n'

type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG'
const RETRY_INTERVAL = 30_000
// 正式版不依赖启动父进程留下的控制台；排障时可显式开启镜像输出。
const consoleEnabled = isDev || process.env.INFOS_LOG_STDIO === '1'
let currentDate = ''
let logStream: fs.WriteStream | null = null
let retryAfter = 0
let closed = false

function ensureLogDir(): void {
  if (!fs.existsSync(paths.logs)) fs.mkdirSync(paths.logs, { recursive: true })
}
function getDateStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function getTimeStr(): string {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`
}
function destroy(stream: fs.WriteStream): void {
  try {
    stream.destroy()
  } catch {
    /* 清理日志流失败不能再次记录到同一通道。 */
  }
}
function endCurrentStream(): void {
  const stream = logStream
  logStream = null
  try {
    stream?.end()
  } catch {
    if (stream) destroy(stream)
  }
}
function getLogStream(): fs.WriteStream | null {
  if (closed) return null
  const today = getDateStr()
  if (today !== currentDate) {
    endCurrentStream()
    currentDate = today
    retryAfter = 0
  }
  if (logStream && !logStream.destroyed && !logStream.writableEnded && logStream.writable)
    return logStream
  if (Date.now() < retryAfter) return null
  try {
    ensureLogDir()
    const stream = fs.createWriteStream(path.join(paths.logs, `infos-${today}.log`), { flags: 'a' })
    const failed = () => {
      // 旧流迟到的错误不影响轮转后或重试打开的新流。
      if (logStream === stream) {
        logStream = null
        retryAfter = Date.now() + RETRY_INTERVAL
      }
      destroy(stream)
    }
    stream.on('error', failed)
    stream.on('close', () => {
      if (logStream === stream) {
        logStream = null
        retryAfter = Date.now() + RETRY_INTERVAL
      }
    })
    logStream = stream
    return stream
  } catch {
    logStream = null
    retryAfter = Date.now() + RETRY_INTERVAL
    return null
  }
}
function lineFor(level: LogLevel, tag: string, message: string): string {
  try {
    message = translateDiagnostic(message)
  } catch {
    /* 翻译失败仍保留原始诊断。 */
  }
  return `[${getTimeStr()}] [${level}] [${tag}] ${message}`
}
function writeFile(line: string): void {
  let stream: fs.WriteStream | null = null
  try {
    stream = getLogStream()
    stream?.write(line + '\n')
  } catch {
    if (stream && logStream === stream) logStream = null
    retryAfter = Date.now() + RETRY_INTERVAL
    if (stream) destroy(stream)
  }
}
function write(level: LogLevel, tag: string, message: string): void {
  if (closed) return
  try {
    const line = lineFor(level, tag, message)
    // 先记录文件，再尝试可选的控制台镜像；两条通道互不依赖。
    writeFile(line)
    if (!consoleEnabled) return
    const method =
      level === 'ERROR' ? 'error' : level === 'WARN' ? 'warn' : level === 'DEBUG' ? 'debug' : 'log'
    stdioGuard.write(level === 'ERROR' || level === 'WARN' ? 'stderr' : 'stdout', () =>
      console[method](line),
    )
  } catch {
    // 日志入口不能抛出第二个异常，也不能在失败分支递归调用自身。
  }
}

/** 全局异常只同步落盘，不使用可能已经损坏的控制台或异步日志流。 */
function critical(tag: string, message: string): void {
  if (closed) return
  try {
    ensureLogDir()
    fs.appendFileSync(
      path.join(paths.logs, `infos-${getDateStr()}.log`),
      lineFor('ERROR', tag, message) + '\n',
    )
  } catch {
    // 文件不可写时交由异常展示保留原始错误，不再尝试其他日志通道。
  }
}

export const logger = {
  info: (tag: string, message: string) => write('INFO', tag, message),
  warn: (tag: string, message: string) => write('WARN', tag, message),
  error: (tag: string, message: string) => write('ERROR', tag, message),
  debug: (tag: string, message: string) => write('DEBUG', tag, message),
  critical,
  close: () => {
    closed = true
    endCurrentStream()
  },
}
