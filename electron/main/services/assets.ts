import { t as __t } from '../utils/i18n'
/**
 * @file 3D 资产联邦扫描与 asset:// 安全协议
 * @description 统一扫描官方、用户和 Steam Workshop 模型；外部只读资源通过虚拟协议加载。
 * @platform ELECTRON
 * @module electron/main/services/assets
 */

import path from 'node:path'
import { pathToFileURL } from 'node:url'
import fs from 'node:fs'
import { protocol, net, app } from 'electron'
import { logger } from '../utils/logger'
import { isDev, paths } from '../utils/env'
import { getWorkshopInstallations } from './steam'
import { YsmManifestGenerator } from '@infos/avatar-assets'
import { assetRequestHeaders } from './assetRequestPolicy'

/** 资产信息 */
export interface AssetInfo {
  name: string
  path: string
  source: 'official' | 'local' | 'workshop'
  workshopId?: string
  manifest?: Record<string, unknown>
  /** 缩略图 URL（供外观菜单展示） */
  thumbnail?: string
}

interface ModelRoot {
  dirPath: string
  source: AssetInfo['source']
  workshopId?: string
}

/** asset://model/{key}/... → 模型物理根目录，仅主进程持有。 */
const modelRoots = new Map<string, string>()
/** 重写后的内存清单，避免修改只读的官方/Workshop 目录。 */
const virtualManifests = new Map<string, Record<string, unknown>>()

/** 生成稳定且可用于 URL host/path 的模型键。 */
function createModelKey(source: string, name: string, workshopId?: string): string {
  const raw = `${source}-${workshopId ?? 'builtin'}-${name}`
  return Buffer.from(raw, 'utf8').toString('base64url')
}

/** 校验并解析模型根内相对路径，拒绝绝对路径和目录逃逸。 */
function resolveInside(rootDir: string, relativePath: string): string | null {
  const decoded = decodeURIComponent(relativePath).replace(/^[/\\]+/, '')
  const root = path.resolve(rootDir)
  const target = path.resolve(root, decoded)
  const relative = path.relative(root, target)
  if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative))) return target
  return null
}

/** 官方 3D 模型目录。 */
function resolveBuiltinModelDir(): string {
  if (isDev) return path.join(app.getAppPath(), 'public', 'assets', '3d')

  const rendererCandidate = path.join(app.getAppPath(), 'renderer', 'assets', '3d')
  if (fs.existsSync(rendererCandidate)) return rendererCandidate
  return path.join(paths.resources, 'assets', '3d')
}

/** 从 Bedrock 模型 JSON 中提取骨骼名与可见包围盒高度。 */
function extractModelMeta(modelJsonPath: string): { bones: string[]; visibleHeight?: number } {
  try {
    const raw = JSON.parse(fs.readFileSync(modelJsonPath, 'utf-8')) as {
      'minecraft:geometry'?: Array<{
        bones?: Array<{ name?: string }>
        description?: { visible_bounds_height?: number }
      }>
    }
    const geo = raw['minecraft:geometry']?.[0]
    const bones = (geo?.bones ?? [])
      .map((bone) => bone.name)
      .filter((name): name is string => !!name)
    return { bones, visibleHeight: geo?.description?.visible_bounds_height }
  } catch (e) {
    logger.warn(
      'Assets',
      __t('electron.logs.assets', '解析模型元数据失败: {0} - {1}', [modelJsonPath, e]),
    )
    return { bones: [] }
  }
}

