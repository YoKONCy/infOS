import { t as __t } from '../utils/i18n'
/**
 * Electron Release 更新服务。
 *
 * 安装版：下载所选 Release 的 NSIS 安装包，应用完整退出后静默安装。
 * 便携版：下载所选 Release 的 ZIP，预先解压到缓存；应用退出后由 Unicode 助手覆盖本体并重启。
 * 数据目录独立于程序本体：安装版位于 userData/data，便携版位于 exe 同级 data，更新器绝不覆盖它。
 */
import { app, BrowserWindow, net } from 'electron'
import AdmZip from 'adm-zip'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve, relative, isAbsolute } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { execFile } from 'node:child_process'
import { isDev, isPackaged, isPortable, paths } from '../utils/env'
import { logger } from '../utils/logger'
import {
  prepareUpdateInstall,
  type PreparedUpdateInstall,
  type UpdateInstallReceipt,
} from './updateInstaller'

const RELEASES_URL = 'https://api.github.com/repos/YoKONCy/infOS/releases?per_page=20'
const RELEASES_PAGE = 'https://github.com/YoKONCy/infOS/releases'
const CACHE_FILE = 'client-release-list.json'
const INSTALL_RECEIPT = 'client-update-install.json'
const VALID_VERSION =
  /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9][a-zA-Z0-9.-]*)?(?:\+[a-zA-Z0-9][a-zA-Z0-9.-]*)?$/

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'up-to-date'
  | 'error'

export type ReleaseChannel = 'stable' | 'rc' | 'alpha' | 'beta' | 'hotfix'
export type UpdateDeployment = 'installed' | 'portable' | 'unsupported'

export interface UpdateRelease {
  tagName: string
  version: string
  name: string
  body: string
  publishedAt: string
  htmlUrl: string
  channel: ReleaseChannel
  prerelease: boolean
  assetName: string
  assetSize: number
  downloadUrl: string
  digest?: string
}

export interface UpdateState {
  phase: UpdatePhase
  deployment: UpdateDeployment
  currentVersion: string
  selectedVersion?: string
  selectedTag?: string
  progress: number
  transferredBytes?: number
  totalBytes?: number
  message: string
  checkedAt?: string
  downloadedPath?: string
  canInstall?: boolean
  logPath?: string
  lastInstallError?: string
}

interface GithubAsset {
  name?: unknown
  size?: unknown
  browser_download_url?: unknown
  digest?: unknown
}

interface GithubRelease {
  tag_name?: unknown
  name?: unknown
  body?: unknown
  published_at?: unknown
  html_url?: unknown
  prerelease?: unknown
  draft?: unknown
  assets?: unknown
}

let releases: UpdateRelease[] = []
let selectedRelease: UpdateRelease | null = null
let portableStagingPath: string | null = null
let state: UpdateState = createInitialState()
let checking: Promise<UpdateState> | null = null
let downloading = false
let installing: Promise<boolean> | null = null
let activeInstall: PreparedUpdateInstall | null = null
let receiptLoaded = false
let downloadedRelease: UpdateRelease | null = null

function deployment(): UpdateDeployment {
  // Steam 版通过安装目录内的 steam_appid.txt 固化识别，不能依赖构建时环境变量继续存在。
  const steamManaged =
    process.env.INFOS_EDITION === 'steam' ||
    (isPackaged && existsSync(join(dirname(app.getPath('exe')), 'steam_appid.txt')))
  if (!isPackaged || isDev || steamManaged) return 'unsupported'
  return isPortable ? 'portable' : 'installed'
}

function createInitialState(): UpdateState {
  const mode = deployment()
  return {
    phase: 'idle',
    deployment: mode,
    currentVersion: app.getVersion(),
    progress: 0,
    message:
      mode === 'unsupported'
        ? isDev
          ? __t('electron.ui.updater', '开发版本不使用 Release 自动更新')
          : __t('electron.ui.updater', '当前发行形态不支持此更新器')
        : __t('electron.ui.updater', '尚未检查更新'),
  }
}

function broadcast(): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    if (!win.isDestroyed()) win.webContents.send('client-update-state', { ...state })
  })
}

function updateState(patch: Partial<UpdateState>): void {
  state = { ...state, ...patch }
  broadcast()
}

function normalizeVersion(tagName: string): string {
  return tagName.trim().replace(/^v/i, '')
}

