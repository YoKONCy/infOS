import { t as __t } from '../lib/i18n'
/**
 * Skill Loader — Skill 文件加载器
 *
 * 负责:
 * 1. 扫描 skills/ 目录加载 SKILL.md 的 frontmatter (Manifest)
 * 2. 按需加载完整 Skill 指令 (L2 渐进式加载)
 * 3. 按需加载参考文件 (L3)
 *
 * 文件结构
 *
 * @module packages/backend/src/capabilities/skillLoader
 */

import {
  readFileSync,
  readdirSync,
  existsSync,
  statSync,
  lstatSync,
  realpathSync,
  cpSync,
  mkdirSync,
  rmSync,
} from 'node:fs'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { SkillManifest } from './types'
import { createLogger } from '../lib/logger'
import { AppError } from '../lib/appError'

const logger = createLogger('SkillLoader')

/** YAML frontmatter 分隔符正则 */
const RE_FRONTMATTER = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/

/** 读取 SKILL.md：去掉 Windows 编辑器写入的 BOM，并统一换行，避免 frontmatter 识别失败。 */
function readSkillText(filePath: string): string {
  return readFileSync(filePath, 'utf-8')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
}

export class SkillLoader {
  /** 所有已加载的 Skill 清单 (id → Manifest) */
  private manifests = new Map<string, SkillManifest>()

  /** Skill 内容缓存 (id → markdown body) */
  private contentCache = new Map<string, string>()

  /** Skill 目录路径 */
  private skillDirs: string[]

  /** 用户 Skill 目录 (导入/删除操作目标) */
  private userSkillsDir: string

  constructor(skillDirs: string[], userSkillsDir: string) {
    this.skillDirs = skillDirs
    this.userSkillsDir = userSkillsDir
    this.reloadAll()
  }

  /** 扫描并加载所有 SKILL.md 的 frontmatter */
  reloadAll(): void {
    this.manifests.clear()
    this.contentCache.clear()

    for (const dir of this.skillDirs) {
      if (!existsSync(dir)) continue
      this.scanDir(dir)
    }

    logger.info(__t('logs.capabilities', '已加载 {0} 个 Skill 清单', [this.manifests.size]))
  }

  /**
   * 运行时追加扫描目录（Package 联邦）
   *
   * Package Skill Contribution 激活时调用，将 Package 的 Skill Resource 目录注入。
   * 追加后自动扫描新目录中的 SKILL.md。
   */
  addDirs(dirs: string[]): void {
    let added = 0
    for (const dir of dirs) {
      if (this.skillDirs.includes(dir)) continue
      this.skillDirs.push(dir)
      if (existsSync(dir)) {
        this.scanDir(dir)
        added++
      }
    }
    if (added > 0) {
      logger.info(
        __t('logs.capabilities', '追加扫描 {0} 个 Extension skills 目录，当前共 {1} 个 Skill', [
          added,
          this.manifests.size,
        ]),
      )
    }
  }

  /** 移除运行时扫描目录并重建 Skill 索引。 */
  removeDirs(dirs: string[]): void {
    const removed = new Set(dirs)
    this.skillDirs = this.skillDirs.filter((dir) => !removed.has(dir))
    this.reloadAll()
  }

  /** 获取 Skill 清单 (L1: 只有 name + description) */
  getManifest(skillId: string): SkillManifest | undefined {
    return this.manifests.get(skillId)
  }

  getCompatibilityReport(
    skillId: string,
    availableTools: Set<string> = new Set(),
  ): {
    compatible: boolean
    missingTools: string[]
    resources: string[]
    scripts: string[]
    warnings: string[]
  } | null {
    const manifest = this.manifests.get(skillId)
    if (!manifest) return null
    const resources = this.listResources(skillId)
    const scripts = resources.filter((item) => item.startsWith('scripts/'))
    const requested = [...new Set([...manifest.requiredTools, ...manifest.allowedTools])]
    const missingTools = requested.filter(
      (tool) => availableTools.size > 0 && !availableTools.has(tool),
    )
    const warnings: string[] = []
    if (scripts.length) warnings.push('包含脚本，执行时必须通过现有受控终端工具并遵守审批策略。')
    if (manifest.compatibility) warnings.push(`环境要求：${manifest.compatibility}`)
    if (manifest.allowedTools.length)
      warnings.push('allowed-tools为实验字段，已作为工具依赖提示处理。')
    return { compatible: missingTools.length === 0, missingTools, resources, scripts, warnings }
  }

