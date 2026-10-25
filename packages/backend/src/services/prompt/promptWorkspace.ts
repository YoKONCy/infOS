import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import type {
  PromptBundle,
  PromptDocument,
  PromptFramework,
  PromptIssue,
  PromptPreview,
  PromptRelease,
  PromptWorkspaceView,
} from '@infos/shared'
import {
  promptFormat,
  ST_UTILITY_FIELDS,
  WHOLESOME_MODE_KEY,
  ASSISTANT_PREFILL_KEY,
  parseAssistantPrefillConfig,
} from '@infos/shared'
import { compilePromptPlan } from './requestCompiler'
import type { ConfigRepository } from '../../repositories/config.repo'
import { AppError } from '../../lib/appError'
import { tokenCounter } from '../tokenizer/tokenCounter'
import { promptFingerprint } from '../llm/promptCache'
import type { ChatMessage, ChatOptions } from '../llm/types'
import type { MdpEngine, RenderedMessage } from './mdpEngine'
import { TASK_PROMPTS } from './taskPrompts'
import { builtinBodyHash, synchronizeBuiltinDocument } from './builtinPromptMigration'
import { createLogger } from '../../lib/logger'
import { assembleSillyTavern, sillyTavernIssues } from './sillyTavernFramework'
import { SillyTavernVariableStore } from './sillyTavernVariables'
import type { PromptVariableState, PromptVariableCommit, StUtilityKey } from '@infos/shared'

const logger = createLogger('PromptWorkspace')

export async function readPromptPersona(filePath?: string): Promise<string> {
  if (!filePath) return ''
  try {
    return await readFile(filePath, 'utf8')
  } catch {
    throw new AppError('NOT_FOUND', { message: '角色人设文件无法读取，请检查角色配置' })
  }
}
const TEMPLATE_LABELS: Record<string, string> = {
  'components/state/turn_context': '本轮上下文',
  'components/rules/system_core': '基础规则',
  'components/rules/wholesome_mode': '健全模式',
  'components/output/output_constraint': '输出约定',
  'components/abilities/interaction_mode': '交互模式',
  'components/abilities/private_flow_protocol': '私有心流',
  'components/abilities/task_plan': '行动计划',
  'components/abilities/vision': '视觉',
  'components/abilities/workspace': '工作区',
  'components/abilities/voice': '语音',
  'apps/social/social_rules': '社交规则',
  'apps/social/abilities/sticker_expression': '收藏表情',
  'apps/social/tasks/social_segment_summarizer': '社交记忆',
  'apps/social/social_instructions': '社交交互说明',
  'apps/social/decisions/friend_request_decision': '好友请求判断',
  'group/butler/persona': '管家人设',
  'group/butler/narrate_and_maintain': '管家叙述',
  'group/environment_display': '据点环境',
  'group/interaction_rules': '据点交互规则',
  'tasks/agent/waifu_text_updater': '角色状态更新',
  'tasks/analysis/file_analysis': '文件分析',
  'tasks/diary/diary': '日记写作',
  'tasks/memory/importer/extract_events': '事件记忆提取',
  'tasks/memory/reflection/auditor': '记忆审计',
  'tasks/memory/reflection/daily_closing': '每日记忆整理',
  'tasks/memory/reflection/dream_associator': '梦境联想',
  'tasks/memory/reflection/memory_reflection': '记忆关联反思',
  'tasks/memory/scorer/graph_builder': '记忆图谱构建',
  'tasks/memory/scorer/summary': '记忆摘要评分',
  'tasks/perception/screen_observe_system': '屏幕观察',
  'slots/600_channel_patch': '频道补充',
}

const KEY = 'prompt.workspace.v1'
const id = z
  .string()
  .min(1)
  .max(180)
  .regex(/^[a-zA-Z0-9_./-]+$/)
  .refine(
    (value) =>
      !value.split(/[./]/).some((part) => ['__proto__', 'constructor', 'prototype'].includes(part)),
    '标识包含保留名称',
  )
const variableId = z
  .string()
  .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/)
  .max(100)
  .refine(
    (value) =>
      !value.startsWith('__') && !['constructor', 'prototype', 'component'].includes(value),
    '变量名称已保留',
  )
