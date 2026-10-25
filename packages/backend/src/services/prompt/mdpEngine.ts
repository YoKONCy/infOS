import { t as __t } from '../../lib/i18n'
/**
 * MDP 模板引擎 v2 — Nunjucks 渲染 + SillyTavern 风格提示词拼接
 *
 * 核心功能：
 * 1. Nunjucks 模板渲染 (兼容 Jinja2 的 {{ variable }} 语法)
 * 2. YAML Frontmatter 解析 (元数据: role, position, enabled 等)
 * 3. Agent 模板覆盖 (pero/system → 回退 system)
 * 4. **提示词槽位系统 (PromptSlot)** — 类似 SillyTavern 的有序拼接
 *
 * 设计思想 (SillyTavern 式提示词编排)：
 * ───────────────────────────────────────────
 * 每个提示词片段 = 一个 PromptSlot，有唯一 ID、角色、排序位置。
 * 用户可在前端：
 *   - 拖拽排序各 Slot 的 position
 *   - 启用/禁用某个 Slot
 *   - 编辑 Slot 内容 (覆盖默认模板)
 *   - 在任意位置插入自定义 Slot
 *
 * 后端按 position 升序排列所有 enabled 的 Slot，
 * 渲染每个 Slot 的 Nunjucks 模板，然后生成最终的消息列表。
 *
 * @module packages/backend/src/services/prompt/mdpEngine
 */

