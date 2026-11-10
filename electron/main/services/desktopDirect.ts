/**
 * @file 「手」的直通通道：不需要观察、不点界面就能做的几件事——剪贴板读写、媒体键、用默认浏览器打开网址。
 *
 * - 都走与键鼠动作同一个护栏入口（desktopActionGuard：禁区、高危名单、信任与预批、执行模式、后端许可），
 *   用一个固定的「程序名」分区：剪贴板 `clipboard`、媒体键 `media-keys`、网址用系统默认浏览器的程序名。
 *   批准后先 consume 再执行，执行后 complete 如实上报。
 * - 媒体键与打开网址会改变用户的电脑，借用 desktopControl.mutate（等用户停手、用户接管即停、显示「她在操作」）。
 * - 剪贴板：密码管理器写入时会带「不要被监视」标记（ExcludeClipboardContentFromMonitorProcessing 等），
 *   带这个标记就不读，报 DESKTOP_CLIPBOARD_PROTECTED。
 * - 网址只收 http / https：其他协议可能拉起任意程序（ms-settings:、file: 等）。
 * - 打开程序仍用 open_application；读写搜索文件走后端 home_files（有备份与撤回）。
 *
 * @platform ELECTRON
 * @see .docs/B02_DESKTOP_AUTOMATION.md 直通通道
 */

import path from 'node:path'
import type { DesktopActionGuard, DesktopCaller, DesktopGuardOutcome } from './desktopControl'

export const DIRECT_ACTIONS = [
  'clipboard_read',
  'clipboard_write',
  'media_key',
  'open_url',
] as const
export type DirectAction = (typeof DIRECT_ACTIONS)[number]

/** 媒体键：工具参数名 → 桥接按键名。 */
export const MEDIA_KEYS: Record<string, string> = {
  play_pause: 'PLAYPAUSE',
  next: 'MEDIANEXT',
  previous: 'MEDIAPREV',
  stop: 'MEDIASTOP',
  volume_up: 'VOLUMEUP',
  volume_down: 'VOLUMEDOWN',
  mute: 'VOLUMEMUTE',
}

/** 密码管理器等写剪贴板时用来表示「别监视、别进历史」的格式名。 */
export const PROTECTED_CLIPBOARD_FORMATS = [
  'ExcludeClipboardContentFromMonitorProcessing',
  'Clipboard Viewer Ignore',
]

/** 读剪贴板最多返回的字数。 */
export const CLIPBOARD_READ_MAX = 20_000
export const CLIPBOARD_WRITE_MAX = 100_000

export interface DirectDeps {
  guard: DesktopActionGuard
  assertAvailable(signal?: AbortSignal): void
  /** 占用桌面执行（等用户停手、用户接管即停）。 */
  mutate<T>(caller: DesktopCaller, action: (signal: AbortSignal) => Promise<T>): Promise<T>
  readClipboard(): Promise<{ text: string; hasImage: boolean; formats: string[] }>
  clipboardProtected(): Promise<boolean>
  writeClipboard(text: string): Promise<void>
  sendMediaKey(key: string, times: number, signal: AbortSignal): Promise<unknown>
  /** 系统默认浏览器的程序路径；查不到返回 undefined。 */
  defaultBrowser(): Promise<string | undefined>
  openExternal(url: string): Promise<void>
}

const fail = (code: string, text: string) => new Error(`${code}: ${text}`)

