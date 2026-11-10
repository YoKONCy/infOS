/**
 * 自定义主题 — 选择、载入并注入当前主题的样式
 *
 * 选中的主题按设备保存（与深色 / 浅色切换一致）。主题样式放在 <head> 末尾的独立 <style> 中，
 * 覆盖 tokens.css / ui-tokens.css 的变量；取消选择即移除，页面回到 infOS 默认外观。
 */

import { ref } from 'vue'
import {
  DESKTOP_SHELL_CHANNELS,
  rewriteCustomThemeUrls,
  type CustomThemeSummary,
} from '@infos/shared'
import { themeApi } from '../../api/modules/themeApi'
import { isElectron, listen } from '../../utils/ipcAdapter'
import { useMainNav } from '../main/useMainNav'

const LS_CUSTOM_THEME = 'infos.customTheme'
const STYLE_ID = 'infos-custom-theme'

const selected = ref('')
const themes = ref<CustomThemeSummary[]>([])
/** 服务端主题文件夹的位置。 */
const folder = ref('')
/** 当前主题载入失败的原因；为空表示正常。 */
const loadError = ref('')
let request = 0
let started = false

function readSaved(): string {
  try {
    return localStorage.getItem(LS_CUSTOM_THEME) ?? ''
  } catch {
    return ''
  }
}

function save(themeId: string): void {
  try {
    if (themeId) localStorage.setItem(LS_CUSTOM_THEME, themeId)
    else localStorage.removeItem(LS_CUSTOM_THEME)
  } catch {
    // localStorage 不可用时只在本次会话生效。
  }
}

/** 按需加载的组件样式会追加到 <head>；主题样式始终移回末尾，同等优先级时主题生效。 */
let keepLast: MutationObserver | undefined

function removeStyle(): void {
  keepLast?.disconnect()
  keepLast = undefined
  document.getElementById(STYLE_ID)?.remove()
}

function writeStyle(css: string): void {
  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null
  if (!style) {
    style = document.createElement('style')
    style.id = STYLE_ID
  }
  style.textContent = css
  document.head.appendChild(style)
  keepLast ??= new MutationObserver(() => {
    const current = document.getElementById(STYLE_ID)
    if (current && document.head.lastElementChild !== current) document.head.appendChild(current)
  })
  keepLast.observe(document.head, { childList: true })
}

/** 载入并注入主题样式；连续切换时只保留最后一次的结果。 */
async function apply(themeId: string): Promise<void> {
  const current = ++request
  if (!themeId) {
    removeStyle()
    loadError.value = ''
    return
  }
  try {
    const css = await themeApi.stylesheet(themeId)
    if (current !== request) return
    writeStyle(rewriteCustomThemeUrls(css, (path) => themeApi.fileUrl(themeId, path)))
    loadError.value = ''
  } catch (cause) {
    if (current !== request) return
    removeStyle()
    loadError.value = cause instanceof Error ? cause.message : String(cause)
  }
}

/** 选择主题；主题声明了适用模式时同时切换深色 / 浅色。 */
async function select(themeId: string): Promise<void> {
  selected.value = themeId
  save(themeId)
  const mode = themes.value.find((theme) => theme.id === themeId)?.mode
  if (mode) useMainNav().setTheme(mode)
  await apply(themeId)
}

async function refresh(): Promise<void> {
  const library = (await themeApi.list()).data
  themes.value = library?.themes ?? []
  folder.value = library?.folder ?? ''
}

/** 连接到服务端后调用；重复调用时重新载入当前主题（例如上次因未连接而失败）。 */
function start(): Promise<void> {
  if (!started) {
    started = true
    selected.value = readSaved()
    window.addEventListener('storage', syncFromStorage)
    // 角色通过外壳工具切换主题时，主进程广播到每个窗口（阶段 3）。
    if (isElectron()) void listen(DESKTOP_SHELL_CHANNELS.customTheme, receiveShellTheme)
  }
  return apply(selected.value)
}

// 其他窗口切换主题时同步，与深色 / 浅色的跨窗口同步一致。
function syncFromStorage(event: StorageEvent): void {
  if (event.key !== LS_CUSTOM_THEME) return
  selected.value = event.newValue ?? ''
  void apply(selected.value)
}

/** 先刷新主题列表（角色可能刚写入新主题），再按主题声明的模式切换并应用。 */
function receiveShellTheme(themeId: unknown): void {
  if (typeof themeId !== 'string') return
  void refresh()
    .catch(() => undefined)
    .then(() => select(themeId))
}

export function useCustomTheme() {
  return { selected, themes, folder, loadError, select, refresh, start, apply }
}
