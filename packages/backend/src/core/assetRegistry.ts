import { t as __t } from '../lib/i18n'
/**
 * 资产联邦化注册表
 *
 * 统一扫描并注册所有可用资产，
 * 覆盖优先级: @data/custom (用户) > @workshop (订阅) > @app (官方)。
 *
 * @module packages/backend/src/core/assetRegistry
 */

import path from 'node:path'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import type { PathResolver } from './pathResolver'
import { createLogger } from '../lib/logger'

const logger = createLogger('AssetRegistry')

// ─────────────────────────────────────────────
// 资产元数据
// ─────────────────────────────────────────────

/** 资产来源 */
export type AssetSource = 'official' | 'workshop' | 'local'

/** 资产类型 */
export type AssetType =
  | 'plugin'
  | 'tool'
  | 'skill'
  | 'persona'
  | 'model_3d'
  | 'prompt'
  | 'mod'
  | 'unknown'

/** 资产元数据 */
export interface AssetMetadata {
  /** 反向域名格式 ID: <scope>.<type>.<name> */
  assetId: string
  /** 资产类型 */
  type: AssetType
  /** 来源 */
  source: AssetSource
  /** 显示名称 */
  displayName: string
  /** 版本号 */
  version: string
  /** 绝对路径 */
  path: string
  /** Workshop ID (仅 workshop 来源) */
  workshopId?: string
  /** 原始配置数据 */
  config?: Record<string, unknown>
}

// ─────────────────────────────────────────────
// AssetRegistry 类
// ─────────────────────────────────────────────

export class AssetRegistry {
  /** asset_id → AssetMetadata */
  private assets = new Map<string, AssetMetadata>()

  /** type → asset_id[] */
  private typeIndex = new Map<string, string[]>()

  /** 是否已完成扫描 */
  private scanned = false

  constructor(private pathResolver: PathResolver) {}

  /**
   * 全量扫描所有资产目录
   *
   * 按优先级从低到高扫描（后扫描的覆盖先扫描的）：
   * 1. Official (@app/) — 总是扫
   * 2. Workshop (@workshop/) — 有就扫，没有就跳
   * 3. Local (@data/custom/) — 总是扫
   */
  async scanAll(): Promise<void> {
    if (this.scanned) return

    logger.info(__t('logs.core', '开始全量资产扫描...'))
    this.assets.clear()
    this.typeIndex.clear()

    // 1. Official — 扫描实际打包布局
    this.scanDir(this.pathResolver.resolve('@app/backend/src/assets/agents'), 'official')
    this.scanDir(this.pathResolver.resolve('@app/backend/src/services/mdp/prompts'), 'official')
    this.scanDir(this.pathResolver.resolve('@app/backend/src/tools'), 'official')
    this.scanDir(this.pathResolver.resolve('@app/backend/src/skills'), 'official')
    const resourcesRoot = process.env.INFOS_RESOURCES_ROOT
    const modelsRoot = resourcesRoot
      ? path.join(resourcesRoot, 'assets', '3d')
      : path.resolve(this.pathResolver.resolve('@app'), '..', 'public', 'assets', '3d')
    this.scanDir(modelsRoot, 'official')

    // 2. Workshop — 每个订阅物品都是独立根，支持 item 根和常见分类子目录。
    for (const workshopRoot of this.pathResolver.getRoots('@workshop')) {
      this.scanAssetRoot(workshopRoot, 'workshop')
    }

    // 3. Local — 用户覆盖层与可执行扩展/技能目录
    this.scanAssetRoot(this.pathResolver.resolve('@data/custom'), 'local')
    this.scanDir(this.pathResolver.resolve('@data/agents'), 'local')
    this.scanDir(this.pathResolver.resolve('@data/packages'), 'local')
    this.scanDir(this.pathResolver.resolve('@data/skills'), 'local')
    this.scanDir(this.pathResolver.resolve('@data/models'), 'local')

    this.scanned = true
    logger.success(__t('logs.core', '资产扫描完成，共索引 {0} 个资产', [this.assets.size]))
  }

  /** 强制重新扫描 (B6-4) */
  async rescan(): Promise<void> {
    this.scanned = false
    await this.scanAll()
  }

  /** 通过 ID 获取资产元数据 */
  getAsset(assetId: string): AssetMetadata | undefined {
    return this.assets.get(assetId)
  }

