/// <reference lib="dom" />
import { ipcRenderer } from 'electron'
import { normalizeLocale, registerCatalog, translate } from '../../packages/shared/src/i18n'
import zhCN from '../../packages/shared/src/i18n/locales/zh-CN/electron/ui/desktopEntry.json'
import zhTW from '../../packages/shared/src/i18n/locales/zh-TW/electron/ui/desktopEntry.json'
import enUS from '../../packages/shared/src/i18n/locales/en-US/electron/ui/desktopEntry.json'

registerCatalog('electron.ui.desktopEntry', 'zh-CN', zhCN)
registerCatalog('electron.ui.desktopEntry', 'zh-TW', zhTW)
registerCatalog('electron.ui.desktopEntry', 'en-US', enUS)

/** 只覆盖新建桌面文档；启动器、桌宠、子应用及普通标签导航均不进入此流程。 */
export function installDesktopEntry(): void {
  if (!/^#\/(?:app)?(?:[?]|$)/.test(location.hash) && location.hash !== '') return
  let disposed = false
  let revealing = false
  let finished = false
  let failure = false
  let root: HTMLElement | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  let revealDeadline: ReturnType<typeof setTimeout> | undefined
  let styleDeadline: ReturnType<typeof setTimeout> | undefined
  let holdDeadline: ReturnType<typeof setTimeout> | undefined
  let releaseHold: (() => void) | undefined
  let visibleAt: number | undefined
  let settleStyles: ((ready: boolean) => void) | undefined
  let stylesheetLoaded = Promise.resolve(false)
  let bodyObserver: MutationObserver | undefined
  let language = normalizeLocale(navigator.language)
  const animations = new Set<Animation>()
  const t = (source: string) => translate('electron.ui.desktopEntry', source, [], language)
  // 角部先松开，上斜面抬起、下切片沉落，最后退开左侧主面；避免整屏同向扫走。
  const facets = [
    { transform: 'translate3d(-110%, 30%, 0)', duration: 1120, delay: 160 },
    { transform: 'translate3d(-22%, -112%, 0)', duration: 1060, delay: 80 },
    { transform: 'translate3d(110%, -32%, 0)', duration: 880, delay: 0 },
    { transform: 'translate3d(36%, 112%, 0)', duration: 1050, delay: 170 },
  ]
  function updateLanguage(value: unknown): void {
    if (disposed || finished) return
    language = normalizeLocale(value)
    if (!root) return
    root.setAttribute('aria-label', t('正在加载桌面界面'))
    root.querySelector('[data-entry-status]')!.textContent = t(
      failure ? '桌面界面未能就绪，请重试。' : '正在加载桌面界面',
    )
    root.querySelector('[data-entry-retry]')!.textContent = t('重新加载')
    root.querySelector('[data-entry-close]')!.textContent = t('关闭窗口')
    root.querySelector('[data-entry-window-close]')!.setAttribute('aria-label', t('关闭窗口'))
    root.querySelector('[data-entry-minimize]')!.setAttribute('aria-label', t('最小化'))
  }
  const onLanguage = (_event: Electron.IpcRendererEvent, value: unknown) => updateLanguage(value)
  const onVisibility = (_event: Electron.IpcRendererEvent, value: unknown) => {
    // 原生窗口可能先在后台绘制；首次显示或恢复时，重新给品牌留出可读时间。
    if (value === true && !revealing && !finished && !disposed) visibleAt = performance.now()
  }
  ipcRenderer.on('i18n:changed', onLanguage)
  ipcRenderer.on('window-visibility-changed', onVisibility)
  void ipcRenderer
    .invoke('i18n:get-language')
    .then(updateLanguage)
    .catch(() => {})
  function motion(): string {
    const level = document.documentElement.dataset.desktopEntryMotion
    if (level === 'off' || level === 'reduced') return level
    try {
      const saved = localStorage.getItem('infos.ui.motionLevel')
      if (saved === 'off' || saved === 'reduced') return saved
    } catch {
      /* 无法读取缓存时仍尊重系统减弱动效设置。 */
    }
    return matchMedia('(prefers-reduced-motion: reduce)').matches ? 'reduced' : 'full'
  }
  function complete(): void {
    if (finished || disposed) return
    finished = true
    clearTimeout(deadline)
    clearTimeout(revealDeadline)
    releaseHold?.()
    settleStyles?.(false)
    for (const animation of animations) animation.cancel()
    animations.clear()
    observer.disconnect()
    root?.remove()
    document.getElementById('app')?.removeAttribute('inert')
    delete document.documentElement.dataset.desktopEntry
    ipcRenderer.off('i18n:changed', onLanguage)
    ipcRenderer.off('window-visibility-changed', onVisibility)
    window.dispatchEvent(new Event('infos:desktop-entry-finished'))
  }
  async function animate(
    element: Element,
    frames: Keyframe[],
    duration: number,
    delay = 0,
    start?: number,
  ) {
    const animation = element.animate(frames, {
      duration,
      delay,
      easing: 'cubic-bezier(.65,0,.2,1)',
      fill: 'both',
    })
    if (start !== undefined) animation.startTime = start
    animations.add(animation)
    try {
      await animation.finished
    } catch {
      /* 关闭文档或关闭动效时取消未完成动画。 */
    }
  }
  async function holdIdentity(): Promise<void> {
    if (motion() !== 'full' || visibleAt === undefined) return
    // 从样式可见或原生窗口显示的较晚时刻计时，慢加载已展示的时间无需再等。
    const remaining = 1100 - (performance.now() - visibleAt)
    if (remaining <= 0) return
    await new Promise<void>((resolve) => {
      releaseHold = () => {
        clearTimeout(holdDeadline)
        releaseHold = undefined
        resolve()
      }
      holdDeadline = setTimeout(() => releaseHold?.(), remaining)
    })
  }
  async function reveal(): Promise<void> {
    if (!root || revealing || disposed || finished) return
    revealing = true
    clearTimeout(deadline)
    root.querySelector('[data-entry-actions]')!.setAttribute('hidden', '')
    if (motion() === 'off') {
      complete()
      return
    }
    if (!(await stylesheetLoaded) || disposed || finished) {
      complete()
      return
    }
    // 先绘制被遮住的真实页面并准备图层，再开始位移；不边展开边建立首帧。
    document.documentElement.dataset.desktopEntry = 'preparing'
    root.dataset.phase = 'preparing'
    root.style.background = ''
    await holdIdentity()
    if (disposed || finished) return
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    )
    if (disposed || finished) return
    const level = motion()
    root.dataset.motion = level
    root.dataset.phase = 'revealing'
    document.documentElement.dataset.desktopEntry = 'revealing'
    if (level === 'off') {
      complete()
      return
    }
    // 已收到真实就绪信号后才允许兜底释放；隐藏窗口时丢失完成回调也不困住页面。
    revealDeadline = setTimeout(complete, level === 'reduced' ? 600 : 1800)
    const start = document.timeline?.currentTime
    const clock = typeof start === 'number' ? start : undefined
    try {
      if (level === 'reduced') await animate(root, [{ opacity: 1 }, { opacity: 0 }], 180, 0, clock)
      else {
        const identity = root.querySelector('.desktop-entry-identity')!
        const opacity = getComputedStyle(identity).opacity
        await Promise.all([
          ...[...root.querySelectorAll('[data-entry-facet]')].map((facet, i) =>
            animate(
              facet,
              [{ transform: 'translate3d(0,0,0)' }, { transform: facets[i]!.transform }],
              facets[i]!.duration,
              facets[i]!.delay,
              clock,
            ),
          ),
          animate(
            identity,
            [
              { opacity, transform: 'translate3d(-50%,-50%,0) scale(1)', offset: 0 },
              { opacity, transform: 'translate3d(-50%,-50%,0) scale(1)', offset: 0.22 },
              { opacity: 0, transform: 'translate3d(-50%,-50%,0) scale(.98)', offset: 1 },
            ],
            640,
            80,
            clock,
          ),
          animate(
            root.querySelector('.desktop-entry-scrim')!,
            [{ opacity: 1 }, { opacity: 0 }],
            900,
            140,
            clock,
          ),
          animate(
            root.querySelector('.desktop-entry-window-actions')!,
            [{ opacity: 1 }, { opacity: 0 }],
            240,
            0,
            clock,
          ),
        ])
      }
    } catch {
      // 页面已经就绪；动效不可用时直接交接，不让装饰层阻止使用。
    } finally {
      complete()
    }
  }
  const observer = new MutationObserver(() => {
    if (document.documentElement.dataset.desktopEntryReady === 'true') void reveal()
    if (root) root.dataset.motion = motion()
    if (motion() !== 'full') releaseHold?.()
    if (revealing && motion() === 'off') complete()
  })
  function mount(): void {
    if (disposed) return
    root = document.createElement('div')
    root.id = 'infos-desktop-entry'
    root.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:#18243a'
    root.setAttribute('role', 'dialog')
    root.setAttribute('aria-modal', 'true')
    // 裁切形状保持静止，只移动各自的 HTML 外层；避免每帧变换同一 SVG 内的路径。
    root.innerHTML = `<div class="desktop-entry-scrim" aria-hidden="true"></div><div class="desktop-entry-facets" aria-hidden="true"><div data-entry-facet="0"><i></i></div><div data-entry-facet="1"><i></i></div><div data-entry-facet="2"><i></i></div><div data-entry-facet="3"><i></i></div></div><div class="desktop-entry-identity"><img class="desktop-entry-mark" src="./infos-mark.svg" alt=""/><img class="desktop-entry-wordmark" src="./infos-wordmark.svg" alt="infOS"/><p data-entry-status role="status"></p><div class="desktop-entry-pixels" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div><div data-entry-actions hidden><button type="button" data-entry-retry></button><button type="button" data-entry-close></button></div></div>`
    root.insertAdjacentHTML(
      'afterbegin',
      '<div class="desktop-entry-drag"></div><div class="desktop-entry-window-actions"><button type="button" data-entry-minimize>—</button><button type="button" data-entry-window-close>×</button></div>',
    )
    const style = document.createElement('link')
    style.rel = 'stylesheet'
    style.href = './desktop-entry.css'
    stylesheetLoaded = new Promise<boolean>((resolve) => {
      let settled = false
      settleStyles = (ready) => {
        if (settled) return
        settled = true
        clearTimeout(styleDeadline)
        if (ready) visibleAt = performance.now()
        resolve(ready)
      }
      style.addEventListener('load', () => settleStyles?.(true), { once: true })
      style.addEventListener('error', () => settleStyles?.(false), { once: true })
      styleDeadline = setTimeout(() => settleStyles?.(false), 2000)
    })
    document.head.append(style)
    document.documentElement.dataset.desktopEntry = 'waiting'
    document.getElementById('app')?.setAttribute('inert', '')
    document.body.append(root)
    root.dataset.phase = 'waiting'
    root.dataset.motion = motion()
    root.querySelector('[data-entry-retry]')!.addEventListener('click', () => location.reload())
    const close = () => {
      void ipcRenderer.invoke('window-close').catch(() => {})
    }
    root.querySelector('[data-entry-close]')!.addEventListener('click', close)
    root.querySelector('[data-entry-window-close]')!.addEventListener('click', close)
    root.querySelector('[data-entry-minimize]')!.addEventListener('click', () => {
      void ipcRenderer.invoke('window-minimize').catch(() => {})
    })
    updateLanguage(language)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-desktop-entry-ready', 'data-desktop-entry-motion'],
    })
    deadline = setTimeout(() => {
      if (!root || disposed || revealing) return
      failure = true
      root.dataset.failed = 'true'
      root.querySelector('[data-entry-actions]')!.removeAttribute('hidden')
      updateLanguage(language)
    }, 30_000)
    if (document.documentElement.dataset.desktopEntryReady === 'true') void reveal()
  }
  // 在 HTML 的 body 出现时立即盖住内容，不等业务模块下载与 DOMContentLoaded。
  if (document.body) mount()
  else {
    bodyObserver = new MutationObserver(() => {
      if (!document.body) return
      bodyObserver?.disconnect()
      mount()
    })
    bodyObserver.observe(document, { childList: true, subtree: true })
  }
  window.addEventListener(
    'DOMContentLoaded',
    () => {
      if (!finished && !disposed) document.getElementById('app')?.setAttribute('inert', '')
    },
    { once: true },
  )
  window.addEventListener(
    'pagehide',
    () => {
      disposed = true
      clearTimeout(deadline)
      clearTimeout(revealDeadline)
      releaseHold?.()
      settleStyles?.(false)
      observer.disconnect()
      bodyObserver?.disconnect()
      ipcRenderer.off('i18n:changed', onLanguage)
      ipcRenderer.off('window-visibility-changed', onVisibility)
      for (const animation of animations) animation.cancel()
      root?.remove()
      document.getElementById('app')?.removeAttribute('inert')
      delete document.documentElement.dataset.desktopEntry
    },
    { once: true },
  )
}