const role = z.enum(['system', 'user', 'assistant'])
const text = z.string().max(200_000)
const condition = z.string().max(1000).optional()
const overrides = z.record(id, id)
export const promptBundleSchema = z.object({
  documents: z
    .array(
      z.object({
        id,
        name: z.string().min(1).max(100),
        kind: z.enum(['slot', 'component', 'task']),
        body: text,
        role,
        enabled: z.boolean(),
        builtin: z.boolean().optional(),
        builtinBodyHash: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        variables: z.array(id).max(100),
      }),
    )
    .max(500),
  frameworks: z
    .array(
      z.object({
        id,
        name: z.string().min(1).max(100),
        builtin: z.boolean().optional(),
        format: z.enum(['infos', 'sillytavern', 'custom']).optional(),
        overrides: overrides.optional(),
        sillyTavern: z
          .object({
            markerBindings: z.record(
              z
                .string()
                .min(1)
                .max(300)
                .refine((value) => !['__proto__', 'constructor', 'prototype'].includes(value)),
              z
                .string()
                .max(100)
                .refine(
                  (value) =>
                    value === '' || value === '$text' || variableId.safeParse(value).success,
                ),
            ),
            values: z.record(
              z
                .string()
                .min(1)
                .max(300)
                .refine((value) => !['__proto__', 'constructor', 'prototype'].includes(value)),
              text,
            ),
            sourcePreset: z.record(z.string(), z.unknown()).optional(),
            orderProfile: z.number().int().min(0).max(99).optional(),
            utility: z
              .partialRecord(
                z.enum(
                  ST_UTILITY_FIELDS.map((item) => item.value) as [StUtilityKey, ...StUtilityKey[]],
                ),
                text,
              )
              .optional(),
            characters: z
              .record(
                z
                  .string()
                  .max(100)
                  .refine(
                    (value) =>
                      !value.startsWith('__') && !['constructor', 'prototype'].includes(value),
                  ),
                z.object({
                  main: text.optional(),
                  postHistory: text.optional(),
                  description: text.optional(),
                  personality: text.optional(),
                  scenario: text.optional(),
                  examples: text.optional(),
                  firstMessage: text.optional(),
                  creatorNotes: text.optional(),
                  version: text.optional(),
                  authorsNote: text.optional(),
                }),
              )
              .optional(),
          })
          .optional(),
        bindings: z
          .array(
            z.object({
              name: variableId,
              kind: z.enum(['template', 'capabilities', 'persona']),
              source: id.optional(),
              template: text.optional(),
              when: condition,
            }),
          )
          .max(100),
        blocks: z
          .array(
            z.object({
              id,
              name: z.string().max(100),
              kind: z.enum(['template', 'history', 'marker']),
              role,
              enabled: z.boolean(),
              source: id.optional(),
              template: text.optional(),
              when: condition,
              marker: z.string().min(1).max(300).optional(),
              stIdentifier: z.string().min(1).max(300).optional(),
              position: z.enum(['relative', 'in_chat']).optional(),
              depth: z.number().int().min(0).max(10_000).optional(),
              order: z.number().int().min(-100_000).max(100_000).optional(),
              triggers: z.array(z.string().min(1).max(50)).max(10).optional(),
              forbidOverrides: z.boolean().optional(),
            }),
          )
          .max(500),
      }),
    )
    .max(100),
  assignments: z
    .array(
      z.object({
        agentId: z.string().max(100),
        channel: z.string().max(60),
        frameworkId: z.string().max(180),
        overrides,
      }),
    )
    .max(500),
})
const storedWorkspaceSchema = z.object({
  revision: z.number().int().nonnegative(),
  draft: promptBundleSchema,
  releases: z
    .array(
      z.object({
        id,
        createdAt: z.string().datetime(),
        note: z.string().max(200),
        bundle: promptBundleSchema,
      }),
    )
    .min(1)
    .max(30),
  activeReleaseId: id,
  recoveryError: z.string().optional(),
})

interface StoredWorkspace {
  revision: number
  draft: PromptBundle
  releases: PromptRelease[]
  activeReleaseId: string
  recoveryError?: string
}
export interface PromptSnapshot {
  id: string
  bundle: PromptBundle
}
interface RenderBudget {
  calls: number
}

export const PROMPT_VARIABLES = [
  ['model', '当前模型'],
  ['max_prompt', '可用输入 Token'],
  ['max_context_tokens', '上下文 Token 上限'],
  ['max_response_tokens', '配置输出 Token 上限'],
  ['agent_id', '角色 ID'],
  ['agent_name', '角色名字'],
  ['channel', '频道'],
  ['persona_definition', '角色人设'],
  ['owner_name', '用户名字'],
  ['owner_appellation', '用户称呼'],
  ['current_time', '当前时间'],
  ['memory_context', '记忆'],
  ['knowledge_context', '文档知识召回'],
  ['facts_context', '事实召回'],
  ['conversation_history', '历史文本'],
  ['tools_description', '工具说明'],
  ['skill_menu', '技能目录'],
  ['flow_state', '心流状态'],
  ['task_plan', '当前计划'],
  ['task_plan_enabled', '计划能力启用'],
  ['channel_patch', '频道补丁'],
  ['user_persona', '用户设定'],
  ['interaction_mode', '交互模式'],
  ['spoken_reply_enabled', '桌宠气泡启用'],
  ['environment_info', '系统环境'],
  ['mood', '心情'],
  ['vibe', '状态'],
  ['mind', '心声'],
  ['realm_execution', '据点执行'],
  ['wholesome_mode_enabled', '健全模式启用'],
  ['weather_location', '天气地点'],
  ['weather_info', '当前天气'],
  ['capability_fragments', '能力模板键'],
  ['native_history', '原生历史消息'],
  ['social_session', '社交身份'],
  ['stickers_available', '账号收藏表情可用'],
  ['char_personality', '兼容角色性格'],
  ['scenario', '兼容场景'],
  ['dialogue_examples', '兼容示例对话'],
  ['current_message', '本次用户消息'],
  ['generation_type', '生成类型'],
  ['prompt_seed', '预览随机种子'],
].map(([name, label]) => ({ name: name!, label: label! }))

function copy<T>(value: T): T {
  return structuredClone(value)
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) freeze(child)
  }
  return value
}
function fail(message: string, data?: unknown): never {
  throw new AppError('VALIDATION_ERROR', { message, data })
}

/** 发布记录只增不改；保存和发布串行落盘成功后才切换内存状态。 */
export class PromptWorkspace {
  private recoveryError = ''
  private state!: StoredWorkspace
  private queue: Promise<unknown> = Promise.resolve()

  readonly variableStore: SillyTavernVariableStore
  constructor(
    private repo: ConfigRepository,
    private engine: MdpEngine,
  ) {
    this.variableStore = new SillyTavernVariableStore(repo)
  }