/** Release 标签映射优先级：hotfix > alpha > beta > rc > stable */
export function classifyReleaseChannel(versionOrTag: string): ReleaseChannel {
  const value = versionOrTag.toLocaleLowerCase()
  if (value.includes('hotfix')) return 'hotfix'
  if (value.includes('alpha')) return 'alpha'
  if (value.includes('beta')) return 'beta'
  if (/(?:^|[.-])rc(?:[.-]?\d+)?(?:$|[.+-])/.test(value)) return 'rc'
  return 'stable'
}

function versionParts(value: string): Array<number | string> {
  return (
    normalizeVersion(value)
      .replace(/\+/g, '-')
      // rc10 / beta2 / hotfix3 等后缀必须拆成文字与数字，否则会出现 rc10 < rc2 的字典序错误。
      .replace(/([a-zA-Z])([0-9])/g, '$1-$2')
      .replace(/([0-9])([a-zA-Z])/g, '$1-$2')
      .split(/[.-]/)
      .filter(Boolean)
      .map((part) => (/^\d+$/.test(part) ? Number(part) : part.toLocaleLowerCase()))
  )
}

/**
 * 比较 Release 版本。
 *
 * hotfix 是项目发行通道而非普通 SemVer 预发布：同一基础版本下，
 * hotfixN 必须高于已发布稳定版，否则 0.9.3 永远看不到 0.9.3-hotfix1。
 * 其他 alpha、beta、rc 仍遵循“稳定版高于预发布”的规则。
 */
export function compareVersions(left: string, right: string): number {
  const leftChannel = classifyReleaseChannel(left)
  const rightChannel = classifyReleaseChannel(right)
  const leftBase = versionParts(left).slice(0, 3)
  const rightBase = versionParts(right).slice(0, 3)
  const baseLength = Math.max(leftBase.length, rightBase.length)
  for (let index = 0; index < baseLength; index++) {
    const av = leftBase[index] ?? 0
    const bv = rightBase[index] ?? 0
    if (av === bv) continue
    return av > bv ? 1 : -1
  }

  if (leftChannel !== rightChannel && (leftChannel === 'hotfix' || rightChannel === 'hotfix')) {
    return leftChannel === 'hotfix' ? 1 : -1
  }

  const a = versionParts(left)
  const b = versionParts(right)
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index++) {
    const av = a[index]
    const bv = b[index]
    if (av === bv) continue
    if (av === undefined) return typeof bv === 'string' ? 1 : -1
    if (bv === undefined) return typeof av === 'string' ? -1 : 1
    if (typeof av === 'number' && typeof bv === 'string') return 1
    if (typeof av === 'string' && typeof bv === 'number') return -1
    return av > bv ? 1 : -1
  }
  return 0
}

function findAsset(rawAssets: unknown, mode: UpdateDeployment): GithubAsset | undefined {
  if (!Array.isArray(rawAssets)) return undefined
  const assets = rawAssets.filter((asset): asset is GithubAsset =>
    Boolean(asset && typeof asset === 'object'),
  )
  return assets.find((asset) => {
    const name = String(asset.name ?? '')
    return mode === 'portable' ? /Portable.*\.zip$/i.test(name) : /Setup.*\.exe$/i.test(name)
  })
}

function parseReleases(raw: unknown): UpdateRelease[] {
  if (!Array.isArray(raw)) throw new Error(__t('electron.ui.updater', 'Release 列表格式无效'))
  const mode = deployment()
  const current = app.getVersion()
  return raw
    .filter((item): item is GithubRelease => Boolean(item && typeof item === 'object'))
    .filter((item) => !item.draft)
    .flatMap((item) => {
      const tagName = String(item.tag_name ?? '').trim()
      const version = normalizeVersion(tagName)
      const asset = findAsset(item.assets, mode)
      const downloadUrl = String(asset?.browser_download_url ?? '')
      if (
        !tagName ||
        !VALID_VERSION.test(version) ||
        !asset ||
        !downloadUrl ||
        typeof asset.size !== 'number' ||
        !Number.isSafeInteger(asset.size) ||
        Number(asset.size) <= 0 ||
        compareVersions(version, current) <= 0
      )
        return []
      return [
        {
          tagName,
          version,
          name: String(item.name ?? tagName),
          body: String(item.body ?? ''),
          publishedAt: String(item.published_at ?? ''),
          htmlUrl: String(item.html_url ?? RELEASES_PAGE),
          channel: classifyReleaseChannel(version),
          prerelease: Boolean(item.prerelease),
          assetName: String(asset.name ?? ''),
          assetSize: Number(asset.size ?? 0),
          downloadUrl,
          digest: typeof asset.digest === 'string' ? asset.digest : undefined,
        } satisfies UpdateRelease,
      ]
    })
    .sort((a, b) => compareVersions(b.version, a.version))
}