/** 校验网址：只收 http / https，不收带账号密码的写法。 */
export function checkUrl(value: unknown): URL {
  let url: URL
  try {
    url = new URL(String(value ?? '').trim())
  } catch {
    throw fail('DESKTOP_URL_INVALID', '请提供完整网址（http:// 或 https:// 开头）')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw fail('DESKTOP_URL_INVALID', '只能打开 http / https 网址；打开程序用 open_application')
  if (url.username || url.password) throw fail('DESKTOP_URL_INVALID', '网址里不能带账号密码')
  if (url.href.length > 2000) throw fail('DESKTOP_URL_INVALID', '网址太长')
  return url
}

/**
 * 走护栏：批准后 consume，执行，complete 如实上报。
 * 等待批准期间用户可能按了停止、关了总开关、锁了屏：consume 前后都再核对一次，不通过就不执行。
 * 执行模式随 caller 传给护栏（手动模式下每个动作都要用户点一次）。
 */
async function guarded<T>(
  deps: DirectDeps,
  caller: DesktopCaller,
  target: { program: string; title: string },
  input: Record<string, unknown>,
  run: () => Promise<T>,
): Promise<T> {
  const outcome = ((await deps.guard(caller, target, {
    ...input,
    // 护栏按调用方身份判断执行模式；身份只来自后端附带的 caller，不来自模型参数。
    __desktopCaller: { executionMode: caller.executionMode },
  })) ?? {}) as DesktopGuardOutcome
  // 还没 consume：不通过时许可自然作废，不用上报。
  deps.assertAvailable(caller.signal)
  await outcome.consume?.()
  try {
    deps.assertAvailable(caller.signal)
  } catch (error) {
    await outcome.complete?.('failed', 'cancelled before dispatch')
    throw error
  }
  try {
    const result = await run()
    await outcome.complete?.('success')
    return result
  } catch (error) {
    await outcome.complete?.('failed', String(error).slice(0, 200))
    throw error
  }
}

/** capabilityProvider 的 `desktopDirect` 入口。 */
export async function handleDesktopDirect(
  input: Record<string, unknown>,
  caller: DesktopCaller,
  deps: DirectDeps,
): Promise<unknown> {
  const action = String(input.action ?? '') as DirectAction
  if (!DIRECT_ACTIONS.includes(action))
    throw fail(
      'DESKTOP_ACTION_UNSUPPORTED',
      '直通通道只支持 clipboard_read、clipboard_write、media_key、open_url',
    )
  deps.assertAvailable(caller.signal)
  if (action === 'clipboard_read') {
    if (await deps.clipboardProtected())
      throw fail('DESKTOP_CLIPBOARD_PROTECTED', '剪贴板里是密码管理器等标记为保密的内容，不读取')
    return guarded(
      deps,
      caller,
      { program: 'clipboard', title: '剪贴板' },
      { action },
      async () => {
        if (await deps.clipboardProtected())
          throw fail(
            'DESKTOP_CLIPBOARD_PROTECTED',
            '剪贴板里是密码管理器等标记为保密的内容，不读取',
          )
        const content = await deps.readClipboard()
        const truncated = content.text.length > CLIPBOARD_READ_MAX
        return {
          success: true,
          text: truncated ? content.text.slice(0, CLIPBOARD_READ_MAX) : content.text,
          ...(truncated ? { truncated: true, length: content.text.length } : {}),
          hasImage: content.hasImage,
        }
      },
    )
  }
  if (action === 'clipboard_write') {
    if (typeof input.text !== 'string')
      throw fail('DESKTOP_TEXT_REQUIRED', '请提供要放进剪贴板的文字')
    if (input.text.length > CLIPBOARD_WRITE_MAX) throw fail('DESKTOP_TEXT_TOO_LONG', '最多十万字')
    const text = input.text
    return guarded(
      deps,
      caller,
      { program: 'clipboard', title: '剪贴板' },
      { action, text },
      async () => {
        await deps.writeClipboard(text)
        return { success: true, length: text.length }
      },
    )
  }
  if (action === 'media_key') {
    const key = MEDIA_KEYS[String(input.key ?? '')]
    if (!key)
      throw fail('DESKTOP_HOTKEY_INVALID', `媒体键只能是 ${Object.keys(MEDIA_KEYS).join('、')}`)
    const times = Math.max(1, Math.min(10, Math.round(Number(input.times ?? 1)) || 1))
    return guarded(
      deps,
      caller,
      { program: 'media-keys', title: '媒体键' },
      { action, key: input.key, times },
      () =>
        deps.mutate(caller, async (signal) => {
          await deps.sendMediaKey(key, times, signal)
          return { success: true, key: input.key, times }
        }),
    )
  }
  const url = checkUrl(input.url)
  const browser = await deps.defaultBrowser().catch(() => undefined)
  const program = browser ? path.win32.basename(browser) : 'default-browser'
  return guarded(deps, caller, { program, title: url.host }, { action, url: url.href }, () =>
    deps.mutate(caller, async (signal) => {
      signal.throwIfAborted()
      await deps.openExternal(url.href)
      return {
        success: true,
        url: url.href,
        browser: program,
        message: '已用默认浏览器打开。要在页面里操作，用 get_active_windows 找到浏览器窗口再观察。',
      }
    }),
  )
}
