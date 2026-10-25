import { randomUUID } from 'node:crypto'
import { ST_MARKER_BINDINGS, ST_MARKERS, PROMPT_GENERATION_TYPES } from '@infos/shared'
import type {
  PromptBlock,
  PromptFramework,
  PromptIssue,
  PromptPreview,
  PromptPreviewSegment,
  PromptRole,
} from '@infos/shared'
import type { ChatMessage, ContentPart } from '../llm/types'
import type { RenderedMessage } from './mdpEngine'
import { SillyTavernMacros } from './sillyTavernMacros'
import { tokenCounter } from '../tokenizer/tokenCounter'
import type { PromptVariableState, PromptVariableEffects } from '@infos/shared'
import { stUtility, stCharacter, stForbidOverrides, parseStExamples } from './sillyTavernContent'

const valueText = (value: unknown): string =>
  value === undefined || value === null
    ? ''
    : typeof value === 'string'
      ? value
      : JSON.stringify(value)
function markerBinding(framework: PromptFramework, marker: string): string {
  const mappings = framework.sillyTavern?.markerBindings ?? {}
  return Object.hasOwn(mappings, marker)
    ? mappings[marker]!
    : Object.hasOwn(ST_MARKER_BINDINGS, marker)
      ? ST_MARKER_BINDINGS[marker]!
      : ''
}
function markerValue(
  framework: PromptFramework,
  marker: string,
  input: Record<string, unknown>,
): string {
  const character = stCharacter(framework, String(input.agent_id ?? ''))
  const field = (
    {
      charDescription: 'description',
      charPersonality: 'personality',
      scenario: 'scenario',
      dialogueExamples: 'examples',
    } as const
  )[marker as 'charDescription' | 'charPersonality' | 'scenario' | 'dialogueExamples']
  if (field && character[field]) return character[field]!
  const binding = markerBinding(framework, marker)
  return binding === '$text'
    ? (framework.sillyTavern?.values[marker] ?? '')
    : binding && Object.hasOwn(input, binding)
      ? valueText(input[binding])
      : ''
}
function macroContext(framework: PromptFramework, input: Record<string, unknown>) {
  const values = Object.fromEntries(
    Object.entries(framework.sillyTavern?.values ?? {}).filter(
      ([key]) =>
        /^[a-zA-Z_][a-zA-Z0-9_]{0,99}$/.test(key) &&
        !key.startsWith('__') &&
        !['constructor', 'prototype'].includes(key),
    ),
  )
  for (const marker of ST_MARKERS)
    values[marker.value] = markerValue(framework, marker.value, input)
  return values
}