  /** 获取特定类型的所有资产 */
  getAssetsByType(type: AssetType): AssetMetadata[] {
    const ids = this.typeIndex.get(type) ?? []
    return ids.map((id) => this.assets.get(id)).filter((m): m is AssetMetadata => m !== undefined)
  }

  /** 获取所有已注册资产 */
  getAllAssets(): AssetMetadata[] {
    return Array.from(this.assets.values())
  }

  /** 按来源过滤资产 (B6-4) */
  getAssetsBySource(source: AssetSource): AssetMetadata[] {
    return [...this.assets.values()].filter((m) => m.source === source)
  }

  /** 检查是否已完成扫描 */
  get isScanned(): boolean {
    return this.scanned
  }

  // ─────────────────────────────────────────────
  // 内部方法
  // ─────────────────────────────────────────────

  /**
   * 扫描一个联邦资产根。
   * Workshop item 可以本身就是单资产，也可以包含 agents/models/extensions/skills/prompts 分类目录。
   */
  private scanAssetRoot(rootPath: string, source: AssetSource): void {
    if (!existsSync(rootPath)) return

    const rootMeta = this.loadAssetMeta(rootPath, source)
    if (rootMeta) this.registerAsset(rootMeta)

    const categories = [
      'agents',
      'models',
      'packages',
      'tools',
      'skills',
      'prompts',
      path.join('assets', '3d'),
      path.join('assets', 'agents'),
    ]
    for (const category of categories) this.scanDir(path.join(rootPath, category), source)
  }

  /**
   * 扫描指定目录下的资产
   *
   * 遍历一级子目录，尝试加载 asset.json / manifest.json / description.json
   */
  private scanDir(dirPath: string, source: AssetSource): void {
    if (!existsSync(dirPath)) return

    try {
      const entries = readdirSync(dirPath, { withFileTypes: true })

      for (const entry of entries) {
        if (!entry.isDirectory()) continue

        const assetDir = path.join(dirPath, entry.name)
        const meta = this.loadAssetMeta(assetDir, source)

        if (meta) {
          this.registerAsset(meta)
        }
      }
    } catch (err) {
      logger.warn(__t('logs.core', '扫描资产目录失败: {0}', [dirPath]), { error: err })
    }
  }

  /**
   * 尝试从目录加载资产元数据
   *
   * 优先查找 asset.json (新标准)，兼容 manifest.json / description.json
   */
  private loadAssetMeta(dirPath: string, source: AssetSource): AssetMetadata | null {
    // 按优先级查找元数据文件
    const candidates = ['agent.json', 'asset.json', 'manifest.json', 'description.json']

    for (const filename of candidates) {
      const filePath = path.join(dirPath, filename)
      if (!existsSync(filePath)) continue

      try {
        const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>

        // 必须有 asset_id
        const assetId = raw.asset_id as string | undefined
        if (!assetId) continue

        // Workshop 特有字段兼容 (B6-4)
        const workshopId =
          (raw.workshop_id as string) ??
          (raw.workshopPublishedFileId as string) ??
          (raw.publishedfileid as string) ??
          undefined

        return {
          assetId,
          type: (raw.type as AssetType) ?? 'unknown',
          source,
          displayName:
            (raw.display_name as string) ??
            (raw.displayName as string) ??
            (raw.title as string) ??
            assetId,
          version: (raw.version as string) ?? '1.0.0',
          path: dirPath,
          workshopId,
          config: raw,
        }
      } catch (err) {
        logger.warn(__t('logs.core', '无法解析 {0}: {1}', [filename, filePath]), { error: err })
      }
    }

    return null
  }

  /** 注册单个资产，同 ID 后扫覆盖先扫 */
  private registerAsset(meta: AssetMetadata): void {
    const existing = this.assets.get(meta.assetId)
    if (existing) {
      logger.debug(
        __t('logs.core', '资产覆盖: {0} ({1} → {2})', [meta.assetId, existing.source, meta.source]),
      )
    }

    this.assets.set(meta.assetId, meta)

    // 更新类型索引
    const typeList = this.typeIndex.get(meta.type) ?? []
    if (!typeList.includes(meta.assetId)) {
      typeList.push(meta.assetId)
    }
    this.typeIndex.set(meta.type, typeList)
  }
}