  async initialize(): Promise<void> {
    const raw = await this.repo.get(KEY)
    try {
      if (raw) {
        const saved = storedWorkspaceSchema.parse(JSON.parse(raw))
        if (!saved.releases.some((r) => r.id === saved.activeReleaseId))
          fail('提示词存储损坏，请恢复配置备份')
        this.state = saved
        this.recoveryError = saved.recoveryError ?? ''
      } else {
        const bundle = this.defaults()
        this.state = {
          revision: 0,
          draft: copy(bundle),
          activeReleaseId: 'builtin',
          releases: [
            { id: 'builtin', createdAt: new Date().toISOString(), note: '内置预设', bundle },
          ],
        }
      }
    } catch (error) {
      // 不让损坏的提示词配置拖垮后台，也不悄悄恢复默认提示词继续执行任务。
      await this.repo.set(`prompt.workspace.recovery.${Date.now()}`, raw ?? '')
      this.recoveryError = '提示词配置损坏，原始内容已备份。请在提示词页重新发布配置后继续。'
      logger.error(this.recoveryError, {
        error: error instanceof Error ? error.message : String(error),
      })
      const bundle = this.defaults()
      this.state = {
        revision: 0,
        draft: copy(bundle),
        activeReleaseId: 'recovery',
        recoveryError: this.recoveryError,
        releases: [
          { id: 'recovery', createdAt: new Date().toISOString(), note: '恢复草稿', bundle },
        ],
      }
    }
    this.engine.setManagedRenderer((key, vars, snapshot) =>
      this.renderDocument((snapshot as PromptSnapshot | undefined) ?? this.snapshot(), key, vars),
    )
    this.engine.capturePromptSnapshot = () => this.snapshot()
    this.engine.managedFramework = (channel, agentId, vars, snapshot) =>
      this.assemble(
        (snapshot as PromptSnapshot | undefined) ?? this.snapshot(),
        channel,
        agentId,
        vars,
      ).messages
    this.engine.prepareManagedFramework = (channel, agentId, vars, snapshot, sessionId) =>
      this.prepare(
        (snapshot as PromptSnapshot | undefined) ?? this.snapshot(),
        channel,
        agentId,
        vars,
        sessionId,
      )
    this.engine.commitPromptVariables = (change) => this.variableStore.commit(change)
  }

