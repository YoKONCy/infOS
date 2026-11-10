/**
 * 桌面卡片 — 角色设计的桌面小组件（阶段 4）：卡片元数据、限制、归一化与沙箱规则
 *
 * 卡片是一段由角色编写的 HTML（可含 CSS 与 JS），在独立的沙箱窗口中通过
 * `infos-card://<卡片 ID>/` 加载，不能联网，只能经卡片专用 preload 暴露的 `window.infosCard`
 * 读取少量白名单数据。本模块只包含纯数据与纯函数，主进程与后端工具共用。
 *
 * @see .docs/P03_DESKTOP_SHELL.md 阶段 4
 */

import {
  normalizeOpacity,
  normalizeShellRect,
  type ShellMinSize,
  type ShellRect,
} from './desktopShell'
import { normalizeHomeCardBinding, type HomeCardBinding } from './homeCardChannel'
import { normalizeDesktopPrefabMeta, type DesktopPrefabMeta } from './desktopPrefabs'

export * from './desktopPrefabs'
export * from './desktopFence'

/** 加载卡片的自定义协议。 */
export const DESKTOP_CARD_SCHEME = 'infos-card'
/** 卡片文件夹（Electron 用户数据目录下）。 */
export const DESKTOP_CARD_FOLDER = 'desktop-cards'
export const DESKTOP_CARD_MANIFEST = 'card.json'
export const DESKTOP_CARD_DOCUMENT = 'index.html'

export const DESKTOP_CARD_LIMITS = {
  /** 单张卡片的 HTML（UTF-8 字节），图片用 data URI 内联。 */
  html: 512 * 1024,
  name: 60,
  /** 同时存在的卡片数（含已收藏但未打开的）。 */
  cards: 30,
  /** 每张卡片每分钟可读取数据的次数。 */
  requestsPerMinute: 30,
  /** 订阅数据的最短间隔。 */
  subscribeIntervalMs: 10_000,
  /** 每张卡片可同时订阅的数据项数。 */
  subscriptions: 4,
  /** 卡片桌面通知的正文长度上限（字符）。 */
  toastMessage: 200,
  /** 每张卡片每分钟可发出的桌面通知数。 */
  toastsPerMinute: 6,
} as const

/** 卡片比功能面板小得多。 */
export const CARD_MIN_SIZE: ShellMinSize = { width: 120, height: 80 }
export const CARD_DEFAULT_SIZE = { width: 320, height: 220 } as const

/**
 * 卡片页面的内容安全策略：只能使用本卡片的内联脚本与样式，图片与字体允许 data URI；
 * 不能联网（`connect-src 'none'`），不能嵌套页面，不能提交表单或改写 base。
 */
export const DESKTOP_CARD_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ')

/** 卡片可读取的数据（阶段 4 精简版只开放不含用户内容的项）。 */
export const DESKTOP_CARD_DATA = ['time', 'theme'] as const
export type DesktopCardDataName = (typeof DESKTOP_CARD_DATA)[number]

export function isDesktopCardDataName(value: unknown): value is DesktopCardDataName {
  return typeof value === 'string' && (DESKTOP_CARD_DATA as readonly string[]).includes(value)
}

/** 卡片 preload 与主进程之间的通道名；只接受卡片窗口自己发来的请求。 */
/** 卡片可发起的动作；主进程按枚举统一校验，未知动作一律拒绝。 */
export const DESKTOP_CARD_ACTIONS = ['save', 'pin', 'close', 'toast', 'reload'] as const
export type DesktopCardAction = (typeof DESKTOP_CARD_ACTIONS)[number]

