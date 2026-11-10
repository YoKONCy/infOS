import { randomUUID } from 'node:crypto'
import {
  HOME_DEFAULT_SETTINGS,
  type HomeActivity,
  type HomeEvent,
  type HomeScope,
  type HomeSettings,
} from '@infos/shared'
import { HomeError } from './homeErrors'
import type { HomeRepository } from '../../repositories/home.repo'

export class HomeActivityService {
  private listeners = new Set<(event: HomeEvent) => void>()
  constructor(
    private repo: HomeRepository,
    private now = Date.now,
    private settings: () => HomeSettings = () => HOME_DEFAULT_SETTINGS,
  ) {}
  subscribe(listener: (event: HomeEvent) => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  /** 有没有展示端在听（桌面客户端的通知窗口经 /events 订阅）。 */
  hasListeners() {
    return this.listeners.size > 0
  }
  emit(event: HomeEvent) {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        /* 展示端失败不能改变已完成的操作。 */
      }
    }
  }
  record(
    scope: HomeScope,
    input: Pick<HomeActivity, 'action' | 'objects' | 'result'> &
      Partial<Pick<HomeActivity, 'checkpointId' | 'detail'>>,
  ): HomeActivity {
    const value = { ...scope, ...input, id: randomUUID(), time: this.now() }
    this.cleanup()
    this.repo.put('activity', value, value.time)
    this.emit({ type: 'activity', data: value })
    return value
  }
  query(input: {
    agentId?: string
    sessionId?: string
    from?: number
    to?: number
    action?: string
    page?: number
    pageSize?: number
  }) {
    this.cleanup()
    const page = Math.max(1, input.page ?? 1),
      pageSize = Math.min(100, Math.max(1, input.pageSize ?? 20))
    const rows = this.repo
      .list<HomeActivity>('activity', input.agentId, input.sessionId)
      .filter(
        (row) =>
          (input.from === undefined || row.time >= input.from) &&
          (input.to === undefined || row.time <= input.to) &&
          (!input.action || row.action === input.action),
      )
      .reverse()
    return {
      items: rows.slice((page - 1) * pageSize, page * pageSize),
      total: rows.length,
      page,
      pageSize,
      hasMore: rows.length > page * pageSize,
    }
  }
  summary(scope: HomeScope) {
    this.cleanup()
    const rows = this.repo.list<HomeActivity>('activity', scope.agentId, scope.sessionId)
    return {
      activities: rows.length,
      files: [...new Set(rows.filter((row) => row.checkpointId).flatMap((row) => row.objects))],
      failed: rows.filter((row) => row.result === 'failed' || row.result === 'conflict').length,
    }
  }
  cleanup() {
    const cutoff = this.now() - this.settings().activityRetentionMs
    for (const row of this.repo.list<HomeActivity>('activity'))
      if (row.time < cutoff) this.repo.remove('activity', row.id)
  }
  get(agentId: string, id: string) {
    this.cleanup()
    const row = this.repo.get<HomeActivity>('activity', id)
    if (!row || row.agentId !== agentId) throw new HomeError('HOME_NOT_FOUND')
    return row
  }
  remove(agentId: string, id: string) {
    this.get(agentId, id)
    this.repo.remove('activity', id)
    return { id }
  }
}