import { readFileSync, readdirSync, existsSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import nunjucks from 'nunjucks'
import { createLogger } from '../../lib/logger'

const logger = createLogger('MdpEngine')

// ─────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────

/** 解析后的 MDP 模板 (磁盘表示) */
export interface MdPrompt {
  /** 模板键 (如 "tasks/scorer_summary") */
  key: string
  /** 模板内容 (原始 Nunjucks 模板) */
  content: string
  /** YAML Frontmatter 元数据 */
  meta: PromptMeta
}

/** 模板元数据 (YAML Frontmatter) */
export interface PromptMeta {
  /** 消息角色 */
  role?: 'system' | 'user' | 'assistant'
  /** 排序位置 (越小越靠前) */
  position?: number
  /** 是否默认启用 */
  enabled?: boolean
  /** 槽位 ID (用于前端标识，默认 = key) */
  slotId?: string
  /** 显示名称 (前端用) */
  label?: string
  /** 分组 (前端分组显示) */
  group?: string
  /** 是否允许用户编辑 */
  editable?: boolean
  /** 是否系统内置 (不可删除) */
  builtin?: boolean
  /** 其他自定义字段 */
  [key: string]: unknown
}

/**
 * 提示词槽位 (SillyTavern 风格)
 *
 * 运行时的一个提示词片段。支持用户覆盖和排序。
 */
export interface PromptSlot {
  /** 唯一标识 (对应模板的 slotId 或 key) */
  id: string
  /** 显示名称 */
  label: string
  /** 消息角色 */
  role: 'system' | 'user' | 'assistant'
  /** 排序位置 (升序) */
  position: number
  /** 是否启用 */
  enabled: boolean
  /** 原始模板内容 (Nunjucks) */
  template: string
  /** 用户覆盖的内容 (优先于 template) */
  userOverride?: string
  /** 分组标识 */
  group: string
  /** 是否允许编辑 */
  editable: boolean
  /** 是否系统内置 */
  builtin: boolean
  /** 渲染后的内容 (调用 render 后填充) */
  rendered?: string
}

/** 提示词拼接预设 (用户可保存/加载的排列方案) */
export interface PromptPreset {
  /** 预设名称 */
  name: string
  /** 预设描述 */
  description?: string
  /** 槽位排列 (override 现有槽位 + 可新增自定义槽位) */
  slots: Array<{
    id: string
    position: number
    enabled: boolean
    userOverride?: string
    /** 以下字段仅用于用户新增的自定义槽位 (builtin 槽位无需填写) */
    label?: string
    role?: 'system' | 'user' | 'assistant'
    template?: string
  }>
}

/** 渲染后的消息 */
export interface RenderedMessage {
  currentMessage?: boolean
  historyMessage?: boolean
  historyCache?: import('../llm/types').ChatMessage['cacheControl']
  nativeContent?: import('../llm/types').ContentPart[]
  role: 'system' | 'user' | 'assistant'
  content: string
  /** 来源 Slot ID (调试用) */
  slotId: string
}

// ─────────────────────────────────────────────
// 预定义槽位位置 (默认排序)
// ─────────────────────────────────────────────

/** 默认位置常量 (间隔 100 方便用户插入) */
export const DEFAULT_POSITIONS = {
  /** 系统核心人设 */
  SYSTEM_PERSONA: 100,
  /** COT 思维链引导 */
  COT_GUIDANCE: 150,
  /** 能力描述 */
  ABILITIES: 200,
  /** 草稿心流 (预留) */
  DRAFT_FLOW: 250,
  /** 工具描述 */
  TOOLS: 300,
  /** 规则约束 */
  RULES: 400,
  /** 知识/技能片段 */
  KNOWLEDGE: 500,
  /** 社交/工作模式补丁 */
  MODE_PATCH: 600,
  /** 记忆上下文 (RAG) */
  MEMORY_CONTEXT: 700,
  /** 宠物状态 */
  PET_STATE: 800,
  /** 用户画像 */
  USER_PERSONA: 900,
  /** 对话历史 (预留, 由 Pipeline 注入) */
  HISTORY: 5000,
  /** 当前用户消息 (预留) */
  USER_MESSAGE: 9000,
} as const

// ─────────────────────────────────────────────
// 正则
// ─────────────────────────────────────────────

/** YAML Frontmatter 匹配 */
const RE_FRONTMATTER = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/

/** HTML 注释 */
const RE_COMMENT = /<!--[\s\S]*?-->/g

/** 顶部 HTML 注释元数据匹配 */
const RE_TOP_COMMENT = /^<!--[\s\S]*?-->\s*/

// ─────────────────────────────────────────────
// 引擎
// ─────────────────────────────────────────────

export class MdpEngine {
  private managedRenderer?: (
    key: string,
    vars: Record<string, unknown>,
    snapshot?: unknown,
  ) => string

  setManagedRenderer(
    renderer: (key: string, vars: Record<string, unknown>, snapshot?: unknown) => string,
  ): void {
    this.managedRenderer = renderer
  }

  /** 只解析模板源码；插入的聊天、记忆和工具文本永不再次解析。 */
  renderOnce(template: string, vars: Record<string, unknown> = {}): string {
    const values = this.withOwnerDefaults(vars)
    let calls = 0
    const render = (body: string, stack: string[] = []): string => {
      const component =
        typeof values.component === 'function'
          ? values.component
          : (key: string): string => {
              const resolved = this.resolveKey(key, values)
              if (stack.includes(resolved)) throw new Error(`提示词组件循环引用：${resolved}`)
              if (++calls > 128 || stack.length >= 24)
                throw new Error('提示词组件引用过多，请缩小装配范围')
              const prompt = this.prompts.get(resolved)
              if (!prompt) throw new Error(`提示词组件不存在：${resolved}`)
              if (prompt.meta.enabled === false) return ''
              return render(prompt.content, [...stack, resolved])
            }
      const rendered = this.nj
        .renderString(body.replace(RE_COMMENT, ''), { ...values, component })
        .trim()
      if (rendered.length > 4_000_000) throw new Error('提示词渲染内容过大，请缩小装配范围')
      return rendered
    }
    return render(template)
  }

  validateTemplate(template: string): void {
    new nunjucks.Template(template, this.nj, undefined, true)
  }

  /** 以相同发布快照供独立应用编译器装配提示词。 */
  managedFramework?: (
    channel: string,
    agentId: string,
    vars: Record<string, unknown>,
    snapshot?: unknown,
  ) => RenderedMessage[]
  prepareManagedFramework?: (
    channel: string,
    agentId: string,
    vars: Record<string, unknown>,
    snapshot?: unknown,
    sessionId?: string,
  ) => Promise<{
    messages: RenderedMessage[]
    preview?: import('@infos/shared').PromptPreview
    variableCommit?: import('@infos/shared').PromptVariableCommit
  }>
  commitPromptVariables?: (change: import('@infos/shared').PromptVariableCommit) => Promise<void>
  capturePromptSnapshot?: () => unknown
  /** 所有已加载的模板 (key → MdPrompt) */
  private prompts = new Map<string, MdPrompt>()

  /** Nunjucks 环境 */
  private nj: nunjucks.Environment

  /** Agent 模板根目录 (用于覆盖查找) */
  private agentsDir: string

  /**
   * 额外的模板根目录列表（由应用通过 addTemplateRoot 注册）
   *
   * AIOS 第八阶段：允许独立应用注册自己的模板目录，
   * 通过 prefix 前缀隔离避免与主 Agent 模板键冲突。
   * 例如社交应用注册 prefix="apps/social" 后，
   * 其 `abilities/sticker_expression.md` 的键为 `apps/social/abilities/sticker_expression`。
   */
  private additionalRoots: Array<{ dir: string; prefix?: string }> = []

  constructor(
    private promptDir: string,
    agentsDir?: string,
  ) {
    this.agentsDir = agentsDir ?? path.join(path.dirname(promptDir), 'agents')

    // 创建 Nunjucks 环境 (不自动转义, 允许未定义变量)
    this.nj = new nunjucks.Environment(null, {
      autoescape: false,
      throwOnUndefined: false,
      trimBlocks: true,
      lstripBlocks: true,
    })

    // 注册自定义过滤器
    this.registerFilters()

    this.reloadAll()
  }

  // ─────────────────────────────────────────
  // 公开 API: 模板管理
  // ─────────────────────────────────────────

  /** 从磁盘重新加载所有模板 */
  reloadAll(): void {
    this.prompts.clear()

    // 1. 加载 prompts/ 下所有 .md（主 Agent 模板根目录）
    if (existsSync(this.promptDir)) {
      this.scanDir(this.promptDir, this.promptDir)
    }

    // 2. 加载 agents/ 下所有 .md（Agent 覆盖模板）
    if (existsSync(this.agentsDir)) {
      this.scanDir(this.agentsDir, this.agentsDir)
    }

    // 3. 加载应用注册的额外模板根目录（带前缀隔离）
    for (const root of this.additionalRoots) {
      if (existsSync(root.dir)) {
        this.scanDir(root.dir, root.dir, root.prefix)
      }
    }

    logger.info(__t('logs.prompt', '已加载 {0} 个 MDP 模板', [this.prompts.size]))
  }

  /**
   * 添加额外的模板根目录（AIOS 第八阶段：应用模板注册）
   *
   * 允许独立应用（如社交应用）注册自己的模板目录。
   * 通过 prefix 前缀隔离，避免与主 Agent 模板键冲突。
   *
   * @param dir    模板目录绝对路径
   * @param prefix 键前缀（如 "apps/social"），注册后该目录下
   *                `abilities/sticker_expression.md` 的键为 `apps/social/abilities/sticker_expression`
   *
   * 注意：带前缀的模板不会注册 basename 别名，避免污染全局短名空间。
   * reloadAll() 会自动重新扫描已注册的额外根目录。
   */
  addTemplateRoot(dir: string, prefix?: string): void {
    // 去重：如果已注册相同 dir + prefix，跳过
    const exists = this.additionalRoots.some((r) => r.dir === dir && r.prefix === prefix)
    if (exists) {
      logger.debug(
        __t('logs.prompt', '模板根目录已注册，跳过: {0} (prefix={1})', [dir, prefix ?? '无']),
      )
      return
    }

    this.additionalRoots.push({ dir, prefix })
    this.scanDir(dir, dir, prefix)
    logger.info(
      __t('logs.prompt', '已注册额外模板根目录: {0} (prefix={1}, 当前共 {2} 个额外根)', [
        dir,
        prefix ?? '无',
        this.additionalRoots.length,
      ]),
    )
  }

  /** 获取模板对象 */
  getPrompt(key: string): MdPrompt | undefined {
    return this.prompts.get(key)
  }

  /** 列出所有模板键 */
  listKeys(): string[] {
    return [...this.prompts.keys()]
  }

  // ─────────────────────────────────────────
  // 公开 API: 渲染 (单模板)
  // ─────────────────────────────────────────

  /**
   * 渲染单个模板
   *
   * 适用于 Scorer / Reflection 等后台任务直接渲染提示词。
   *
   * @param templateKey - 模板键或 Agent 覆盖键
   * @param vars - 变量字典
   */
  render(templateKey: string, vars: Record<string, unknown> = {}, snapshot?: unknown): string {
    if (this.managedRenderer) return this.managedRenderer(templateKey, vars, snapshot)
    const resolved = this.resolveKey(templateKey, vars)
    const prompt = this.prompts.get(resolved)
    if (!prompt) {
      logger.warn(__t('logs.prompt', '模板未找到: {0}', [templateKey]))
      return `{{Missing: ${templateKey}}}`
    }
    return this.renderTemplate(prompt.content, this.withOwnerDefaults(vars))
  }

  /**
   * 渲染 Nunjucks 模板字符串
   *
   * 暴露给外部直接渲染任意模板文本。
   */
  renderString(template: string, vars: Record<string, unknown> = {}): string {
    return this.renderOnce(template, vars)
  }

  // ─────────────────────────────────────────
  // 公开 API: 提示词拼接系统 (SillyTavern 风格)
  // ─────────────────────────────────────────

  /**
   * 从模板构建默认槽位列表
   *
   * 加载所有 `slots/` 子目录下的模板，
   * 按 frontmatter 中的 role/position/enabled 构建 PromptSlot[]。
   *
   * @param agentId - Agent ID (用于模板覆盖)
   */
  buildDefaultSlots(agentId?: string): PromptSlot[] {
    const slots: PromptSlot[] = []

    for (const [key, prompt] of this.prompts) {
      const meta = prompt.meta

      // 跳过 basename 别名条目：loadFile 会为每个模板额外注册一个 basename 别名
      // (如 slots/100_system_persona 同时注册别名 system_persona)，两者指向同一 prompt 对象。
      // 别名条目的 Map key 与 prompt.key 不一致，若不跳过会导致每个槽位被收录两次、提示词整体重复。
      if (key !== prompt.key) continue

      // 只有带 role 元数据的模板才参与槽位系统
      if (!meta.role) continue

      // Agent 覆盖: 如果有 agentId/key, 优先使用
      let finalPrompt = prompt
      if (agentId) {
        const override = this.prompts.get(`${agentId}/${key}`)
        if (override) finalPrompt = override
      }

      slots.push({
        id: meta.slotId ?? key,
        label: (meta.label as string) ?? key,
        role: meta.role,
        position: meta.position ?? DEFAULT_POSITIONS.KNOWLEDGE,
        enabled: meta.enabled !== false,
        template: finalPrompt.content,
        group: (meta.group as string) ?? 'default',
        editable: meta.editable !== false,
        builtin: meta.builtin === true,
      })
    }

    // 按 position 排序
    return slots.sort((a, b) => a.position - b.position)
  }

  /**
   * 应用用户预设
   *
   * 将预设中的排序/启用/覆盖内容合并到默认槽位。
   *
   * @param defaultSlots - buildDefaultSlots() 的输出
   * @param preset - 用户保存的预设
   */
  applyPreset(defaultSlots: PromptSlot[], preset: PromptPreset): PromptSlot[] {
    const presetMap = new Map(preset.slots.map((s) => [s.id, s]))
    const result = defaultSlots.map((slot) => {
      const override = presetMap.get(slot.id)
      if (!override) return slot
      return {
        ...slot,
        position: override.position,
        enabled: override.enabled,
        userOverride: override.userOverride,
      }
    })

    // 合并用户自定义新增槽位 (preset 中有但 defaultSlots 中没有的)
    const existingIds = new Set(result.map((s) => s.id))
    for (const ps of preset.slots) {
      if (!existingIds.has(ps.id) && ps.template) {
        result.push({
          id: ps.id,
          label: ps.label ?? ps.id,
          role: ps.role ?? 'system',
          position: ps.position,
          enabled: ps.enabled,
          template: ps.template,
          group: 'custom',
          editable: true,
          builtin: false,
        })
      }
    }

    // 按新的 position 排序
    return result.sort((a, b) => a.position - b.position)
  }

  /**
   * 渲染槽位列表 → 消息列表
   *
   * 核心方法: 将有序的 PromptSlot[] 渲染为最终的 LLM 消息。
   *
   * @param slots - 已排序的槽位列表
   * @param vars - 渲染变量
   * @param options - 渲染选项
   */
  renderSlots(
    slots: PromptSlot[],
    vars: Record<string, unknown> = {},
    options: {
      /** 是否合并相邻同角色消息 (减少消息数) */
      mergeAdjacentRoles?: boolean
      /** 是否跳过空内容 */
      skipEmpty?: boolean
    } = {},
  ): RenderedMessage[] {
    const { mergeAdjacentRoles = true, skipEmpty = true } = options

    const messages: RenderedMessage[] = []

    // 渲染变量统一合并称呼/名字兜底，调用方显式传入的值优先
    const mergedVars = this.withOwnerDefaults(vars)

    for (const slot of slots) {
      if (!slot.enabled) continue

      // 优先用户覆盖，否则用默认模板
      const template = slot.userOverride ?? slot.template
      const rendered = this.renderTemplate(template, mergedVars)

      if (skipEmpty && !rendered.trim()) continue

      // 回写渲染结果
      slot.rendered = rendered

      messages.push({
        role: slot.role,
        content: rendered,
        slotId: slot.id,
      })
    }

    // 合并相邻同角色消息
    if (mergeAdjacentRoles) {
      return this.mergeMessages(messages)
    }

    return messages
  }

  /**
   * 导出预设 (从当前槽位状态)
   */
  exportPreset(name: string, slots: PromptSlot[], description?: string): PromptPreset {
    return {
      name,
      description,
      slots: slots.map((s) => ({
        id: s.id,
        position: s.position,
        enabled: s.enabled,
        userOverride: s.userOverride,
      })),
    }
  }

  /**
   * 保存预设到磁盘
   */
  savePreset(preset: PromptPreset, savePath: string): void {
    const dir = path.dirname(savePath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(savePath, JSON.stringify(preset, null, 2), 'utf-8')
    logger.info(__t('logs.prompt', '预设已保存: {0} → {1}', [preset.name, savePath]))
  }

  /**
   * 从磁盘加载预设
   */
  loadPreset(presetPath: string): PromptPreset | null {
    try {
      const raw = readFileSync(presetPath, 'utf-8')
      return JSON.parse(raw) as PromptPreset
    } catch (err) {
      logger.warn(__t('logs.prompt', '加载预设失败: {0}', [presetPath]), { error: err })
      return null
    }
  }

  // ─────────────────────────────────────────
  // 内部方法: 渲染
  // ─────────────────────────────────────────

  /** 旧调用入口同样只解释模板源码，不递归解释插入的数据。 */
  private renderTemplate(template: string, vars: Record<string, unknown>): string {
    return this.renderOnce(template, vars)
  }

  /**
   * 合并称呼/名字默认兜底变量
   *
   * 所有模板统一可安全引用：
   * - owner_name:       用户名字（默认 用户）
   * - owner_appellation: 用户称呼（默认 主人）
   *
   * 调用方（如 ContextCompiler）显式传入配置值时会覆盖默认值，
   * 避免未注入变量导致模板渲染出空串。
   */
  private withOwnerDefaults(vars: Record<string, unknown>): Record<string, unknown> {
    return {
      owner_name: '用户',
      owner_appellation: '主人',
      ...vars,
    }
  }

  /** 合并相邻同角色消息 */
  private mergeMessages(messages: RenderedMessage[]): RenderedMessage[] {
    if (messages.length <= 1) return messages

    const merged: RenderedMessage[] = []
    for (const msg of messages) {
      const prev = merged[merged.length - 1]
      if (prev && prev.role === msg.role) {
        prev.content = prev.content + '\n\n' + msg.content
        prev.slotId = prev.slotId + '+' + msg.slotId
      } else {
        merged.push({ ...msg })
      }
    }
    return merged
  }

  // ─────────────────────────────────────────
  // 内部方法: Agent 覆盖
  // ─────────────────────────────────────────

  /** 解析 Agent 覆盖 (pero/system_prompt → 回退 system_prompt) */
  private resolveKey(key: string, vars: Record<string, unknown>): string {
    // 优先使用 agent_id（目录名一致，大小写精确匹配）
    const agentId = (vars.agent_id ?? vars.agentId) as string | undefined
    if (agentId) {
      const overrideKey = `${agentId}/${key}`
      if (this.prompts.has(overrideKey)) return overrideKey
    }

    // 回退到 agent_name（兼容旧调用，但做小写匹配）
    const agentName = (vars.agent_name ?? vars.agentName) as string | undefined
    if (agentName) {
      const overrideKey = `${agentName.toLowerCase()}/${key}`
      if (this.prompts.has(overrideKey)) return overrideKey
    }
    return key
  }

  // ─────────────────────────────────────────
  // 内部方法: 文件扫描
  // ─────────────────────────────────────────

  /**
   * 递归扫描目录加载 .md 文件
   *
   * @param dir     当前扫描目录
   * @param baseDir 基准目录（用于计算相对路径作为键）
   * @param prefix  键前缀（应用模板隔离用，如 "apps/social"）
   */
  private scanDir(dir: string, baseDir: string, prefix?: string): void {
    for (const entry of readdirSync(dir)) {
      const fullPath = path.join(dir, entry)
      const stat = statSync(fullPath)
      if (stat.isDirectory()) {
        this.scanDir(fullPath, baseDir, prefix)
      } else if (entry.endsWith('.md') || entry.endsWith('.txt')) {
        this.loadFile(fullPath, baseDir, prefix)
      }
    }
  }

  /**
   * 解析单个模板文件
   *
   * @param filePath 文件绝对路径
   * @param baseDir  基准目录（用于计算相对路径作为键）
   * @param prefix   键前缀（应用模板隔离用，如 "apps/social"）
   */
  private loadFile(filePath: string, baseDir: string, prefix?: string): void {
    try {
      const raw = readFileSync(filePath, 'utf-8')
      const relPath = path.relative(baseDir, filePath).replace(/\\/g, '/')
      let key = relPath.replace(/\.(md|txt)$/, '')

      // 带前缀的模板：键 = prefix/relativePath（如 apps/social/abilities/sticker_expression）
      if (prefix) {
        key = `${prefix}/${key}`
      }

      let content = raw
      let meta: PromptMeta = {}
      const yamlSource = raw.replace(RE_TOP_COMMENT, '')

      // 解析 YAML Frontmatter
      const fmMatch = RE_FRONTMATTER.exec(yamlSource)
      if (fmMatch) {
        meta = this.parseSimpleYaml(fmMatch[1] ?? '')
        content = fmMatch[2] ?? ''
      }

      // 注意: 不再剥离注释，Nunjucks 渲染后再剥离
      content = content.trim()

      this.prompts.set(key, { key, content, meta })

      // 注册基名 (兼容短名调用)
      // agents/ 目录下的模板不注册全局 basename，避免 agent 特定模板污染全局
      // slots/ 目录下的模板使用 frontmatter slotId 作为基名（如 abilities），而不是带数字的文件名。
      // 带前缀的应用模板不注册全局 basename，避免污染主 Agent 短名空间
      const isAgentsTemplate = key.startsWith('agents/')
      const isPrefixedTemplate = Boolean(prefix)
      if (!isAgentsTemplate && !isPrefixedTemplate) {
        const basename = meta.slotId && key.startsWith('slots/') ? meta.slotId : path.basename(key)
        if (!this.prompts.has(basename)) {
          this.prompts.set(basename, { key, content, meta })
        }
      }
    } catch (err) {
      logger.warn(__t('logs.prompt', '加载模板失败: {0}', [filePath]), { error: err })
    }
  }

  /** 简易 YAML 解析 (支持基本类型: string/number/boolean) */
  private parseSimpleYaml(yaml: string): PromptMeta {
    const result: PromptMeta = {}
    for (const line of yaml.split('\n')) {
      const match = /^(\w+)\s*:\s*(.+)$/.exec(line.trim())
      if (match && match[1] && match[2]) {
        const key = match[1]
        let val: unknown = match[2].replace(/^['"]|['"]$/g, '')

        // 类型推断
        if (val === 'true') val = true
        else if (val === 'false') val = false
        else if (/^\d+$/.test(val as string)) val = parseInt(val as string, 10)
        else if (/^\d+\.\d+$/.test(val as string)) val = parseFloat(val as string)

        result[key] = val
      }
    }
    return result
  }

  // ─────────────────────────────────────────
  // 内部方法: Nunjucks 过滤器
  // ─────────────────────────────────────────

  /** 注册自定义 Nunjucks 过滤器 */
  private registerFilters(): void {
    // 截断
    this.nj.addFilter('truncate', (str: string, length: number) => {
      if (!str) return ''
      return str.length > length ? str.slice(0, length) + '...' : str
    })

    // 默认值 (Nunjucks 内置有 default，这里补充 d 别名)
    this.nj.addFilter('d', (val: unknown, defaultVal: unknown) => {
      return val ?? defaultVal ?? ''
    })

    // 时间格式化
    this.nj.addFilter('timeago', (dateStr: string) => {
      if (!dateStr) return '未知'
      const diff = Date.now() - new Date(dateStr).getTime()
      const minutes = Math.floor(diff / 60000)
      if (minutes < 1) return '刚刚'
      if (minutes < 60) return `${minutes} 分钟前`
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return `${hours} 小时前`
      const days = Math.floor(hours / 24)
      return `${days} 天前`
    })

    // 列表拼接
    this.nj.addFilter('joinlines', (arr: string[]) => {
      if (!Array.isArray(arr)) return ''
      return arr.filter(Boolean).join('\n')
    })

    // XML 包裹
    this.nj.addFilter('xmlwrap', (content: string, tag: string) => {
      if (!content?.trim()) return ''
      return `<${tag}>\n${content}\n</${tag}>`
    })
  }
}
