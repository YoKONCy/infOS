import { t as __t } from './i18n'
import { getSocialTurnKind } from '@infos/shared'
import { createHash } from 'node:crypto'
import { SOCIAL_BUSINESS_TOOLS, type SocialBusinessTool } from '@infos/shared'
import { createLogger, safeModelDiagnostic } from '@infos/backend/applicationHostAbi'
import type { InboundMessage, OutboundMessage } from './types'
import { currentSocialRecovery, runSocialStep, socialDelay, socialFailure } from './socialRecovery'
import { MAX_SOCIAL_IMAGES } from './socialImageReader'

type ObjectValue = Record<string, unknown>
export type StepStatus = 'completed' | 'failed' | 'uncertain' | 'skipped'
interface Step extends ObjectValue {
  id: string
  op: 'call' | 'send' | 'wait' | 'if' | 'parallel' | 'observe' | 'yield'
  steps?: Step[]
  then?: Step[]
  else?: Step[]
  fallback?: Step[]
}
interface StepResult {
  step_id: string
  status: StepStatus
  data?: unknown
  error?: { code: string; message: string; retryable: boolean }
  completed_at: number
}
interface PlanWait {
  stepId: string
  kind: 'delay' | 'wait' | 'observe' | 'defer'
  until: number
  expiresAt: number
  startedAt: number
  watch?: ObjectValue
  event?: InboundMessage
  decision?: 'cancel' | 'reconsider'
}
interface Plan {
  id: string
  fingerprint: string
  steps: Step[]
  results: Record<string, StepResult>
  executing?: { id: string; readonly: boolean }
  attempts: Record<string, number>
  next: 'auto' | 'end' | 'continue'
  onNewMessage: 'keep' | 'cancel' | 'reconsider'
  hasSend: boolean
  hasCall: boolean
  triggerSenderId?: string
  createdAt: number
  wait?: PlanWait
  status: 'running' | 'waiting' | 'continue' | 'completed'
  stopped?: boolean
  action?: string
  reason?: string
  intention?: string
  endParticipation?: boolean
  lowActivity?: boolean
}
export interface SocialOrchestrationCheckpoint {
  version: 1
  active?: string
  plans: Record<string, Plan>
  businessCalls: number
  sends: number
}
export interface SocialActResult {
  success: boolean
  status: 'continue' | 'waiting' | 'completed' | 'failed' | 'uncertain'
  plan_id: string
  observations: StepResult[]
  delivered_messages: unknown[]
  images?: string[]
  images_omitted?: number
  end_participation?: boolean
  low_activity?: boolean
  wake_at?: number
  expires_at?: number
  had_errors: boolean
  unexecuted_steps: Array<{ step_id: string; op: string }>
}
export interface SocialOrchestrationDeps {
  assertAllowed?(): Promise<void>
  isReadOnly?(name: string, args: ObjectValue): boolean
  accountId: string
  channelId: string
  channelType: 'private' | 'group'
  triggerMessageId?: string
  triggerSenderId?: string
  execute(name: string, args: ObjectValue, callId: string): Promise<string>
  available(name: string, args: ObjectValue): boolean
  send(message: OutboundMessage, key: string): Promise<unknown>
  sendResource(source: string, caption: string | undefined, key: string): Promise<string>
}

const object = (value: unknown): ObjectValue => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('参数必须是对象')
  return value as ObjectValue
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const fields = (value: ObjectValue, allowed: string[]) => {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) throw new Error(`未知编排参数 ${key}`)
}
const number = (value: unknown, fallback: number, min: number, max: number) => {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`数值必须是 ${min} 至 ${max} 范围的整数`)
  return value
}
const text = (value: unknown, max = 10000): string => {
  if (typeof value !== 'string' || value.length > max) throw new Error('文字参数格式不正确或过长')
  return value
}
const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => {
  if (value === undefined) return fallback
  if (!allowed.includes(value as T)) throw new Error(`参数只能使用 ${allowed.join('、')}`)
  return value as T
}
const normalizeText = (value: string) =>
  value.replace(/\r\n?/g, '\n').replace(/\n(?:[ \t]*\n)+/g, '\n')
const logger = createLogger('SocialOrchestration')

/** 日志保留工具观察的结构与短摘要，不复制图片正文或大段历史数据。 */
function observationForLog(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return safeModelDiagnostic(value.slice(0, 1000), 240)
  if (!value || typeof value !== 'object') return value
  if (depth >= 3) return '[嵌套内容已省略]'
  if (Array.isArray(value))
    return {
      count: value.length,
      preview: value.slice(0, 3).map((item) => observationForLog(item, depth + 1)),
    }
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 12)
      .map(([key, child]) => [
        key,
        /api.?key|token|secret|authorization|cookie|opaque|base64/i.test(key)
          ? '[已隐藏]'
          : key === 'images' && Array.isArray(child)
            ? { count: child.length }
            : observationForLog(child, depth + 1),
      ]),
  )
}

