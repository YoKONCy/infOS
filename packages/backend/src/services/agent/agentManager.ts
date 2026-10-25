import { t as __t } from '../../lib/i18n'
/**
 * Agent Manager — 多 Agent 配置管理
 *
 * 职责：
 * 1. 扫描 agents/ 目录加载 config.json + system_prompt.md
 * 2. 管理活跃 Agent 切换
 * 3. 提供 AgentProfile 数据给 PromptService / ToolPolicy
 *
 * 核心特性：
 * - 移除全局单例，通过 DI 注入
 * - 移除 DB 访问和 Gateway 广播 (拆到 Router 层)
 * - 支持内置 + 用户自定义双目录
 *
 * @module packages/backend/src/services/agent/agentManager
 */

import path from 'node:path'
import { createHash } from 'node:crypto'
import {
  existsSync,
  readdirSync,
  statSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  copyFileSync,
} from 'node:fs'
import type { PathResolver } from '../../core/pathResolver'
import type { AgentPublicProfile } from '@infos/shared'
import type { ConfigRepository } from '../../repositories/config.repo'
import type { PetStateService } from './petStateService'
import { createLogger } from '../../lib/logger'

const logger = createLogger('AgentManager')

/** 旧版官方头像指纹，仅识别未被用户更换的默认资源副本。 */
const LEGACY_BUILTIN_AVATAR_SHA256: Readonly<Record<string, readonly string[]>> = {
  pero: [
    '23bc63e925972e716098d69fc529e58653e83d69cc7ab2e9a2412005f3cdb22e',
    'b892ac785eed8997c7ccef8c6c2bbf593d0952a698c19270046a014494b78d31',
  ],
  nana: [
    '78583973e0532d3943833803de713c8e0866f0303f120f1fef30d353fd9f2d8c',
    '59456d85570dacf73f10e8d219ded2244c12289b6546551741caf55f30a6037d',
  ],
  tsukinaga: [
    'af312b624567d25a93ed802cbf8ab99619d55ecfb6b12b521aaf45912559a8f1',
    '5033ff41e1c6c983db2b4241825aa050a9c56675731c4cf47801ebf907038416',
  ],
}

/**
 * 新建自定义角色的默认能力矩阵（CapabilityGate fail-closed）
 *
 * 默认只声明 desktop；桌宠的 ambient 作用域会在运行时对它继续收窄。
 * 其余 channel 未声明 → 运行时 fail-closed 返回空工具集（安全最小权限）。
 * 工具名必须与 ToolRegistry 注册名一致；用户可在角色管理"高级"页调整。
 */
const DEFAULT_CAPABILITIES_YAML = `# ${'<自动生成>'} 新角色默认能力矩阵 — CapabilityGate (AIOS)
# 未在此声明的 channel 将 fail-closed（无任何工具可用），请按需补充。
agent: __AGENT_ID__

channels:
  desktop:
    tools:
      - '*'
    skills: []
    prompt_fragments: []
`

/** 安全解析 JSON，失败时返回兜底值 */
function safeJsonParse<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

function normalizeDynamicWaifuTexts(texts: Record<string, unknown>): Record<string, unknown> {
  const normalized = structuredClone(texts)
  const welcome =
    normalized.welcome &&
    typeof normalized.welcome === 'object' &&
    !Array.isArray(normalized.welcome)
      ? (normalized.welcome as Record<string, unknown>)
      : {}
  const randTextures =
    normalized.randTextures &&
    typeof normalized.randTextures === 'object' &&
    !Array.isArray(normalized.randTextures)
      ? (normalized.randTextures as Record<string, unknown>)
      : {}

  for (const [key, value] of Object.entries(normalized)) {
    if (key.startsWith('welcome_timeRanges_')) {
      const slot = key.slice('welcome_timeRanges_'.length)
      welcome[slot] = Array.isArray(value) ? String(value[0] ?? '') : value
      delete normalized[key]
    }
  }
  if (normalized.randTexturesNoClothes !== undefined) {
    randTextures.noClothes = normalized.randTexturesNoClothes
    delete normalized.randTexturesNoClothes
  }
  if (normalized.randTexturesSuccess !== undefined) {
    randTextures.success = normalized.randTexturesSuccess
    delete normalized.randTexturesSuccess
  }
  if (Object.keys(welcome).length > 0) normalized.welcome = welcome
  if (Object.keys(randTextures).length > 0) normalized.randTextures = randTextures
  return normalized
}

// ─────────────────────────────────────────────
// ─────────────────────────────────────────────

export interface AgentPackageExport {
  format: 'infos.agent-package'
  version: 1
  agentId: string
  name: string
  fileName: string
  exportedAt: string
  files: Array<{ path: string; contentBase64: string }>
}