async function fetchReleaseList(): Promise<{
  list: UpdateRelease[]
  cached: boolean
  checkedAt: string
}> {
  const cachePath = join(paths.cache, CACHE_FILE)
  try {
    const response = await net.fetch(RELEASES_URL, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'infOS-Updater' },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok)
      throw new Error(__t('electron.ui.updater', 'GitHub 返回 HTTP {0}', [response.status]))
    const raw = await response.json()
    const list = parseReleases(raw)
    const checkedAt = new Date().toISOString()
    try {
      await mkdir(paths.cache, { recursive: true })
      await writeFile(cachePath, JSON.stringify({ format: 1, checkedAt, releases: raw }), 'utf8')
    } catch (error) {
      // 缓存写入失败不能把已成功取得的在线结果退回旧缓存。
      logger.warn('Updater', __t('electron.logs.updater', '保存更新列表缓存失败：{0}', [String(error)]))
    }
    return { list, cached: false, checkedAt }
  } catch (error) {
    logger.warn(
      'Updater',
      __t('electron.logs.updater', '获取 Release 列表失败，尝试读取缓存: {0}', [String(error)]),
    )
    try {
      const cached = JSON.parse(await readFile(cachePath, 'utf8'))
      if (cached?.format !== 1 || typeof cached.checkedAt !== 'string') throw error
      const list = parseReleases(cached.releases)
      // 缓存为空只能说明上次没发现更新，不能证明本次已是最新。
      if (!list.length) throw error
      return { list, cached: true, checkedAt: cached.checkedAt }
    } catch {
      throw error
    }
  }
}

export function setupUpdater(): void {
  if (deployment() === 'unsupported') return
  getUpdateState()
  setTimeout(() => void checkForUpdates().catch(() => undefined), 10_000)
}

export function getUpdateState(): UpdateState {
  if (!receiptLoaded) {
    receiptLoaded = true
    restoreInstallResult()
  }
  return { ...state }
}