/** 只允许数据路径引用，不运行表达式，也不沿原型链读取字段。 */
function reference(path: string, results: Plan['results']): unknown {
  const keys = path.split('.')
  if (
    keys.some(
      (key) =>
        !/^[a-zA-Z0-9_-]+$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key),
    )
  )
    throw new Error('结果引用路径不合法')
  let value: unknown = results
  for (const key of keys) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined
    value = (value as ObjectValue)[key]
  }
  return value
}
function resolve(value: unknown, results: Plan['results']): unknown {
  if (Array.isArray(value)) return value.map((item) => resolve(item, results))
  if (value && typeof value === 'object') {
    const item = value as ObjectValue
    if (Object.hasOwn(item, '$ref')) {
      if (Object.keys(item).length !== 1) throw new Error('结果引用不能同时包含其他字段')
      const result = reference(text(item.$ref, 200), results)
      if (result === undefined) throw new Error(`引用结果不存在：${item.$ref}`)
      return result
    }
    return Object.fromEntries(
      Object.entries(item).map(([key, child]) => [key, resolve(child, results)]),
    )
  }
  return value
}

function watch(value: unknown): ObjectValue | undefined {
  if (value === undefined) return undefined
  const result = object(value)
  fields(result, ['senders', 'events', 'expires_in_seconds'])
  if (
    result.senders !== undefined &&
    (!Array.isArray(result.senders) ||
      result.senders.length > 10 ||
      result.senders.some(
        (id) =>
          // eslint-disable-next-line no-control-regex -- 显式拦截控制字符，防止标识或路径混入不可见内容。
          typeof id !== 'string' || !id.trim() || id.length > 200 || /[\u0000-\u001f]/.test(id),
      ))
  )
    throw new Error('观察发送者必须使用有效的平台账号标识')
  if (
    result.events !== undefined &&
    (!Array.isArray(result.events) ||
      !result.events.length ||
      result.events.some(
        (event) => !['new_message', 'mention_me', 'image'].includes(String(event)),
      ))
  )
    throw new Error('观察事件格式不正确')
  number(result.expires_in_seconds, 300, 1, 21600)
  return result
}

/** 编排等待归调度器托管，工具内部不挂起数小时的 Promise。 */
export class SocialOrchestration {
  private readonly checkpoint: SocialOrchestrationCheckpoint
  private closing = false
  private saving: Promise<void> = Promise.resolve()
  constructor(private readonly deps: SocialOrchestrationDeps) {
    const recovery = currentSocialRecovery()
    if (!recovery) throw new Error('社交编排必须在持久化回合中执行')
    if (
      recovery.record.accountId !== deps.accountId ||
      recovery.record.channelId !== deps.channelId ||
      recovery.record.channelType !== deps.channelType
    )
      throw new Error('社交编排的账号或会话与原始回合不一致')
    this.checkpoint = (recovery.record.checkpoint.orchestration as
      | SocialOrchestrationCheckpoint
      | undefined) ?? {
      version: 1,
      plans: {},
      businessCalls: 0,
      sends: 0,
    }
    recovery.record.checkpoint.orchestration = this.checkpoint
  }

  private save() {
    const recovery = currentSocialRecovery()!
    // 只读并发也共用一条持久化队列，避免异步存储把较旧快照覆盖到较新进度上。
    this.saving = this.saving
      .catch(() => {})
      .then(async () => {
        this.active()
        const results = Object.values(this.checkpoint.plans).flatMap((plan) =>
          Object.values(plan.results),
        )
        const active = this.checkpoint.active
          ? this.checkpoint.plans[this.checkpoint.active]
          : undefined
        recovery.record.orchestrationSummary = {
          plans: Object.keys(this.checkpoint.plans).length,
          stepsCompleted: results.filter((result) => result.status === 'completed').length,
          stepsFailed: results.filter((result) => result.status === 'failed').length,
          stepsUncertain: results.filter((result) => result.status === 'uncertain').length,
          stepsSkipped: results.filter((result) => result.status === 'skipped').length,
          businessCalls: this.checkpoint.businessCalls,
          sends: Object.values(
            (recovery.record.checkpoint.deliveries ?? {}) as Record<string, string>,
          ).filter((status) => status === 'sent').length,
          waitingFor: active?.wait?.kind,
          wakeAt: active?.wait?.until,
          expiresAt: active?.wait?.expiresAt,
        }
        await recovery.save()
      })
    return this.saving
  }

  private active() {
    currentSocialRecovery()!.signal.throwIfAborted()
  }
  private isReadOnly(step: Step): boolean {
    if (step.op !== 'call') return false
    const args =
      step.args === undefined ? { action: step.action, input: step.input ?? {} } : object(step.args)
    return this.deps.isReadOnly?.(String(step.tool), args) === true
  }

