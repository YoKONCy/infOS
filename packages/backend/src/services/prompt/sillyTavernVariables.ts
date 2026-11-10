import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { PromptVariableCommit, PromptVariableState } from '@infos/shared'
import type { ConfigRepository } from '../../repositories/config.repo'
import { AppError } from '../../lib/appError'

const KEY = 'prompt.variables.st.v1'
const name = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => !value.startsWith('__') && !['constructor', 'prototype'].includes(value))
const values = z.record(name, z.string().max(200_000))
const stateSchema = z.object({
  global: values,
  sessions: z.record(z.string(), z.object({ scope: z.string().max(500), values })),
  committed: z.array(z.string()).max(512),
  epoch: z.number().int().nonnegative().default(0),
  deletedThreads: z.array(z.string()).max(2000).default([]),
  scopeEpochs: z.record(z.string(), z.number().int().nonnegative()).default({}),
})
const effect = z.object({
  name,
  before: z.string().max(200_000).optional(),
  after: z.string().max(200_000).optional(),
  write: z.boolean(),
})
const commitSchema = z.object({
  id: z.string().uuid(),
  scope: z.string().min(1).max(500),
  epoch: z.number().int().nonnegative().default(0),
  scopeEpoch: z.number().int().nonnegative().default(0),
  effects: z.object({ local: z.array(effect).max(1000), global: z.array(effect).max(1000) }),
})
type StoredVariables = z.infer<typeof stateSchema>

