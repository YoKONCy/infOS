import { t as __t } from '../utils/i18n'
import { createHash, randomUUID } from 'node:crypto'
import type { BrowserObserverFrame } from '@infos/shared'
import { AsyncLocalStorage } from 'node:async_hooks'
import {
  WebContentsView,
  app,
  nativeImage,
  session,
  type NativeImage,
  type WebContents,
} from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { desktopTabs } from '../windows/desktopTabs'
import {
  browserInvocationScope,
  assertBrowserTargetScope,
  type BrowserInvocationScope,
} from './browserScope'
import {
  mapScreenshotRegion,
  screenshotMaxWidth,
  screenshotPixelRect,
  type ScreenshotRect,
} from './screenshotGeometry'

interface BrowserViewport {
  width: number
  height: number
  scrollX: number
  scrollY: number
  revision: number
  zoomFactor: number
}

interface BrowserScreenshot {
  owner: string
  targetId: string
  scopeKey: string
  generation: number
  createdAt: number
  viewport: BrowserViewport
  bounds: ScreenshotRect
  width: number
  height: number
}

interface BrowserTarget {
  scope: BrowserInvocationScope
  id: string
  view: WebContentsView
  tabId: string
  retained: boolean
  overlay?: WebContentsView
  createdAt: string
  lastUsedAt: string
  generation: number
  previousSnapshot?: {
    snapshotId: string
    contentHash: string
    structureHash: string
    elementIds: string[]
  }
  pendingDialog?: { type: string; message: string; defaultPrompt?: string }
  debuggerReady?: Promise<void>
  debuggerEventsBound?: boolean
  pendingScreenshot?: Promise<NativeImage>
  pendingObserver?: Promise<BrowserObserverFrame>
  observerFrame?: BrowserObserverFrame
  network: Array<Record<string, unknown>>
}

interface BrowserDownload {
  scopeKey: string
  id: string
  filename: string
  state: 'running' | 'completed' | 'cancelled' | 'failed'
  receivedBytes: number
  totalBytes: number
  path?: string
}

interface ElementDescriptor {
  handle: string
  tag: string
  text: string
  role?: string
  name?: string
  type?: string
  disabled?: boolean
  checked?: boolean
  value?: string
  required?: boolean
  label?: string
  parentFormHandle?: string
  sensitive?: boolean
  valueLength?: number
  imageId?: string
  src?: string
  alt?: string
  bounds?: { x: number; y: number; width: number; height: number }
}

const PARTITION = 'persist:infos-browser'
const SEARCH_ENDPOINT = 'https://www.bing.com/search?q='
const NAVIGATION_TIMEOUT_MS = 15_000
const SCREENSHOT_TIMEOUT_MS = 8_000
// 独立世界只维护观察版本，不向页面脚本暴露截图引用或宿主状态。
const SCREENSHOT_WORLD_ID = 1105
const SCREENSHOT_READ_OPERATIONS = new Set([
  'screenshot',
  'elementScreenshot',
  'inspect',
  'extract',
  'listTargets',
  'domQuery',
  'sourceSearch',
  'frameQuery',
  'runtimeStatus',
  'networkQuery',
  'networkBody',
])
const MAX_TEXT_LENGTH = 120_000
const MAX_TARGETS = 8
const IDLE_TIMEOUT_MS = 5 * 60 * 1000
const SEARCH_CACHE_TTL_MS = 2 * 60 * 1000
const SEARCH_MIN_INTERVAL_MS = 1_200
const SEARCH_ENGINES = {
  google: 'https://www.google.com/search?q=',
  baidu: 'https://www.baidu.com/s?wd=',
  bing_cn: 'https://cn.bing.com/search?q=',
  bing_global: SEARCH_ENDPOINT,
} as const

type SearchEngine = keyof typeof SEARCH_ENGINES

export class ElectronBrowserRuntime {
  private readonly targets = new Map<string, BrowserTarget>()
  private readonly screenshots = new Map<string, BrowserScreenshot>()
  private defaultActiveTargetId?: string
  private readonly scopedActiveTargets = new Map<string, string>()
  private get activeTargetId(): string | undefined {
    const context = this.invocationContext.getStore()
    return context ? context.targetId : this.defaultActiveTargetId
  }
  private set activeTargetId(id: string | undefined) {
    const context = this.invocationContext.getStore()
    if (!context) {
      this.defaultActiveTargetId = id
      return
    }
    context.targetId = id
    if (id) this.scopedActiveTargets.set(context.scope.key, id)
    else this.scopedActiveTargets.delete(context.scope.key)
    if (context.scope.key === 'legacy') this.defaultActiveTargetId = id
  }
  private nextTarget = 1
  private readonly configuredPartitions = new Set<string>()
  private readonly downloadPermissions = new Map<string, boolean>()
  private get downloadsAllowed(): boolean {
    return this.downloadPermissions.get(this.scope().key) ?? false
  }
  private set downloadsAllowed(value: boolean) {
    this.downloadPermissions.set(this.scope().key, value)
  }
  private readonly downloads = new Map<string, BrowserDownload>()
  private readonly downloadDir = path.join(app.getPath('userData'), 'browser-downloads')
  private invocationQueue: Promise<void> = Promise.resolve()
  private rejectActiveInvocation?: (error: Error) => void
  private invocationTargetId?: string
  private invocationRunning = false
  private readonly invocationContext = new AsyncLocalStorage<{
    scope: BrowserInvocationScope
    screenshotCaller?: string
    targetId?: string
    cancelled: boolean
  }>()
  private readonly programmaticCloseTargetIds = new Set<string>()
  private activeOperator = 'Agent'
  private unlockTimer?: NodeJS.Timeout
  private idleTimer?: NodeJS.Timeout
  private lastError?: string
  private lastCloseReason?: string
  private readonly searchCache = new Map<string, { expiresAt: number; result: unknown }>()
  private readonly searchLastAt = new Map<SearchEngine, number>()