  private normalize(input: ObjectValue, id: string): Plan {
    fields(input, [
      'action',
      'reply',
      'messages',
      'steps',
      'next',
      'on_new_message',
      'watch',
      'delay_ms',
      'expires_in_seconds',
      'intention',
      'reason',
      'after',
      'quote',
      'mentions',
      'attachments',
      'end_participation',
      'low_activity',
    ])
    if (input.end_participation !== undefined && typeof input.end_participation !== 'boolean')
      throw new Error(__t('errors.social', 'end_participation 必须为布尔值'))
    const endParticipation = input.end_participation === true
    if (input.low_activity !== undefined && typeof input.low_activity !== 'boolean')
      throw new Error(__t('errors.social', 'low_activity 必须为布尔值'))
    const lowActivity = input.low_activity === true
    if (lowActivity && this.deps.channelType !== 'group')
      throw new Error(__t('errors.social', '低活跃仅适用于群聊'))
    if (lowActivity && getSocialTurnKind(currentSocialRecovery()!.record) === 'task')
      throw new Error(__t('errors.social', '委派任务不能修改群聊参与模式'))
    const exitOnly =
      (endParticipation || lowActivity) &&
      input.reply === undefined &&
      input.messages === undefined &&
      input.steps === undefined &&
      input.attachments === undefined
    const action = oneOf(
      input.action,
      ['reply', 'pass', 'wait', 'observe', 'defer', 'continue'] as const,
      exitOnly ? 'pass' : 'reply',
    )
    if (input.intention !== undefined) text(input.intention, 500)
    if (input.reason !== undefined) text(input.reason, 500)
    const rawSteps: unknown[] = input.steps === undefined ? [] : [...this.array(input.steps)]
    if (input.reply !== undefined)
      rawSteps.push({
        op: 'send',
        content: input.reply,
        ...(input.quote !== undefined ? { quote: input.quote } : {}),
        ...(input.mentions !== undefined ? { mentions: input.mentions } : {}),
        ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
        ...(input.delay_ms !== undefined ? { delay_ms: input.delay_ms } : {}),
      })
    else if (input.attachments !== undefined)
      rawSteps.push({ op: 'send', attachments: input.attachments })
    if (input.messages !== undefined) {
      const messages = this.array(input.messages)
      if (messages.length > 12) throw new Error('一次编排最多发送 12 段消息')
      rawSteps.push(...messages.map((message) => ({ ...object(message), op: 'send' })))
    }
    const pause = input.after === undefined ? input : object(input.after)
    if (input.after !== undefined)
      fields(pause, ['action', 'watch', 'delay_ms', 'expires_in_seconds', 'intention'])
    const pauseAction =
      input.after === undefined
        ? action
        : oneOf(pause.action, ['wait', 'observe', 'defer'] as const, 'observe')
    if (['wait', 'observe', 'defer'].includes(pauseAction)) {
      const config = watch(pause.watch)
      rawSteps.push({
        op: pauseAction === 'observe' ? 'observe' : 'wait',
        duration_ms: number(pause.delay_ms, pauseAction === 'defer' ? 300000 : 5000, 0, 21600000),
        kind: pauseAction,
        watch: config,
        expires_in_seconds: number(
          pause.expires_in_seconds ?? config?.expires_in_seconds,
          pauseAction === 'defer' ? 3600 : 300,
          1,
          21600,
        ),
        intention: pause.intention,
      })
    }
    if (action === 'pass' && rawSteps.length) throw new Error('PASS 不能同时执行步骤或发送消息')
    if (!rawSteps.length && !['pass', 'continue'].includes(action))
      throw new Error('请提供 reply、messages、steps 或明确的参与行为')
    let count = 0
    const ids = new Set<string>()
    const normalizeSteps = (items: unknown[], prefix: string, depth: number): Step[] => {
      if (depth > 4) throw new Error('编排嵌套最多 4 层')
      return items.map((value, index) => {
        const entry = object(value)
        fields(entry, [
          'id',
          'op',
          'tool',
          'args',
          'action',
          'input',
          'content',
          'quote',
          'mentions',
          'attachments',
          'delay_ms',
          'duration_ms',
          'watch',
          'depends_on',
          'retries',
          'on_error',
          'condition',
          'steps',
          'then',
          'else',
          'fallback',
          'kind',
          'expires_in_seconds',
          'intention',
        ])
        if (++count > 48) throw new Error('一次编排最多包含 48 个步骤')
        const stepId = entry.id === undefined ? `${prefix}${index + 1}` : text(entry.id, 64)
        if (
          !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(stepId) ||
          ids.has(stepId) ||
          ['__proto__', 'constructor', 'prototype'].includes(stepId)
        )
          throw new Error('步骤 ID 必须合法且不能重复')
        ids.add(stepId)
        const op = oneOf(
          entry.op,
          ['call', 'send', 'wait', 'if', 'parallel', 'observe', 'yield'] as const,
          'yield',
        )
        if (entry.op === undefined) throw new Error('步骤缺少 op')
        const result = { ...entry, id: stepId, op } as Step
        oneOf(
          entry.on_error,
          ['continue', 'return_to_model', 'fallback', 'stop_branch'] as const,
          'continue',
        )
        number(entry.retries, 0, 0, 2)
        number(entry.delay_ms, 0, 0, 21600000)
        number(entry.duration_ms, 0, 0, 21600000)
        watch(entry.watch)
        if (entry.depends_on !== undefined)
          this.array(entry.depends_on).forEach((dependency) => text(dependency, 64))
        for (const branch of ['steps', 'then', 'else', 'fallback'] as const)
          if (entry[branch] !== undefined)
            result[branch] = normalizeSteps(
              this.array(entry[branch]),
              `${stepId}_${branch}_`,
              depth + 1,
            )
        if (op === 'call') {
          text(entry.tool, 100)
          if (entry.args !== undefined) object(entry.args)
          if (entry.input !== undefined) object(entry.input)
          if (entry.args !== undefined && (entry.input !== undefined || entry.action !== undefined))
            throw new Error('call 请使用 args 或 action/input 其中一种参数格式')
        }
        if (op === 'send') this.validateMessage(entry)
        if (op === 'if') {
          const condition = object(entry.condition)
          fields(condition, ['ref', 'test', 'value'])
          text(condition.ref, 200)
          result.condition = {
            ...condition,
            test: oneOf(condition.test, ['exists', 'truthy', 'eq', 'ne'] as const, 'truthy'),
          }
        }
        if (
          op === 'parallel' &&
          (!result.steps?.length ||
            result.steps.some(
              (child) =>
                !this.isReadOnly(child) ||
                child.depends_on !== undefined ||
                child.fallback !== undefined,
            ))
        )
          throw new Error('parallel 只接受独立只读 call；写操作和有依赖的步骤必须串行')
        if (entry.on_error === 'fallback' && !result.fallback?.length)
          throw new Error('fallback 策略缺少备用步骤')
        return result
      })
    }
    const steps = normalizeSteps(rawSteps, 's', 0)
    const flat = (items: Step[]): Step[] =>
      items.flatMap((step) => [
        step,
        ...flat(step.steps ?? []),
        ...flat(step.then ?? []),
        ...flat(step.else ?? []),
        ...flat(step.fallback ?? []),
      ])
    const all = flat(steps)
    if (
      (endParticipation || lowActivity) &&
      (input.after !== undefined ||
        action === 'continue' ||
        input.next === 'continue' ||
        all.some((step) => ['wait', 'observe', 'yield'].includes(step.op)))
    )
      throw new Error(
        __t('errors.social', '退出活跃状态不能同时等待、延后、yield 或 next:continue'),
      )
    const next = oneOf(
      input.next,
      ['auto', 'end', 'continue'] as const,
      action === 'continue' ? 'continue' : 'auto',
    )
    return {
      id,
      fingerprint: hash(input),
      steps,
      results: {},
      attempts: {},
      next: endParticipation || lowActivity ? 'end' : next,
      onNewMessage: oneOf(
        input.on_new_message,
        ['keep', 'cancel', 'reconsider'] as const,
        'reconsider',
      ),
      hasSend: all.some((step) => step.op === 'send'),
      hasCall: all.some((step) => step.op === 'call'),
      createdAt: Date.now(),
      status: 'running',
      triggerSenderId: this.deps.triggerSenderId,
      action,
      reason: input.reason as string | undefined,
      intention: input.intention as string | undefined,
      endParticipation,
      lowActivity,
    }
  }

