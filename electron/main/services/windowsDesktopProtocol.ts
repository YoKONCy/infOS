/**
 * @file Windows 桥接的启动脚本、编译缓存与请求超时规则（纯函数，便于单独测试）。
 *
 * - 启动：桥接 C# 源码按内容哈希编译成缓存 DLL，之后启动直接加载（不再每次编译，首次约 10–20 秒）；
 *   缓存不可用（加载失败、目录不可写）时退回内存编译，行为与原来一致。开始编译时先输出一行
 *   `{"compiling":true}`，TS 侧据此提示用户「正在准备桌面组件」并放宽启动超时。
 * - 超时：单个请求超时只取消这一个请求，不再杀掉整个桥接进程；执行线程长时间卡死（多个请求超时后
 *   仍无响应）才回收进程。注入类请求超时时结果不确定，按「已发出」处理。
 *
 * @platform WINDOWS
 * @see windowsDesktop.ts
 */

import { createHash } from 'node:crypto'
import path from 'node:path'

/** 只读请求：用户动鼠标键盘不会打断它们，超时也不会造成未确认的输入。与 C# 的 ActiveReadOnly 一致。 */
export const READ_ONLY_OPERATIONS = new Set([
  'windows',
  'active',
  'window',
  'position',
  'observe',
  'focus',
  'state',
  'ocr',
  'capture',
  'release',
  'windowAt',
  'findText',
])

/** 各请求的超时（毫秒）；没列出的用 DEFAULT_REQUEST_TIMEOUT_MS。 */
export const REQUEST_TIMEOUTS_MS: Record<string, number> = {
  observe: 15_000,
  ocr: 20_000,
  capture: 12_000,
  findText: 6_000,
}
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
/** 启动等待：已在编译时放宽到 COMPILE_START_TIMEOUT_MS。 */
export const START_TIMEOUT_MS = 20_000
export const COMPILE_START_TIMEOUT_MS = 60_000
/** 超时被放弃的请求过了这么久仍没有任何回音，视为执行线程卡死，回收桥接进程。 */
export const HUNG_BRIDGE_MS = 30_000

export function requestTimeout(operation: string): number {
  return REQUEST_TIMEOUTS_MS[operation] ?? DEFAULT_REQUEST_TIMEOUT_MS
}

/** 桥接 C# 用到的程序集；源码变了或引用变了都会换缓存文件。 */
const ASSEMBLIES =
  'UIAutomationClient,UIAutomationTypes,WindowsBase,System.Web.Extensions,System.Drawing'
const REFERENCES =
  '$refs=@([System.Windows.Automation.AutomationElement].Assembly.Location,[System.Windows.Automation.ControlType].Assembly.Location,[System.Windows.Rect].Assembly.Location,[System.Web.Script.Serialization.JavaScriptSerializer].Assembly.Location,[System.Drawing.Bitmap].Assembly.Location,"System.dll","System.Core.dll")'

/** 桥接 DLL 的缓存路径：按源码与引用的哈希命名。 */
export function bridgeAssemblyFile(cacheDir: string, source: string): string {
  const hash = createHash('sha256').update(ASSEMBLIES).update(source).digest('hex').slice(0, 16)
  return path.join(cacheDir, `infos-desktop-${hash}.dll`)
}

/**
 * PowerShell 启动脚本（以分号连接成一行）。源码从标准输入第一行读入（base64）；
 * 缓存 DLL 路径经环境变量 INFOS_DESKTOP_ASSEMBLY 传入，为空时只做内存编译；
 * 编译时记下的哈希经 INFOS_DESKTOP_ASSEMBLY_SHA256 传入，比对不上就重新编译。
 * 新编译出缓存 DLL 时输出一行 `{"assembly":"<sha256>"}`，TS 侧记下这个哈希。
 */
export function bootstrapScript(): string {
  return [
    '$ErrorActionPreference="Stop"',
    '[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)',
    '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)',
    '$source=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::ReadLine()))',
    `Add-Type -AssemblyName ${ASSEMBLIES}`,
    REFERENCES,
    '$dll=$env:INFOS_DESKTOP_ASSEMBLY',
    '$want=$env:INFOS_DESKTOP_ASSEMBLY_SHA256',
    // 按字节加载：先算哈希，与编译时记下的一致才加载，读取与加载之间文件被换掉也无效。
    'function InfOSHash([byte[]]$b){[BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($b)).Replace("-","").ToLowerInvariant()}',
    'if($dll -and $want -and (Test-Path -LiteralPath $dll)){try{$b=[IO.File]::ReadAllBytes($dll);if((InfOSHash $b) -eq $want){[void][Reflection.Assembly]::Load([byte[]]$b)}}catch{}}',
    `if(-not ("InfOSDesktop" -as [type])){[Console]::Out.WriteLine('{"compiling":true}');[Console]::Out.Flush();if($dll){$tmp=$dll+"."+$PID+".dll";try{New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dll)|Out-Null;Add-Type -TypeDefinition $source -ReferencedAssemblies $refs -OutputAssembly $tmp;$b=[IO.File]::ReadAllBytes($tmp);$h=InfOSHash $b;Move-Item -LiteralPath $tmp -Destination $dll -Force;[void][Reflection.Assembly]::Load([byte[]]$b);[Console]::Out.WriteLine('{"assembly":"'+$h+'"}');[Console]::Out.Flush()}catch{Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue}}}`,
    'if(-not ("InfOSDesktop" -as [type])){Add-Type -TypeDefinition $source -ReferencedAssemblies $refs}',
    '[InfOSDesktop]::Run()',
  ].join(';')
}

/** 超时的请求结果是否不确定（注入类请求可能已经发出了一部分输入）。 */
export function timeoutUncertain(operation: string): boolean {
  return !READ_ONLY_OPERATIONS.has(operation)
}