  async invoke(
    operation: string,
    input: Record<string, unknown>,
    operatorName = 'Agent',
  ): Promise<unknown> {
    const scope = browserInvocationScope(input.__browserScope, operatorName)
    // 旁观不进入操作队列，不锁页面、不续命、不创建或作废 Agent 截图引用。
    if (operation === 'observeFrame') return this.observeFrame(scope)
    const run = this.invocationQueue.then(() => {
      this.activeOperator = operatorName
      this.touchRuntime()
      return this.invocationContext.run(
        {
          scope,
          screenshotCaller:
            typeof input.__screenshotCaller === 'string' ? input.__screenshotCaller : undefined,
          targetId:
            this.scopedActiveTargets.get(scope.key) ??
            (scope.key === 'legacy' ? this.defaultActiveTargetId : undefined),
          cancelled: false,
        },
        () => this.invokeOnce(operation, input),
      )
    })
    this.invocationQueue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async observeFrame(scope: BrowserInvocationScope): Promise<BrowserObserverFrame> {
    const id = this.scopedActiveTargets.get(scope.key)
    const target = id ? this.targets.get(id) : undefined
    if (!target || target.view.webContents.isDestroyed()) return { state: 'closed' }
    assertBrowserTargetScope(target.scope.key, scope.key)
    const contents = target.view.webContents
    const metadata = () => ({
      targetId: target.id,
      title: contents.getTitle(),
      url: contents.getURL(),
    })
    // Agent 的正式截图优先；旁观采集之间共享请求，避免多个观看端叠加负载。
    if (target.pendingScreenshot) return { state: 'waiting', ...metadata() }
    if (target.observerFrame && Date.now() - target.observerFrame.capturedAt! < 750)
      return target.observerFrame
    if (!target.pendingObserver) {
      const generation = target.generation
      const capture = (async (): Promise<BrowserObserverFrame> => {
        if (!contents.debugger.isAttached() || !target.debuggerEventsBound)
          await this.attachDebugger(target)
        const result = (await contents.debugger.sendCommand('Page.captureScreenshot', {
          format: 'jpeg',
          quality: 60,
          fromSurface: true,
          captureBeyondViewport: false,
        })) as { data?: string }
        if (contents.isDestroyed() || this.targets.get(id!) !== target) return { state: 'closed' }
        if (
          target.generation !== generation ||
          this.scopedActiveTargets.get(scope.key) !== target.id ||
          !result.data
        )
          return { state: 'waiting' }
        let image = nativeImage.createFromBuffer(Buffer.from(result.data, 'base64'))
        if (image.isEmpty()) return { state: 'waiting' }
        const size = image.getSize()
        if (size.width > 960) image = image.resize({ width: 960 })
        const bytes = image.toJPEG(60)
        if (bytes.length > 384_000) return { state: 'paused' }
        const frame: BrowserObserverFrame = {
          state: 'live',
          ...metadata(),
          dataUri: `data:image/jpeg;base64,${bytes.toString('base64')}`,
          ...image.getSize(),
          capturedAt: Date.now(),
        }
        target.observerFrame = frame
        return frame
      })().catch((): BrowserObserverFrame => ({ state: 'paused' }))
      target.pendingObserver = capture
      void capture.then(() => {
        if (target.pendingObserver === capture) target.pendingObserver = undefined
      })
    }
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        target.pendingObserver,
        new Promise<BrowserObserverFrame>((resolve) => {
          timer = setTimeout(() => resolve({ state: 'paused' }), 3_000)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private async invokeOnce(operation: string, input: Record<string, unknown>): Promise<unknown> {
    let rejectTermination!: (error: Error) => void
    const termination = new Promise<never>((_resolve, reject) => {
      rejectTermination = reject
    })
    this.rejectActiveInvocation = rejectTermination
    this.invocationRunning = true
    this.invocationTargetId = this.activeTargetId
    if (this.unlockTimer) clearTimeout(this.unlockTimer)
    this.unlockTimer = undefined
    try {
      const execution = (async () => {
        await this.lockActiveTarget(input)
        if (this.invocationContext.getStore()?.cancelled)
          throw new Error('WEB_OPERATION_CANCELLED: 操作已结束')
        return this.dispatch(operation, input)
      })()
      return await Promise.race([execution, termination])
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      this.rejectActiveInvocation = undefined
      const context = this.invocationContext.getStore()
      if (context) context.cancelled = true
      this.invocationRunning = false
      this.invocationTargetId = undefined
      this.unlockTimer = setTimeout(() => {
        this.unlockTimer = undefined
        this.unlockAllTargets()
      }, 250)
    }
  }

  private async dispatch(operation: string, input: Record<string, unknown>): Promise<unknown> {
    // 坐标动作先验证自己的截图引用，其余页面变更在执行前作废旧图。
    if (
      !SCREENSHOT_READ_OPERATIONS.has(operation) &&
      !['click', 'nativeClick', 'hover'].includes(operation)
    )
      this.clearScreenshots(this.scope().key)
    switch (operation) {
      case 'open':
        return this.open(String(input.url ?? 'about:blank'))
      case 'inspect':
        return this.inspect()
      case 'extract':
        return this.extract()
      case 'search':
        return this.search(input)
      case 'screenshot':
        return this.screenshot(input)
      case 'elementScreenshot':
        return this.elementScreenshot(input)
      case 'click':
      case 'nativeClick':
        if (input.screenshotId !== undefined || input.x !== undefined || input.y !== undefined)
          return this.pointAction(input, false)
        return this.click(String(input.handle ?? input.target ?? ''))
      case 'hover':
        if (input.screenshotId !== undefined || input.x !== undefined || input.y !== undefined)
          return this.pointAction(input, true)
        return this.hover(String(input.handle ?? input.target ?? ''))
      case 'type':
      case 'setValue':
        return this.type(
          String(input.handle ?? input.target ?? ''),
          String(input.text ?? input.value ?? ''),
        )
      case 'sendKeys':
        return this.sendKeys(String(input.keys ?? ''))
      case 'selectOption':
        return this.select(String(input.handle ?? input.target ?? ''), input)
      case 'check':
        return this.check(String(input.handle ?? input.target ?? ''), input.checked !== false)
      case 'scroll':
        return this.scroll(input)
      case 'back':
        return this.back()
      case 'wait':
        return this.wait(input)
      case 'listTargets':
        return this.listTargets()
      case 'createTarget':
        return this.createTarget(String(input.url ?? 'about:blank'), true)
      case 'switchTarget':
        return this.switchTarget(String(input.targetId ?? ''))
      case 'closeTarget':
        return this.closeTarget(String(input.targetId ?? ''))
      case 'domQuery':
        return this.domQuery(input)
      case 'sourceSearch':
        return this.sourceSearch(input)
      case 'frameQuery':
        return this.frameQuery()
      case 'handleDialog':
        return this.handleDialog(input)
      case 'storage':
        return this.storage(input)
      case 'emulate':
        return this.emulate(input)
      case 'evaluate':
        return this.evaluate(String(input.expression ?? ''))
      case 'runtimeStatus':
        return this.status()
      case 'networkQuery':
        return this.networkQuery(input)
      case 'networkBody':
        return this.networkBody(input)
      case 'networkConfigure':
        return this.networkConfigure(input)
      case 'downloadConfigure':
        return this.configureDownload(input)
      case 'uploadFile':
        return this.uploadFile(input)
      default:
        throw new Error(`WEB_OPERATION_UNSUPPORTED: ${operation}`)
    }
  }

  private activateTarget(target: BrowserTarget): void {
    if (this.invocationContext.getStore())
      assertBrowserTargetScope(target.scope.key, this.scope().key)
    if (this.invocationContext.getStore()?.cancelled)
      throw new Error('WEB_OPERATION_CANCELLED: 浏览器操作已结束')
    if (this.activeTargetId !== target.id) this.clearScreenshots(target.scope.key)
    this.activeTargetId = target.id
    // Agent 的操作目标与用户正在查看的标签分别维护。
    const context = this.invocationContext.getStore()
    if (this.invocationRunning && context && !context.cancelled) {
      this.invocationTargetId = target.id
      context.targetId = target.id
    }
  }

  show(): void {
    desktopTabs.reveal(this.activeTarget().tabId)
  }

  private async lockActiveTarget(_input: Record<string, unknown>): Promise<void> {
    const target = this.activeTargetId ? this.targets.get(this.activeTargetId) : undefined
    if (target && !target.view.webContents.isDestroyed()) await this.lockTarget(target)
  }

  private overlayHtml(): string {
    const displayName =
      this.activeOperator === 'system'
        ? 'Agent'
        : this.activeOperator.charAt(0).toUpperCase() + this.activeOperator.slice(1)
    const operator = displayName.replace(
      /[&<>"']/g,
      (character) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
    )
    return `<!doctype html><html><head><meta charset="UTF-8"><style>
      :root{color-scheme:dark;--violet:#a98cff;--violet-2:#7658df}*{box-sizing:border-box}html,body{width:100%;height:100%;margin:0;overflow:hidden;font-family:Inter,"Microsoft YaHei",sans-serif}
      body{display:grid;place-items:center;background:radial-gradient(circle at 50% 48%,rgba(110,76,205,.1),transparent 38%),rgba(10,12,24,.18);user-select:none;cursor:wait}
      .halo{position:absolute;width:390px;height:190px;border:1px solid rgba(169,140,255,.16);border-radius:50%;filter:blur(.2px);animation:halo 2.8s ease-in-out infinite}.halo:after{position:absolute;inset:18px;content:"";border:1px dashed rgba(169,140,255,.16);border-radius:50%;animation:spin 9s linear infinite}
      .card{position:relative;display:grid;grid-template-columns:54px 1fr;gap:15px;align-items:center;min-width:336px;padding:18px 22px;border:1px solid rgba(171,139,255,.5);border-radius:18px;background:linear-gradient(135deg,rgba(29,25,54,.96),rgba(15,21,40,.94));box-shadow:0 20px 70px rgba(6,8,20,.55),0 0 36px rgba(128,89,235,.16),inset 0 1px rgba(255,255,255,.09);overflow:hidden;animation:card-in .35s cubic-bezier(.2,.8,.2,1)}
      .card:before{position:absolute;inset:0;content:"";background:linear-gradient(110deg,transparent 20%,rgba(151,119,255,.16) 45%,transparent 70%);transform:translateX(-120%);animation:sheen 2.2s ease-in-out infinite}.card:after{position:absolute;right:18px;bottom:9px;width:74px;height:2px;content:"";background:linear-gradient(90deg,transparent,var(--violet),transparent);animation:scan 1.8s ease-in-out infinite}
      .orb{position:relative;width:48px;height:48px;border:1px solid rgba(166,132,255,.45);border-radius:15px;background:rgba(123,92,230,.12);box-shadow:inset 0 0 18px rgba(154,118,255,.1)}
      .orbit{position:absolute;inset:5px;border:1px solid rgba(190,168,255,.22);border-radius:12px;animation:orbit 3.6s linear infinite}.cube{position:absolute;top:14px;left:14px;width:19px;height:19px;border:1px solid #d4c6ff;border-radius:6px;background:linear-gradient(145deg,#e2d9ff,#8b65ef 55%,#5136a2);box-shadow:0 6px 18px rgba(137,98,239,.62);animation:float 1.25s cubic-bezier(.37,0,.24,1) infinite}
      .dot{position:absolute;width:4px;height:4px;border-radius:2px;background:#c9b9ff;animation:spark 1.25s ease-out infinite}.d1{top:5px;right:3px}.d2{bottom:5px;left:3px;animation-delay:.24s}
      strong{display:block;color:#f4f0ff;font-size:14px;letter-spacing:.03em}small{display:flex;align-items:center;gap:8px;margin-top:6px;color:#aaa5c4;font-size:11px}.live{color:#c2adff}.live:before{display:inline-block;width:6px;height:6px;margin-right:5px;border-radius:50%;background:var(--violet);box-shadow:0 0 10px var(--violet);content:"";animation:pulse .9s ease-in-out infinite}
      @keyframes card-in{from{opacity:0;transform:translateY(8px) scale(.96)}to{opacity:1;transform:none}}@keyframes halo{0%,100%{opacity:.45;transform:scale(.92)}50%{opacity:.9;transform:scale(1.06)}}@keyframes orbit{to{transform:rotate(360deg)}}@keyframes spin{to{transform:rotate(-360deg)}}@keyframes pulse{50%{opacity:.35;transform:scale(.72)}}@keyframes float{0%,100%{transform:translateY(3px) rotate(-8deg)}50%{transform:translateY(-5px) rotate(95deg)}}@keyframes spark{0%,30%{opacity:0;transform:scale(.5)}55%{opacity:1}100%{opacity:0;transform:translate(3px,-5px) rotate(90deg)}}@keyframes sheen{0%,35%{transform:translateX(-120%)}75%,100%{transform:translateX(120%)}}@keyframes scan{0%,100%{opacity:.2;transform:translateX(-18px)}50%{opacity:1;transform:translateX(18px)}}
    </style></head><body><div class="halo"></div><section class="card"><div class="orb"><i class="orbit"></i><i class="cube"></i><i class="dot d1"></i><i class="dot d2"></i></div><div><strong>${operator} 操作中...</strong><small><span class="live">LIVE</span><span>页面已安全锁定，请稍候</span></small></div></section></body></html>`
  }

  private syncOverlayBounds(target: BrowserTarget): void {
    if (!target.overlay || target.view.webContents.isDestroyed()) return
    const { width, height } = target.view.getBounds()
    target.overlay.setBounds({ x: 0, y: 0, width, height })
  }

  private async lockTarget(target: BrowserTarget): Promise<void> {
    if (target.overlay) return
    const overlay = new WebContentsView({
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
    })
    target.overlay = overlay
    desktopTabs.installShortcuts(overlay.webContents)
    desktopTabs.update(target.tabId, { locked: true })
    overlay.setBackgroundColor('#00000000')
    target.view.addChildView(overlay)
    this.syncOverlayBounds(target)
    await overlay.webContents.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(this.overlayHtml())}`,
    )
    if (!target.view.webContents.isDestroyed()) {
      this.syncOverlayBounds(target)
      target.view.addChildView(overlay)
    }
  }

  private unlockAllTargets(): void {
    for (const target of this.targets.values()) {
      if (target.overlay) {
        if (!target.view.webContents.isDestroyed()) target.view.removeChildView(target.overlay)
        if (!target.overlay.webContents.isDestroyed()) target.overlay.webContents.close()
      }
      target.overlay = undefined
      desktopTabs.update(target.tabId, { locked: false })
    }
  }

  private failActiveInvocation(code: string, message: string): void {
    this.rejectActiveInvocation?.(new Error(`${code}: ${message}`))
  }

  async close(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = undefined
    if (this.invocationRunning)
      this.failActiveInvocation('WEB_RUNTIME_CLOSED', '浏览器运行时已关闭')
    if (this.unlockTimer) clearTimeout(this.unlockTimer)
    this.unlockTimer = undefined
    for (const id of this.targets.keys()) this.programmaticCloseTargetIds.add(id)
    this.unlockAllTargets()
    for (const target of this.targets.values()) {
      if (!target.view.webContents.isDestroyed()) await desktopTabs.close(target.tabId, true)
    }
    this.targets.clear()
    this.screenshots.clear()
    this.scopedActiveTargets.clear()
    this.programmaticCloseTargetIds.clear()
    this.activeTargetId = undefined
    await Promise.all(
      [...this.configuredPartitions].map((partition) =>
        session
          .fromPartition(partition)
          .clearAuthCache()
          .catch(() => undefined),
      ),
    )
  }

  private async loadUrlWithTimeout(contents: WebContents, url: string): Promise<void> {
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        contents.loadURL(this.normalizeUrl(url)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            if (!contents.isDestroyed()) contents.stop()
            reject(new Error(`WEB_NAVIGATION_TIMEOUT: 页面加载超过${NAVIGATION_TIMEOUT_MS}ms`))
          }, NAVIGATION_TIMEOUT_MS)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private touchRuntime(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    const now = new Date().toISOString()
    for (const target of this.targets.values()) target.lastUsedAt = now
    this.idleTimer = setTimeout(() => {
      if (this.invocationRunning) {
        this.touchRuntime()
        return
      }
      this.lastCloseReason = 'idle-timeout'
      const expired = [...this.targets.values()].filter((target) => !target.retained)
      for (const target of expired) this.programmaticCloseTargetIds.add(target.id)
      this.unlockAllTargets()
      for (const target of expired) {
        if (!target.view.webContents.isDestroyed()) void desktopTabs.close(target.tabId, true)
      }
    }, IDLE_TIMEOUT_MS)
  }

  private async search(input: Record<string, unknown>): Promise<unknown> {
    if (Array.isArray(input.queries)) {
      const queries = input.queries
        .map((query) => String(query).trim())
        .filter(Boolean)
        .slice(0, 10)
      if (queries.length === 0) throw new Error('WEB_SEARCH_QUERY_REQUIRED: 缺少搜索关键词')
      const items: unknown[] = []
      const mergedResults: Array<Record<string, unknown>> = []
      const seen = new Set<string>()
      for (const query of queries) {
        try {
          const result = (await this.search({ ...input, queries: undefined, query })) as Record<
            string,
            unknown
          >
          items.push({ query, success: true, result })
          for (const item of (result.results as Array<Record<string, unknown>> | undefined) ?? []) {
            const url = String(item.url ?? '')
            if (!url || seen.has(url)) continue
            seen.add(url)
            mergedResults.push({ ...item, matchedQuery: query })
          }
        } catch (error) {
          items.push({
            query,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
      return { batch: true, queryCount: queries.length, items, results: mergedResults }
    }
    const query = String(input.query ?? '').trim()
    if (!query) throw new Error('WEB_SEARCH_QUERY_REQUIRED: 缺少搜索关键词')
    const requested = String(input.engine ?? 'auto').toLowerCase()
    const engine: SearchEngine =
      requested === 'auto'
        ? /[\u3400-\u9fff]/u.test(query)
          ? 'bing_cn'
          : 'bing_global'
        : requested in SEARCH_ENGINES
          ? (requested as SearchEngine)
          : 'bing_global'
    const maxResults = Math.min(30, Math.max(1, Number(input.maxResults ?? 10)))
    const cacheKey = JSON.stringify({
      partition: this.scope().partition,
      query,
      engine,
      maxResults,
      timeRange: input.timeRange,
      market: input.market,
      safeSearch: input.safeSearch,
    })
    const cached = this.searchCache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now() && input.bypassCache !== true) {
      return { ...(cached.result as Record<string, unknown>), cached: true }
    }
    const waitMs = SEARCH_MIN_INTERVAL_MS - (Date.now() - (this.searchLastAt.get(engine) ?? 0))
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs))
    this.searchLastAt.set(engine, Date.now())
    const url = new URL(`${SEARCH_ENGINES[engine]}${encodeURIComponent(query)}`)
    const market = String(input.market ?? '')
    if (market) {
      url.searchParams.set('mkt', market)
      url.searchParams.set('hl', market)
    }
    const safeSearch = String(input.safeSearch ?? '').toLowerCase()
    if (engine.startsWith('bing') && safeSearch) url.searchParams.set('adlt', safeSearch)
    if (engine === 'google' && safeSearch) {
      url.searchParams.set('safe', safeSearch === 'strict' ? 'active' : 'off')
    }
    if (input.timeRange) {
      if (engine.startsWith('bing'))
        url.searchParams.set('filters', `ex1:${String(input.timeRange)}`)
      if (engine === 'google') url.searchParams.set('tbs', `qdr:${String(input.timeRange)}`)
    }
    await this.open(url.toString())
    const extracted = (await this.activeContents().executeJavaScript(`(() => {
      const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const body = clean(document.body?.innerText || '');
      const blocked = /captcha|verify you are human|unusual traffic|安全验证|人机验证/i.test(body);
      const configs = {
        google: ['div.MjjYud,div.g', 'h3', 'a', '.VwiC3b,.IsZvec'],
        baidu: ['div.result,div.c-container', 'h3,.t', 'h3 a,.t a,a', '.c-abstract,[class*=abstract]'],
        bing: ['li.b_algo,li.b_ans', 'h2,h3', 'h2 a,h3 a,a', '.b_caption p,.b_snippet,p']
      };
      const mode = location.hostname.includes('google') ? 'google' : location.hostname.includes('baidu') ? 'baidu' : 'bing';
      const [containerSelector,titleSelector,linkSelector,snippetSelector] = configs[mode];
      const seen = new Set();
      const results = [...document.querySelectorAll(containerSelector)].flatMap((container) => {
        const titleNode = container.querySelector(titleSelector);
        const linkNode = container.querySelector(linkSelector)?.closest('a') || container.querySelector(linkSelector);
        const title = clean(titleNode?.textContent || linkNode?.textContent);
        const href = linkNode?.href || '';
        if (!title || !/^https?:/i.test(href) || seen.has(href)) return [];
        seen.add(href);
        return [{ title, url: href, snippet: clean(container.querySelector(snippetSelector)?.textContent).slice(0, 1000) }];
      }).slice(0, ${maxResults}).map((item,index) => ({ rank:index + 1, ...item }));
      return { effectiveUrl: location.href, pageTitle: document.title, blocked, results };
    })()`)) as Record<string, unknown>
    const result = { query, requestedEngine: engine, ...extracted, cached: false }
    if (!extracted.blocked) {
      this.searchCache.set(cacheKey, { expiresAt: Date.now() + SEARCH_CACHE_TTL_MS, result })
      if (this.searchCache.size > 200)
        this.searchCache.delete(this.searchCache.keys().next().value!)
    }
    return result
  }

  private async open(url: string): Promise<unknown> {
    if (!this.activeTargetId || !this.targets.has(this.activeTargetId)) {
      const created = (await this.createTarget(url, true)) as { targetId: string }
      const target = this.targets.get(created.targetId)
      if (!target) throw new Error('WEB_TARGET_UNAVAILABLE: 浏览器窗口创建失败')
      return this.inspect()
    }
    const target = this.activeTarget()
    await this.loadUrlWithTimeout(target.view.webContents, url)
    return this.inspect()
  }

  private async inspect(): Promise<unknown> {
    const target = this.activeTarget()
    const contents = target.view.webContents
    const page = await contents.executeJavaScript(`(() => {
      const observed = [...document.querySelectorAll('form,a,button,input,textarea,select,img,video,[role]')]
        .filter((node) => {
          const rect = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden';
        })
        .slice(0, 500);
      observed.forEach((node, index) => node.setAttribute('data-infos-browser-handle', '${target.generation}:' + String(index + 1)));
      let imageIndex = 0;
      const elements = observed
        .map((node) => {
          const handle = node.getAttribute('data-infos-browser-handle');
          const inputType = node.getAttribute('type') || '';
          const sensitive = node.tagName === 'INPUT' && /password|token|secret|auth|cookie|session|cc-|card|cvv|payment/i.test([inputType,node.id,node.getAttribute('name'),node.getAttribute('autocomplete'),node.getAttribute('aria-label')].filter(Boolean).join(' '));
          const rawValue = typeof node.value === 'string' ? node.value : undefined;
          const isVisual = node.tagName === 'IMG' || node.tagName === 'VIDEO';
          const rect = node.getBoundingClientRect();
          const imageId = isVisual && rect.width >= 96 && rect.height >= 72 ? 'IMG' + String(++imageIndex) : undefined;
          if (imageId) node.setAttribute('data-infos-image-id', imageId);
          return {
            handle,
            tag: node.tagName.toLowerCase(),
            text: (node.innerText || node.textContent || '').trim().slice(0, 500),
            role: node.getAttribute('role') || node.tagName.toLowerCase(),
            name: node.getAttribute('aria-label') || node.getAttribute('name') || (node.innerText || '').trim().slice(0, 200) || undefined,
            type: inputType || undefined,
            disabled: Boolean(node.disabled || node.getAttribute('aria-disabled') === 'true'),
            checked: typeof node.checked === 'boolean' ? node.checked : undefined,
            value: sensitive ? undefined : rawValue?.slice(0, 1000),
            valueLength: sensitive ? rawValue?.length : undefined,
            sensitive,
            imageId,
            src: imageId ? (node.currentSrc || node.src || undefined) : undefined,
            alt: imageId ? (node.getAttribute('alt') || node.getAttribute('aria-label') || undefined) : undefined,
            required: Boolean(node.required || node.getAttribute('aria-required') === 'true'),
            label: node.labels?.[0]?.innerText?.trim() || undefined,
            parentFormHandle: node.form?.getAttribute('data-infos-browser-handle') || undefined,
            bounds: (() => { const rect = node.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; })()
          };
        });
      return {
        title: document.title,
        url: location.href,
        text: (document.body?.innerText || '').slice(0, ${MAX_TEXT_LENGTH}),
        hiddenText: [...document.querySelectorAll('body *')]
          .filter((node) => { const style = getComputedStyle(node); return style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0; })
          .map((node) => node.textContent || '').join('\\n').slice(0, 20000),
        viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY },
        elements
      };
    })()`)
    const text = String(page.text ?? '')
    const elements = (page.elements ?? []) as ElementDescriptor[]
    const structure = JSON.stringify(elements)
    const contentHash = createHash('sha256').update(text).digest('hex')
    const structureHash = createHash('sha256').update(structure).digest('hex')
    const snapshotId = `snapshot:${target.id}:${target.generation}:${createHash('sha256')
      .update(text + structure)
      .digest('hex')
      .slice(0, 16)}`
    const elementIds = elements.map((element) => element.handle)
    const previous = target.previousSnapshot
    const diff = {
      previousSnapshotId: previous?.snapshotId,
      contentChanged: Boolean(previous && previous.contentHash !== contentHash),
      structureChanged: Boolean(previous && previous.structureHash !== structureHash),
      addedElementIds: previous ? elementIds.filter((id) => !previous.elementIds.includes(id)) : [],
      removedElementIds: previous
        ? previous.elementIds.filter((id) => !elementIds.includes(id))
        : [],
    }
    target.previousSnapshot = { snapshotId, contentHash, structureHash, elementIds }
    const groundedMarkdown = this.compileGroundedMarkdown(
      String(page.title ?? ''),
      String(page.url ?? contents.getURL()),
      text,
      elements,
      page.viewport as Record<string, unknown>,
    )
    return {
      targetId: target.id,
      generation: target.generation,
      snapshotId,
      title: String(page.title ?? ''),
      url: String(page.url ?? contents.getURL()),
      text,
      hiddenText: String(page.hiddenText ?? ''),
      viewport: page.viewport,
      groundedMarkdown,
      diff,
      contentHash,
      structureHash,
      elements,
      canGoBack: contents.navigationHistory.canGoBack(),
      loading: contents.isLoading(),
    }
  }

  private compileGroundedMarkdown(
    title: string,
    url: string,
    text: string,
    elements: ElementDescriptor[],
    viewport: Record<string, unknown>,
  ): string {
    const lines = [`# ${title || '未命名页面'}`, `URL: ${url}`, '']
    lines.push(
      `> 视口 ${Number(viewport.width ?? 0)}×${Number(viewport.height ?? 0)}，滚动位置 (${Number(viewport.scrollX ?? 0)}, ${Number(viewport.scrollY ?? 0)})`,
      '',
      text.slice(0, 40_000),
      '',
      '## 可操作对象',
    )
    for (const [index, element] of elements.entries()) {
      if (element.imageId) {
        lines.push(
          `- [图片 ${element.imageId}｜${element.alt || element.name || '无描述'}｜${Math.round(element.bounds?.width ?? 0)}×${Math.round(element.bounds?.height ?? 0)}｜handle=${element.handle}]`,
        )
        continue
      }
      if (!['a', 'button', 'input', 'textarea', 'select', 'form'].includes(element.tag)) continue
      const shortId = `A${index + 1}`
      const state = [
        element.disabled ? 'disabled' : '',
        element.checked !== undefined ? `checked=${element.checked}` : '',
        element.sensitive
          ? `value=[已隐藏,长度=${element.valueLength ?? 0}]`
          : element.value
            ? `value=${element.value}`
            : '',
      ]
        .filter(Boolean)
        .join(', ')
      lines.push(
        `- [${shortId}] ${element.role || element.tag}「${element.name || element.label || element.text || '未命名'}」 handle=${element.handle}${state ? ` (${state})` : ''}`,
      )
    }
    return lines.join('\n')
  }

  private async extract(): Promise<unknown> {
    const snapshot = (await this.inspect()) as {
      title: string
      url: string
      text: string
      groundedMarkdown: string
      diff: unknown
    }
    return {
      title: snapshot.title,
      url: snapshot.url,
      content: snapshot.groundedMarkdown,
      plainText: snapshot.text,
      diff: snapshot.diff,
    }
  }

  private async elementScreenshot(input: Record<string, unknown>): Promise<unknown> {
    if (input.maxWidth !== undefined) screenshotMaxWidth(input.maxWidth)
    const key = String(input.imageId ?? input.handle ?? input.target ?? '')
    if (!key) throw new Error('WEB_IMAGE_TARGET_REQUIRED: 缺少图片ID或元素句柄')
    this.assertHandleGeneration(key)
    const target = this.activeTarget()
    const generation = target.generation
    const contents = target.view.webContents
    const bounds = (await contents.executeJavaScript(`(() => {
      const key = ${JSON.stringify(key)};
      const node = document.querySelector('[data-infos-image-id="' + CSS.escape(key) + '"]') || document.querySelector('[data-infos-browser-handle="' + CSS.escape(key) + '"]');
      if (!node) throw new Error('WEB_ELEMENT_NOT_FOUND: ' + key);
      node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const rect = node.getBoundingClientRect();
      const x = Math.max(0, rect.x), y = Math.max(0, rect.y);
      return { x, y, width: Math.min(innerWidth, rect.right) - x, height: Math.min(innerHeight, rect.bottom) - y,
        viewportWidth: innerWidth, viewportHeight: innerHeight, scrollX, scrollY };
    })()`)) as {
      x: number
      y: number
      width: number
      height: number
      viewportWidth: number
      viewportHeight: number
      scrollX: number
      scrollY: number
    }
    if (
      ![
        bounds.x,
        bounds.y,
        bounds.width,
        bounds.height,
        bounds.viewportWidth,
        bounds.viewportHeight,
      ].every(Number.isFinite) ||
      bounds.width <= 0 ||
      bounds.height <= 0 ||
      bounds.viewportWidth <= 0 ||
      bounds.viewportHeight <= 0
    )
      throw new Error('WEB_IMAGE_TARGET_HIDDEN: 目标元素没有可见的截图区域')
    this.assertScreenshotTarget(target, generation)
    const viewport = await this.screenshotViewport(target)
    const image = await this.captureViewport(target)
    const after = await this.screenshotViewport(target)
    this.assertScreenshotTarget(target, generation)
    if (
      viewport.width !== bounds.viewportWidth ||
      viewport.height !== bounds.viewportHeight ||
      viewport.scrollX !== bounds.scrollX ||
      viewport.scrollY !== bounds.scrollY ||
      JSON.stringify(viewport) !== JSON.stringify(after)
    )
      throw new Error('WEB_SCREENSHOT_STALE: 截图期间页面尺寸或位置已变化，请重新读取元素后截图')
    return {
      ...this.screenshotResult(target, image, viewport, bounds, input.maxWidth),
      target: key,
    }
  }

  private async screenshot(input: Record<string, unknown>): Promise<unknown> {
    const target = this.activeTarget()
    const generation = target.generation
    const viewport = await this.screenshotViewport(target)
    const reference =
      input.region !== undefined
        ? this.screenshotReference(input.screenshotId, target, viewport)
        : undefined
    const bounds = reference
      ? mapScreenshotRegion(input.region, reference, reference.bounds)
      : { x: 0, y: 0, width: viewport.width, height: viewport.height }
    if (input.maxWidth !== undefined) screenshotMaxWidth(input.maxWidth)
    const image = await this.captureViewport(target)
    const after = await this.screenshotViewport(target)
    this.assertScreenshotTarget(target, generation)
    if (JSON.stringify(viewport) !== JSON.stringify(after)) throw this.staleScreenshot()
    return {
      ...this.screenshotResult(target, image, viewport, bounds, input.maxWidth),
      ...(reference ? { referenceScreenshotId: input.screenshotId } : {}),
    }
  }

  private staleScreenshot(): Error {
    return new Error(
      __t('errors.electron', 'WEB_SCREENSHOT_STALE: 参考截图已过期或页面视口已变化，请重新截图'),
    )
  }

  private async screenshotViewport(target: BrowserTarget): Promise<BrowserViewport> {
    const generation = target.generation
    const viewport = (await target.view.webContents.executeJavaScriptInIsolatedWorld(
      SCREENSHOT_WORLD_ID,
      [
        {
          code: `(() => {
        if (!globalThis.__infosScreenshotViewport) {
          const state = { revision: 0 };
          globalThis.__infosScreenshotViewport = state;
          const changed = () => state.revision++;
          addEventListener('scroll', changed, true);
          addEventListener('resize', changed);
          visualViewport?.addEventListener('resize', changed);
          visualViewport?.addEventListener('scroll', changed);
        }
        return { width: innerWidth, height: innerHeight, scrollX, scrollY,
          revision: globalThis.__infosScreenshotViewport.revision };
      })()`,
        },
      ],
    )) as Omit<BrowserViewport, 'zoomFactor'>
    this.assertScreenshotTarget(target, generation)
    return { ...viewport, zoomFactor: target.view.webContents.getZoomFactor() }
  }

  private screenshotReference(
    id: unknown,
    target: BrowserTarget,
    viewport: BrowserViewport,
  ): BrowserScreenshot {
    const reference = this.screenshots.get(String(id ?? ''))
    if (
      !reference ||
      reference.owner !== this.screenshotOwner() ||
      reference.targetId !== target.id ||
      reference.scopeKey !== this.scope().key ||
      reference.generation !== target.generation ||
      Date.now() - reference.createdAt > 120_000 ||
      JSON.stringify(reference.viewport) !== JSON.stringify(viewport)
    )
      throw this.staleScreenshot()
    return reference
  }

  private screenshotOwner(): string {
    return JSON.stringify([
      this.activeOperator,
      this.invocationContext.getStore()?.screenshotCaller,
    ])
  }

  private clearScreenshots(scopeKey: string): void {
    for (const [id, reference] of this.screenshots)
      if (reference.scopeKey === scopeKey) this.screenshots.delete(id)
  }

  private screenshotResult(
    target: BrowserTarget,
    image: NativeImage,
    viewport: BrowserViewport,
    area: ScreenshotRect,
    maxWidth?: unknown,
  ) {
    const size = image.getSize()
    const pixels = screenshotPixelRect(
      {
        x: (area.x * size.width) / viewport.width,
        y: (area.y * size.height) / viewport.height,
        width: (area.width * size.width) / viewport.width,
        height: (area.height * size.height) / viewport.height,
      },
      size,
    )
    const bounds = {
      x: (pixels.x * viewport.width) / size.width,
      y: (pixels.y * viewport.height) / size.height,
      width: (pixels.width * viewport.width) / size.width,
      height: (pixels.height * viewport.height) / size.height,
    }
    let cropped = image.crop(pixels)
    if (maxWidth !== undefined && cropped.getSize().width > screenshotMaxWidth(maxWidth))
      cropped = cropped.resize({ width: screenshotMaxWidth(maxWidth), quality: 'best' })
    if (cropped.isEmpty()) throw new Error('WEB_SCREENSHOT_EMPTY: 未生成元素截图')
    const screenshotId = randomUUID()
    const outputSize = cropped.getSize()
    this.screenshots.set(screenshotId, {
      owner: this.screenshotOwner(),
      targetId: target.id,
      scopeKey: this.scope().key,
      generation: target.generation,
      createdAt: Date.now(),
      viewport,
      bounds,
      ...outputSize,
    })
    while (this.screenshots.size > 32)
      this.screenshots.delete(this.screenshots.keys().next().value!)
    return {
      base64: cropped.toPNG().toString('base64'),
      mimeType: 'image/png',
      screenshotId,
      coordinateContext: {
        screenshotId,
        targetId: target.id,
        generation: target.generation,
        coordinateSpace: 'screenshot',
        screenshotWidth: outputSize.width,
        screenshotHeight: outputSize.height,
        sourceCoordinateSpace: 'viewport-css',
        bounds,
        viewport,
      },
    }
  }

  private async pointAction(input: Record<string, unknown>, hover: boolean): Promise<unknown> {
    const target = this.activeTarget()
    await this.attachDebugger(target)
    const viewport = await this.screenshotViewport(target)
    const reference = this.screenshotReference(input.screenshotId, target, viewport)
    const x = input.x,
      y = input.y
    if (
      typeof x !== 'number' ||
      typeof y !== 'number' ||
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      x < 0 ||
      y < 0 ||
      x >= reference.width ||
      y >= reference.height ||
      input.target ||
      input.handle
    )
      throw new Error(
        __t('errors.electron', 'WEB_SCREENSHOT_POINT_INVALID: 点击坐标必须位于参考截图内'),
      )
    const point = {
      x: reference.bounds.x + (x * reference.bounds.width) / reference.width,
      y: reference.bounds.y + (y * reference.bounds.height) / reference.height,
    }
    this.clearScreenshots(reference.scopeKey)
    await target.view.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      ...point,
    })
    this.assertScreenshotTarget(target, reference.generation)
    if (!hover) {
      if (JSON.stringify(await this.screenshotViewport(target)) !== JSON.stringify(viewport))
        throw this.staleScreenshot()
      try {
        await target.view.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          button: 'left',
          buttons: 1,
          clickCount: 1,
          ...point,
        })
      } finally {
        await target.view.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          button: 'left',
          buttons: 0,
          clickCount: 1,
          ...point,
        })
      }
    }
    return { dispatched: true, screenshotId: input.screenshotId, viewportPoint: point }
  }

  private assertScreenshotTarget(target: BrowserTarget, generation: number): void {
    if (this.invocationContext.getStore()?.cancelled)
      throw new Error('WEB_OPERATION_CANCELLED: 网页截图已取消')
    if (this.targets.get(target.id) !== target || target.view.webContents.isDestroyed())
      throw new Error('WEB_TARGET_CLOSED: 截图目标标签已关闭')
    if (target.generation !== generation)
      throw new Error('WEB_SCREENSHOT_STALE: 截图期间页面已跳转，请重新读取后截图')
  }

  private async captureViewport(target: BrowserTarget): Promise<NativeImage> {
    const generation = target.generation
    this.assertScreenshotTarget(target, generation)
    if (target.pendingScreenshot)
      throw new Error('WEB_SCREENSHOT_BUSY: 上一次网页截图仍在等待渲染，可先读取网页内容')
    const contents = target.view.webContents
    const capture = (async () => {
      // 可见标签沿用原生路径；后台标签由 CDP 先唤醒绘制，避免依赖尚未建立的显示表面。
      if (desktopTabs.isVisible(target.tabId)) {
        try {
          const image = await contents.capturePage(undefined, { stayHidden: true, stayAwake: true })
          this.assertScreenshotTarget(target, generation)
          if (!image.isEmpty()) return nativeImage.createFromBuffer(image.toPNG())
        } catch (error) {
          this.assertScreenshotTarget(target, generation)
          if (
            !/display surface not available|unable to capture|failed to capture/i.test(
              String(error),
            )
          )
            throw error
        }
      }
      await this.attachDebugger(target)
      this.assertScreenshotTarget(target, generation)
      const result = (await contents.debugger.sendCommand('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: false,
      })) as { data?: string }
      this.assertScreenshotTarget(target, generation)
      if (!result.data) throw new Error('WEB_SCREENSHOT_EMPTY: 网页未返回截图')
      const image = nativeImage.createFromBuffer(Buffer.from(result.data, 'base64'))
      if (image.isEmpty()) throw new Error('WEB_SCREENSHOT_EMPTY: 网页返回了空截图')
      return image
    })()
    target.pendingScreenshot = capture
    const clearPending = () => {
      if (target.pendingScreenshot === capture) target.pendingScreenshot = undefined
    }
    void capture.then(clearPending, clearPending)
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        capture,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(new Error('WEB_SCREENSHOT_TIMEOUT: 网页截图等待渲染超时，可先读取网页内容')),
            SCREENSHOT_TIMEOUT_MS,
          )
        }),
      ])
    } catch (error) {
      if (error instanceof Error && /^WEB_[A-Z_]+:/.test(error.message)) throw error
      throw new Error(
        `WEB_SCREENSHOT_FAILED: 网页截图失败，可先读取网页内容。${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private async click(target: string): Promise<unknown> {
    this.clearScreenshots(this.scope().key)
    this.assertHandleGeneration(target)
    await this.withElement(target, `(element) => element.click()`)
    await this.wait({ ms: 250 })
    return this.inspect()
  }

  private async hover(target: string): Promise<unknown> {
    this.clearScreenshots(this.scope().key)
    await this.withElement(
      target,
      `(element) => element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))`,
    )
    return this.inspect()
  }

  private async type(target: string, text: string): Promise<unknown> {
    await this.withElement(
      target,
      `(element) => {
        element.focus();
        element.value = ${JSON.stringify(text)};
        element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(text)} }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      }`,
    )
    return this.inspect()
  }

  private async sendKeys(keys: string): Promise<unknown> {
    this.activeContents().sendInputEvent({ type: 'keyDown', keyCode: keys })
    this.activeContents().sendInputEvent({ type: 'keyUp', keyCode: keys })
    return this.inspect()
  }

  private async select(target: string, input: Record<string, unknown>): Promise<unknown> {
    const value = input.value ?? input.index ?? ''
    await this.withElement(
      target,
      `(element) => { element.value = ${JSON.stringify(String(value))}; element.dispatchEvent(new Event('change', { bubbles: true })); }`,
    )
    return this.inspect()
  }

  private async check(target: string, checked: boolean): Promise<unknown> {
    await this.withElement(
      target,
      `(element) => { element.checked = ${checked}; element.dispatchEvent(new Event('change', { bubbles: true })); }`,
    )
    return this.inspect()
  }

  private async scroll(input: Record<string, unknown>): Promise<unknown> {
    const direction = String(input.direction ?? 'down')
    const amount = Math.max(1, Number(input.amount ?? 0))
    const target = String(input.target ?? input.handle ?? '')
    return this.activeContents().executeJavaScript(`(() => {
      const root = ${JSON.stringify(target)} ? (document.querySelector(${JSON.stringify(target)}) || document.querySelector('[data-infos-browser-handle="' + CSS.escape(${JSON.stringify(target)}) + '"]')) : document.scrollingElement;
      if (!root) throw new Error('WEB_SCROLL_TARGET_NOT_FOUND');
      const before = { x: root.scrollLeft, y: root.scrollTop };
      const vw = root === document.scrollingElement ? innerWidth : root.clientWidth;
      const vh = root === document.scrollingElement ? innerHeight : root.clientHeight;
      const stepX = ${amount} || Math.round(vw * .8);
      const stepY = ${amount} || Math.round(vh * .8);
      const direction = ${JSON.stringify(direction)};
      if (direction === 'top') root.scrollTo({ top: 0, behavior: 'instant' });
      else if (direction === 'bottom') root.scrollTo({ top: root.scrollHeight, behavior: 'instant' });
      else if (direction === 'left') root.scrollBy({ left: -stepX, behavior: 'instant' });
      else if (direction === 'right') root.scrollBy({ left: stepX, behavior: 'instant' });
      else if (direction === 'to') root.scrollTo({ left: ${Number(input.x ?? 0)}, top: ${Number(input.y ?? 0)}, behavior: 'instant' });
      else root.scrollBy({ top: ['up','page_up'].includes(direction) ? -stepY : stepY, behavior: 'instant' });
      const after = { x: root.scrollLeft, y: root.scrollTop };
      return { before, after, moved: before.x !== after.x || before.y !== after.y, reachedBoundary: before.x === after.x && before.y === after.y, max: { x: root.scrollWidth - root.clientWidth, y: root.scrollHeight - root.clientHeight } };
    })()`)
  }

  private async back(): Promise<unknown> {
    const contents = this.activeContents()
    if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack()
    await this.wait({ ms: 300 })
    return this.inspect()
  }

  private async wait(input: Record<string, unknown>): Promise<unknown> {
    const condition = String(input.condition ?? 'delay')
    const timeoutMs = Math.min(30_000, Math.max(0, Number(input.timeoutMs ?? input.ms ?? 500)))
    if (condition === 'delay') {
      await new Promise((resolve) => setTimeout(resolve, timeoutMs))
      return this.inspect()
    }
    const pollMs = Math.min(1_000, Math.max(50, Number(input.pollMs ?? 100)))
    const stableMs = Math.min(timeoutMs, Math.max(100, Number(input.stableMs ?? 500)))
    const started = Date.now()
    let stableSince = 0
    let previousHash = ''
    while (Date.now() - started <= timeoutMs) {
      const state = (await this.activeContents().executeJavaScript(`(() => {
        const condition = ${JSON.stringify(condition)};
        const target = ${JSON.stringify(String(input.target ?? ''))};
        const expected = ${JSON.stringify(String(input.text ?? input.url ?? input.value ?? ''))};
        const node = target ? (() => { try { return document.querySelector(target) || document.querySelector('[data-infos-browser-handle="' + CSS.escape(target) + '"]'); } catch { return null; } })() : null;
        const visible = node ? (() => { const r=node.getBoundingClientRect(),s=getComputedStyle(node); return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'; })() : false;
        const pass = condition==='element' ? Boolean(node) : condition==='visible' ? visible : condition==='hidden' ? !node||!visible : condition==='text' ? (document.body?.innerText||'').includes(expected) : condition==='url' ? location.href.includes(expected) : condition==='value' ? String(node?.value??'')===expected : false;
        return { pass, hash: document.body?.innerText?.length + ':' + document.querySelectorAll('*').length, url: location.href };
      })()`)) as { pass: boolean; hash: string; url: string }
      if (condition === 'dom_stable') {
        if (state.hash === previousHash) stableSince ||= Date.now()
        else stableSince = 0
        previousHash = state.hash
        if (stableSince && Date.now() - stableSince >= stableMs)
          return { condition, satisfied: true }
      } else if (state.pass) return { condition, satisfied: true, url: state.url }
      await new Promise((resolve) => setTimeout(resolve, pollMs))
    }
    throw new Error(`WEB_WAIT_TIMEOUT: 等待条件 ${condition} 超时`)
  }

  private listTargets(): unknown[] {
    return [...this.targets.values()]
      .filter((target) => target.scope.key === this.scope().key)
      .map((target) => ({
        targetId: target.id,
        title: target.view.webContents.getTitle(),
        url: target.view.webContents.getURL(),
        active: target.id === this.activeTargetId,
        visible: desktopTabs.isVisible(target.tabId),
        createdAt: target.createdAt,
        lastUsedAt: target.lastUsedAt,
        generation: target.generation,
        retained: target.retained,
        loading: target.view.webContents.isLoading(),
      }))
  }

  /** 用户创建的页面不会被 Agent 的空闲回收器销毁。 */
  async openUserTab(url: string, replaceId?: string): Promise<void> {
    await this.createTarget(url, false, true, replaceId)
  }

  retainTarget(targetId: string): void {
    const target = this.targets.get(targetId)
    if (target) target.retained = true
  }

  private userTarget(targetId: string): BrowserTarget {
    const target = this.targets.get(targetId)
    if (!target || target.view.webContents.isDestroyed()) throw new Error('浏览器标签已关闭')
    if (target.overlay || (this.invocationRunning && this.invocationTargetId === targetId)) {
      throw new Error('Agent 正在操作此页面，请稍后再试')
    }
    target.retained = true
    return target
  }

  async navigateUserTarget(targetId: string, url: string): Promise<void> {
    const target = this.userTarget(targetId)
    desktopTabs.update(target.tabId, { error: undefined })
    try {
      await this.loadUrlWithTimeout(target.view.webContents, url)
    } catch (error) {
      if (
        target.view.webContents.isDestroyed() ||
        (error as { code?: string })?.code === 'ERR_ABORTED'
      )
        return
      throw error
    }
  }

  userAction(targetId: string, action: string): void {
    const target = this.userTarget(targetId)
    const contents = target.view.webContents
    const history = contents.navigationHistory
    if (action === 'back' && history.canGoBack()) history.goBack()
    else if (action === 'forward' && history.canGoForward()) history.goForward()
    else if (action === 'reload') {
      desktopTabs.update(target.tabId, { error: undefined })
      contents.reload()
    } else if (action === 'stop') contents.stop()
  }

  private async createTarget(
    url: string,
    activate: boolean,
    retained = false,
    replaceId?: string,
  ): Promise<unknown> {
    if (this.invocationContext.getStore()?.cancelled)
      throw new Error('WEB_OPERATION_CANCELLED: 浏览器操作已结束')
    url = this.normalizeUrl(url)
    if (this.targets.size >= MAX_TARGETS) {
      throw new Error(`WEB_TARGET_LIMIT_REACHED: 浏览器标签数量已达上限 ${MAX_TARGETS}`)
    }
    const id = `browser-${this.nextTarget++}`
    const scope = this.scope()
    const browserSession = session.fromPartition(scope.partition)
    if (!this.configuredPartitions.has(scope.partition)) {
      browserSession.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false),
      )
      browserSession.setPermissionCheckHandler(() => false)
      fs.mkdirSync(this.downloadDir, { recursive: true })
      browserSession.on('will-download', (event, item, contents) => {
        const owner = [...this.targets.values()].find(
          (target) => target.view.webContents === contents,
        )
        if (!owner || !this.downloadPermissions.get(owner.scope.key)) {
          event.preventDefault()
          return
        }
        const id = randomUUID()
        const filename = path.basename(item.getFilename())
        const destination = path.join(this.downloadDir, `${id}-${filename}`)
        const download: BrowserDownload = {
          scopeKey: owner.scope.key,
          id,
          filename,
          state: 'running',
          receivedBytes: 0,
          totalBytes: item.getTotalBytes(),
          path: destination,
        }
        this.downloads.set(id, download)
        item.setSavePath(destination)
        item.on('updated', (_event, state) => {
          download.receivedBytes = item.getReceivedBytes()
          if (state === 'interrupted') download.state = 'failed'
        })
        item.once('done', (_event, state) => {
          download.receivedBytes = item.getReceivedBytes()
          download.state =
            state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'failed'
        })
      })
      this.configuredPartitions.add(scope.partition)
    }
    const view = new WebContentsView({
      webPreferences: {
        session: browserSession,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        backgroundThrottling: false,
      },
    })
    const now = new Date().toISOString()
    const target: BrowserTarget = {
      scope,
      id,
      view,
      tabId: id,
      retained,
      createdAt: now,
      lastUsedAt: now,
      generation: 1,
      network: [],
    }
    this.targets.set(id, target)
    try {
      target.tabId = desktopTabs.mountView(
        {
          id,
          targetId: id,
          kind: 'browser',
          icon: 'globe',
          title: __t('electron.ui.browserRuntime', '浏览器'),
          url,
          loading: true,
        },
        view,
        retained,
        replaceId,
      )
    } catch (error) {
      this.targets.delete(id)
      for (const [screenshotId, reference] of this.screenshots)
        if (reference.targetId === id) this.screenshots.delete(screenshotId)
      view.webContents.close({ waitForBeforeUnload: false })
      throw error
    }
    view.webContents.setWindowOpenHandler(({ url: requestedUrl }) => {
      this.invocationContext.run(
        { scope: target.scope, targetId: target.id, cancelled: false },
        () => {
          void this.createTarget(requestedUrl, !retained, retained).catch((error) => {
            this.lastError = String(error)
          })
        },
      )
      return { action: 'deny' }
    })
    view.webContents.on('will-navigate', (event, requestedUrl) => {
      if (!this.isAllowedUrl(requestedUrl)) event.preventDefault()
    })
    view.webContents.on('focus', () => {
      target.retained = true
    })
    view.webContents.on('destroyed', () => {
      const programmatic = this.programmaticCloseTargetIds.delete(id)
      if (target.overlay) {
        if (!target.overlay.webContents.isDestroyed()) target.overlay.webContents.close()
        target.overlay = undefined
      }
      this.lastCloseReason = programmatic ? 'programmatic' : 'user-closed'
      this.targets.delete(id)
      for (const [screenshotId, reference] of this.screenshots)
        if (reference.targetId === id) this.screenshots.delete(screenshotId)
      for (const [key, selected] of this.scopedActiveTargets)
        if (selected === id) this.scopedActiveTargets.delete(key)
      if (this.defaultActiveTargetId === id)
        this.defaultActiveTargetId = [...this.targets.values()].find(
          (target) => target.scope.key === 'legacy',
        )?.id
      if (this.invocationContext.getStore()?.targetId === id)
        this.invocationContext.getStore()!.targetId = undefined
      if (!programmatic) {
        if (this.invocationTargetId === id) {
          this.failActiveInvocation('WEB_TARGET_CLOSED', '用户关闭了 Agent 正在操作的浏览器标签')
        }
      }
    })
    view.on('bounds-changed', () => this.syncOverlayBounds(target))
    view.webContents.on('render-process-gone', (_event, details) => {
      this.lastCloseReason = `renderer-${details.reason}`
      if (this.invocationTargetId === id)
        this.failActiveInvocation(
          'WEB_RENDERER_CRASHED',
          `浏览器渲染进程异常退出（${details.reason}，exitCode=${details.exitCode}）`,
        )
      this.programmaticCloseTargetIds.add(id)
      if (!view.webContents.isDestroyed()) void desktopTabs.close(target.tabId, true)
    })
    view.webContents.on('unresponsive', () => {
      if (this.invocationTargetId === id)
        this.failActiveInvocation('WEB_TARGET_UNRESPONSIVE', '浏览器标签无响应')
    })
    const sync = () => {
      if (view.webContents.isDestroyed()) return
      const contents = view.webContents
      desktopTabs.update(target.tabId, {
        title: contents.getTitle() || __t('electron.ui.browserRuntime', '浏览器'),
        url: contents.getURL() || url,
        loading: contents.isLoading(),
        canGoBack: contents.navigationHistory.canGoBack(),
        canGoForward: contents.navigationHistory.canGoForward(),
      })
    }
    if (activate || !this.activeTargetId) this.activateTarget(target)
    if (!retained && this.invocationRunning) await this.lockTarget(target)
    void this.attachDebugger(target).catch(() => undefined)
    view.webContents.on('page-title-updated', sync)
    view.webContents.on('did-start-loading', () => {
      desktopTabs.update(target.tabId, { error: undefined })
      sync()
    })
    view.webContents.on('did-stop-loading', sync)
    view.webContents.on('did-navigate', sync)
    view.webContents.on('did-navigate-in-page', sync)
    view.webContents.on('did-start-navigation', (_event, _url, _isInPlace, isMainFrame) => {
      if (isMainFrame) {
        target.generation += 1
        target.observerFrame = undefined
        this.clearScreenshots(target.scope.key)
      }
    })
    view.webContents.on('did-finish-load', () => {
      target.generation = Math.max(1, target.generation)
    })
    view.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      target.network.push({
        type: 'navigation-failed',
        code,
        description,
        url,
        at: new Date().toISOString(),
      })
      if (isMainFrame && code !== -3)
        desktopTabs.update(target.tabId, {
          loading: false,
          error: `网页加载失败：${description}`,
        })
    })
    const loading = this.loadUrlWithTimeout(view.webContents, url)
    if (retained) {
      // 用户标签创建后立即返回，页面加载不阻塞继续新建或打开其他应用。
      void loading.catch((error: unknown) => {
        if (view.webContents.isDestroyed() || (error as { code?: string })?.code === 'ERR_ABORTED')
          return
        desktopTabs.update(target.tabId, { loading: false, error: String(error) })
      })
      return { targetId: id, url }
    }
    try {
      await loading
    } catch (error) {
      desktopTabs.update(target.tabId, { loading: false, error: String(error) })
      throw error
    }
    return { targetId: id, url: view.webContents.getURL() }
  }

  private switchTarget(targetId: string): unknown {
    const target = this.targets.get(targetId)
    if (!target) throw new Error(`WEB_TARGET_NOT_FOUND: ${targetId}`)
    assertBrowserTargetScope(target.scope.key, this.scope().key)
    this.activateTarget(target)
    return this.listTargets()
  }

  private async closeTarget(targetId: string): Promise<unknown> {
    const target = this.targets.get(targetId)
    if (!target) return this.listTargets()
    assertBrowserTargetScope(target.scope.key, this.scope().key)
    this.programmaticCloseTargetIds.add(targetId)
    await desktopTabs.close(target.tabId, true)
    return this.listTargets()
  }

  private async domQuery(input: Record<string, unknown>): Promise<unknown> {
    const selector = String(input.selector ?? '*')
    return this.activeContents().executeJavaScript(
      `(() => [...document.querySelectorAll(${JSON.stringify(selector)})].slice(0, 200).map((node) => ({ tag: node.tagName.toLowerCase(), text: (node.innerText || node.textContent || '').trim().slice(0, 1000), html: node.outerHTML.slice(0, 4000) })))()`,
    )
  }

  private async sourceSearch(input: Record<string, unknown>): Promise<unknown> {
    const query = String(input.query ?? '')
    if (!query) throw new Error('WEB_SOURCE_QUERY_REQUIRED')
    const regex = input.regex === true
    const caseSensitive = input.caseSensitive === true
    const maxResults = Math.min(100, Math.max(1, Number(input.maxResults ?? 20)))
    return this.activeContents().executeJavaScript(`(() => {
      const query = ${JSON.stringify(query)};
      const flags = ${JSON.stringify(caseSensitive ? 'g' : 'gi')};
      const pattern = ${regex} ? new RegExp(query, flags) : new RegExp(query.replace(/[.*+?^\${}()|[\\]\\]/g, '\\$&'), flags);
      const selectedScopes = new Set(${JSON.stringify(
        String(input.scope ?? 'dom,inline_script,style,codeblock')
          .split(',')
          .map((scope) => scope.trim())
          .filter(Boolean),
      )});
      const sources = [
        { scope:'dom', content: document.documentElement.outerHTML },
        ...[...document.querySelectorAll('script:not([src])')].map((node) => ({ scope:'inline_script', content:node.textContent||'' })),
        ...[...document.querySelectorAll('style')].map((node) => ({ scope:'style', content:node.textContent||'' })),
        ...[...document.querySelectorAll('pre,code')].map((node) => ({ scope:'codeblock', content:node.textContent||'' }))
      ].filter((source) => selectedScopes.has(source.scope));
      const results=[];
      for (const source of sources) {
        pattern.lastIndex=0; let match;
        while ((match=pattern.exec(source.content)) && results.length < ${maxResults}) {
          results.push({ scope:source.scope, index:match.index, match:match[0], excerpt:source.content.slice(Math.max(0,match.index-300),match.index+match[0].length+300) });
          if (!match[0]) pattern.lastIndex++;
        }
      }
      return { query, regex:${regex}, results, total:results.length, truncated:results.length>=${maxResults} };
    })()`)
  }

  private frameQuery(): unknown {
    return this.activeContents().mainFrame.framesInSubtree.map((frame) => ({
      name: frame.name,
      url: frame.url,
    }))
  }

  private async attachDebugger(target: BrowserTarget): Promise<void> {
    if (target.debuggerReady) return target.debuggerReady
    const ready = this.initializeDebugger(target)
    target.debuggerReady = ready
    try {
      await ready
    } finally {
      if (target.debuggerReady === ready) target.debuggerReady = undefined
    }
  }

  private async initializeDebugger(target: BrowserTarget): Promise<void> {
    const debuggerApi = target.view.webContents.debugger
    if (!debuggerApi.isAttached()) debuggerApi.attach('1.3')
    await debuggerApi.sendCommand('Network.enable')
    await debuggerApi.sendCommand('Page.enable')
    // 导航、截图与模拟共用同一连接，重新连接不叠加事件监听。
    if (target.debuggerEventsBound) return
    target.debuggerEventsBound = true
    debuggerApi.on('message', (_event, method, params) => {
      if (method.startsWith('Network.')) {
        target.network.push({
          method,
          ...(params as Record<string, unknown>),
          at: new Date().toISOString(),
        })
        if (target.network.length > 2_000) target.network.splice(0, target.network.length - 2_000)
      }
      if (method === 'Page.javascriptDialogOpening') {
        const value = params as { type?: string; message?: string; defaultPrompt?: string }
        target.pendingDialog = {
          type: value.type ?? 'alert',
          message: value.message ?? '',
          defaultPrompt: value.defaultPrompt,
        }
      }
      if (method === 'Page.javascriptDialogClosed') target.pendingDialog = undefined
    })
  }

  private async handleDialog(input: Record<string, unknown>): Promise<unknown> {
    const target = this.activeTarget()
    if (!target.pendingDialog) throw new Error('WEB_DIALOG_UNAVAILABLE: 当前没有待处理对话框')
    await target.view.webContents.debugger.sendCommand('Page.handleJavaScriptDialog', {
      accept: input.accept !== false,
      promptText: typeof input.promptText === 'string' ? input.promptText : undefined,
    })
    const dialog = target.pendingDialog
    target.pendingDialog = undefined
    return { handled: true, dialog }
  }

  private networkQuery(input: Record<string, unknown>): unknown {
    const query = String(input.query ?? '').toLowerCase()
    const events = this.activeTarget().network
    return query
      ? events.filter((event) => JSON.stringify(event).toLowerCase().includes(query)).slice(-500)
      : events.slice(-500)
  }

  private async networkBody(input: Record<string, unknown>): Promise<unknown> {
    const requestId = String(input.requestId ?? '')
    if (!requestId) throw new Error('WEB_NETWORK_REQUEST_ID_REQUIRED')
    return this.activeContents().debugger.sendCommand('Network.getResponseBody', { requestId })
  }

  private async networkConfigure(input: Record<string, unknown>): Promise<unknown> {
    const debuggerApi = this.activeContents().debugger
    if (typeof input.offline === 'boolean') {
      await debuggerApi.sendCommand('Network.emulateNetworkConditions', {
        offline: input.offline,
        latency: Number(input.latency ?? 0),
        downloadThroughput: Number(input.downloadThroughput ?? -1),
        uploadThroughput: Number(input.uploadThroughput ?? -1),
      })
    }
    if (input.clear === true) this.activeTarget().network.length = 0
    return { configured: true }
  }

  private configureDownload(input: Record<string, unknown>): unknown {
    this.downloadsAllowed = input.enabled !== false
    return {
      enabled: this.downloadsAllowed,
      directory: this.downloadDir,
      downloads: [...this.downloads.values()]
        .filter((download) => download.scopeKey === this.scope().key)
        .map((download) => ({
          ...download,
          digest:
            download.state === 'completed' && download.path && fs.existsSync(download.path)
              ? `sha256:${createHash('sha256').update(fs.readFileSync(download.path)).digest('hex')}`
              : undefined,
        })),
    }
  }

  private async uploadFile(input: Record<string, unknown>): Promise<unknown> {
    const token = String(input.fileToken ?? '')
    const handle = String(input.handle ?? input.target ?? '')
    if (!token || !/^[a-zA-Z0-9._-]+$/.test(token)) throw new Error('FILE_HANDLE_INVALID')
    const importRoot = path.resolve(app.getPath('userData'), 'imports')
    const filePath = path.resolve(importRoot, token)
    if (!filePath.startsWith(`${importRoot}${path.sep}`) || !fs.existsSync(filePath)) {
      throw new Error('FILE_HANDLE_NOT_FOUND')
    }
    this.assertHandleGeneration(handle)
    const documentNodeId = await this.resolveBackendNodeId(handle)
    await this.activeContents().debugger.sendCommand('DOM.setFileInputFiles', {
      files: [filePath],
      backendNodeId: documentNodeId,
    })
    return {
      uploaded: true,
      fileToken: token,
      digest: `sha256:${createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')}`,
    }
  }

  private async resolveBackendNodeId(handle: string): Promise<number> {
    const document = (await this.activeContents().debugger.sendCommand('DOM.getDocument', {
      depth: 1,
    })) as { root: { nodeId: number } }
    const result = (await this.activeContents().debugger.sendCommand('DOM.querySelector', {
      nodeId: document.root.nodeId,
      selector: `[data-infos-browser-handle="${handle.replaceAll('"', '\\"')}"]`,
    })) as { nodeId: number }
    if (!result.nodeId) throw new Error(`WEB_ELEMENT_NOT_FOUND: ${handle}`)
    const described = (await this.activeContents().debugger.sendCommand('DOM.describeNode', {
      nodeId: result.nodeId,
    })) as { node: { backendNodeId: number } }
    return described.node.backendNodeId
  }

  private async storage(input: Record<string, unknown>): Promise<unknown> {
    const area = String(input.area ?? 'local')
    const action = String(input.action ?? 'get')
    if (area === 'cookies') {
      const browserSession = session.fromPartition(this.scope().partition)
      if (action === 'get')
        return browserSession.cookies.get(
          typeof input.origin === 'string' ? { url: input.origin } : {},
        )
      if (action === 'clear') return browserSession.clearStorageData({ storages: ['cookies'] })
      throw new Error('WEB_STORAGE_OPERATION_UNAVAILABLE: Cookie写入需要结构化 Cookie输入')
    }
    const storageName = area === 'session' ? 'sessionStorage' : 'localStorage'
    const key = typeof input.key === 'string' ? input.key : undefined
    if (action === 'get')
      return this.activeContents().executeJavaScript(
        key
          ? `${storageName}.getItem(${JSON.stringify(key)})`
          : `Object.fromEntries(Object.entries(${storageName}))`,
      )
    if (action === 'set' && key)
      return this.activeContents().executeJavaScript(
        `${storageName}.setItem(${JSON.stringify(key)}, ${JSON.stringify(String(input.value ?? ''))})`,
      )
    if (action === 'remove' && key)
      return this.activeContents().executeJavaScript(
        `${storageName}.removeItem(${JSON.stringify(key)})`,
      )
    if (action === 'clear') return this.activeContents().executeJavaScript(`${storageName}.clear()`)
    throw new Error('WEB_STORAGE_INPUT_INVALID')
  }

  private async emulate(input: Record<string, unknown>): Promise<unknown> {
    if (typeof input.userAgent === 'string') this.activeContents().setUserAgent(input.userAgent)
    const width = Number(input.width)
    const height = Number(input.height)
    if (Number.isFinite(width) && Number.isFinite(height)) {
      if (!this.activeContents().debugger.isAttached())
        await this.attachDebugger(this.activeTarget())
      await this.activeContents().debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
        width: Math.max(320, Math.round(width)),
        height: Math.max(240, Math.round(height)),
        deviceScaleFactor: 1,
        mobile: false,
      })
    }
    return this.status()
  }

  private async evaluate(expression: string): Promise<unknown> {
    if (!expression.trim()) throw new Error('WEB_EVALUATE_EXPRESSION_REQUIRED')
    return this.activeContents().executeJavaScript(expression)
  }

  private status(): unknown {
    const active = this.activeTargetId ? this.targets.get(this.activeTargetId) : undefined
    return {
      available: true,
      partition: this.scope().partition,
      profilePath: path.join(
        app.getPath('userData'),
        'Partitions',
        this.scope().partition.replace('persist:', ''),
      ),
      activeTargetId: this.activeTargetId,
      targetCount: this.listTargets().length,
      maxTargets: MAX_TARGETS,
      idleTimeoutMs: IDLE_TIMEOUT_MS,
      rendererPid: active?.view.webContents.getOSProcessId(),
      debuggerAttached: active?.view.webContents.debugger.isAttached() ?? false,
      locked: Boolean(active?.overlay),
      activeOperator: this.activeOperator,
      lastError: this.lastError,
      lastCloseReason: this.lastCloseReason,
      searchCacheEntries: this.searchCache.size,
      targets: this.listTargets(),
      pendingDialog: this.activeTargetId
        ? this.targets.get(this.activeTargetId)?.pendingDialog
        : undefined,
      downloads: [...this.downloads.values()].filter(
        (download) => download.scopeKey === this.scope().key,
      ),
    }
  }

  private async withElement(target: string, operation: string): Promise<void> {
    if (!target.trim()) throw new Error('WEB_ELEMENT_TARGET_REQUIRED')
    this.assertHandleGeneration(target)
    const script = `(() => {
      const escaped = ${JSON.stringify(target)};
      const byHandle = document.querySelector('[data-infos-browser-handle="' + CSS.escape(escaped) + '"]');
      const bySelector = (() => { try { return document.querySelector(escaped); } catch { return null; } })();
      const byText = [...document.querySelectorAll('a,button,input,textarea,select,[role]')].find((node) => (node.innerText || node.textContent || node.getAttribute('aria-label') || '').trim().includes(escaped));
      const element = byHandle || bySelector || byText;
      if (!element) throw new Error('WEB_ELEMENT_NOT_FOUND: ' + escaped);
      return (${operation})(element);
    })()`
    await this.activeContents().executeJavaScript(script)
  }

  private assertHandleGeneration(handle: string): void {
    const match = /^(\d+):/.exec(handle)
    if (match && Number(match[1]) !== this.activeTarget().generation) {
      throw new Error(
        `RUNTIME_STALE_HANDLE: 句柄代次 ${match[1]} 与当前页面代次 ${this.activeTarget().generation} 不一致`,
      )
    }
  }

  private activeTarget(): BrowserTarget {
    const context = this.invocationContext.getStore()
    if (context?.cancelled) throw new Error('WEB_OPERATION_CANCELLED: 浏览器操作已结束')
    const id = context ? context.targetId : this.activeTargetId
    const target = id ? this.targets.get(id) : undefined
    if (!target || target.view.webContents.isDestroyed()) throw new Error('WEB_TARGET_UNAVAILABLE')
    if (context) assertBrowserTargetScope(target.scope.key, context.scope.key)
    return target
  }

  private scope(): BrowserInvocationScope {
    return this.invocationContext.getStore()?.scope ?? { key: 'legacy', partition: PARTITION }
  }

  private activeContents(): WebContents {
    return this.activeTarget().view.webContents
  }

  private normalizeUrl(value: string): string {
    const url = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`
    if (!this.isAllowedUrl(url)) throw new Error(`WEB_URL_SCHEME_BLOCKED: ${url}`)
    return url
  }

  private isAllowedUrl(value: string): boolean {
    try {
      return ['http:', 'https:', 'about:'].includes(new URL(value).protocol)
    } catch {
      return false
    }
  }
}

export const browserRuntime = new ElectronBrowserRuntime()