  private array(value: unknown): unknown[] {
    if (!Array.isArray(value) || value.length > 24)
      throw new Error('步骤或消息必须是最多 24 项的数组')
    return value
  }
  private validateMessage(message: ObjectValue): void {
    if (message.content !== undefined && !(message.content && typeof message.content === 'object'))
      text(message.content)
    if (message.content === undefined && message.attachments === undefined)
      throw new Error('发送步骤缺少正文或附件')
    if (message.quote !== undefined) text(message.quote, 100)
    if (
      message.mentions !== undefined &&
      (!Array.isArray(message.mentions) ||
        message.mentions.length > 10 ||
        message.mentions.some(
          (id) =>
            // eslint-disable-next-line no-control-regex -- 显式拦截控制字符，防止标识或路径混入不可见内容。
            typeof id !== 'string' || !id.trim() || id.length > 200 || /[\u0000-\u001f]/.test(id),
        ))
    )
      throw new Error('mentions 必须是有效的平台账号标识数组')
    if (message.attachments !== undefined) {
      const attachments = this.array(message.attachments)
      if (!attachments.length || attachments.length > 3)
        throw new Error('每个发送步骤只支持 1 至 3 个附件')
      for (const raw of attachments) {
        const attachment = object(raw)
        fields(attachment, ['source', 'caption'])
        if (!(attachment.source && typeof attachment.source === 'object'))
          text(attachment.source, 2048)
        if (attachment.caption !== undefined) text(attachment.caption, 300)
      }
    }
  }