export function sillyTavernIssues(
  framework: PromptFramework,
  variableNames: string[],
): PromptIssue[] {
  const issues: PromptIssue[] = []
  const available = Object.fromEntries(variableNames.map((name) => [name, '']))
  const macros = new SillyTavernMacros(available, macroContext(framework, available), 'validation')
  const inspect = (source: string, body: string, enabled = true) => {
    try {
      for (const name of macros.inspect(body))
        issues.push({
          level: enabled ? 'error' : 'warning',
          source,
          message: `暂不支持宏 {{${name}}}；请修改或停用对应提示词`,
        })
    } catch (error) {
      issues.push({
        level: enabled ? 'error' : 'warning',
        source,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
  for (const [key, body] of Object.entries(stUtility(framework)))
    inspect(`${framework.id}/${key}`, body)
  for (const [agentId, character] of Object.entries(framework.sillyTavern?.characters ?? {})) {
    if (character.main) inspect(`${framework.id}/character/${agentId}/main`, character.main)
    if (character.postHistory)
      inspect(`${framework.id}/character/${agentId}/postHistory`, character.postHistory)
  }
  if (framework.bindings.length)
    issues.push({
      level: 'error',
      source: framework.id,
      message: '酒馆框架使用数据映射与兼容变量，不使用原生数据装配',
    })
  if (framework.blocks.filter((block) => block.kind === 'history').length > 1)
    issues.push({
      level: 'error',
      source: framework.id,
      message: '酒馆框架只能包含一个聊天历史标记',
    })
  const identifiers = new Set<string>()
  for (const block of framework.blocks) {
    if (
      block.id === 'st.current-message' ||
      block.id.startsWith('st.history.') ||
      block.id.startsWith('st.utility.')
    )
      issues.push({
        level: 'error',
        source: block.id,
        message: '条目 ID 与运行时消息标识冲突，请更换 ID',
      })
    const identifier = block.stIdentifier ?? block.id
    if (identifiers.has(identifier))
      issues.push({ level: 'error', source: block.id, message: '酒馆提示词标识重复' })
    identifiers.add(identifier)
    if (block.source)
      issues.push({
        level: 'error',
        source: block.id,
        message: '酒馆条目请直接编辑宏正文，不引用原生模板',
      })
    if (block.when)
      issues.push({
        level: 'error',
        source: block.id,
        message: '酒馆条目请使用生成触发类型，不使用原生模板条件',
      })
    for (const trigger of block.triggers ?? [])
      if (!PROMPT_GENERATION_TYPES.some((item) => item.value === trigger))
        issues.push({
          level: block.enabled ? 'error' : 'warning',
          source: block.id,
          message: `暂不支持生成触发类型：${trigger}，请移除此类型或停用条目`,
        })
    if (block.kind === 'history' && block.position === 'in_chat')
      issues.push({ level: 'error', source: block.id, message: '聊天历史标记必须使用列表位置' })
    if (block.kind === 'template') {
      inspect(block.id, block.template ?? '', block.enabled)
    }
    if (block.enabled && block.kind === 'marker') {
      const marker = block.marker ?? identifier
      const binding = markerBinding(framework, marker)
      if (!binding || (binding === '$text' && !framework.sillyTavern?.values[marker]))
        issues.push({
          level: 'warning',
          source: block.id,
          message: `${block.name}未绑定运行时数据；可使用角色资料或手动填写`,
        })
      else if (binding !== '$text' && !variableNames.includes(binding))
        issues.push({
          level: 'warning',
          source: block.id,
          message: `运行时变量 ${binding} 未在目录中注册，请在预览中确认`,
        })
    }
  }
  if (
    framework.blocks.some(
      (block) => block.enabled && block.role === 'system' && block.position === 'in_chat',
    ) ||
    framework.blocks.some(
      (block, index) =>
        block.enabled &&
        block.role === 'system' &&
        framework.blocks.slice(0, index).some((previous) => previous.kind === 'history'),
    )
  ) {
    issues.push({
      level: 'warning',
      source: framework.id,
      message:
        '历史中的系统指令按原位置转为带系统指令标记的用户消息，兼容只允许开头 system 的模型接口；预览展示实际角色',
    })
  }
  return issues
}

/** 先按原生聊天消息计算深度，再插入条目；工具回合复用这份编译结果。 */
export function assembleSillyTavern(
  framework: PromptFramework,
  revision: string,
  input: Record<string, unknown>,
  variableState?: PromptVariableState,
): {
  messages: RenderedMessage[]
  preview: PromptPreview
  includesCurrentMessage: boolean
  variableEffects: PromptVariableEffects
} {
  const segments: PromptPreviewSegment[] = []
  const native = new Map<string, ContentPart[]>()
  const historyCaches = new Map<string, ChatMessage['cacheControl']>()
  const currentIds = new Set<string>()
  const contentIssues: PromptIssue[] = []
  const utility = stUtility(framework),
    character = stCharacter(framework, String(input.agent_id ?? ''))
  const rawHistory = Array.isArray(input.native_history) ? input.native_history : []
  const rawCurrent =
    input.current_message && typeof input.current_message === 'object'
      ? (input.current_message as { role?: string; content?: unknown })
      : undefined
  const historyMessages = [...rawHistory, ...(rawCurrent ? [rawCurrent] : [])].filter(
    (message) =>
      message &&
      typeof message === 'object' &&
      ['user', 'assistant'].includes(String((message as { role: string }).role)),
  ) as Array<{
    role: 'user' | 'assistant'
    content: unknown
    cacheControl?: ChatMessage['cacheControl']
  }>
  const textOf = (content: unknown) =>
    Array.isArray(content)
      ? content
          .map((part) =>
            part?.type === 'text'
              ? String(part.text ?? '')
              : part?.type === 'image_url'
                ? '[图片]'
                : '[音频]',
          )
          .join('\n')
      : valueText(content)
  const lastUser = [...historyMessages].reverse().find((message) => message.role === 'user')
  const lastAssistant = [...historyMessages]
    .reverse()
    .find((message) => message.role === 'assistant')
  const vars = {
    ...input,
    last_user_message: textOf(lastUser?.content),
    last_assistant_message: textOf(lastAssistant?.content),
    last_message: textOf(historyMessages.at(-1)?.content),
    last_message_id: historyMessages.length - 1,
    first_included_message_id: historyMessages.length ? 0 : '',
    char_prompt: character.main ?? input.char_prompt ?? '',
    char_instruction: character.postHistory ?? input.char_instruction ?? '',
    char_first_message: character.firstMessage ?? input.char_first_message ?? '',
    char_creator_notes: character.creatorNotes ?? input.char_creator_notes ?? '',
    char_version: character.version ?? input.char_version ?? '',
    authors_note: character.authorsNote ?? input.authors_note ?? '',
  }
  const macros = new SillyTavernMacros(
    vars,
    macroContext(framework, vars),
    String(input.prompt_seed ?? `${framework.id}:${revision}:${randomUUID()}`),
    variableState,
  )
  const generation = String(input.generation_type ?? 'normal')
  const active = (block: PromptBlock) =>
    block.enabled && (!block.triggers?.length || block.triggers.includes(generation))
  const segment = (
    id: string,
    source: string,
    role: PromptRole,
    content: string,
  ): PromptPreviewSegment => ({
    id,
    source,
    role,
    content,
    tokens: tokenCounter.countTokens(content),
  })
  const historyBlock = framework.blocks.find((block) => block.kind === 'history')
  const history: PromptPreviewSegment[] = []
  for (const [index, message] of historyMessages.entries()) {
    const isCurrent = Boolean(rawCurrent && message === rawCurrent)
    if (!isCurrent && (!historyBlock || !active(historyBlock))) continue
    const id = isCurrent ? 'st.current-message' : `st.history.${index}`
    historyCaches.set(id, message.cacheControl)
    if (isCurrent) currentIds.add(id)
    const replacement =
      isCurrent &&
      typeof message.content === 'string' &&
      !message.content.trim() &&
      utility.send_if_empty
        ? macros.render(utility.send_if_empty)
        : undefined
    history.push(
      segment(
        id,
        isCurrent ? 'current_message' : 'native_history',
        message.role,
        replacement ?? textOf(message.content),
      ),
    )
    if (Array.isArray(message.content)) native.set(id, message.content as ContentPart[])
  }
  const injections: Array<{ block: PromptBlock; segments: PromptPreviewSegment[]; index: number }> =
    []
  const rendered = new Map<string, PromptPreviewSegment[]>()
  // 宏按预设列表顺序展开，状态操作、随机结果在一次编译中只执行一次。
  for (const [index, block] of framework.blocks.entries()) {
    if (!active(block) || block.kind === 'history') continue
    const marker = block.marker ?? block.stIdentifier ?? block.id
    const override =
      !stForbidOverrides(framework, block) &&
      (marker === 'main'
        ? character.main
        : marker === 'jailbreak'
          ? character.postHistory
          : undefined)
    let content =
      block.kind === 'marker'
        ? markerValue(framework, marker, input)
        : override
          ? macros.withOriginal(
              () => macros.render(block.template ?? ''),
              () => macros.render(override),
            )
          : macros.render(block.template ?? '')
    const format =
      marker === 'scenario'
        ? utility.scenario_format
        : marker === 'charPersonality'
          ? utility.personality_format
          : undefined
    if (block.kind === 'marker' && content && format) content = macros.render(format)
    if (!content.trim()) continue
    const results: PromptPreviewSegment[] = []
    const examples =
      block.kind === 'marker' && marker === 'dialogueExamples'
        ? parseStExamples(content, String(input.owner_name ?? ''), String(input.agent_name ?? ''))
        : []
    if (examples.length) {
      for (const [groupIndex, group] of examples.entries()) {
        if (utility.new_example_chat_prompt)
          results.push(
            segment(
              `${block.id}/example/${groupIndex}/header`,
              'new_example_chat_prompt',
              'system',
              macros.render(utility.new_example_chat_prompt),
            ),
          )
        for (const [messageIndex, message] of group.entries())
          results.push(
            segment(
              `${block.id}/example/${groupIndex}/${messageIndex}`,
              'dialogueExamples',
              message.role,
              message.content,
            ),
          )
      }
    } else {
      if (block.kind === 'marker' && marker === 'dialogueExamples')
        contentIssues.push({
          level: 'warning',
          source: block.id,
          message:
            '示例对话未识别出说话人，已保留为原文；可使用 <START> 与 {{user}}: / {{char}}: 格式',
        })
      results.push(
        segment(block.id, block.stIdentifier ?? `${framework.id}/${block.id}`, block.role, content),
      )
    }
    if (block.position === 'in_chat') injections.push({ block, segments: results, index })
    else rendered.set(block.id, results)
  }
  // 世界书统一放在当前输入之前（深度 1，排在同深度预设条目之后），不进入系统提示词，避免破坏提示词缓存。
  const worldInfo = typeof input.world_info === 'string' ? input.world_info.trim() : ''
  if (worldInfo) {
    const id = 'st.worldbook'
    injections.push({
      block: {
        id,
        name: id,
        kind: 'template',
        role: 'system',
        enabled: true,
        position: 'in_chat',
        depth: 1,
        order: Number.MAX_SAFE_INTEGER,
      },
      segments: [segment(id, 'world_info', 'system', `<world_info>\n${worldInfo}\n</world_info>`)],
      index: framework.blocks.length,
    })
  }
  const buckets = new Map<number, typeof injections>()
  for (const injection of injections) {
    const index = Math.max(0, history.length - (injection.block.depth ?? 4))
    const bucket = buckets.get(index) ?? []
    bucket.push(injection)
    buckets.set(index, bucket)
  }
  const rank = { assistant: 0, user: 1, system: 2 }
  const injected: PromptPreviewSegment[] = []
  const newChat =
    input.is_group || input.channel === 'group'
      ? utility.new_group_chat_prompt
      : utility.new_chat_prompt
  if (newChat)
    injected.push(
      segment('st.utility.new-chat', 'new_chat_prompt', 'system', macros.render(newChat)),
    )
  for (let index = 0; index <= history.length; index++) {
    const bucket = buckets.get(index) ?? []
    bucket.sort(
      (a, b) =>
        (a.block.order ?? 100) - (b.block.order ?? 100) ||
        rank[a.block.role] - rank[b.block.role] ||
        a.index - b.index,
    )
    // 酒馆将同深度、同顺序、同角色的指令合并为一条消息，保留组内原顺序。
    for (const [bucketIndex, item] of bucket.entries()) {
      const previous = injected.at(-1)
      const previousItem = bucket[bucketIndex - 1]
      if (
        previous &&
        previousItem &&
        previousItem.segments.length === 1 &&
        item.segments.length === 1 &&
        previous.role === item.segments[0]!.role &&
        previousItem.block.role === item.block.role &&
        (previousItem.block.order ?? 100) === (item.block.order ?? 100)
      ) {
        previous.content += `\n${item.segments[0]!.content}`
        previous.tokens = tokenCounter.countTokens(previous.content)
        previous.source += ` + ${item.segments[0]!.source}`
      } else injected.push(...item.segments.map((result) => ({ ...result })))
    }
    if (history[index]) injected.push(history[index]!)
  }
  if ((input.is_group || input.channel === 'group') && utility.group_nudge_prompt)
    injected.push(
      segment(
        'st.utility.group-nudge',
        'group_nudge_prompt',
        'system',
        macros.render(utility.group_nudge_prompt),
      ),
    )
  let inserted = false
  for (const block of framework.blocks) {
    if (block.kind === 'history' && !inserted) {
      segments.push(...injected)
      inserted = true
    } else if (rendered.has(block.id)) segments.push(...rendered.get(block.id)!)
  }
  if (!inserted) segments.push(...injected)
  const control =
    generation === 'continue'
      ? utility.continue_nudge_prompt
      : generation === 'impersonate'
        ? utility.impersonation_prompt
        : undefined
  if (control)
    segments.push(segment('st.utility.control', generation, 'system', macros.render(control)))
  // 只有变量写入而没有正文的辅助宏，不生成空的系统指令消息。
  for (let index = segments.length - 1; index >= 0; index--) {
    const item = segments[index]!
    if (
      !item.content.trim() &&
      (item.id.startsWith('st.utility.') || item.source === 'new_example_chat_prompt')
    )
      segments.splice(index, 1)
  }
  // 通用 Provider 只保证开头的 system；保留插入位置，不把历史后指令偷偷搬到开头。
  let started = false
  for (const item of segments) {
    if (item.role !== 'system') started = true
    else if (started) {
      item.originalRole = 'system'
      item.role = 'user'
      item.content = `【系统指令】\n${item.content}`
      item.tokens = tokenCounter.countTokens(item.content)
    }
  }
  if (segments.reduce((size, item) => size + item.content.length, 0) > 4_000_000)
    throw new Error('酒馆框架渲染内容超过 4 MB')
  const issues = [...sillyTavernIssues(framework, Object.keys(input)), ...contentIssues]
  if (
    segments.some((item) => item.originalRole) &&
    !issues.some((issue) => issue.message.includes('预览展示实际角色'))
  )
    issues.push({
      level: 'warning',
      source: framework.id,
      message: '对话开始后的 system 已按原位置适配为带系统指令标记的 user；预览展示实际角色',
    })
  return {
    includesCurrentMessage: currentIds.size > 0,
    variableEffects: macros.effects(),
    messages: segments.map((item) => ({
      role: item.role,
      content: item.content,
      slotId: item.id,
      nativeContent: native.get(item.id),
      currentMessage: currentIds.has(item.id),
      historyMessage: item.source === 'native_history',
      historyCache: historyCaches.get(item.id),
    })),
    preview: {
      frameworkId: framework.id,
      revision,
      segments,
      tokens: segments.reduce((sum, item) => sum + item.tokens, 0),
      issues,
    },
  }
}