function restoreInstallResult(): void {
  if (deployment() === 'unsupported' || activeInstall) return
  try {
    const file = join(paths.cache, INSTALL_RECEIPT)
    if (statSync(file).size > 16 * 1024) return
    const receipt = JSON.parse(readFileSync(file, 'utf8')) as UpdateInstallReceipt
    if (
      receipt.format !== 1 ||
      typeof receipt.version !== 'string' ||
      !VALID_VERSION.test(receipt.version) ||
      !['waiting', 'installing', 'installed', 'failed', 'cancelled'].includes(receipt.status)
    )
      return
    if (receipt.status === 'cancelled') return
    const completed = compareVersions(app.getVersion(), receipt.version) >= 0
    const message = completed
      ? __t('electron.ui.updater', '已完成更新，当前版本为 {0}', [app.getVersion()])
      : __t(
          'electron.ui.updater',
          '上次更新未完成，当前仍为 {0}；可重试或手动运行安装包，详情见更新日志',
          [app.getVersion()],
        )
    updateState({
      phase: completed ? 'up-to-date' : 'error',
      logPath: typeof receipt.logPath === 'string' ? receipt.logPath : undefined,
      message,
      lastInstallError: completed ? undefined : message,
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      logger.warn('Updater', __t('electron.logs.updater', '读取更新安装结果失败：{0}', [String(error)]))
  }
}

export function getCachedReleases(): UpdateRelease[] {
  return releases.map((release) => ({ ...release }))
}

export async function checkForUpdates(): Promise<UpdateState> {
  if (deployment() === 'unsupported') return getUpdateState()
  if (downloading || installing || activeInstall) return getUpdateState()
  if (checking) return checking
  checking = performUpdateCheck()
  try {
    return await checking
  } finally {
    checking = null
  }
}

async function performUpdateCheck(): Promise<UpdateState> {
  getUpdateState()
  updateState({
    phase: 'checking',
    progress: 0,
    message: __t('electron.ui.updater', '正在检查 GitHub Release…'),
  })
  try {
    const result = await fetchReleaseList()
    releases = result.list
    selectedRelease = releases[0] ?? null
    const ready = downloadedRelease && state.downloadedPath
    updateState({
      phase: ready ? 'downloaded' : releases.length ? 'available' : 'up-to-date',
      selectedVersion: ready ? downloadedRelease!.version : selectedRelease?.version,
      selectedTag: ready ? downloadedRelease!.tagName : selectedRelease?.tagName,
      progress: ready || !releases.length ? 100 : 0,
      canInstall: Boolean(ready),
      message: result.cached
        ? __t('electron.ui.updater', '无法在线检查，当前显示缓存的 {0} 个更新版本', [releases.length])
        : ready
          ? __t('electron.ui.updater', '更新已下载，点击安装后应用将完整退出')
          : releases.length
            ? __t('electron.ui.updater', '发现 {0} 个可用版本', [releases.length])
            : __t('electron.ui.updater', '当前已是最新版本'),
      checkedAt: result.checkedAt,
    })
    return getUpdateState()
  } catch (error) {
    updateState({
      phase: 'error',
      message: __t('electron.ui.updater', '检查更新失败：{0}', [
        error instanceof Error ? error.message : String(error),
      ]),
    })
    throw error
  }
}

function selectRelease(tagName?: string): UpdateRelease {
  const target = tagName ? releases.find((release) => release.tagName === tagName) : releases[0]
  if (!target) throw new Error(__t('electron.ui.updater', '未找到可下载的 Release 版本'))
  selectedRelease = target
  return target
}

async function verifyDigest(filePath: string, digest?: string): Promise<void> {
  if (!digest) return
  const match = /^sha256:([a-f0-9]{64})$/i.exec(digest)
  if (!match)
    throw new Error(__t('electron.ui.updater', '更新包摘要格式无效'))
  const expected = match[1]!
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  const actual = hash.digest('hex')
  if (actual.toLocaleLowerCase() !== expected.toLocaleLowerCase()) {
    throw new Error(__t('electron.ui.updater', '更新包 SHA-256 校验失败'))
  }
}

function assertTrustedDownloadUrl(rawUrl: string): void {
  const url = new URL(rawUrl)
  const trusted =
    url.protocol === 'https:' &&
    (url.hostname === 'github.com' ||
      url.hostname.endsWith('.github.com') ||
      url.hostname.endsWith('.githubusercontent.com'))
  if (!trusted) throw new Error(__t('electron.ui.updater', 'Release 资产下载地址不受信任'))
}

async function downloadFile(release: UpdateRelease, destination: string): Promise<void> {
  assertTrustedDownloadUrl(release.downloadUrl)
  const signal = AbortSignal.timeout(30 * 60_000)
  let url = release.downloadUrl
  let response: Response
  for (let hop = 0; ; hop++) {
    assertTrustedDownloadUrl(url)
    response = await net.fetch(url, {
      headers: { Accept: 'application/octet-stream', 'User-Agent': 'infOS-Updater' },
      redirect: 'manual',
      signal,
    })
    if (![301, 302, 303, 307, 308].includes(response.status)) break
    await response.body?.cancel()
    const next = response.headers.get('location')
    if (!next || hop >= 5) throw new Error(__t('electron.ui.updater', '更新下载重定向无效'))
    url = new URL(next, url).href
  }
  if (!response.ok || !response.body)
    throw new Error(__t('electron.ui.updater', '下载服务器返回 HTTP {0}', [response.status]))
  const total = release.assetSize
  const announced = response.headers.get('content-length')
  if (announced !== null && Number(announced) !== total) {
    await response.body.cancel()
    throw new Error(__t('electron.ui.updater', '更新包大小与 Release 声明不一致，请重新检查更新'))
  }
  let transferred = 0
  const source = Readable.fromWeb(response.body as never)
  source.on('data', (chunk: Buffer) => {
    transferred += chunk.length
    if (transferred > total) {
      source.destroy(
        new Error(__t('electron.ui.updater', '更新包大小与 Release 声明不一致，请重新检查更新')),
      )
      return
    }
    const progress = total > 0 ? Math.min(99, Math.round((transferred / total) * 100)) : 0
    updateState({
      phase: 'downloading',
      progress,
      transferredBytes: transferred,
      totalBytes: total,
      message:
        total > 0
          ? __t('electron.ui.updater', '正在下载 {0}%', [progress])
          : __t('electron.ui.updater', '正在下载更新包…'),
    })
  })
  await pipeline(source, createWriteStream(destination))
  if (transferred !== total)
    throw new Error(__t('electron.ui.updater', '更新包大小与 Release 声明不一致，请重新检查更新'))
}

async function findPortableRoot(root: string): Promise<string> {
  const marker = join(root, '.portable')
  try {
    if ((await stat(marker)).isFile()) return root
  } catch {
    // 继续扫描下一层
  }
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const child = join(root, entry.name)
    try {
      if ((await stat(join(child, '.portable'))).isFile()) return child
    } catch {
      // 不是便携根目录
    }
  }
  throw new Error(__t('electron.ui.updater', '便携更新包缺少 .portable 标记'))
}

export async function downloadUpdate(tagName?: string): Promise<UpdateState> {
  if (deployment() === 'unsupported') return getUpdateState()
  if (downloading || activeInstall || installing) return getUpdateState()
  if (checking) await checking
  if (downloading || activeInstall || installing) return getUpdateState()
  getUpdateState()
  downloading = true
  try {
    return await performDownload(tagName)
  } catch (error) {
    if (state.phase !== 'error')
      updateState({
        phase: 'error',
        message: __t('electron.ui.updater', '下载更新失败：{0}', [String(error)]),
      })
    throw error
  } finally {
    downloading = false
  }
}

async function performDownload(tagName?: string): Promise<UpdateState> {
  const release = selectRelease(tagName)
  // 便携版暂存必须位于程序目录之外：便携 data/cache 位于目标目录内部，
  // 若在其中执行 /MIR 覆盖，会形成“源目录嵌套于目标目录”的危险更新拓扑。
  const updatesBase =
    deployment() === 'portable'
      ? join(app.getPath('temp'), 'infos-client-updates')
      : join(paths.cache, 'client-updates')
  await mkdir(updatesBase, { recursive: true })
  const updateRoot = await mkdtemp(join(updatesBase, 'download-'))
  const downloadPath = join(updateRoot, deployment() === 'portable' ? 'portable.zip' : 'installer.exe')
  downloadedRelease = null
  portableStagingPath = null
  updateState({
    phase: 'downloading',
    selectedVersion: release.version,
    selectedTag: release.tagName,
    progress: 0,
    transferredBytes: 0,
    totalBytes: release.assetSize,
    downloadedPath: undefined,
    canInstall: false,
    lastInstallError: undefined,
    message: __t('electron.ui.updater', '准备下载 {0}', [release.version]),
  })
  try {
    await downloadFile(release, downloadPath)
    await verifyDigest(downloadPath, release.digest)
    portableStagingPath = null
    if (deployment() === 'portable') {
      const extractPath = join(updateRoot, 'staging')
      await mkdir(extractPath, { recursive: true })
      const archive = new AdmZip(downloadPath)
      for (const entry of archive.getEntries()) {
        const target = resolve(extractPath, entry.entryName)
        const child = relative(resolve(extractPath), target)
        if (
          !child ||
          child === '..' ||
          child.startsWith('../') ||
          child.startsWith('..\\') ||
          isAbsolute(child) ||
          ((entry.attr >>> 16) & 0o170000) === 0o120000
        )
          throw new Error(__t('electron.ui.updater', '便携更新包包含无效路径'))
      }
      archive.extractAllTo(extractPath, true)
      portableStagingPath = await findPortableRoot(extractPath)
      if (!existsSync(join(portableStagingPath, basename(paths.exe))))
        throw new Error(__t('electron.ui.updater', '便携更新包缺少应用程序'))
    }
    downloadedRelease = release
    updateState({
      phase: 'downloaded',
      selectedVersion: release.version,
      selectedTag: release.tagName,
      progress: 100,
      transferredBytes: release.assetSize,
      totalBytes: release.assetSize,
      downloadedPath: downloadPath,
      canInstall: true,
      message: __t('electron.ui.updater', '更新已下载，点击安装后应用将完整退出'),
    })
    return getUpdateState()
  } catch (error) {
    updateState({
      phase: 'error',
      message: __t('electron.ui.updater', '下载更新失败：{0}', [
        error instanceof Error ? error.message : String(error),
      ]),
    })
    throw error
  }
}

export async function installUpdate(): Promise<boolean> {
  if (installing) return installing
  if (activeInstall || downloading || checking || !downloadedRelease || !state.downloadedPath)
    return false
  installing = performInstall(downloadedRelease, state.downloadedPath)
  try {
    return await installing
  } finally {
    installing = null
  }
}

async function performInstall(release: UpdateRelease, downloadPath: string): Promise<boolean> {
  let packageVerified = false
  updateState({
    phase: 'installing',
    canInstall: false,
    message: __t('electron.ui.updater', '正在准备安装助手，确认就绪后应用才会退出…'),
  })
  try {
    const mode = deployment()
    if (mode === 'unsupported') throw new Error('UPDATE_UNSUPPORTED')
    if ((await stat(downloadPath)).size !== release.assetSize)
      throw new Error(__t('electron.ui.updater', '更新包大小与 Release 声明不一致，请重新检查更新'))
    await verifyDigest(downloadPath, release.digest)
    packageVerified = true
    const prepared = await prepareUpdateInstall({
      version: release.version,
      deployment: mode,
      downloadPath,
      executable: paths.exe,
      stagingPath: portableStagingPath ?? undefined,
      temporaryRoot: join(app.getPath('temp'), 'infos-client-updates'),
      receiptPath: join(paths.cache, INSTALL_RECEIPT),
      logDirectory: paths.logs,
      parentPid: process.pid,
      messages: {
        started: __t('electron.logs.updater', '开始安装客户端更新：{0}', [release.version]),
        finished: __t('electron.logs.updater', '客户端更新文件安装完成：{0}', [release.version]),
        failed: __t('electron.logs.updater', '客户端更新安装失败：{0}'),
        failedNotice: __t(
          'electron.ui.updater',
          '更新安装未完成，请重新打开应用查看状态；也可手动运行下载的安装包。日志：{0}',
        ),
        failedTitle: __t('electron.ui.updater', '客户端更新失败'),
      },
    })
    if (prepared.child.exitCode !== null || prepared.child.signalCode !== null)
      throw Object.assign(new Error('UPDATE_HELPER_EXITED'), { logPath: prepared.logPath })
    activeInstall = prepared
    updateState({
      logPath: prepared.logPath,
      message: __t('electron.ui.updater', '安装助手已就绪，正在退出应用；安装完成后将重新打开'),
    })
    prepared.child.once('exit', () => {
      if (activeInstall?.id !== prepared.id) return
      activeInstall = null
      updateState({
        phase: 'error',
        canInstall: true,
        message: __t(
          'electron.ui.updater',
          '安装助手已结束，但当前应用尚未完成更新；请查看更新日志后重试',
        ),
      })
    })
    logger.info('Updater', __t('electron.logs.updater', '已启动退出安装助手: {0}', [release.version]))
    setImmediate(() => {
      if (
        activeInstall?.id === prepared.id &&
        prepared.child.exitCode === null &&
        prepared.child.signalCode === null
      )
        app.quit()
    })
    return true
  } catch (error) {
    const logPath = (error as { logPath?: string }).logPath
    if (!packageVerified) downloadedRelease = null
    const receipt: UpdateInstallReceipt = {
      format: 1,
      id: (error as { installId?: string }).installId ?? 'preparation',
      version: release.version,
      status: 'failed',
      logPath: logPath ?? paths.logs,
      errorCode: 'UPDATE_PREPARATION_FAILED',
    }
    await writeFile(join(paths.cache, INSTALL_RECEIPT), JSON.stringify(receipt), 'utf8').catch(() => {})
    updateState({
      phase: 'error',
      canInstall: packageVerified,
      logPath,
      message: __t(
        'electron.ui.updater',
        '安装准备失败，应用未退出，更新包已保留；请重试或手动安装，详情见更新日志',
      ),
    })
    logger.error('Updater', __t('electron.logs.updater', '客户端更新安装失败：{0}', [String(error)]))
    return false
  }
}

/** 未保存内容阻止退出时同步取消助手，不能让它在稍后一次普通退出时意外安装。 */
export async function cancelUpdateInstall(): Promise<void> {
  const prepared = activeInstall
  if (!prepared) return
  try {
    await writeFile(prepared.cancelPath, '')
  } catch (error) {
    // 此时宿主仍活着，助手只会等待；取消标记失败时结束整个自有助手树。
    if (!prepared.child.pid || !process.env.SystemRoot) throw error
    await new Promise<void>((resolve, reject) =>
      execFile(
        join(process.env.SystemRoot!, 'System32', 'taskkill.exe'),
        ['/PID', String(prepared.child.pid), '/T', '/F'],
        { windowsHide: true },
        (failure) => failure ? reject(failure) : resolve(),
      ),
    )
  }
  activeInstall = null
  updateState({
    phase: 'downloaded',
    canInstall: true,
    message: __t('electron.ui.updater', '已取消退出与本次安装，更新包已保留，可再次安装'),
  })
}

/** 兼容旧 Launcher 的单条公告接口。 */
export async function getLatestRelease(): Promise<UpdateRelease | null> {
  if (!releases.length) await checkForUpdates()
  return releases[0] ?? null
}