  async execute(input: ObjectValue, callId: string, closing = false): Promise<SocialActResult> {
    this.active()
    this.closing = closing
    if (JSON.stringify(input).length > 120000) throw new Error('编排参数过大，请分步处理')
    let plan = this.checkpoint.plans[callId]
    const resumed = Boolean(plan)
    if (plan && plan.fingerprint !== hash(input)) throw new Error('恢复编排参数与原计划不一致')
    plan ??= this.normalize(input, callId)
    // 纯 PASS 不执行能力或发送，不领取或重置互聊预算；取消检查仍始终生效。
    if (plan.action !== 'pass' || plan.steps.length > 0) await this.deps.assertAllowed?.()
    this.checkpoint.plans[callId] = plan
    this.checkpoint.active = callId
    logger.info(
      resumed
        ? __t('apps.social.logs', '恢复社交编排决策')
        : __t('apps.social.logs', '社交 Agent 已提交参与决策'),
      {
        turnId: currentSocialRecovery()!.record.id,
        planId: plan.id,
        action: plan.action ?? __t('apps.social.logs', '按已有计划恢复'),
        reason: plan.reason ? safeModelDiagnostic(plan.reason, 500) : undefined,
        intention: plan.intention ? safeModelDiagnostic(plan.intention, 500) : undefined,
        steps: plan.steps.map((step) => ({
          id: step.id,
          op: step.op,
          tool: step.tool,
          action: step.action ?? (step.args as ObjectValue | undefined)?.action,
        })),
        next: plan.next,
        onNewMessage: plan.onNewMessage,
      },
    )
    if (plan.status === 'completed' || plan.status === 'continue') return this.output(plan)
    // 上次进程在调用中退出：只读可重新读取，写操作只能确认未知，不能重放。
    if (plan.executing) {
      if (!plan.executing.readonly && !plan.results[plan.executing.id]) {
        plan.results[plan.executing.id] = this.failure(
          plan.executing.id,
          '执行被中断，外部结果尚未确认',
          true,
        )
        plan.stopped = true
      }
      plan.executing = undefined
    }
    plan.status = 'running'
    await this.save()
    await this.sequence(plan, plan.steps)
    if (!['waiting', 'completed'].includes(plan.status)) {
      const failed = Object.values(plan.results).some((item) =>
        ['failed', 'uncertain'].includes(item.status),
      )
      plan.status =
        plan.stopped ||
        (failed && plan.next !== 'end') ||
        plan.next === 'continue' ||
        (plan.next === 'auto' && plan.hasCall)
          ? 'continue'
          : 'completed'
      plan.wait = undefined
    }
    await this.save()
    logger.info(__t('apps.social.logs', '社交编排阶段完成'), {
      turnId: currentSocialRecovery()!.record.id,
      planId: plan.id,
      status: plan.status,
      steps: Object.values(plan.results).map((result) => ({
        stepId: result.step_id,
        status: result.status,
        error: result.error ? safeModelDiagnostic(result.error.message, 300) : undefined,
      })),
    })
    return this.output(plan)
  }