/** 一次 upsert 原子保存两类变量；串行提交并检查读取版本，避免并发覆盖。 */
export class SillyTavernVariableStore {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private repo: ConfigRepository) {}
  private async load(): Promise<StoredVariables> {
    const raw = await this.repo.get(KEY)
    if (!raw) return stateSchema.parse({ global: {}, sessions: {}, committed: [] })
    try {
      return stateSchema.parse(JSON.parse(raw))
    } catch {
      throw new AppError('CONFIG_ERROR', {
        message: '酒馆变量存储损坏，请在提示词页重置变量后继续',
      })
    }
  }
  private key(scope: string) {
    return createHash('sha256').update(scope).digest('hex')
  }
  async snapshot(scope: string): Promise<PromptVariableState & { epoch: number; scopeEpoch: number }> {
    await this.queue
    const state = await this.load()
    return {
      local: structuredClone(state.sessions[this.key(scope)]?.values ?? {}),
      global: structuredClone(state.global),
      epoch: state.epoch,
      scopeEpoch: state.scopeEpochs[scope.split(':').at(-1)!] ?? 0,
    }
  }
  commit(input: PromptVariableCommit): Promise<void> {
    const change = commitSchema.parse(input)
    const action = this.queue.then(async () => {
      const state = await this.load()
      if (state.committed.includes(change.id)) return
      if (
        change.epoch !== state.epoch ||
        change.scopeEpoch !== (state.scopeEpochs[change.scope.split(':').at(-1)!] ?? 0) ||
        state.deletedThreads.some((threadId) => change.scope.endsWith(`:${threadId}`))
      )
        throw new AppError('CONFLICT', { message: '酒馆变量已重置或会话已删除，本轮变量不再提交' })
      const local = state.sessions[this.key(change.scope)]?.values ?? {}
      for (const [records, target] of [
        [change.effects.local, local],
        [change.effects.global, state.global],
      ] as const) {
        for (const item of records) {
          const current = Object.hasOwn(target, item.name) ? target[item.name] : undefined
          if (current !== item.before)
            throw new AppError('CONFLICT', {
              message: `酒馆变量“${item.name}”已被另一轮对话修改，本轮变量未提交，请重新生成`,
            })
        }
      }
      const apply = (target: Record<string, string>, records: typeof change.effects.local) => {
        for (const item of records)
          if (item.write) {
            if (item.after === undefined) delete target[item.name]
            else target[item.name] = item.after
          }
      }
      apply(local, change.effects.local)
      apply(state.global, change.effects.global)
      if (Object.keys(local).length)
        state.sessions[this.key(change.scope)] = { scope: change.scope, values: local }
      else delete state.sessions[this.key(change.scope)]
      state.committed = [...state.committed, change.id].slice(-512)
      if (JSON.stringify(state).length > 4_000_000 || Object.keys(state.sessions).length > 2000)
        throw new AppError('CONFIG_ERROR', {
          message: '酒馆变量存储已满，请清理不再使用的会话变量',
        })
      await this.repo.setJson(KEY, state)
    })
    this.queue = action.catch(() => {})
    return action
  }
  async inspect() {
    await this.queue
    const state = await this.load()
    return {
      global: state.global,
      sessions: Object.values(state.sessions).map((item) => ({
        scope: item.scope,
        count: Object.keys(item.values).length,
      })),
    }
  }
  reset(scope?: string): Promise<void> {
    const action = this.queue.then(async () => {
      let state: StoredVariables
      try {
        state = await this.load()
      } catch (error) {
        if (scope) throw error
        state = stateSchema.parse({ global: {}, sessions: {}, committed: [] })
      }
      if (!scope) {
        state.global = {}
        state.sessions = {}
        state.committed = []
      } else if (scope === '$global') state.global = {}
      else delete state.sessions[this.key(scope)]
      state.epoch = Math.max(Date.now(), state.epoch + 1)
      await this.repo.setJson(KEY, state)
    })
    this.queue = action.catch(() => {})
    return action
  }
  removeThread(threadId: string): Promise<void> {
    const action = this.queue.then(async () => {
      const state = await this.load()
      for (const [key, session] of Object.entries(state.sessions))
        if (session.scope.endsWith(`:${threadId}`)) delete state.sessions[key]
      state.deletedThreads = [...new Set([...state.deletedThreads, threadId])].slice(-2000)
      await this.repo.setJson(KEY, state)
    })
    this.queue = action.catch(() => {})
    return action
  }

  /** 局部变量与会话代次同事务重置，保留 ID 并使旧全局变量提交失效。 */
  resetThread<T>(threadId: string, commit: (variables: { key: string; value: string }) => Promise<T>): Promise<T> {
    const action = this.queue.then(async () => {
      const state = await this.load()
      state.scopeEpochs[threadId] = (state.scopeEpochs[threadId] ?? 0) + 1
      for (const [key, session] of Object.entries(state.sessions))
        if (session.scope.endsWith(`:${threadId}`)) delete state.sessions[key]
      return commit({ key: KEY, value: JSON.stringify(state) })
    })
    this.queue = action.catch(() => {})
    return action
  }

  /** 全量清空聊天时保留用户全局变量，并使所有旧执行的变量提交失效。 */
  clearConversationScopes<T>(commit: (variables: { key: string; value: string }) => Promise<T>): Promise<T> {
    const action = this.queue.then(async () => {
      const state = await this.load()
      state.sessions = {}
      state.epoch = Math.max(Date.now(), state.epoch + 1)
      return commit({ key: KEY, value: JSON.stringify(state) })
    })
    this.queue = action.catch(() => {})
    return action
  }

  /** 与变量提交串行，交由调用方在创建会话的同一事务内保存当前局部变量副本。 */
  forkThread<T>(
    sourceThreadId: string,
    targetThreadId: string,
    commit: (configuration: { key: string; value: string }) => T,
  ): Promise<T> {
    const action = this.queue.then(async () => {
      const state = await this.load()
      for (const session of Object.values(state.sessions)) {
        if (!session.scope.endsWith(`:${sourceThreadId}`)) continue
        const scope = session.scope.slice(0, -sourceThreadId.length) + targetThreadId
        state.sessions[this.key(scope)] = { scope, values: structuredClone(session.values) }
      }
      const value = JSON.stringify(state)
      if (value.length > 4_000_000 || Object.keys(state.sessions).length > 2000)
        throw new AppError('CONFIG_ERROR', {
          message: '酒馆变量存储已满，请清理不再使用的会话变量',
        })
      return commit({ key: KEY, value })
    })
    this.queue = action.catch(() => {})
    return action
  }
}