export const DESKTOP_CARD_CHANNELS = {
  /** 卡片标题栏需要的信息（名称、收藏、置顶与界面文案） */
  info: 'desktop-card:info',
  /** 读取白名单数据 */
  data: 'desktop-card:data',
  /** 在主窗口打开功能页（或聚焦已摘出的面板） */
  openPage: 'desktop-card:open-page',
  /**
   * 卡片动作的统一通道：标题栏按钮与 `infosCard.close()` / `togglePin()` / `toast(message)`。
   * 参数为 `(action, payload?)`，动作见 `DESKTOP_CARD_ACTIONS`；新增动作只需加枚举值并在主进程实现。
   */
  control: 'desktop-card:control',
  /** 主进程推送：标题栏信息变化 */
  changed: 'desktop-card:changed',
  homeGet: 'desktop-card:home-get',
  homeSend: 'desktop-card:home-send',
  homeData: 'desktop-card:home-data',
  homeMessage: 'desktop-card:home-message',
  interaction: 'desktop-card:interaction',
} as const

/**
 * 主窗口 / 桌面面板（设置页）管理卡片的通道：卡片本身之外的查看与关闭入口，
 * 卡片页面隐藏了标题栏时用户仍能关闭或删除它。只接受主窗口与桌面面板的请求。
 */
export const DESKTOP_CARD_ADMIN_CHANNELS = {
  list: 'desktop-card-admin:list',
  show: 'desktop-card-admin:show',
  close: 'desktop-card-admin:close',
  remove: 'desktop-card-admin:remove',
  /** 改名、收藏、置顶、开机自动打开（`DesktopCardAdminPatch`） */
  patch: 'desktop-card-admin:patch',
  /** 读取卡片源码（只读查看） */
  source: 'desktop-card-admin:source',
} as const

/** 临时卡片关闭后在「最近关闭」里保留的时长；期间可以收藏捡回，过期后清理。 */
export const DESKTOP_CARD_RECENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/** 卡片页可以修改的字段；未给出的字段保持不变。 */
export interface DesktopCardAdminPatch {
  name?: string
  saved?: boolean
  alwaysOnTop?: boolean
  autoOpen?: boolean
}

/** 卡片页列表项：卡片信息、缩略图（PNG data URL，没有时省略）与「最近关闭」的过期时间。 */
export interface DesktopCardListItem extends DesktopCardMeta {
  thumbnail?: string
  expiresAt?: string
}

/** 「最近关闭」中的卡片何时过期；不在最近关闭里时返回 undefined。 */
export function desktopCardExpiresAt(card: DesktopCardMeta): string | undefined {
  if (card.saved || !card.closedAt) return undefined
  return new Date(Date.parse(card.closedAt) + DESKTOP_CARD_RECENT_RETENTION_MS).toISOString()
}

/** 最近关闭的临时卡片是否已超过保留期。 */
export function isDesktopCardExpired(card: DesktopCardMeta, now: number): boolean {
  const expiresAt = desktopCardExpiresAt(card)
  return expiresAt !== undefined && Date.parse(expiresAt) <= now
}

/** 卡片窗口的按键（Electron before-input-event 的子集）。 */
export interface DesktopCardKeyInput {
  type: string
  key: string
  control: boolean
  meta: boolean
  alt: boolean
  shift: boolean
}

/**
 * 关闭卡片的快捷键：Ctrl+W（macOS 为 Cmd+W）。由主进程在页面收到按键之前拦截，
 * 卡片脚本无法阻止。
 */
export function isDesktopCardCloseShortcut(input: DesktopCardKeyInput): boolean {
  return (
    input.type === 'keyDown' &&
    input.key.toLowerCase() === 'w' &&
    (input.control || input.meta) &&
    !input.alt &&
    !input.shift
  )
}

/** 保存在 card.json 中的卡片信息。 */
export interface DesktopCardMeta {
  id: string
  homeBinding?: HomeCardBinding
  name: string
  bounds?: ShellRect
  alwaysOnTop: boolean
  opacity: number
  /** 已收藏：应用退出后保留，下次启动恢复。未收藏的卡片关闭或退出后进「最近关闭」，7 天后清理。 */
  saved: boolean
  /** 窗口是否打开；收藏的卡片关闭后保留在卡片库中，可再次打开。 */
  open: boolean
  /** 贴到桌面底层（阶段 5，仅 Windows）；打开时重新挂接。 */
  desktopLayer: boolean
  /** 开机自动打开：只对收藏的卡片生效，不论上次退出时是否打开。 */
  autoOpen: boolean
  /** 临时卡片关闭的时间：在「最近关闭」里保留 7 天，收藏或重新打开时清除。 */
  closedAt?: string
  /** 预制件（受信任的内置卡片，见 desktopPrefabs.ts）；没有时是角色写的普通卡片。 */
  prefab?: DesktopPrefabMeta
  createdAt: string
  updatedAt: string
}