  private output(plan: Plan): SocialActResult {
    const observations = Object.values(plan.results)
    const images: string[] = []
    const collect = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(collect)
      if (!value || typeof value !== 'object') return value
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => {
          if (key === 'images' && Array.isArray(child)) {
            images.push(
              ...child.filter(
                (image): image is string =>
                  typeof image === 'string' && image.startsWith('data:image/'),
              ),
            )
            return ['image_count', child.length]
          }
          return [key, collect(child)]
        }),
      )
    }
    const compact = collect(observations) as StepResult[]
    const uniqueImages = [...new Set(images)]
    const flatten = (steps: Step[]): Step[] =>
      steps.flatMap((step) => [
        step,
        ...flatten(step.steps ?? []),
        ...flatten(step.then ?? []),
        ...flatten(step.else ?? []),
        ...flatten(step.fallback ?? []),
      ])
    return {
      success: true,
      status:
        plan.status === 'waiting'
          ? 'waiting'
          : plan.status === 'completed'
            ? 'completed'
            : 'continue',
      plan_id: plan.id,
      ...(plan.status === 'completed' && plan.endParticipation ? { end_participation: true } : {}),
      ...(plan.status === 'completed' && plan.lowActivity ? { low_activity: true } : {}),
      observations: compact,
      delivered_messages: Object.values(
        (currentSocialRecovery()!.record.checkpoint.sentMessages ?? {}) as Record<
          string,
          { key: string }
        >,
      ).filter((message) => message.key.startsWith(plan.id)),
      ...(uniqueImages.length
        ? {
            images: uniqueImages.slice(0, MAX_SOCIAL_IMAGES),
            images_omitted: Math.max(0, uniqueImages.length - MAX_SOCIAL_IMAGES),
          }
        : {}),
      wake_at: plan.wait?.until,
      expires_at: plan.wait?.expiresAt,
      had_errors: observations.some((item) => ['failed', 'uncertain'].includes(item.status)),
      unexecuted_steps: flatten(plan.steps)
        .filter((step) => !plan.results[step.id])
        .map((step) => ({ step_id: step.id, op: step.op })),
    }
  }
  currentResult(): SocialActResult | undefined {
    const plan = this.checkpoint.active ? this.checkpoint.plans[this.checkpoint.active] : undefined
    return plan ? this.output(plan) : undefined
  }
  private failure(
    id: string,
    message: string,
    uncertain = false,
    code = 'SOCIAL_STEP_FAILED',
    retryable = false,
  ): StepResult {
    return {
      step_id: id,
      status: uncertain ? 'uncertain' : 'failed',
      error: { code, message: message.slice(0, 800), retryable },
      completed_at: Date.now(),
    }
  }

  private async sequence(plan: Plan, steps: Step[]): Promise<void> {
    for (const step of steps) {
      this.active()
      if (plan.stopped || ['waiting', 'completed', 'continue'].includes(plan.status)) return
      await this.deps.assertAllowed?.()
      const previous = plan.results[step.id]
      if (previous) {
        if (['failed', 'uncertain'].includes(previous.status) && step.on_error === 'fallback')
          await this.sequence(plan, step.fallback ?? [])
        continue
      }
      const dependencies = (step.depends_on ?? []) as string[]
      if (dependencies.some((id) => plan.results[id]?.status !== 'completed')) {
        logger.info(__t('apps.social.logs', '社交编排步骤因依赖失败而跳过'), {
          turnId: currentSocialRecovery()!.record.id,
          planId: plan.id,
          stepId: step.id,
          dependencies,
        })
        plan.results[step.id] = {
          step_id: step.id,
          status: 'skipped',
          error: {
            code: 'DEPENDENCY_FAILED',
            message: __t('apps.social.ui', '依赖步骤没有成功，当前步骤未执行'),
            retryable: false,
          },
          completed_at: Date.now(),
        }
        await this.save()
        continue
      }
      await runSocialStep(`${plan.id}:${step.id}`, () => this.step(plan, step))
      if (['waiting', 'completed', 'continue'].includes(plan.status)) return
      const result = plan.results[step.id]
      if (!result || !['failed', 'uncertain'].includes(result.status)) continue
      if (result.status === 'uncertain' || step.on_error === 'return_to_model') {
        plan.stopped = true
        return
      }
      if (step.on_error === 'fallback') await this.sequence(plan, step.fallback ?? [])
      if (step.on_error === 'stop_branch') return
    }
  }

  private async step(plan: Plan, step: Step): Promise<void> {
    const readonly = this.isReadOnly(step)
    const startedAt = Date.now()
    logger.info(__t('apps.social.logs', '社交编排步骤开始'), {
      turnId: currentSocialRecovery()!.record.id,
      planId: plan.id,
      stepId: step.id,
      op: step.op,
      tool: step.tool,
      action: step.action ?? (step.args as ObjectValue | undefined)?.action,
      readonly,
    })
    try {
      let data: unknown
      if (step.op === 'call') {
        if (this.closing || this.checkpoint.businessCalls >= 24)
          throw new Error('业务工具预算已结束，请通过 social_act 回复、PASS、等待或观察收尾')
        const args = object(
          resolve(step.args ?? { action: step.action, input: step.input ?? {} }, plan.results),
        )
        const tool = String(step.tool)
        if (SOCIAL_BUSINESS_TOOLS.includes(tool as SocialBusinessTool)) {
          const input = object(args.input ?? {})
          args.input = input
          if (['history_get', 'mark_read'].includes(String(args.action))) {
            input.channel_id ??= this.deps.channelId
            input.channel_type ??= this.deps.channelType
          }
          if (tool === 'social_group' && this.deps.channelType === 'group')
            input.group_id ??= this.deps.channelId
        }
        if (!this.deps.available(tool, args)) throw new Error('此能力或操作未向当前会话开放')
        const maxRetries = readonly ? number(step.retries, 1, 0, 2) : 0
        for (;;) {
          this.active()
          if (this.checkpoint.businessCalls >= 24) throw new Error('本回合的业务工具预算已用完')
          this.checkpoint.businessCalls++
          plan.attempts[step.id] = (plan.attempts[step.id] ?? 0) + 1
          plan.executing = { id: step.id, readonly }
          await this.save()
          try {
            const raw = await this.deps.execute(tool, args, `${plan.id}:${step.id}`)
            try {
              data = JSON.parse(raw)
            } catch {
              data = { text: raw }
            }
            const result = data as ObjectValue | null
            if (result?.success === false || result?.error != null) {
              const error = result?.error
              const detail = error && typeof error === 'object' ? (error as ObjectValue) : {}
              const retryable =
                readonly &&
                (result?.retryable === true ||
                  detail.retryable === true ||
                  socialFailure({ message: String(error) }).retryable)
              if (retryable && plan.attempts[step.id]! <= maxRetries) {
                logger.warn(__t('apps.social.logs', '社交只读工具失败，等待重试'), {
                  turnId: currentSocialRecovery()!.record.id,
                  planId: plan.id,
                  stepId: step.id,
                  attempt: plan.attempts[step.id],
                  maxRetries,
                  reason: safeModelDiagnostic(String(detail.message ?? error), 300),
                })
                plan.executing = undefined
                await this.save()
                await socialDelay(500 * plan.attempts[step.id]!, currentSocialRecovery()!.signal)
                continue
              }
              plan.results[step.id] = this.failure(
                step.id,
                String(detail.message ?? error ?? '工具操作失败'),
                result?.uncertain === true,
                String(detail.code ?? result?.code ?? 'SOCIAL_TOOL_FAILED'),
                retryable,
              )
              plan.results[step.id]!.data = data
            }
            break
          } catch (error) {
            this.active()
            const failure = socialFailure(error)
            if (readonly && failure.retryable && plan.attempts[step.id]! <= maxRetries) {
              logger.warn(__t('apps.social.logs', '社交只读工具异常，等待重试'), {
                turnId: currentSocialRecovery()!.record.id,
                planId: plan.id,
                stepId: step.id,
                attempt: plan.attempts[step.id],
                maxRetries,
                reason: safeModelDiagnostic(failure.message, 300),
              })
              plan.executing = undefined
              await this.save()
              await socialDelay(500 * plan.attempts[step.id]!, currentSocialRecovery()!.signal)
              continue
            }
            plan.results[step.id] = this.failure(
              step.id,
              failure.message,
              !readonly,
              !readonly ? 'SOCIAL_WRITE_UNCERTAIN' : 'SOCIAL_READ_FAILED',
              readonly && failure.retryable,
            )
            break
          }
        }
        plan.executing = undefined
      } else if (step.op === 'send') {
        if (await this.pause(plan, step, 'delay', number(step.delay_ms, 0, 0, 21600000))) return
        if (this.checkpoint.sends >= 24) throw new Error('本回合的平台发送次数已达到上限，请收尾')
        const message = object(resolve(step, plan.results))
        this.validateMessage(message)
        const content = normalizeText(message.content === undefined ? '' : text(message.content))
        if (!content.trim() && !message.attachments) throw new Error('不能发送空白消息')
        if (/<\/?(?:think|tool_call)\b/i.test(content))
          throw new Error('发送正文不能包含内部思考或工具协议标签')
        plan.executing = { id: step.id, readonly: false }
        await this.save()
        const receipts: unknown[] = []
        if (content.trim()) {
          const quote = String(message.quote ?? 'trigger')
          receipts.push(
            await this.deps.send(
              {
                accountId: this.deps.accountId,
                channelId: this.deps.channelId,
                channelType: this.deps.channelType,
                content,
                replyTo:
                  quote === 'none'
                    ? undefined
                    : quote === 'trigger'
                      ? this.deps.triggerMessageId
                      : quote,
                mentions: message.mentions as string[] | undefined,
              },
              `${plan.id}:${step.id}:text`,
            ),
          )
        }
        for (const [index, raw] of ((message.attachments ?? []) as ObjectValue[]).entries()) {
          const attachment = object(raw)
          const rawResult = await this.deps.sendResource(
            text(attachment.source, 2048),
            attachment.caption as string | undefined,
            `${plan.id}:${step.id}:attachment:${index}`,
          )
          const result = object(JSON.parse(rawResult))
          if (result.success === false || result.error != null)
            throw Object.assign(new Error(String(result.error ?? '附件发送失败')), {
              uncertain: result.uncertain,
            })
          receipts.push(result)
        }
        data = { delivered: true, receipts }
        plan.executing = undefined
      } else if (step.op === 'wait' || step.op === 'observe') {
        const kind = oneOf(
          step.kind,
          ['wait', 'observe', 'defer'] as const,
          step.op === 'observe' ? 'observe' : 'wait',
        )
        if (await this.pause(plan, step, kind, number(step.duration_ms, 5000, 0, 21600000))) return
        data = { resumed: true, intention: step.intention }
        if (kind !== 'observe' || plan.wait?.event) plan.stopped = true
      } else if (step.op === 'if') {
        const condition = object(step.condition)
        const value = reference(String(condition.ref), plan.results)
        const equal = JSON.stringify(value) === JSON.stringify(condition.value)
        const matches =
          condition.test === 'exists'
            ? value !== undefined
            : condition.test === 'truthy'
              ? Boolean(value)
              : condition.test === 'eq'
                ? equal
                : !equal
        logger.info(__t('apps.social.logs', '社交编排已选择条件分支'), {
          turnId: currentSocialRecovery()!.record.id,
          planId: plan.id,
          stepId: step.id,
          reference: condition.ref,
          test: condition.test,
          branch: matches ? 'then' : 'else',
        })
        await this.sequence(plan, matches ? (step.then ?? []) : (step.else ?? []))
        if (plan.status === 'waiting') return
        data = { branch: matches ? 'then' : 'else' }
      } else if (step.op === 'parallel') {
        for (let start = 0; start < step.steps!.length; start += 3) {
          const settled = await Promise.allSettled(
            step
              .steps!.slice(start, start + 3)
              .map((child) =>
                runSocialStep(`${plan.id}:${child.id}`, () => this.sequence(plan, [child])),
              ),
          )
          this.active()
          const rejected = settled.find((item) => item.status === 'rejected')
          if (rejected?.status === 'rejected') throw rejected.reason
        }
        data = { steps: step.steps!.map((child) => child.id) }
      } else {
        plan.stopped = true
        data = { message: __t('apps.social.ui', '已把观察结果交回当前模型，后续步骤不再自动执行') }
      }
      this.active()
      plan.results[step.id] ??= {
        step_id: step.id,
        status: 'completed',
        data,
        completed_at: Date.now(),
      }
    } catch (error) {
      this.active()
      const detail = error as { uncertain?: boolean; code?: string }
      const uncertain =
        detail.uncertain === true ||
        (step.op === 'send' &&
          plan.executing?.id === step.id &&
          !['DELIVERY_NOT_SENT', 'DELIVERY_REJECTED'].includes(detail.code ?? ''))
      plan.results[step.id] = this.failure(
        step.id,
        error instanceof Error ? error.message : String(error),
        uncertain,
        detail.code,
      )
      plan.executing = undefined
    }
    await this.save()
    logger.info(__t('apps.social.logs', '社交编排步骤结束'), {
      turnId: currentSocialRecovery()!.record.id,
      planId: plan.id,
      stepId: step.id,
      op: step.op,
      tool: step.tool,
      action: step.action ?? (step.args as ObjectValue | undefined)?.action,
      status: plan.results[step.id]?.status,
      elapsedMs: Date.now() - startedAt,
      error: plan.results[step.id]?.error
        ? safeModelDiagnostic(plan.results[step.id]!.error!.message, 300)
        : undefined,
      observation: observationForLog(plan.results[step.id]?.data),
    })
  }

  private async pause(
    plan: Plan,
    step: Step,
    kind: PlanWait['kind'],
    delay: number,
  ): Promise<boolean> {
    if (kind === 'delay' && delay === 0) return false
    let pending = plan.wait
    if (!pending || pending.stepId !== step.id) {
      const now = Date.now()
      const deadline = Date.parse(currentSocialRecovery()!.record.deadline)
      const config = watch(step.watch)
      const anchor =
        kind === 'delay'
          ? Math.max(
              plan.createdAt,
              ...Object.values(plan.results).map((result) => result.completed_at),
            )
          : now
      const lifetime = number(
        step.expires_in_seconds ?? config?.expires_in_seconds,
        kind === 'delay' ? Math.min(21600, Math.ceil(delay / 1000) + 300) : 300,
        1,
        21600,
      )
      const expiresAt = Math.min(deadline, anchor + lifetime * 1000)
      const until = kind === 'observe' ? expiresAt : Math.min(deadline, anchor + delay)
      pending = { stepId: step.id, kind, until, expiresAt, startedAt: anchor, watch: config }
      if (until > expiresAt) throw new Error('等待时间超过观察或计划有效期')
      plan.wait = pending
    }
    if (pending.event || Date.now() >= pending.until) {
      logger.info(__t('apps.social.logs', '社交等待已唤醒'), {
        turnId: currentSocialRecovery()!.record.id,
        planId: plan.id,
        stepId: step.id,
        kind,
        trigger: pending.event
          ? __t('apps.social.logs', '新消息')
          : __t('apps.social.logs', '到达唤醒时间'),
        decision: pending.decision,
        intention: step.intention,
      })
      const recent = currentSocialRecovery()!.record.checkpoint.orchestrationContext
      if (kind === 'delay' && Date.now() >= pending.expiresAt) {
        plan.stopped = true
        plan.status = 'continue'
        plan.results[step.id] = {
          step_id: step.id,
          status: 'skipped',
          data: {
            reason: '延迟发送已过期，尚未发送，请模型根据最新语境重新判断',
            recent_messages: recent,
          },
          completed_at: Date.now(),
        }
        plan.wait = undefined
        return true
      }
      if (pending.decision === 'cancel' || pending.decision === 'reconsider') {
        plan.stopped = pending.decision === 'reconsider'
        plan.status = pending.decision === 'cancel' ? 'completed' : 'continue'
        plan.results[step.id] = {
          step_id: step.id,
          status: 'skipped',
          data: {
            reason:
              pending.decision === 'cancel'
                ? '相关新消息到达，未执行部分已取消'
                : '相关新消息到达，请模型重新判断',
            event: pending.event,
            recent_messages: recent,
          },
          completed_at: Date.now(),
        }
        plan.steps = []
        return true
      }
      if (kind !== 'delay') {
        plan.results[step.id] = {
          step_id: step.id,
          status: 'completed',
          data: {
            resumed: Boolean(pending.event),
            expired: !pending.event && Date.now() >= pending.expiresAt,
            event: pending.event,
            intention: step.intention,
            recent_messages: recent,
          },
          completed_at: Date.now(),
        }
        plan.stopped = kind !== 'observe' || Boolean(pending.event)
      }
      plan.wait = undefined
      return false
    }
    plan.status = 'waiting'
    await this.save()
    logger.info(__t('apps.social.logs', '社交 Agent 已选择托管等待'), {
      turnId: currentSocialRecovery()!.record.id,
      planId: plan.id,
      stepId: step.id,
      kind,
      wakeAt: new Date(pending.until).toISOString(),
      expiresAt: new Date(pending.expiresAt).toISOString(),
      watch: pending.watch,
      intention:
        typeof step.intention === 'string' ? safeModelDiagnostic(step.intention, 500) : undefined,
    })
    return true
  }
}