  defaults(): PromptBundle {
    const documents: PromptDocument[] = []
    for (const key of this.engine.listKeys()) {
      const prompt = this.engine.getPrompt(key)!
      if (key !== prompt.key || !/^(slots|components|tasks|group|apps)\//.test(key)) continue
      const kind = key.startsWith('slots/')
        ? 'slot'
        : key.startsWith('apps/social/tasks/') || key === 'group/butler/narrate_and_maintain'
          ? 'task'
          : 'component'
      const variables = [
        ...new Set(
          [...prompt.content.matchAll(/\{\{-?\s*([a-zA-Z_][a-zA-Z0-9_]*)/g)].map(
            (match) => match[1]!,
          ),
        ),
      ].filter((name) => name !== 'component')
      documents.push({
        id: key,
        name: String(TEMPLATE_LABELS[key] ?? prompt.meta.label ?? key.split('/').at(-1)),
        kind,
        body: prompt.content,
        role: prompt.meta.role ?? 'system',
        enabled: prompt.meta.enabled !== false,
        builtin: true,
        builtinBodyHash: builtinBodyHash(prompt.content),
        variables,
      })
    }
    documents.push(
      ...Object.values(TASK_PROMPTS).map((document) => ({
        ...copy(document),
        builtinBodyHash: builtinBodyHash(document.body),
      })),
    )
    const main: PromptFramework = {
      id: 'builtin.main',
      name: 'infOS 默认',
      builtin: true,
      format: 'infos',
      bindings: [
        { name: 'persona_definition', kind: 'persona' },
        { name: 'system_core', kind: 'template', source: 'components/rules/system_core' },
        { name: 'output_format', kind: 'template', source: 'components/output/output_constraint' },
        {
          name: 'mode_instructions',
          kind: 'template',
          source: 'components/abilities/interaction_mode',
          when: 'channel == "desktop" and not realm_execution',
        },
        { name: 'capability_text', kind: 'capabilities' },
        {
          name: 'ability_fragments',
          kind: 'template',
          template: '{{ mode_instructions }}\n\n{{ capability_text }}',
        },
      ],
      blocks: [
        ...this.engine
          .buildDefaultSlots()
          .filter(
            (s) =>
              this.slotKey(s.id).startsWith('slots/') &&
              !['memory_context', 'conversation_history', 'pet_state', 'history'].includes(s.id),
          )
          .map<PromptFramework['blocks'][number]>((s) => ({
            id: s.id,
            name: TEMPLATE_LABELS[this.slotKey(s.id)] ?? s.label,
            kind: 'template',
            role: s.role,
            enabled: s.enabled,
            source: this.slotKey(s.id),
          })),
        { id: 'native_history', name: '历史', kind: 'history', role: 'user', enabled: true },
        {
          id: 'turn_context',
          name: '本轮上下文',
          kind: 'template',
          role: 'user',
          enabled: true,
          source: 'components/state/turn_context',
        },
      ],
    }
    const social: PromptFramework = {
      id: 'builtin.social',
      name: '社交默认',
      builtin: true,
      format: 'infos',
      bindings: [
        { name: 'persona_definition', kind: 'persona' },
        { name: 'social_rules', kind: 'template', source: 'apps/social/social_rules' },
        {
          name: 'sticker_expression',
          kind: 'template',
          source: 'apps/social/abilities/sticker_expression',
          when: 'stickers_available',
        },
      ],
      blocks: [
        ...[
          [
            'persona',
            '人设',
            '<persona name="{{ agent_name }}">\n{{ persona_definition }}\n</persona>',
          ],
          [
            'stickers',
            '收藏表情',
            '{% if sticker_expression %}<account_stickers>\n{{ sticker_expression }}\n</account_stickers>{% endif %}',
          ],
          ['abilities', '能力描述', ''],
          ['rules', '规则', '<social_rules>\n{{ social_rules }}\n</social_rules>'],
        ].map<PromptFramework['blocks'][number]>(([blockId, name, template]) => ({
          id: blockId!,
          name: name!,
          ...(blockId === 'abilities' ? { source: this.slotKey('abilities') } : { template }),
          kind: 'template',
          role: 'system',
          enabled: true,
        })),
        { id: 'native_history', name: '历史', kind: 'history', role: 'user', enabled: true },
        {
          id: 'turn_context',
          name: '本轮上下文',
          kind: 'template',
          role: 'user',
          enabled: true,
          source: 'components/state/turn_context',
        },
      ],
    }
    return {
      documents,
      frameworks: [main, social],
      assignments: [
        { agentId: '', channel: '', frameworkId: main.id, overrides: {} },
        { agentId: '', channel: 'social', frameworkId: social.id, overrides: {} },
      ],
    }
  }

  private slotKey(slotId: string): string {
    return (
      this.engine
        .listKeys()
        .find((k) => k.startsWith('slots/') && this.engine.getPrompt(k)?.meta.slotId === slotId) ??
      slotId
    )
  }

  /** 补入后注册模板，并按原文指纹升级未改动的内置正文；不覆盖用户定制或发布原件。 */
  private withNewDefaults(bundle: PromptBundle): PromptBundle {
    const result = copy(bundle)
    for (const framework of result.frameworks) framework.format ??= promptFormat(framework)
    const defaults = this.defaults()
    for (const framework of result.frameworks) {
      if (
        !framework.builtin ||
        framework.format !== 'infos' ||
        framework.blocks.some((block) => block.id === 'turn_context')
      )
        continue
      const standard = defaults.frameworks.find((item) => item.id === framework.id)
      if (
        !standard ||
        promptFingerprint(framework.bindings) !== promptFingerprint(standard.bindings)
      )
        continue
      const oldSlots = this.engine
        .buildDefaultSlots()
        .filter((slot) => this.slotKey(slot.id).startsWith('slots/'))
      const oldMainIds = oldSlots.map((slot) => slot.id)
      const unchangedMain =
        framework.id === 'builtin.main' &&
        JSON.stringify(framework.blocks.map((block) => block.id)) === JSON.stringify(oldMainIds) &&
        framework.blocks.every(
          (block) =>
            block.kind === 'template' &&
            !block.template &&
            !block.when &&
            block.source === this.slotKey(block.id) &&
            block.enabled === oldSlots.find((slot) => slot.id === block.id)?.enabled,
        )
      const unchangedSocial =
        framework.id === 'builtin.social' &&
        JSON.stringify(framework.blocks.map((block) => block.id)) ===
          JSON.stringify([
            'memory',
            'history',
            'persona',
            'stickers',
            'abilities',
            'rules',
            'session',
          ]) &&
        framework.blocks.every(
          (block) =>
            block.enabled &&
            block.role === 'system' &&
            !block.when &&
            (Boolean(
              standard.blocks.find(
                (item) =>
                  item.id === block.id &&
                  item.kind === block.kind &&
                  item.source === block.source &&
                  item.template === block.template,
              ),
            ) ||
              (block.id === 'abilities' && block.source === this.slotKey('abilities')) ||
              (block.id === 'memory' &&
                block.template ===
                  '{% if memory_context %}<long_term_memory>\n{{ memory_context }}\n</long_term_memory>{% endif %}') ||
              (block.id === 'history' &&
                block.template ===
                  '{% if conversation_history %}<chat_history>\n{{ conversation_history }}\n</chat_history>{% endif %}') ||
              (block.id === 'session' &&
                block.template === '<session_context>\n{{ social_session }}\n</session_context>')),
        )
      // 只升级原样内置布局；自定义框架、正文和发布版本继续由用户管理。
      if (standard && (unchangedMain || unchangedSocial)) {
        framework.blocks = copy(standard.blocks).map((block) => ({
          ...block,
          enabled: framework.blocks.find((old) => old.id === block.id)?.enabled ?? block.enabled,
        }))
      }
    }
    // 只迁移旧的自动名称，保留用户改名、正文及历史发布记录。
    for (const doc of result.documents) {
      const original = defaults.documents.find((item) => item.id === doc.id)
      // 只修复原样保存的已知内置语法错误；用户改写的正文仍由校验明确报告。
      if (
        original &&
        doc.builtin !== false &&
        doc.id === 'tasks/agent/waifu_text_updater' &&
        original.body.includes('{{ agent_name }}，你好。') &&
        doc.body === original.body.replace('{{ agent_name }}，你好。', '{{ agent_name }，你好。')
      )
        doc.body = original.body
      if (original) synchronizeBuiltinDocument(doc, original)
      const oldLabel = this.engine.getPrompt(doc.id)?.meta.label
      if (
        original &&
        doc.builtin !== false &&
        (doc.name === doc.id.split('/').at(-1) ||
          (TEMPLATE_LABELS[doc.id] && doc.name === oldLabel))
      )
        doc.name = original.name
    }
    const known = new Set(result.documents.map((d) => d.id))
    result.documents.push(...defaults.documents.filter((d) => !known.has(d.id)))
    return result
  }

  view(): PromptWorkspaceView {
    return {
      recoveryError: this.recoveryError || undefined,
      revision: this.state.revision,
      activeReleaseId: this.state.activeReleaseId,
      draft: this.withNewDefaults(this.state.draft),
      defaults: this.defaults(),
      releases: this.state.releases.map(({ bundle: _bundle, ...meta }) => copy(meta)),
      variables: PROMPT_VARIABLES,
    }
  }

  snapshot(): PromptSnapshot {
    if (this.recoveryError) fail(this.recoveryError)
    const release = this.state.releases.find((r) => r.id === this.state.activeReleaseId)!
    return freeze({ id: release.id, bundle: this.withNewDefaults(release.bundle) })
  }

  release(id: string): PromptRelease {
    const release = this.state.releases.find((r) => r.id === id)
    if (!release) throw new AppError('NOT_FOUND', { message: '提示词版本不存在' })
    return copy(release)
  }

  private mutate(
    expectedRevision: number,
    operation: (next: StoredWorkspace) => void,
  ): Promise<PromptWorkspaceView> {
    const action = this.queue.then(async () => {
      if (expectedRevision !== this.state.revision)
        throw new AppError('CONFLICT', { message: '提示词已在其他页面修改，请重新载入后再保存' })
      const next = copy(this.state)
      operation(next)
      next.revision++
      await this.repo.setJson(KEY, next)
      this.state = next
      this.recoveryError = next.recoveryError ?? ''
      return this.view()
    })
    this.queue = action.catch(() => {})
    return action
  }

  save(bundle: unknown, expectedRevision: number): Promise<PromptWorkspaceView> {
    const parsed = promptBundleSchema.parse(bundle)
    if (JSON.stringify(parsed).length > 4_000_000) fail('提示词配置不能超过 4 MB')
    return this.mutate(expectedRevision, (next) => {
      next.draft = this.withNewDefaults(parsed)
    })
  }

  publish(expectedRevision: number, note = ''): Promise<PromptWorkspaceView> {
    return this.mutate(expectedRevision, (next) => {
      const bundle = this.withNewDefaults(next.draft)
      const issues = this.validate(bundle)
      if (issues.some((i) => i.level === 'error')) fail('提示词校验未通过', issues)
      const release = {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        note: note.slice(0, 200),
        bundle,
      }
      next.releases = [...next.releases, release].slice(-30)
      next.activeReleaseId = release.id
      next.draft = copy(bundle)
      delete next.recoveryError
    })
  }

  restore(id: string, expectedRevision: number): Promise<PromptWorkspaceView> {
    return this.save(this.release(id).bundle, expectedRevision)
  }

  private assignment(
    snapshot: PromptSnapshot,
    channel: string,
    agentId: string,
    frameworkId?: string,
  ) {
    const result = { frameworkId: '', overrides: {} as Record<string, string> }
    for (const [agent, scope] of [
      ['', ''],
      ['', channel],
      [agentId, ''],
      [agentId, channel],
    ]) {
      if ((!agentId && agent) || (!channel && scope)) continue
      const match = snapshot.bundle.assignments.find(
        (a) => a.agentId === agent && a.channel === scope,
      )
      if (match) {
        if (match.frameworkId) result.frameworkId = match.frameworkId
        Object.assign(result.overrides, match.overrides)
      }
    }
    if (frameworkId) result.frameworkId = frameworkId
    result.overrides = {
      ...snapshot.bundle.frameworks.find((f) => f.id === result.frameworkId)?.overrides,
      ...result.overrides,
    }
    return result
  }

  renderDocument(
    snapshot: PromptSnapshot,
    key: string,
    vars: Record<string, unknown>,
    stack: string[] = [],
    budget: RenderBudget = { calls: 0 },
  ): string {
    if (++budget.calls > 512) fail('提示词组件展开次数过多，请简化引用')
    key = this.engine.getPrompt(key)?.key ?? key
    const scope = this.assignment(
      snapshot,
      String(vars.channel ?? ''),
      String(vars.agent_id ?? ''),
      typeof vars.__framework_id === 'string' ? vars.__framework_id : undefined,
    )
    const target = scope.overrides[key] ?? key
    if (stack.includes(target) || stack.length >= 32)
      fail(`提示词组件循环引用：${[...stack, target].join(' → ')}`)
    const doc = snapshot.bundle.documents.find((d) => d.id === target)
    // 角色文件属于显式模板来源，普通聊天变量不会进入此路径。
    const inherited =
      !scope.overrides[key] && this.engine.getPrompt(`${String(vars.agent_id ?? '')}/${key}`)
    const file = this.engine.getPrompt(target)
    if (!doc && !file) fail(`提示词不存在：${target}`)
    if (doc?.enabled === false) return ''
    const original = this.engine.getPrompt(key)
    const body =
      inherited && doc?.body === original?.content
        ? inherited.content
        : (doc?.body ?? file!.content)
    const content = this.renderSource(snapshot, body, vars, [...stack, target], budget)
    if (key === 'components/rules/system_core') {
      const wholesome = this.wholesomeContent(snapshot, vars, [...stack, target], budget)
      return wholesome && !content.includes(wholesome)
        ? [content, wholesome].filter(Boolean).join('\n\n')
        : content
    }
    return content
  }

  private wholesomeContent(
    snapshot: PromptSnapshot,
    vars: Record<string, unknown>,
    stack: string[] = [],
    budget: RenderBudget = { calls: 0 },
  ): string {
    if (vars.wholesome_mode_enabled === false) return ''
    const key = 'components/rules/wholesome_mode'
    if (!snapshot.bundle.documents.some((doc) => doc.id === key) && !this.engine.getPrompt(key))
      return ''
    return this.renderDocument(snapshot, key, vars, stack, budget)
  }

  /** 原生、社交与导入框架统一编译全局规则和请求策略，不改写发布原件。 */
  private withGlobalPolicies<T extends { messages: RenderedMessage[]; preview: PromptPreview }>(
    result: T,
    snapshot: PromptSnapshot,
    vars: Record<string, unknown>,
  ): T {
    const plan = compilePromptPlan(
      parseAssistantPrefillConfig(
        typeof vars.assistant_prefill_config === 'string'
          ? vars.assistant_prefill_config
          : undefined,
      ),
    )
    result.preview.requestPlan = plan
    if (plan.assistantPrefill) {
      const segment = plan.assistantPrefill
      const tokens = tokenCounter.countTokens(segment.content)
      result.preview.segments.push({
        id: 'assistant_prefill',
        source: segment.source,
        role: 'assistant',
        content: segment.content,
        tokens,
      })
      result.preview.tokens += tokens
    }
    const content = this.wholesomeContent(snapshot, vars)
    if (
      !content ||
      result.messages.some(
        (message) => message.role === 'system' && message.content.includes(content),
      )
    )
      return result
    const tokens = tokenCounter.countTokens(content)
    result.messages.unshift({ role: 'system', content, slotId: 'system_core/wholesome_mode' })
    result.preview.segments.unshift({
      id: 'system_core/wholesome_mode',
      source: 'components/rules/wholesome_mode',
      role: 'system',
      content,
      tokens,
    })
    result.preview.tokens += tokens
    return result
  }

  private renderSource(
    snapshot: PromptSnapshot,
    body: string,
    vars: Record<string, unknown>,
    stack: string[] = [],
    budget: RenderBudget = { calls: 0 },
  ): string {
    const rendered = this.engine.renderOnce(body, {
      ...vars,
      component: (key: string) => this.renderDocument(snapshot, key, vars, stack, budget),
    })
    if (rendered.length > 4_000_000) fail('提示词渲染内容过大，请缩小装配范围')
    return rendered
  }

  private matches(
    snapshot: PromptSnapshot,
    when: string | undefined,
    vars: Record<string, unknown>,
  ): boolean {
    return !when || this.renderSource(snapshot, `{% if ${when} %}1{% endif %}`, vars) === '1'
  }

  async prepare(
    snapshot: PromptSnapshot,
    channel: string,
    agentId: string,
    input: Record<string, unknown>,
    sessionId?: string,
  ): Promise<ReturnType<PromptWorkspace['assemble']> & { variableCommit?: PromptVariableCommit }> {
    const framework = snapshot.bundle.frameworks.find(
      (item) => item.id === this.assignment(snapshot, channel, agentId).frameworkId,
    )
    const state =
      framework && promptFormat(framework) === 'sillytavern' && sessionId
        ? await this.variableStore.snapshot(sessionId)
        : undefined
    const result = this.assemble(
      snapshot,
      channel,
      agentId,
      {
        ...input,
        wholesome_mode_enabled: (await this.repo.get(WHOLESOME_MODE_KEY)) !== 'false',
        assistant_prefill_config: await this.repo.get(ASSISTANT_PREFILL_KEY),
      },
      undefined,
      state,
    )
    const effects = result.variableEffects
    return {
      ...result,
      variableCommit:
        sessionId && effects && [...effects.local, ...effects.global].some((item) => item.write)
          ? { id: randomUUID(), scope: sessionId, epoch: state?.epoch, effects }
          : undefined,
    }
  }
  async previewVariableState(
    bundle: PromptBundle,
    channel: string,
    agentId: string,
    frameworkId?: string,
  ) {
    const framework = bundle.frameworks.find(
      (item) =>
        item.id ===
        (frameworkId ?? this.assignment({ id: 'preview', bundle }, channel, agentId).frameworkId),
    )
    return framework && promptFormat(framework) === 'sillytavern'
      ? this.variableStore.snapshot('preview')
      : undefined
  }

  assemble(
    snapshot: PromptSnapshot,
    channel: string,
    agentId: string,
    input: Record<string, unknown>,
    frameworkId?: string,
    variableState?: PromptVariableState,
  ): {
    messages: RenderedMessage[]
    preview: PromptPreview
    format?: string
    includesCurrentMessage?: boolean
    variableEffects?: import('@infos/shared').PromptVariableEffects
  } {
    const selected = frameworkId ?? this.assignment(snapshot, channel, agentId).frameworkId
    const framework = snapshot.bundle.frameworks.find((f) => f.id === selected)
    if (!framework) fail(`未找到已指派的提示词框架：${selected}`)
    const vars: Record<string, unknown> = {
      owner_name: '用户',
      owner_appellation: '主人',
      ...input,
      channel,
      agent_id: agentId,
      __framework_id: selected,
    }
    if (promptFormat(framework) === 'sillytavern')
      return this.withGlobalPolicies(
        {
          ...assembleSillyTavern(framework, snapshot.id, vars, variableState),
          format: 'sillytavern',
        },
        snapshot,
        vars,
      )
    for (const binding of framework.bindings) {
      if (!this.matches(snapshot, binding.when, vars)) {
        vars[binding.name] = ''
        continue
      }
      if (binding.kind === 'persona')
        vars[binding.name] = this.renderSource(
          snapshot,
          String(input.persona_definition ?? ''),
          vars,
        )
      else if (binding.kind === 'capabilities')
        vars[binding.name] = (
          Array.isArray(input.capability_fragments) ? input.capability_fragments : []
        )
          .map((key) => this.renderDocument(snapshot, String(key), vars))
          .filter(Boolean)
          .join('\n\n')
      else
        vars[binding.name] = binding.source
          ? this.renderDocument(snapshot, binding.source, vars)
          : this.renderSource(snapshot, binding.template ?? '', vars)
    }
    const segments: PromptPreview['segments'] = []
    const nativeContents = new Map<string, import('../llm/types').ContentPart[]>()
    const historyCache = new Map<string, ChatMessage['cacheControl']>()
    vars.append_turn_context = framework.blocks.some(
      (block) => block.enabled && block.source === 'components/state/turn_context',
    )
    for (const block of framework.blocks) {
      if (!block.enabled || !this.matches(snapshot, block.when, vars)) continue
      if (block.kind === 'history') {
        const history = Array.isArray(input.native_history)
          ? (input.native_history as Array<{
              role: string
              content: unknown
              cacheControl?: ChatMessage['cacheControl']
            }>)
          : []
        for (const [index, message] of history.entries()) {
          historyCache.set(`${block.id}/${index}`, message.cacheControl)
          if (message.role !== 'user' && message.role !== 'assistant') continue
          const parts = Array.isArray(message.content)
            ? (message.content as import('../llm/types').ContentPart[])
            : []
          const content =
            typeof message.content === 'string'
              ? message.content
              : parts
                  .map((part) =>
                    part.type === 'text'
                      ? part.text
                      : part.type === 'image_url'
                        ? '[图片]'
                        : '[音频]',
                  )
                  .join('\n')
          segments.push({
            id: `${block.id}/${index}`,
            source: 'native_history',
            role: message.role,
            content,
            tokens: tokenCounter.countTokens(content),
          })
          if (Array.isArray(message.content))
            nativeContents.set(
              `${block.id}/${index}`,
              message.content as import('../llm/types').ContentPart[],
            )
        }
      } else {
        const blockVars =
          vars.append_turn_context &&
          framework.builtin &&
          ['builtin.main', 'builtin.social'].includes(framework.id) &&
          block.role === 'system'
            ? { ...vars, flow_state: vars.flow_state ? {} : undefined, task_plan: null }
            : vars
        const content = block.source
          ? this.renderDocument(snapshot, block.source, blockVars)
          : this.renderSource(snapshot, block.template ?? '', blockVars)
        const origin = block.source
          ? (this.engine.getPrompt(block.source)?.key ?? block.source)
          : `${framework.id}/${block.id}`
        const actualSource =
          this.assignment(snapshot, channel, agentId, selected).overrides[origin] ?? origin
        if (content.trim())
          segments.push({
            id: block.id,
            source: actualSource,
            role: block.role,
            content,
            tokens: tokenCounter.countTokens(content),
          })
      }
    }
    let conversationStarted = false
    for (const segment of segments) {
      if (segment.role !== 'system') conversationStarted = true
      else if (conversationStarted) fail('system 区块必须排在 user / assistant 区块之前')
    }
    if (segments.reduce((sum, segment) => sum + segment.content.length, 0) > 4_000_000)
      fail('提示词总内容过大，请缩小装配范围')
    return this.withGlobalPolicies(
      {
        messages: segments.map((s) => ({
          role: s.role,
          content: s.content,
          slotId: s.id,
          nativeContent: nativeContents.get(s.id),
          historyMessage: s.source === 'native_history',
          historyCache: historyCache.get(s.id),
        })),
        preview: {
          frameworkId: framework.id,
          revision: snapshot.id,
          segments,
          tokens: segments.reduce((n, s) => n + s.tokens, 0),
          issues: [],
        },
      },
      snapshot,
      vars,
    )
  }

  prepareTask(messages: ChatMessage[], opts: ChatOptions): ChatMessage[] {
    if (!opts.promptTask) return messages
    const def = TASK_PROMPTS[opts.promptTask]
    if (!def) fail(`未注册的任务提示词：${opts.promptTask}`)
    const snapshot = this.snapshot()
    const vars: Record<string, unknown> = {
      ...opts.promptVariables,
      agent_id: opts.promptVariables?.agent_id ?? opts.usageContext?.agentId ?? '',
      channel: opts.promptChannel ?? 'task',
    }
    for (const name of opts.promptSources ?? []) {
      if (typeof vars[name] === 'string')
        vars[name] = this.renderSource(snapshot, vars[name] as string, vars)
    }
    const content = this.renderDocument(snapshot, def.id, vars)
    return [
      ...(content ? [{ role: 'system' as const, content }] : []),
      ...messages.filter((m) => m.role !== 'system'),
    ]
  }

  validate(bundle: PromptBundle): PromptIssue[] {
    const issues: PromptIssue[] = []
    const add = (source: string, message: string, level: PromptIssue['level'] = 'error') =>
      issues.push({ source, message, level })
    const docs = new Map(bundle.documents.map((d) => [d.id, d]))
    const frameworks = new Set(bundle.frameworks.map((f) => f.id))
    if (docs.size !== bundle.documents.length) add('documents', '模板 ID 重复')
    if (frameworks.size !== bundle.frameworks.length) add('frameworks', '框架 ID 重复')
    const reference = (source: string, target?: string) => {
      if (target && !docs.has(target) && !this.engine.getPrompt(target))
        add(source, `引用不存在：${target}`)
    }
    const syntax = (source: string, body: string) => {
      if (/\{%[-\s]*(include|extends|import|from)\s/.test(body))
        add(source, '模板引用请使用 component()，不支持文件加载指令')
      try {
        this.engine.validateTemplate(body)
      } catch (e) {
        add(source, e instanceof Error ? e.message : String(e))
      }
      for (const match of body.matchAll(/component\(\s*['"]([^'"]+)['"]\s*\)/g))
        reference(source, match[1])
    }
    const dependencies = new Map<string, string[]>()
    for (const doc of bundle.documents) {
      syntax(doc.id, doc.body)
      const refs = [...doc.body.matchAll(/component\(\s*['"]([^'"]+)['"]\s*\)/g)].map(
        (m) => this.engine.getPrompt(m[1]!)?.key ?? m[1]!,
      )
      dependencies.set(doc.id, refs)
      refs.forEach((ref) => reference(doc.id, ref))
    }
    const visited = new Set<string>()
    const walk = (key: string, stack: string[]) => {
      if (stack.includes(key)) {
        add(key, `循环引用：${[...stack, key].join(' → ')}`)
        return
      }
      if (visited.has(key)) return
      if (stack.length > 32) {
        add(key, '组件嵌套超过 32 层')
        return
      }
      for (const ref of dependencies.get(key) ?? []) walk(ref, [...stack, key])
      visited.add(key)
    }
    for (const key of docs.keys()) walk(key, [])
    for (const framework of bundle.frameworks) {
      if (promptFormat(framework) === 'sillytavern') {
        issues.push(
          ...sillyTavernIssues(
            framework,
            PROMPT_VARIABLES.map((variable) => variable.name),
          ),
        )
        if (new Set(framework.blocks.map((block) => block.id)).size !== framework.blocks.length)
          add(framework.id, '区块 ID 重复')
        continue
      }
      for (const [source, target] of Object.entries(framework.overrides ?? {})) {
        reference(framework.id, source)
        reference(framework.id, target)
      }
      const blockIds = new Set<string>(),
        names = new Set<string>()
      let conversationStarted = false
      for (const binding of framework.bindings) {
        if (names.has(binding.name)) add(framework.id, `变量重复：${binding.name}`)
        names.add(binding.name)
        reference(framework.id, binding.source)
        syntax(framework.id, binding.template ?? '')
        if (binding.when) syntax(framework.id, `{% if ${binding.when} %}1{% endif %}`)
      }
      for (const block of framework.blocks) {
        if (block.kind === 'marker' || block.position === 'in_chat')
          add(block.id, '历史插入与数据标记请使用 SillyTavern 格式')
        if (blockIds.has(block.id)) add(framework.id, `区块 ID 重复：${block.id}`)
        blockIds.add(block.id)
        reference(framework.id, block.source)
        syntax(framework.id, block.template ?? '')
        if (block.when) syntax(framework.id, `{% if ${block.when} %}1{% endif %}`)
        if (!block.enabled) continue
        if (block.kind === 'history' || block.role !== 'system') conversationStarted = true
        else if (conversationStarted) add(framework.id, 'system 区块必须位于对话区块之前')
      }
      if (!framework.blocks.some((b) => b.enabled))
        add(framework.id, '框架为空；发布后只保留运行时数据与本次用户消息', 'warning')
    }
    const scopes = new Set<string>()
    for (const assignment of bundle.assignments) {
      const scope = JSON.stringify([assignment.agentId, assignment.channel])
      if (scopes.has(scope)) add('assignments', '指派范围重复')
      scopes.add(scope)
      if (assignment.frameworkId && !frameworks.has(assignment.frameworkId))
        add('assignments', `框架不存在：${assignment.frameworkId}`)
      for (const [source, target] of Object.entries(assignment.overrides)) {
        reference('assignments', source)
        reference('assignments', target)
      }
    }
    if (!bundle.assignments.some((a) => !a.agentId && !a.channel && frameworks.has(a.frameworkId)))
      add('assignments', '必须选择一个全局默认框架')
    // 替换后的引用图也必须无环，避免发布时看似正常、角色指派后才出现循环。
    const checkOverrides = (scope: string, mapping: Record<string, string>) => {
      const seen = new Set<string>()
      const visit = (key: string, stack: string[]) => {
        const target = mapping[key] ?? key
        if (stack.includes(target)) {
          add(scope, `替换后的组件循环：${[...stack, target].join(' → ')}`)
          return
        }
        if (seen.has(target) || stack.length > 32) return
        seen.add(target)
        for (const ref of dependencies.get(target) ?? []) visit(ref, [...stack, target])
      }
      for (const key of docs.keys()) visit(key, [])
    }
    const snapshot = { id: 'validation', bundle }
    for (const framework of bundle.frameworks)
      checkOverrides(framework.id, framework.overrides ?? {})
    for (const scope of bundle.assignments)
      checkOverrides(
        `${scope.agentId || 'global'}/${scope.channel || '*'}`,
        this.assignment(snapshot, scope.channel, scope.agentId).overrides,
      )
    return issues
  }

  preview(
    bundle: PromptBundle,
    channel: string,
    agentId: string,
    variables: Record<string, unknown>,
    frameworkId?: string,
    taskId?: string,
    variableState?: PromptVariableState,
  ): PromptPreview {
    const issues = this.validate(bundle)
    if (issues.some((i) => i.level === 'error'))
      return { frameworkId: frameworkId ?? '', revision: 'draft', segments: [], tokens: 0, issues }
    const snapshot = { id: 'draft', bundle }
    const selected = bundle.frameworks.find(
      (f) => f.id === (frameworkId ?? this.assignment(snapshot, channel, agentId).frameworkId),
    )
    const available = new Set([
      ...PROMPT_VARIABLES.map((v) => v.name),
      ...Object.keys(variables),
      ...(selected?.bindings.map((b) => b.name) ?? []),
    ])
    const relevant = taskId
      ? [taskId]
      : [
          ...(selected?.blocks.flatMap((b) => (b.source ? [b.source] : [])) ?? []),
          ...(selected?.bindings.flatMap((b) => (b.source ? [b.source] : [])) ?? []),
        ]
    for (const key of relevant) {
      const target = this.assignment(snapshot, channel, agentId, frameworkId).overrides[key] ?? key
      for (const name of bundle.documents.find((d) => d.id === target)?.variables ?? []) {
        if (!available.has(name))
          issues.push({ level: 'warning', source: target, message: `示例变量未提供：${name}` })
      }
    }
    try {
      if (taskId) {
        const content = this.renderDocument(snapshot, taskId, {
          ...variables,
          agent_id: agentId,
          channel,
        })
        return {
          frameworkId: taskId,
          revision: 'draft',
          segments: [
            {
              id: taskId,
              source: this.assignment(snapshot, channel, agentId).overrides[taskId] ?? taskId,
              role: 'system',
              content,
              tokens: tokenCounter.countTokens(content),
            },
          ],
          tokens: tokenCounter.countTokens(content),
          issues,
        }
      }
      const result = this.assemble(
        snapshot,
        channel,
        agentId,
        variables,
        frameworkId,
        variableState,
      ).preview
      result.issues = [...issues, ...result.issues].filter(
        (issue, index, all) =>
          all.findIndex(
            (item) => item.source === issue.source && item.message === issue.message,
          ) === index,
      )
      return result
    } catch (e) {
      return {
        frameworkId: frameworkId ?? '',
        revision: 'draft',
        segments: [],
        tokens: 0,
        issues: [
          ...issues,
          {
            level: 'error',
            source: frameworkId ?? 'preview',
            message: e instanceof Error ? e.message : String(e),
          },
        ],
      }
    }
  }
}