/** 将 manifest 中的资源定位到当前虚拟模型根。 */
function rewriteManifestUrls(
  manifest: Record<string, unknown>,
  baseUrl: string,
  modelName: string,
): Record<string, unknown> {
  const encodedName = encodeURIComponent(modelName)
  const rewrite = (value: unknown): unknown => {
    if (typeof value !== 'string' || !value) return value
    if (/^(https?:|data:|blob:|asset:)/i.test(value)) return value

    const normalized = value.replace(/\\/g, '/')
    const prefixes = [
      `/assets/3d/${encodedName}/`,
      `/assets/3d/${modelName}/`,
      `assets/3d/${modelName}/`,
    ]
    const matchedPrefix = prefixes.find((prefix) => normalized.startsWith(prefix))
    const relative = matchedPrefix
      ? normalized.slice(matchedPrefix.length)
      : normalized.replace(/^\.\//, '')
    return `${baseUrl}/${relative.replace(/^\//, '')}`
  }

  const resources = (manifest.resources ?? {}) as Record<string, unknown>
  const controllers = manifest.animation_controllers
  return {
    ...manifest,
    resources: {
      ...resources,
      model: rewrite(resources.model),
      texture: rewrite(resources.texture),
      animations: Array.isArray(resources.animations) ? resources.animations.map(rewrite) : [],
    },
    animation_controllers: Array.isArray(controllers)
      ? controllers.map(rewrite)
      : rewrite(controllers),
    ysmFunctions: Array.isArray(manifest.ysmFunctions)
      ? manifest.ysmFunctions.map(rewrite)
      : undefined,
  }
}

/** 从模型目录读取或在内存中生成 manifest，绝不写入官方/Workshop 只读目录。 */
function loadModelManifest(
  dirPath: string,
  name: string,
  baseUrl: string,
): Record<string, unknown> {
  const manifestPath = path.join(dirPath, 'manifest.json')
  let manifest: Record<string, unknown>

  if (fs.existsSync(manifestPath)) {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>
  } else {
    const ysmPath = path.join(dirPath, 'ysm.json')
    if (!fs.existsSync(ysmPath)) throw new Error(`模型缺少 manifest.json/ysm.json: ${dirPath}`)

    const ysm = JSON.parse(fs.readFileSync(ysmPath, 'utf-8'))
    const mainModelPath = path.join(dirPath, 'models', 'main.json')
    const modelMeta = fs.existsSync(mainModelPath) ? extractModelMeta(mainModelPath) : { bones: [] }
    manifest = YsmManifestGenerator.fromYsm(
      ysm,
      name,
      modelMeta.bones,
      modelMeta.visibleHeight,
    ) as unknown as Record<string, unknown>

    const functionsDir = path.join(dirPath, 'functions')
    if (fs.existsSync(functionsDir)) {
      const files = fs.readdirSync(functionsDir).filter((file) => file.endsWith('.molang'))
      if (files.length > 0) manifest.ysmFunctions = files.map((file) => `functions/${file}`)
    }
  }

  return rewriteManifestUrls(manifest, baseUrl, name)
}

/** 注册 asset:// 自定义协议（必须在 app ready 后调用）。 */
export function registerAssetProtocol(): void {
  protocol.handle('asset', async (request) => {
    try {
      const cors = assetRequestHeaders(
        request,
        isDev ? (process.env.ELECTRON_RENDERER_URL ?? process.env.VITE_DEV_SERVER_URL) : undefined,
      )
      if (!cors) return new Response(null, { status: 403 })
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
      const url = new URL(request.url)
      if (url.hostname !== 'model') return new Response('不支持的资产命名空间', { status: 404 })

      const segments = url.pathname.split('/').filter(Boolean)
      const key = segments.shift()
      if (!key) return new Response('缺少资产键', { status: 400 })
      const rootDir = modelRoots.get(key)
      if (!rootDir) return new Response('资产未注册或已失效', { status: 404 })

      const relativePath = segments.join('/')
      if (relativePath === 'manifest.json') {
        const manifest = virtualManifests.get(key)
        if (!manifest) return new Response('模型清单未注册', { status: 404 })
        return new Response(JSON.stringify(manifest), {
          headers: {
            ...Object.fromEntries(cors),
            'content-type': 'application/json; charset=utf-8',
          },
        })
      }

      const filePath = resolveInside(rootDir, relativePath)
      if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        return new Response('资产文件不存在', { status: 404 })
      }
      const response = await net.fetch(pathToFileURL(filePath).toString(), {
        method: request.method,
      })
      const headers = new Headers(response.headers)
      cors.forEach((value, name) => headers.set(name, value))
      return new Response(request.method === 'HEAD' ? null : response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      })
    } catch (e) {
      logger.warn('Assets', __t('electron.logs.assets', 'asset:// 请求失败: {0}', [e]))
      return new Response('资产加载失败', { status: 500 })
    }
  })
  logger.info('Assets', __t('electron.logs.assets', 'asset:// 安全资产协议已注册'))
}