/** Agent 配置 (从 config.json 加载) */
export interface AgentProfile {
  id: string
  name: string
  description: string
  /** 允许其他 Agent 读取的结构化公开档案，不包含完整人格与私有记忆。 */
  publicProfile: AgentPublicProfile
  /**
   * 用户称呼（AI 对用户的亲密称谓，如 主人/哥哥/老师）
   *
   * 来自 agent.json 的 owner_appellation 字段，未配置时兜底"主人"。
   * 各角色的称呼独立配置，渲染提示词/台词时按该 Agent 的称呼占位。
   */
  ownerAppellation: string
  // AIOS: workPersona 已移除（work 模式废弃），Social 由子 Agent 处理
  /** 社交模式特征标签 */
  socialTraits: string[]
  /** 社交绑定 (QQ ID 等) */
  socialBinding: Record<string, unknown>
  /** 工具策略覆写 */
  toolPolicies: Record<string, unknown>
  /**
   * 各 channel 的人格补丁（第六阶段 #1）
   *
   * key 为 channel 名（desktop/social/group），
   * value 为注入到 slots/600_channel_patch.md 槽位的补丁文本。
   * 空字符串表示无补丁（槽位会被 skipEmpty 过滤掉）。
   */
  channelPatches: Record<string, string>
  /** 头像文件路径 */
  avatarPath: string | null
  /** config.json 文件路径 */
  configPath: string
  /** system_prompt.md 文件路径 */
  promptPath: string
  /** 看板娘动态文案 (合并自 waifu_texts.json) */
  waifuTexts: Record<string, unknown> | null
}

// ─────────────────────────────────────────────
// Manager
// ─────────────────────────────────────────────

export class AgentManager {
  /** 所有已加载的 Agent */
  private agents = new Map<string, AgentProfile>()

  /**
   * 默认 Agent ID
   *
   * AIOS 架构下不再有"全局活跃 Agent"的概念，前端窗口级状态由 RuntimeStateService 管理。
   * 此字段仅作为"默认 Agent"用于无 Thread 上下场的场景（Scheduler/Cron/Startup），
   * 不再允许运行时切换（setActiveAgent 已移除）。
   */
  defaultAgentId = 'pero'

  /** 已启用的 Agent ID 集合 */
  enabledAgents = new Set<string>()

  /** 会话角色状态服务，用于合并当前会话的动态台词。 */
  private petStateService?: PetStateService

  constructor(
    private pathResolver: PathResolver,
    private configRepo?: ConfigRepository,
  ) {
    this.reloadAgents()
  }

  /** 注入 PetStateService (容器装配阶段调用) */
  setPetStateService(service: PetStateService): void {
    this.petStateService = service
  }

  /** 角色目录加载完成后的回调，用于导入角色资源包内嵌的世界书。 */
  private agentsLoadedListener?: (agents: Array<{ id: string; directory: string }>) => void

  /** 注册后立即以当前角色执行一次，此后每次重载角色目录都会再次通知。 */
  setAgentsLoadedListener(
    listener: (agents: Array<{ id: string; directory: string }>) => void,
  ): void {
    this.agentsLoadedListener = listener
    this.notifyAgentsLoaded()
  }

  private notifyAgentsLoaded(): void {
    this.agentsLoadedListener?.(
      [...this.agents.values()].map((profile) => ({
        id: profile.id,
        directory: path.dirname(profile.configPath),
      })),
    )
  }

  /** 扫描并加载所有 Agent 配置 */
  reloadAgents(): void {
    this.agents.clear()

    // 1. 内置 Agent（最低优先级）
    const builtinDir = this.pathResolver.resolve('@app/backend/src/assets/agents')
    if (existsSync(builtinDir)) this.scanAgents(builtinDir)

    // 2. Workshop Agent（订阅包可采用 agents/、assets/agents/ 或 item 根布局）
    // 角色清单与人设是声明式资源，恢复模式只暂停第三方运行代码，不隐藏角色资料。
    const workshopRoots =
      (this.pathResolver as PathResolver & { getRoots?: (prefix: string) => string[] }).getRoots?.(
        '@workshop',
      ) ?? []
    for (const workshopRoot of workshopRoots) {
      const candidates = [
        path.join(workshopRoot, 'agents'),
        path.join(workshopRoot, 'assets', 'agents'),
        workshopRoot,
      ]
      for (const candidate of candidates) {
        if (!existsSync(candidate)) continue
        if (
          existsSync(path.join(candidate, 'agent.json')) ||
          existsSync(path.join(candidate, 'config.json'))
        ) {
          this.scanAgentPackage(candidate)
        } else {
          this.scanAgents(candidate)
        }
      }
    }

    // 3. 用户自定义 Agent（最高优先级）
    const userDir = this.pathResolver.resolve('@data/agents')
    if (existsSync(userDir)) this.scanAgents(userDir)

    // 默认启用所有
    if (this.enabledAgents.size === 0 && this.agents.size > 0) {
      this.enabledAgents = new Set(this.agents.keys())
    }

    // 确保活跃 Agent 有效
    if (!this.agents.has(this.defaultAgentId) && this.agents.size > 0) {
      this.defaultAgentId = this.agents.keys().next().value!
    }

    logger.info(__t('logs.agent', '已加载 {0} 个 Agent', [this.agents.size]))
    this.notifyAgentsLoaded()
  }

