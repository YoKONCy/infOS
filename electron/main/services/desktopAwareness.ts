import { t as __t } from '../utils/i18n'
/**
 * 桌面感知服务
 *
 * Electron 专属的桌面环境感知能力：
 * - 屏幕截图      → desktopCapturer (Electron 内置)
 * - 剪贴板读写    → clipboard (Electron 内置)
 * - 前台窗口识别  → PowerShell (Windows) / AppleScript (macOS)
 *
 * 全部零第三方依赖。
 *
 * @platform ELECTRON
 * @module electron/main/services/desktopAwareness
 */

import { desktopCapturer, clipboard, ClipboardItem, nativeImage, screen } from 'electron'
import { exec } from 'node:child_process'
import { logger } from '../utils/logger'
import type { DesktopRect } from './desktopCoordinates'
import { screenshotMaxWidth, screenshotPixelRect } from './screenshotGeometry'

// ── 屏幕截图 ──

export interface ScreenshotResult {
  /** Base64 编码的 PNG 数据 */
  dataUrl: string
  /** 实际截图宽度 */
  width: number
  /** 实际截图高度 */
  height: number
  /** Electron 显示器 ID */
  displayId: string
  /** 显示器在桌面 DIP 坐标系中的边界 */
  bounds: DesktopRect
  /** 显示器可用工作区 */
  workArea: DesktopRect
  /** 显示器 DPI 缩放因子 */
  scaleFactor: number
  /** 截图时间戳 */
  timestamp: number
}

/**
 * 截取目标屏幕或其中的区域，按选区所需分辨率采集后再限制输出宽度。
 *
 * @param maxWidth 最大宽度 (缩放以节省 token), 默认 1280
 */
export async function captureScreen(
  maxWidth = 1280,
  options: { displayId?: string; bounds?: DesktopRect } = {},
): Promise<ScreenshotResult | null> {
  try {
    maxWidth = screenshotMaxWidth(maxWidth)
    const display = options.displayId
      ? screen.getAllDisplays().find((item) => String(item.id) === options.displayId)
      : screen.getPrimaryDisplay()
    if (!display) throw new Error('DESKTOP_DISPLAY_NOT_FOUND: 显示器已断开')
    let bounds = { ...display.bounds }
    if (options.bounds) {
      const requested = options.bounds
      if (
        ![requested.x, requested.y, requested.width, requested.height].every(Number.isFinite) ||
        requested.width <= 0 ||
        requested.height <= 0
      )
        throw new Error(
          __t('errors.electron', 'SCREENSHOT_REGION_INVALID: 选区必须是参考画面内的有效矩形'),
        )
      const left = Math.max(bounds.x, requested.x)
      const top = Math.max(bounds.y, requested.y)
      const right = Math.min(bounds.x + bounds.width, requested.x + requested.width)
      const bottom = Math.min(bounds.y + bounds.height, requested.y + requested.height)
      if (right <= left || bottom <= top)
        throw new Error('SCREEN_CAPTURE_REGION_INVALID: 窗口不在目标显示器内')
      bounds = { x: left, y: top, width: right - left, height: bottom - top }
    }
    // 以选区宽度决定采样密度，避免先缩小整屏后再放大局部小字。
    const density = Math.min(display.scaleFactor, maxWidth / bounds.width)
    const targetWidth = Math.max(1, Math.ceil(display.bounds.width * density))
    const targetHeight = Math.max(
      1,
      Math.round((targetWidth * display.bounds.height) / display.bounds.width),
    )
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: targetWidth, height: targetHeight },
    })

    if (sources.length === 0) {
      logger.warn('DesktopAwareness', __t('electron.logs.desktopAwareness', '未找到可截取的屏幕'))
      return null
    }

    const primary = sources.find((source) => String(source.display_id) === String(display.id))
    if (!primary) {
      logger.warn('DesktopAwareness', __t('electron.logs.desktopAwareness', '未找到主显示器截图源'))
      return null
    }
    let thumbnail = primary.thumbnail
    if (options.bounds) {
      const size = thumbnail.getSize()
      const displayBounds = display.bounds
      const pixels = screenshotPixelRect(
        {
          x: ((bounds.x - displayBounds.x) * size.width) / displayBounds.width,
          y: ((bounds.y - displayBounds.y) * size.height) / displayBounds.height,
          width: (bounds.width * size.width) / displayBounds.width,
          height: (bounds.height * size.height) / displayBounds.height,
        },
        size,
      )
      // 坐标原点与实际裁切像素一致，避免小数舍入造成点击偏移。
      bounds = {
        x: displayBounds.x + (pixels.x * displayBounds.width) / size.width,
        y: displayBounds.y + (pixels.y * displayBounds.height) / size.height,
        width: (pixels.width * displayBounds.width) / size.width,
        height: (pixels.height * displayBounds.height) / size.height,
      }
      thumbnail = thumbnail.crop(pixels)
    }
    if (thumbnail.getSize().width > maxWidth)
      thumbnail = thumbnail.resize({ width: maxWidth, quality: 'best' })
    const size = thumbnail.getSize()
    if (size.width <= 0 || size.height <= 0 || thumbnail.isEmpty()) {
      throw new Error('SCREEN_CAPTURE_EMPTY: 截图结果为空')
    }

    return {
      dataUrl: thumbnail.toDataURL(),
      width: size.width,
      height: size.height,
      displayId: String(display.id),
      bounds,
      workArea: { ...display.workArea },
      scaleFactor: display.scaleFactor,
      timestamp: Date.now(),
    }
  } catch (err) {
    logger.error('DesktopAwareness', __t('electron.logs.desktopAwareness', '截屏失败: {0}', [err]))
    return null
  }
}

