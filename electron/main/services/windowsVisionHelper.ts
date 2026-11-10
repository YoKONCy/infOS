/**
 * @file 编译并缓存 Windows 视觉助手（文字识别、Windows.Graphics.Capture 窗口截图）。
 *
 * 助手引用 WinRT 元数据，`Add-Type` 无法编译，改用系统自带的 .NET Framework `csc.exe`。
 * 编译结果按源码哈希缓存在用户数据目录，只在第一次使用或源码变化时编译（约 1–3 秒）。
 * 编译失败（找不到 csc.exe 或 WinRT 元数据、系统过旧）不影响桥接其他功能，调用方拿到稳定错误码与原因。
 *
 * @platform WINDOWS
 * @see windowsVisionSource.ts
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { assemblyIntegrity, sha256File, type AssemblyIntegrity } from './home/assemblyIntegrity'
import { WINDOWS_VISION_SOURCE } from './windowsVisionSource'

/** 助手用到的 WinRT 元数据；Windows 10 与 11 的文件名一致，缺哪个就不引用哪个，由编译器报具体缺失。 */
export const VISION_WINMDS = [
  'Windows.Foundation.winmd',
  'Windows.Globalization.winmd',
  'Windows.Graphics.winmd',
  'Windows.Media.winmd',
  'Windows.Storage.winmd',
]

export interface VisionToolchain {
  csc: string
  references: string[]
}

/** 找到 csc.exe 与引用文件；缺少时抛 `DESKTOP_VISION_UNAVAILABLE` 并说明缺什么。 */
export function visionToolchain(
  windowsDir = process.env.SystemRoot ?? 'C:\\Windows',
  exists: (file: string) => boolean = fs.existsSync,
): VisionToolchain {
  const framework = ['Framework64', 'Framework']
    .map((name) => path.win32.join(windowsDir, 'Microsoft.NET', name, 'v4.0.30319'))
    .find((dir) => exists(path.win32.join(dir, 'csc.exe')))
  if (!framework)
    throw new Error('DESKTOP_VISION_UNAVAILABLE: 系统没有 .NET Framework 4 的 csc.exe')
  const metadata = path.win32.join(windowsDir, 'System32', 'WinMetadata')
  const winmds = VISION_WINMDS.map((name) => path.win32.join(metadata, name)).filter(exists)
  if (!winmds.length)
    throw new Error(
      'DESKTOP_VISION_UNAVAILABLE: 系统没有 WinRT 元数据（需要 Windows 10 或更新版本）',
    )
  return {
    csc: path.win32.join(framework, 'csc.exe'),
    references: [
      ...winmds,
      path.win32.join(framework, 'System.Runtime.WindowsRuntime.dll'),
      path.win32.join(framework, 'System.Runtime.dll'),
      'System.dll',
    ],
  }
}

/** csc.exe 的参数：每个引用单独一个参数，避免路径里的空格被拆开。 */
export function visionCompileArgs(
  toolchain: VisionToolchain,
  output: string,
  source: string,
): string[] {
  return [
    '/nologo',
    '/target:library',
    '/optimize+',
    `/out:${output}`,
    ...toolchain.references.map((reference) => `/r:${reference}`),
    source,
  ]
}

/** 按源码内容命名缓存文件：源码变化后自动重新编译，旧文件不会被误用。 */
export function visionHelperFile(cacheDir: string, source = WINDOWS_VISION_SOURCE): string {
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 16)
  return path.join(cacheDir, `infos-vision-${hash}.dll`)
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 60_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${stdout}${stderr}`.trim() || error.message))
      else resolve(stdout)
    })
  })
}

let pending: { dir: string; promise: Promise<string> } | undefined
let failure: { dir: string; reason: string; at: number } | undefined
/** 编译失败后多久再试一次（毫秒）；期间直接返回上次的原因。 */
const RETRY_AFTER_MS = 10 * 60_000

/**
 * 返回可加载的助手 DLL 路径；没有缓存时编译。失败抛 `DESKTOP_VISION_UNAVAILABLE`，原因截取前 300 字。
 * 同一进程内并发调用共用一次编译。
 *
 * 缓存文件与编译时记下的 SHA-256 不一致（或没有记录）时删掉重新编译；桥接加载时再按字节比对一次，
 * 见 assemblyIntegrity.ts。
 */
export function ensureVisionHelper(
  cacheDir: string,
  integrity: AssemblyIntegrity = assemblyIntegrity,
): Promise<string> {
  const output = visionHelperFile(cacheDir)
  if (integrity.verifyOrRemove(output)) return Promise.resolve(output)
  if (failure?.dir === cacheDir && Date.now() - failure.at < RETRY_AFTER_MS)
    return Promise.reject(new Error(failure.reason))
  if (pending?.dir === cacheDir) return pending.promise
  const promise = (async () => {
    const toolchain = visionToolchain()
    fs.mkdirSync(cacheDir, { recursive: true })
    const source = `${output}.${process.pid}.cs`
    const temporary = `${output}.${process.pid}.dll`
    fs.writeFileSync(source, WINDOWS_VISION_SOURCE, 'utf8')
    try {
      await run(toolchain.csc, visionCompileArgs(toolchain, temporary, source))
      // 先记下刚编译出的哈希再改名，改名后被替换的文件在加载前会被发现。
      integrity.record(output, sha256File(temporary))
      fs.renameSync(temporary, output)
      return output
    } catch (error) {
      const detail = (error instanceof Error ? error.message : String(error)).slice(0, 300)
      throw new Error(
        detail.startsWith('DESKTOP_VISION_UNAVAILABLE')
          ? detail
          : `DESKTOP_VISION_UNAVAILABLE: 视觉组件编译失败：${detail}`,
      )
    } finally {
      fs.rmSync(source, { force: true })
      fs.rmSync(temporary, { force: true })
    }
  })()
  pending = { dir: cacheDir, promise }
  // 在调用方的 await 之前清掉 pending（反应按注册顺序执行），下一次调用会重新校验缓存文件。
  const settle = () => {
    if (pending?.promise === promise) pending = undefined
  }
  void promise.then(
    () => {
      failure = undefined
      settle()
    },
    (error: Error) => {
      failure = { dir: cacheDir, reason: error.message, at: Date.now() }
      settle()
    },
  )
  return promise
}