export function orchestrationWait(checkpoint: Record<string, unknown>) {
  const state = checkpoint.orchestration as SocialOrchestrationCheckpoint | undefined
  return state?.active ? state.plans[state.active]?.wait : undefined
}

/** 匹配只使用当前账号与会话；群里无关发言不会打断延迟发送。 */
export function notifyOrchestrationInbound(
  checkpoint: Record<string, unknown>,
  message: InboundMessage,
): boolean {
  const state = checkpoint.orchestration as SocialOrchestrationCheckpoint | undefined
  const plan = state?.active ? state.plans[state.active] : undefined
  const pending = plan?.wait
  if (!plan || !pending || pending.event || Date.now() >= pending.expiresAt) return false
  const senders = pending.watch?.senders as string[] | undefined
  const related = senders?.length
    ? senders.includes(message.senderId)
    : message.isMentioned || message.senderId === plan.triggerSenderId
  if (!related) return false
  if (pending.kind === 'delay' && plan.onNewMessage === 'keep') return false
  const events = (pending.watch?.events ?? ['new_message']) as string[]
  if (
    pending.kind !== 'delay' &&
    !events.some(
      (event) =>
        event === 'new_message' ||
        (event === 'mention_me' && message.isMentioned) ||
        (event === 'image' && message.attachments?.some((item) => item.type === 'image')),
    )
  )
    return false
  pending.event = {
    ...message,
    content: message.content.slice(0, 10000),
    rawEvent: undefined,
  }
  if (pending.kind === 'delay')
    pending.decision = plan.onNewMessage === 'cancel' ? 'cancel' : 'reconsider'
  return true
}