/** 卡片 ID：小写字母、数字与连字符，由主进程生成。 */
export function isDesktopCardId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,47}$/.test(value)
}

// eslint-disable-next-line no-control-regex -- 名称显示在标题栏，去掉不可见控制字符。
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/g

/** 卡片名称：去掉首尾空白与控制字符，截断到上限；为空时返回空字符串。 */
export function normalizeDesktopCardName(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(CONTROL_CHARACTERS, ' ').trim().slice(0, DESKTOP_CARD_LIMITS.name)
}

/** HTML 超出上限或不是字符串时返回 false。 */
export function isDesktopCardHtml(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    new TextEncoder().encode(value).length <= DESKTOP_CARD_LIMITS.html
  )
}

/** 卡片窗口的 `card:<ID>` 目标写法。 */
export function desktopCardTarget(id: string): string {
  return `card:${id}`
}

/** 卡片页面地址；只有这一页，资源全部内联。 */
export function desktopCardUrl(id: string): string {
  return `${DESKTOP_CARD_SCHEME}://${id}/${DESKTOP_CARD_DOCUMENT}`
}

/** 卡片窗口可以加载的地址：本卡片的 `infos-card://<ID>/`，以及内联的 data / blob 资源。 */
export function isDesktopCardRequestAllowed(id: string, url: string): boolean {
  if (url.startsWith('data:') || url.startsWith(`blob:${DESKTOP_CARD_SCHEME}://${id}/`)) return true
  try {
    const parsed = new URL(url)
    return parsed.protocol === `${DESKTOP_CARD_SCHEME}:` && parsed.host === id
  } catch {
    return false
  }
}

/** 协议请求只提供 index.html（根路径同样指向它），其他路径一律不存在。 */
export function desktopCardDocumentPath(id: string, url: string): boolean {
  try {
    const parsed = new URL(url)
    return (
      parsed.protocol === `${DESKTOP_CARD_SCHEME}:` &&
      parsed.host === id &&
      (parsed.pathname === '/' || parsed.pathname === `/${DESKTOP_CARD_DOCUMENT}`)
    )
  } catch {
    return false
  }
}

/** 读取 card.json：ID 以文件夹名为准，无效字段使用默认值；名称为空时用 ID。 */
export function normalizeDesktopCardMeta(value: unknown, id: string): DesktopCardMeta {
  const item = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const bounds = normalizeShellRect(item.bounds, CARD_MIN_SIZE)
  const prefab = normalizeDesktopPrefabMeta(item.prefab)
  const time = (field: unknown) =>
    typeof field === 'string' && !Number.isNaN(Date.parse(field))
      ? field
      : new Date(0).toISOString()
  return {
    id,
    ...(normalizeHomeCardBinding(item.homeBinding)
      ? { homeBinding: normalizeHomeCardBinding(item.homeBinding) }
      : {}),
    name: normalizeDesktopCardName(item.name) || id,
    ...(bounds ? { bounds } : {}),
    alwaysOnTop: item.alwaysOnTop === true,
    opacity: normalizeOpacity(item.opacity),
    saved: item.saved === true,
    open: item.open !== false,
    desktopLayer: item.desktopLayer === true,
    autoOpen: item.autoOpen === true,
    ...(typeof item.closedAt === 'string' && !Number.isNaN(Date.parse(item.closedAt))
      ? { closedAt: item.closedAt }
      : {}),
    ...(prefab ? { prefab } : {}),
    createdAt: time(item.createdAt),
    updatedAt: time(item.updatedAt),
  }
}