/** 判断目录自身是否为模型包。 */
function isModelPackage(dirPath: string): boolean {
  return (
    fs.existsSync(path.join(dirPath, 'manifest.json')) ||
    fs.existsSync(path.join(dirPath, 'ysm.json'))
  )
}

/** 从候选容器中发现模型包（支持 item 根、models/、assets/3d/ 三种布局）。 */
function discoverModelPackages(root: ModelRoot): ModelRoot[] {
  const containers = [
    root.dirPath,
    path.join(root.dirPath, 'models'),
    path.join(root.dirPath, 'assets', '3d'),
  ]
  const results: ModelRoot[] = []
  const seen = new Set<string>()

  for (const container of containers) {
    if (!fs.existsSync(container) || !fs.statSync(container).isDirectory()) continue
    if (isModelPackage(container)) {
      const resolved = path.resolve(container)
      if (!seen.has(resolved)) results.push({ ...root, dirPath: resolved })
      seen.add(resolved)
      continue
    }

    for (const entry of fs.readdirSync(container, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const candidate = path.join(container, entry.name)
      const resolved = path.resolve(candidate)
      if (isModelPackage(candidate) && !seen.has(resolved)) {
        results.push({ ...root, dirPath: resolved })
        seen.add(resolved)
      }
    }
  }
  return results
}

/** 扫描官方、用户和 Workshop 3D 模型。 */
export async function scan3DModels(): Promise<AssetInfo[]> {
  // 覆盖优先级与后端资产联邦一致：官方 < Workshop < 用户本地。
  const roots: ModelRoot[] = [
    { dirPath: resolveBuiltinModelDir(), source: 'official' },
    ...getWorkshopInstallations().map((item) => ({
      dirPath: item.folder,
      source: 'workshop' as const,
      workshopId: item.itemId,
    })),
    { dirPath: paths.models, source: 'local' },
  ]

  modelRoots.clear()
  virtualManifests.clear()
  const results = new Map<string, AssetInfo>()
  for (const root of roots) {
    if (!fs.existsSync(root.dirPath)) continue

    try {
      for (const model of discoverModelPackages(root)) {
        const name = path.basename(model.dirPath)
        const key = createModelKey(model.source, name, model.workshopId)
        modelRoots.set(key, model.dirPath)
        const baseUrl = `asset://model/${key}`
        const manifest = loadModelManifest(model.dirPath, name, baseUrl)
        virtualManifests.set(key, manifest)

        let thumbnail = ''
        const avatarDir = path.join(model.dirPath, 'avatar')
        if (fs.existsSync(avatarDir)) {
          const image = fs.readdirSync(avatarDir).find((file) => /\.(png|jpe?g|webp)$/i.test(file))
          if (image) thumbnail = `${baseUrl}/avatar/${encodeURIComponent(image)}`
        }

        const assetId = String(
          manifest.asset_id ?? `${model.source}:${model.workshopId ?? ''}:${name}`,
        )
        results.set(assetId, {
          name: String(
            manifest.display_name ??
              (manifest.metadata as Record<string, unknown> | undefined)?.name ??
              name,
          ),
          path: `${baseUrl}/manifest.json`,
          source: model.source,
          workshopId: model.workshopId,
          manifest,
          thumbnail,
        })
      }
    } catch (e) {
      logger.warn(
        'Assets',
        __t('electron.logs.assets', '扫描模型源失败: {0} - {1}', [root.dirPath, e]),
      )
    }
  }

  const assets = [...results.values()]
  logger.info(
    'Assets',
    __t('electron.logs.assets', '扫描到 {0} 个 3D 模型（官方/本地/Workshop 联邦）', [
      assets.length,
    ]),
  )
  return assets
}