  /** 将当前生效的官方或用户角色导出为客户端可落盘的版本化资源包。 */
  exportAgentPackage(agentId: string): AgentPackageExport {
    const profile = this.agents.get(agentId.toLowerCase())
    if (!profile) throw new Error(`Agent "${agentId}" 不存在`)
    const sourceDir = path.dirname(profile.configPath)
    const files: AgentPackageExport['files'] = []
    const collect = (directory: string, prefix = ''): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === 'workspace') continue
        const absolute = path.join(directory, entry.name)
        const relative = path.posix.join(prefix, entry.name)
        if (entry.isDirectory()) collect(absolute, relative)
        else if (entry.isFile()) {
          files.push({ path: relative, contentBase64: readFileSync(absolute).toString('base64') })
        }
      }
    }
    collect(sourceDir)
    // 用户副本沿用旧默认头像时，导出当前生效的新资源，避免移动客户端再次导入旧图。
    if (profile.avatarPath && path.dirname(profile.avatarPath) !== sourceDir) {
      const avatarNames = new Set(['avatar.png', 'avatar.jpg', 'avatar.webp'])
      for (let index = files.length - 1; index >= 0; index--) {
        const file = files[index]
        if (file && avatarNames.has(file.path)) files.splice(index, 1)
      }
      files.push({
        path: path.basename(profile.avatarPath),
        contentBase64: readFileSync(profile.avatarPath).toString('base64'),
      })
    }
    files.sort((left, right) => left.path.localeCompare(right.path))
    if (!files.some((item) => item.path === 'agent.json' || item.path === 'config.json')) {
      throw new Error(`Agent "${agentId}" 缺少角色清单`)
    }
    return {
      format: 'infos.agent-package',
      version: 1,
      agentId: profile.id,
      name: profile.name,
      fileName: `${profile.id}.infos-agent.zip`,
      exportedAt: new Date().toISOString(),
      files,
    }
  }

  /** 获取 Agent */
  getAgent(agentId: string): AgentProfile | undefined {
    return this.agents.get(agentId.toLowerCase())
  }

  /**
   * 获取默认 Agent
   *
   * 返回 defaultAgentId 对应的 AgentProfile，用于无 Thread 上下文的场景
   * （Scheduler/Cron/Startup）。前端窗口级 Agent 由 RuntimeStateService 管理。
   */
  getDefaultAgent(): AgentProfile | undefined {
    return this.agents.get(this.defaultAgentId)
  }

  /**
   * 获取该 Agent 对用户的称呼
   *
   * 来自 agent.json 的 owner_appellation；Agent 不存在时兜底"主人"。
   * 供提示词渲染/台词占位等位置统一取值，确保各角色称呼独立。
   */
  getOwnerAppellation(agentId: string): string {
    return this.agents.get(agentId.toLowerCase())?.ownerAppellation ?? '主人'
  }

  /**
   * 获取 Agent 的完整可编辑详情（供角色管理 API 使用）
   *
   * 返回前端四个分页所需的全部字段：
   * 基础信息 / 称呼 / 人设正文 / channel 人格补丁 / 社交绑定 / 看板娘台词 / 用户自定义标记。
   */
  getAgentDetail(agentId: string): {
    id: string
    name: string
    description: string
    publicProfile: AgentPublicProfile
    ownerAppellation: string
    systemPrompt: string
    channelPatches: Record<string, string>
    waifuTexts: Record<string, unknown> | null
    isUser: boolean
    isEnabled: boolean
    isActive: boolean
  } | null {
    const profile = this.agents.get(agentId.toLowerCase())
    if (!profile) return null

    let systemPrompt = ''
    try {
      systemPrompt = readFileSync(profile.promptPath, 'utf-8')
    } catch {
      // 人设文件缺失时返回空字符串，由前端提示用户填写
    }

    const userAgentsDir = this.pathResolver.resolve('@data/agents')
    return {
      id: profile.id,
      name: profile.name,
      description: profile.description,
      publicProfile: profile.publicProfile,
      ownerAppellation: profile.ownerAppellation,
      systemPrompt,
      channelPatches: profile.channelPatches,
      waifuTexts: profile.waifuTexts,
      isUser: profile.configPath.startsWith(userAgentsDir),
      isEnabled: this.enabledAgents.has(profile.id),
      isActive: profile.id === this.defaultAgentId,
    }
  }

  /**
   * 更新 Agent 配置（写回 agent.json / system_prompt.md 并同步内存）
   *
   * 内置角色与用户角色均可更新。内置角色的安装目录只读，
   * 第一次修改时自动在 @data/agents/{id} 创建可写副本，之后读写都走副本，
   * 不影响其他用户的安装目录。
   *
   * @returns 更新后的内存 AgentProfile
   */
  updateAgent(
    agentId: string,
    patch: {
      name?: string
      description?: string
      publicProfile?: AgentPublicProfile
      ownerAppellation?: string
      channelPatches?: Record<string, string>
      socialBinding?: Record<string, unknown>
      toolPolicies?: Record<string, unknown>
      waifuTexts?: Record<string, unknown>
      /** 人设正文（写入 system_prompt.md） */
      systemPrompt?: string
    },
  ): AgentProfile {
    const id = agentId.toLowerCase()
    const profile = this.agents.get(id)
    if (!profile) {
      throw new Error(`Agent "${id}" 不存在`)
    }

    // 确保可写副本（内置角色第一次编辑时自动复制到用户数据目录）
    const agentDir = this.ensureUserCopy(id)
    const configPath = path.join(agentDir, 'agent.json')

    // 读取现有 agent.json（保留 schema/资产元数据等未被管理的字段）
    let config: Record<string, unknown>
    try {
      config = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>
    } catch (err) {
      throw new Error(`读取 Agent 配置失败: ${String(err)}`)
    }

    // 白名单字段逐个写回（patch 未提供时保留原值）
    if (patch.name !== undefined) config.name = patch.name
    if (patch.description !== undefined) config.description = patch.description
    if (patch.publicProfile !== undefined) config.public_profile = patch.publicProfile
    if (patch.ownerAppellation !== undefined) config.owner_appellation = patch.ownerAppellation
    if (patch.channelPatches !== undefined) config.channel_patches = patch.channelPatches
    if (patch.toolPolicies !== undefined) config.tool_policies = patch.toolPolicies
    if (patch.waifuTexts !== undefined) config.waifu_texts = patch.waifuTexts
    if (patch.socialBinding !== undefined) {
      config.social = { ...(config.social as Record<string, unknown>), ...patch.socialBinding }
    }

    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')

    // 人设正文写入 system_prompt.md（若提供）
    if (patch.systemPrompt !== undefined) {
      writeFileSync(path.join(agentDir, 'system_prompt.md'), patch.systemPrompt, 'utf-8')
    }

    // 同步内存 profile（加载路径统一走 loadAgentConfig 的同一套规则）
    const updated = this.loadAgentConfig(id, agentDir, configPath)
    this.agents.set(id, updated)

    logger.info(__t('logs.agent', '已更新 Agent 配置: {0}', [id]))
    return updated
  }

  /**
   * 确保指定 Agent 存在可写的用户副本
   *
   * 内置 Agent 位于只读安装目录（@app/...），用户首次编辑时把整个角色包
   * （agent.json / system_prompt.md / capabilities.yaml / avatar 等）
   * 复制到 @data/agents/{id}，并把内存中该 Agent 的读写路径切换到副本。
   *
   * 已存在于 @data 的自定义角色直接返回原目录。
   *
   * @returns 可写的 Agent 目录绝对路径
   */
  private ensureUserCopy(agentId: string): string {
    const id = agentId.toLowerCase()
    const profile = this.agents.get(id)
    if (!profile) {
      throw new Error(`Agent "${id}" 不存在`)
    }

    const userAgentsDir = this.pathResolver.resolve('@data/agents')
    // 已在用户目录 → 直接可写
    if (profile.configPath.startsWith(userAgentsDir)) {
      return path.dirname(profile.configPath)
    }

    // 复制内置角色包到用户目录。目录可能由并发保存或上次中断提前创建，
    // 因此不能只判断目录是否存在，必须确认角色清单已经完整落盘。
    const sourceDir = path.dirname(profile.configPath)
    const targetDir = path.join(userAgentsDir, id)
    const targetConfigPath = path.join(targetDir, path.basename(profile.configPath))
    if (!existsSync(targetConfigPath)) {
      mkdirSync(targetDir, { recursive: true })
      this.copyDir(sourceDir, targetDir)
      logger.info(__t('logs.agent', '内置角色已创建用户副本: {0} → {1}', [id, targetDir]))
    }

    // 将内存中该 Agent 的读写路径切换到副本并重新加载
    const configPath = existsSync(path.join(targetDir, 'agent.json'))
      ? path.join(targetDir, 'agent.json')
      : path.join(targetDir, 'config.json')
    const updated = this.loadAgentConfig(id, targetDir, configPath)
    this.agents.set(id, updated)

    return targetDir
  }

  /**
   * 递归复制目录（用于把内置角色包复制到用户数据目录）
   *
   * 跳过 workspace 子目录（那是运行期数据，不应随角色包一起复制）。
   */
  private copyDir(source: string, target: string): void {
    const entries = readdirSync(source, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name === 'workspace') continue
      const srcPath = path.join(source, entry.name)
      const dstPath = path.join(target, entry.name)
      if (entry.isDirectory()) {
        mkdirSync(dstPath, { recursive: true })
        this.copyDir(srcPath, dstPath)
      } else {
        copyFileSync(srcPath, dstPath)
      }
    }
  }

  /**
   * 获取 Agent 看板娘台词 (静态 + 动态合并)
   *
   * 数据来源:
   * 1. agent.json → waifu_texts (静态默认台词)
   * 2. ConfigRepository → waifu_dynamic_texts_{id} (LLM 动态更新覆盖)
   *
   * 合并后会将台词内出现的 {{ owner_appellation }} 占位替换为该 Agent 的称呼，
   * 使各角色的台词与其称呼配置保持一致。
   *
   * @returns 合并后的台词对象，agent 不存在时返回 null
   */
  async getWaifuTexts(agentId: string, threadId?: string): Promise<Record<string, unknown> | null> {
    const agent = this.agents.get(agentId)
    if (!agent) return null

    // 1. 静态台词
    const staticTexts = (agent.waifuTexts ?? {}) as Record<string, unknown>

    // 2. 动态台词 (由 WaifuTextUpdater 维护周期写入)
    let dynamicTexts: Record<string, unknown> = {}
    if (this.configRepo) {
      try {
        const configVal = await this.configRepo.getJson<Record<string, unknown>>(
          `waifu_dynamic_texts_${agentId}`,
        )
        if (configVal && typeof configVal === 'object') {
          dynamicTexts = normalizeDynamicWaifuTexts(configVal)
        }
      } catch {
        // 动态台词不存在时使用空对象
      }
    }

    // 3. 合并动态台词；嵌套对象按字段合并，避免更新一个时段时清空其他默认问候。
    const merged: Record<string, unknown> = { ...staticTexts, ...dynamicTexts }
    for (const nestedKey of ['welcome', 'randTextures', 'click']) {
      const staticNested = staticTexts[nestedKey]
      const dynamicNested = dynamicTexts[nestedKey]
      if (
        staticNested &&
        typeof staticNested === 'object' &&
        !Array.isArray(staticNested) &&
        dynamicNested &&
        typeof dynamicNested === 'object' &&
        !Array.isArray(dynamicNested)
      ) {
        merged[nestedKey] = {
          ...(staticNested as Record<string, unknown>),
          ...(dynamicNested as Record<string, unknown>),
        }
      }
    }

    // 4. 合并当前会话的临时台词，不读取旧全局状态。
    //    click → texts.click (按部位深合并)；idle → texts.idleMessages；back → texts.backMessages
    if (this.petStateService) {
      try {
        const petState = await this.petStateService.get(agentId, threadId)
        if (petState && this.petStateService.hasActiveTemporaryTexts(petState)) {
          const petClick = safeJsonParse<Record<string, string[]>>(petState.clickMessagesJson, {})
          if (petClick && Object.keys(petClick).length > 0) {
            const baseClick = (merged.click as Record<string, unknown>) ?? {}
            const appendedClick: Record<string, unknown> = { ...baseClick }
            for (const [part, lines] of Object.entries(petClick)) {
              const baseLines = Array.isArray(baseClick[part]) ? baseClick[part].map(String) : []
              appendedClick[part] = [...new Set([...baseLines, ...lines])]
            }
            merged.click = appendedClick
          }

          const petIdle = safeJsonParse<string[]>(petState.idleMessagesJson, [])
          if (Array.isArray(petIdle) && petIdle.length > 0) {
            const baseIdle = Array.isArray(merged.idleMessages)
              ? merged.idleMessages.map(String)
              : []
            merged.idleMessages = [...new Set([...baseIdle, ...petIdle])]
          }

          const petBack = safeJsonParse<string[]>(petState.backMessagesJson, [])
          if (Array.isArray(petBack) && petBack.length > 0) {
            const baseBack = Array.isArray(merged.backMessages)
              ? merged.backMessages.map(String)
              : []
            merged.backMessages = [...new Set([...baseBack, ...petBack])]
          }
        }
      } catch (err) {
        logger.warn(__t('logs.agent', '合并会话动态台词失败: {0}', [err]))
      }
    }

    // 5. 将台词中的 {{ owner_appellation }} 占位替换为该 Agent 的称呼，
    //    使各角色台词与其称呼配置保持一致（支持用户在台词里用占位统一称呼）
    return this.substituteAppellation(merged, agent.name ?? agentId, agent.ownerAppellation)
  }

  /**
   * 递归替换台词对象中的称呼占位
   *
   * 遍历对象/数组中的字符串叶子节点，替换 {{ owner_appellation }} / {{ owner_name }} 占
   * 位，其余键结构保持原样。
   */
  private substituteAppellation<T>(value: T, ownerName: string, appellation: string): T {
    if (value == null) return value
    if (typeof value === 'string') {
      return value
        .replaceAll('{{ owner_appellation }}', appellation)
        .replaceAll('{{ owner_name }}', ownerName) as T
    }
    if (Array.isArray(value)) {
      return value.map((v) => this.substituteAppellation(v, ownerName, appellation)) as T
    }
    if (typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = this.substituteAppellation(v, ownerName, appellation)
      }
      return out as T
    }
    return value
  }

  /** 运行时热启用 Agent (D54) */
  enableAgent(agentId: string): boolean {
    const id = agentId.toLowerCase()
    if (!this.agents.has(id)) {
      logger.warn(__t('logs.agent', '无法启用未知 Agent: {0}', [agentId]))
      return false
    }
    this.enabledAgents.add(id)
    logger.info(__t('logs.agent', 'Agent 已启用: {0}', [id]))
    return true
  }

  /** 运行时热禁用 Agent (D54) */
  disableAgent(agentId: string): boolean {
    const id = agentId.toLowerCase()
    if (id === this.defaultAgentId) {
      logger.warn(__t('logs.agent', '不能禁用主角色: {0}', [id]))
      return false
    }
    this.enabledAgents.delete(id)
    logger.info(__t('logs.agent', 'Agent 已禁用: {0}', [id]))
    return true
  }

  /** 列出所有 Agent (给 API 用) */
  listAgents(): Array<{
    id: string
    name: string
    description: string
    /** 该 Agent 对用户的称呼（用于角色管理列表展示） */
    ownerAppellation: string
    isActive: boolean
    isEnabled: boolean
    /** 是否为用户自定义角色（非内置） */
    isUser: boolean
  }> {
    const userAgentsDir = this.pathResolver.resolve('@data/agents')
    return [...this.agents.values()].map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      ownerAppellation: p.ownerAppellation,
      isActive: p.id === this.defaultAgentId,
      isEnabled: this.enabledAgents.has(p.id),
      isUser: p.configPath.startsWith(userAgentsDir),
    }))
  }

  /**
   *   <agentId>/
   *     agent.json       ← 基本配置
   *     personas/
   *       social.md       ← 社交人设骨架
   */
  createAgent(opts: {
    id: string
    name: string
    description?: string
    /** 该 Agent 对用户的称呼（未指定时兜底"主人"） */
    ownerAppellation?: string
    /** 初始人设文本（未指定时写入默认骨架，用户可后续在人设页编辑） */
    systemPrompt?: string
  }): AgentProfile {
    const agentId = opts.id.toLowerCase()

    // 检查重复
    if (this.agents.has(agentId)) {
      throw new Error(`Agent "${agentId}" 已存在`)
    }

    // 创建目录
    const userAgentsDir = this.pathResolver.resolve('@data/agents')
    const agentDir = path.join(userAgentsDir, agentId)
    mkdirSync(agentDir, { recursive: true })

    // 写入 agent.json
    // AIOS: work 模式已废弃（由 subagent 应用处理），Social 由子 Agent 处理
    const config = {
      name: opts.name,
      description: opts.description ?? '',
      public_profile: {},
      // 角色级称呼：AI 对该用户的亲密称谓，渲染提示词/台词时按此占位
      owner_appellation: opts.ownerAppellation ?? '主人',
      traits: {
        social: [],
      },
      social: { enabled: false, qq_id: '' },
      tool_policies: {},
    }
    const configPath = path.join(agentDir, 'agent.json')
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')

    // 默认 system_prompt.md（人设统一由该文件管理，AIOS）
    const systemPrompt =
      opts.systemPrompt ??
      `# 角色设定\n\n你是 ${opts.name}。\n\n<identity>\n在这里描述你的性格、语气与说话方式。\n</identity>\n`
    writeFileSync(path.join(agentDir, 'system_prompt.md'), systemPrompt, 'utf-8')

    // 默认 capabilities.yaml（CapabilityGate fail-closed：未声明的 channel 无工具）
    writeFileSync(
      path.join(agentDir, 'capabilities.yaml'),
      DEFAULT_CAPABILITIES_YAML.replaceAll('__AGENT_ID__', agentId),
      'utf-8',
    )

    // 自动创建 Principal Workspace 目录骨架（始终位于 @data）
    this.ensureWorkspaceDir(agentId)

    // 加载到内存
    const profile = this.loadAgentConfig(agentId, agentDir, configPath)
    this.agents.set(agentId, profile)
    this.enabledAgents.add(agentId)

    logger.info(__t('logs.agent', '创建自定义 Agent: {0} ({1})', [opts.name, agentId]))
    return profile
  }

  /**
   * 删除自定义 Agent (B6-3)
   *
   * 删除整个 Agent 目录并从内存中移除。
   * 禁止删除内置 Agent 或当前活跃 Agent。
   */
  deleteAgent(agentId: string): void {
    const id = agentId.toLowerCase()
    const profile = this.agents.get(id)
    if (!profile) {
      throw new Error(`Agent "${id}" 不存在`)
    }

    // 禁止删除当前活跃角色
    if (id === this.defaultAgentId) {
      throw new Error(`不能删除当前活跃的 Agent: ${id}`)
    }

    // 禁止删除内置 Agent (判断路径是否在 @data/ 下)
    const userAgentsDir = this.pathResolver.resolve('@data/agents')
    const isUserAgent = profile.configPath.startsWith(userAgentsDir)
    if (!isUserAgent) {
      throw new Error(`不能删除内置 Agent: ${id}`)
    }

    // 删除目录
    const agentDir = path.dirname(profile.configPath)
    rmSync(agentDir, { recursive: true, force: true })

    // 从内存移除
    this.agents.delete(id)
    this.enabledAgents.delete(id)

    logger.info(__t('logs.agent', '已删除 Agent: {0}', [id]))
  }

  /** 判断 Agent 是否为用户自定义 (非内置) */
  isUserAgent(agentId: string): boolean {
    const profile = this.agents.get(agentId.toLowerCase())
    if (!profile) return false
    const userAgentsDir = this.pathResolver.resolve('@data/agents')
    return profile.configPath.startsWith(userAgentsDir)
  }

  /**
   * 获取指定 Agent 可写的 capabilities.yaml 路径
   *
   * 内置角色安装目录只读，第一次编辑能力矩阵时自动创建用户副本，
   * 返回副本内的 capabilities.yaml 路径，交给 CapabilityGate.writeChannels 写回。
   */
  getWritableCapabilitiesPath(agentId: string): string {
    const agentDir = this.ensureUserCopy(agentId)
    return path.join(agentDir, 'capabilities.yaml')
  }

  // ─────────────────────────────────────────
  // 内部
  // ─────────────────────────────────────────

  /** 扫描单个 Agent 包目录。定义文件可只读，运行时 workspace 始终创建在 @data。 */
  private scanAgentPackage(agentDir: string): void {
    let configPath = path.join(agentDir, 'agent.json')
    if (!existsSync(configPath)) configPath = path.join(agentDir, 'config.json')
    if (!existsSync(configPath)) return

    const id = path.basename(agentDir).toLowerCase()
    try {
      const profile = this.loadAgentConfig(id, agentDir, configPath)
      this.agents.set(profile.id, profile)
      this.ensureWorkspaceDir(profile.id)
      logger.debug(__t('logs.agent', '已加载 Agent: {0} ({1})', [profile.name, profile.id]))
    } catch (err) {
      logger.warn(__t('logs.agent', '加载 Agent {0} 失败', [id]), { error: err })
    }
  }

  /** 扫描目录下的 Agent 子目录 */
  private scanAgents(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const agentDir = path.join(dir, entry)
      if (!statSync(agentDir).isDirectory()) continue
      this.scanAgentPackage(agentDir)
    }
  }

  /**
   * 从 ConfigRepository (SQLite) 应用运行时社交覆盖值
   *
   * 只覆盖 social.enabled 和 social.qq_id —— 这两个是部署/用户特定的，
   * 不应硬编码在静态 agent.json 中。
   */
  async applySocialOverrides(agentId: string): Promise<void> {
    if (!this.configRepo) return
    const profile = this.agents.get(agentId)
    if (!profile) return

    const enabledStr = await this.configRepo.get(`agent.${agentId}.social.enabled`)
    if (enabledStr !== undefined) {
      const enabled = enabledStr === 'true'
      profile.socialBinding = {
        ...profile.socialBinding,
        enabled,
      }
    }

    const qqId = await this.configRepo.get(`agent.${agentId}.social.qq_id`)
    if (qqId !== undefined) {
      profile.socialBinding = {
        ...profile.socialBinding,
        qq_id: qqId,
      }
    }
  }

  /**
   * 应用所有 Agent 的运行时覆盖值
   *
   * 应在服务启动后、首次使用前调用。
   */
  async applyAllOverrides(): Promise<void> {
    for (const agentId of this.agents.keys()) {
      await this.applySocialOverrides(agentId)
    }
  }

  /**
   * 确保 Principal Workspace 根目录存在。
   *
   * Agent 定义可能来自 @app 或 Steam Workshop（只读且可被更新/卸载），因此运行时数据
   * 永远写入 @data/principals/{agentId}/workspace，不允许污染资源包目录。
   * 子目录不再预置空骨架，按需懒创建。
   */
  private ensureWorkspaceDir(agentId: string): void {
    const resolver = this.pathResolver as PathResolver & {
      getWorkspaceRoot?: (id: string) => string
    }
    const workspaceRoot =
      resolver.getWorkspaceRoot?.(agentId) ??
      path.join(this.pathResolver.resolve('@data/principals'), agentId, 'workspace')
    if (
      !path.isAbsolute(workspaceRoot) ||
      /^@(app|data|temp|workshop|principal)(?:[\\/]|$)/i.test(workspaceRoot)
    ) {
      throw new Error(`Agent Workspace必须解析为绝对物理路径: ${workspaceRoot}`)
    }
    if (!existsSync(workspaceRoot)) {
      mkdirSync(workspaceRoot, { recursive: true })
    }
  }

  /** 加载单个 Agent 配置 */
  private loadAgentConfig(agentId: string, agentDir: string, configPath: string): AgentProfile {
    const raw = readFileSync(configPath, 'utf-8')
    const config = JSON.parse(raw) as Record<string, unknown>

    // AIOS: workPersona/socialPersona 加载已移除（work 模式废弃，Social 由子 Agent 处理）

    // 特征
    const traits = (config.traits ?? {}) as Record<string, string[]>
    const socialTraits = traits.social ?? (config.social_traits as string[]) ?? []

    // 社交绑定
    const socialBinding = { ...((config.social ?? {}) as Record<string, unknown>) }
    // 兼容旧角色包，收藏表情已迁移为社交账号能力。
    delete socialBinding.use_stickers

    // 头像
    const avatarPath = this.findAvatar(agentDir)

    return {
      id: agentId,
      name: (config.name as string) ?? agentId,
      description: (config.description as string) ?? '',
      publicProfile: this.normalizePublicProfile(config.public_profile),
      // 用户称呼（AI 对用户的亲密称谓），来自 agent.json 的 owner_appellation，未配置时兜底"主人"
      ownerAppellation: (config.owner_appellation as string) ?? '主人',
      socialTraits,
      socialBinding,
      toolPolicies: (config.tool_policies ?? {}) as Record<string, unknown>,
      // 第六阶段 #1: 各 channel 的人格补丁（注入到 slots/600_channel_patch.md）
      channelPatches: (config.channel_patches ?? {}) as Record<string, string>,
      avatarPath,
      configPath,
      promptPath: path.join(agentDir, 'system_prompt.md'),
      waifuTexts: config.waifu_texts as Record<string, unknown>,
    }
  }

  private normalizePublicProfile(value: unknown): AgentPublicProfile {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    const source = value as Record<string, unknown>
    const profile: AgentPublicProfile = {}
    for (const key of ['gender', 'identity', 'appearance', 'personality'] as const) {
      const field = source[key]
      if (typeof field === 'string' && field.trim()) profile[key] = field.trim()
    }
    return profile
  }

  // AIOS: loadPersonaFile 已移除（workPersona/socialPersona 废弃，人设统一由 system_prompt.md 管理）

  /** 查找头像文件 */
  private findAvatar(agentDir: string): string | null {
    for (const name of ['avatar.png', 'avatar.jpg', 'avatar.webp', 'icon.png']) {
      const filePath = path.join(agentDir, name)
      if (!existsSync(filePath)) continue

      const id = path.basename(agentDir).toLowerCase()
      const legacyHashes = LEGACY_BUILTIN_AVATAR_SHA256[id]
      if (legacyHashes) {
        const builtinAvatar = path.join(
          this.pathResolver.resolve('@app/backend/src/assets/agents'),
          id,
          'avatar.png',
        )
        // 只切换与旧官方文件逐字节一致的资源，不写入用户目录或覆盖自定义头像。
        if (
          filePath !== builtinAvatar &&
          existsSync(builtinAvatar) &&
          legacyHashes.includes(createHash('sha256').update(readFileSync(filePath)).digest('hex'))
        ) {
          return builtinAvatar
        }
      }
      return filePath
    }
    return null
  }

  /**
   * 保存 Agent 头像资源。
   *
   * 客户端负责将原图裁切并编码为 PNG；服务端只负责校验后的资源落盘。
   * 内置角色会先创建用户副本，保证安装资源不被直接改写。
   */
  saveAvatar(agentId: string, image: Buffer): void {
    if (image.length === 0) throw new Error('头像文件为空')
    const agentDir = this.ensureUserCopy(agentId)
    const avatarPath = path.join(agentDir, 'avatar.png')
    writeFileSync(avatarPath, image)

    const profile = this.agents.get(agentId.toLowerCase())
    if (profile) profile.avatarPath = avatarPath
    logger.info(__t('logs.agent', 'Agent 头像已保存: {0}', [agentId]))
  }

  /** 只发布实际存在的头像资源，无头像或已删除的角色不返回地址。 */
  getAvatarUrl(agentId: string): string | undefined {
    const agent = this.agents.get(agentId.toLowerCase())
    if (!agent?.avatarPath) return undefined
    try {
      const stat = statSync(agent.avatarPath)
      if (!stat.isFile()) return undefined
      const url = `/agents/${encodeURIComponent(agent.id)}/avatar`
      const builtinAvatar = path.join(
        this.pathResolver.resolve('@app/backend/src/assets/agents'),
        agent.id,
        'avatar.png',
      )
      // 默认资源更新后切换地址，避免浏览器继续复用旧头像的一小时缓存。
      return agent.avatarPath === builtinAvatar
        ? `${url}?v=${stat.size.toString(36)}-${Math.trunc(stat.mtimeMs).toString(36)}`
        : url
    } catch {
      return undefined
    }
  }

  /** 获取头像二进制数据；没有头像时返回 null，文件读取由 Service 负责。 */
  getAvatarData(agentId: string): { buffer: Buffer; mime: string } | null {
    const agent = this.agents.get(agentId.toLowerCase())
    if (!agent?.avatarPath || !existsSync(agent.avatarPath)) return null

    const ext = agent.avatarPath.split('.').pop()?.toLowerCase() ?? 'png'
    const mimeMap: Record<string, string> = {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      webp: 'image/webp',
    }
    return {
      buffer: readFileSync(agent.avatarPath),
      mime: mimeMap[ext] ?? 'image/png',
    }
  }
}