// ── 剪贴板 ──

export interface ClipboardContent {
  text: string
  hasImage: boolean
  formats: string[]
}

/** 读取剪贴板内容 */
export async function readClipboard(): Promise<ClipboardContent> {
  const items = await clipboard.read()
  const formats = [...new Set(items.flatMap((item) => item.types))]
  const textItem = items.find((item) => item.types.includes('text/plain'))
  return {
    text: textItem ? await (await textItem.getType('text/plain')).text() : '',
    hasImage: formats.some((type) => type.startsWith('image/')),
    formats,
  }
}

/** 写入文本到剪贴板 */
export async function writeClipboard(text: string): Promise<void> {
  await clipboard.writeText(text)
}

/** 读取剪贴板图片 (Base64) */
export async function readClipboardImage(): Promise<string | null> {
  const items = await clipboard.read()
  const item =
    items.find((entry) => entry.types.includes('image/png')) ??
    items.find((entry) => entry.types.some((type) => type.startsWith('image/')))
  if (!item) return null
  const type = item.types.includes('image/png')
    ? 'image/png'
    : item.types.find((type) => type.startsWith('image/'))!
  const blob = await item.getType(type)
  if (!('arrayBuffer' in blob)) return null
  const img = nativeImage.createFromBuffer(Buffer.from(await blob.arrayBuffer()))
  if (img.isEmpty()) return null
  return img.toDataURL()
}

/** 写入图片到剪贴板 */
export async function writeClipboardImage(dataUrl: string): Promise<void> {
  const img = nativeImage.createFromDataURL(dataUrl)
  await clipboard.write([
    new ClipboardItem({
      'image/png': new Blob([Uint8Array.from(img.toPNG())], { type: 'image/png' }),
    }),
  ])
}

// ── 前台窗口识别 ──

export interface ActiveWindowInfo {
  title: string
  processName: string
  pid: number
}

/**
 * 获取当前前台窗口信息
 *
 * Windows: PowerShell Get-Process
 * macOS: osascript
 * Linux: xdotool
 *
 * 零第三方依赖。
 */
export function getActiveWindow(): Promise<ActiveWindowInfo | null> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      // PowerShell 一行命令获取前台窗口
      const cmd = `powershell -NoProfile -Command "
        Add-Type @'
          using System;
          using System.Runtime.InteropServices;
          public class User32 {
            [DllImport(\\"user32.dll\\")]
            public static extern IntPtr GetForegroundWindow();
            [DllImport(\\"user32.dll\\", SetLastError=true)]
            public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
            [DllImport(\\"user32.dll\\", CharSet=CharSet.Unicode)]
            public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);
          }
'@
        $hwnd = [User32]::GetForegroundWindow()
        $sb = New-Object System.Text.StringBuilder(256)
        [void][User32]::GetWindowText($hwnd, $sb, 256)
        $pid = 0
        [void][User32]::GetWindowThreadProcessId($hwnd, [ref]$pid)
        $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
        $name = if ($proc) { $proc.ProcessName } else { 'unknown' }
        Write-Output \\"$($sb.ToString())|$name|$pid\\"
      "`

      exec(cmd, { timeout: 3000 }, (err, stdout) => {
        if (err) {
          resolve(null)
          return
        }
        const parts = stdout.trim().split('|')
        if (parts.length >= 3) {
          resolve({
            title: parts[0] ?? '',
            processName: parts[1] ?? '',
            pid: parseInt(parts[2] ?? '0', 10) || 0,
          })
        } else {
          resolve(null)
        }
      })
    } else if (process.platform === 'darwin') {
      const cmd = `osascript -e 'tell application "System Events" to get {name, unix id} of first process whose frontmost is true'`
      exec(cmd, { timeout: 3000 }, (err, stdout) => {
        if (err) {
          resolve(null)
          return
        }
        const parts = stdout.trim().split(', ')
        resolve({
          title: parts[0] ?? '',
          processName: parts[0] ?? '',
          pid: parseInt(parts[1] ?? '0', 10) || 0,
        })
      })
    } else {
      // Linux: xdotool
      exec('xdotool getactivewindow getwindowname', { timeout: 3000 }, (err, stdout) => {
        if (err) {
          resolve(null)
          return
        }
        resolve({
          title: stdout.trim(),
          processName: '',
          pid: 0,
        })
      })
    }
  })
}