  resolveResource(skillId: string, relativePath: string): string | null {
    const manifest = this.manifests.get(skillId)
    if (!manifest || !relativePath || path.isAbsolute(relativePath)) return null
    const root = path.resolve(manifest.rootPath)
    const target = path.resolve(root, relativePath)
    if (target !== root && !target.startsWith(root + path.sep)) return null
    if (!existsSync(target) || !statSync(target).isFile() || lstatSync(target).isSymbolicLink()) {
      return null
    }
    const realRoot = realpathSync(root)
    const realTarget = realpathSync(target)
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) return null
    return realTarget
  }

  listResources(skillId: string): string[] {
    const manifest = this.manifests.get(skillId)
    if (!manifest) return []
    const result: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry)
        const stat = lstatSync(full)
        if (stat.isSymbolicLink()) continue
        if (stat.isDirectory()) walk(full)
        else if (stat.isFile() && path.basename(full) !== 'SKILL.md') {
          result.push(path.relative(manifest.rootPath, full).replaceAll('\\', '/'))
        }
        if (result.length >= 500) return
      }
    }
    walk(manifest.rootPath)
    return result
  }

  readResource(skillId: string, relativePath: string, maxBytes = 256_000): string | null {
    const target = this.resolveResource(skillId, relativePath)
    if (!target || statSync(target).size > maxBytes) return null
    return readFileSync(target, 'utf-8')
  }

  /** 获取所有清单 */
  getAllManifests(): SkillManifest[] {
    return [...this.manifests.values()]
  }

  /**
   * 加载完整 Skill 指令 (L2: 渐进式加载)
   *
   * 由 load_skill NIT 工具调用。返回 SKILL.md 的 markdown body。
   */
  loadSkillContent(skillId: string): string | null {
    // 缓存命中
    if (this.contentCache.has(skillId)) {
      return this.contentCache.get(skillId)!
    }

    // 懒加载: 在各 skillDir 中查找
    for (const dir of this.skillDirs) {
      const skillPath = path.join(dir, skillId, 'SKILL.md')
      if (!existsSync(skillPath)) continue

      try {
        const raw = readSkillText(skillPath)
        const match = RE_FRONTMATTER.exec(raw)
        const body = match?.[2]?.trim() ?? raw.trim()
        this.contentCache.set(skillId, body)
        logger.debug(__t('logs.capabilities', 'Skill 内容已加载: {0}', [skillId]))
        return body
      } catch {
        logger.warn(__t('logs.capabilities', '加载 Skill 内容失败: {0}', [skillId]))
      }
    }

    return null
  }

  /**
   * 加载参考文件 (L3: 极少使用)
   */
  loadReference(skillId: string, filename: string): string | null {
    for (const dir of this.skillDirs) {
      const refPath = path.join(dir, skillId, 'references', filename)
      if (!existsSync(refPath)) continue

      try {
        return readFileSync(refPath, 'utf-8')
      } catch {
        return null
      }
    }
    return null
  }

  // ── 导入 / 删除 (用户 Skill 管理) ──

  /**
   * 导入本地 Skill 文件夹到用户目录
   *
   * 验证来源有 SKILL.md → 检查目标不重复 → 递归复制 → 重新扫描。
   * @returns 导入后的文件夹名
   */
  importFromPath(sourcePath: string): string {
    // 验证来源路径存在
    if (!existsSync(sourcePath) || !statSync(sourcePath).isDirectory()) {
      throw new AppError('VALIDATION_ERROR', { message: `路径不存在或不是目录: ${sourcePath}` })
    }

    // 验证来源有 SKILL.md
    const skillMdPath = path.join(sourcePath, 'SKILL.md')
    if (!existsSync(skillMdPath)) {
      throw new AppError('VALIDATION_ERROR', {
        message: '该目录下没有 SKILL.md 文件，不是有效的 Skill 文件夹',
      })
    }

    // 确保用户目录存在
    if (!existsSync(this.userSkillsDir)) {
      mkdirSync(this.userSkillsDir, { recursive: true })
    }

    // 复制到 userSkillsDir/<folder-name>
    const folderName = path.basename(sourcePath)
    this.parseManifest(folderName, skillMdPath)
    const destPath = path.join(this.userSkillsDir, folderName)

    // 检查目标是否已存在
    if (existsSync(destPath)) {
      throw new AppError('ALREADY_EXISTS', {
        message: `目标目录已存在: ${folderName}，请先删除或重命名`,
        data: { resource: folderName },
      })
    }

    // 递归复制
    cpSync(sourcePath, destPath, { recursive: true })
    logger.info(__t('logs.capabilities', 'Skill 已导入: {0}', [folderName]), {
      sourcePath,
      destPath,
    })

    // 重新扫描
    this.reloadAll()

    return folderName
  }

  /**
   * 删除用户 Skill
   *
   * 只允许删除 userSkillsDir 下的 Skill，不允许删除内置或 Package 提供的 Skill。
   */
  deleteById(skillId: string): void {
    const skillPath = path.join(this.userSkillsDir, skillId)

    if (!existsSync(skillPath)) {
      throw new AppError('NOT_FOUND', {
        message: `Skill "${skillId}" 不存在或不在用户目录中`,
      })
    }

    rmSync(skillPath, { recursive: true, force: true })
    logger.info(__t('logs.capabilities', 'Skill 已删除: {0}', [skillId]))

    // 重新扫描
    this.reloadAll()
  }

  // ── 内部 ──

  private scanDir(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const skillDir = path.join(dir, entry)
      if (!statSync(skillDir).isDirectory()) continue

      const skillMdPath = path.join(skillDir, 'SKILL.md')
      if (!existsSync(skillMdPath)) continue

      try {
        const manifest = this.parseManifest(entry, skillMdPath)
        if (manifest) {
          this.manifests.set(manifest.id, manifest)
        }
      } catch (err) {
        logger.warn(__t('logs.capabilities', '解析 Skill {0} 失败: {1}', [entry, err]))
      }
    }
  }

  /** 解析 SKILL.md 的 YAML frontmatter */
  private parseManifest(skillId: string, filePath: string): SkillManifest | null {
    const raw = readSkillText(filePath)
    const match = RE_FRONTMATTER.exec(raw)
    if (!match) {
      logger.warn(__t('logs.capabilities', 'Skill {0} 缺少 frontmatter', [skillId]))
      return null
    }

    const frontmatter = parseYaml(match[1] ?? '') as Record<string, unknown>
    const name = String(frontmatter.name ?? '')
    const description = String(frontmatter.description ?? '')
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name !== skillId) {
      throw new Error(`name必须与目录一致并使用小写kebab-case: ${skillId}`)
    }
    if (!description || description.length > 1024) {
      throw new Error('description必须为1-1024字符')
    }
    const metadata = Object.fromEntries(
      Object.entries((frontmatter.metadata as Record<string, unknown>) ?? {}).map(
        ([key, value]) => [key, String(value)],
      ),
    )
    const list = (value: unknown): string[] => {
      if (Array.isArray(value)) return value.map(String).filter(Boolean)
      if (typeof value === 'string') return value.split(/[\s,]+/).filter(Boolean)
      return []
    }
    const requiredTools = list(frontmatter.requiredTools ?? metadata['infos.required-tools'])
    const dependsOnSkills = list(frontmatter.dependsOnSkills ?? metadata['infos.depends-on-skills'])

    return {
      id: skillId,
      name,
      description,
      requiredTools,
      category: String(frontmatter.category ?? metadata['infos.category'] ?? 'general'),
      tags: list(frontmatter.tags ?? metadata['infos.tags']),
      parameters: Object.fromEntries(
        Object.entries((frontmatter.parameters as Record<string, unknown>) ?? {}).map(
          ([key, value]) => [key, String(value)],
        ),
      ),
      dependsOnSkills,
      license: frontmatter.license ? String(frontmatter.license) : undefined,
      compatibility: frontmatter.compatibility ? String(frontmatter.compatibility) : undefined,
      metadata,
      allowedTools: list(frontmatter['allowed-tools']),
      rootPath: path.dirname(filePath),
    }
  }

  /**
   * 加载 Skill 内容并注入参数 (L2+)
   *
   * 参数通过 `{{param_name}}` 模板变量注入到 SKILL.md body 中。
   * 未提供的参数保留原始占位符。
   */
  loadSkillContentWithParams(skillId: string, params?: Record<string, string>): string | null {
    const raw = this.loadSkillContent(skillId)
    if (!raw) return null

    // 无参数时直接返回
    if (!params || Object.keys(params).length === 0) return raw

    // 模板变量替换: {{key}} → value
    let result = raw
    for (const [key, value] of Object.entries(params)) {
      result = result.replaceAll(`{{${key}}}`, value)
    }
    return result
  }
}
