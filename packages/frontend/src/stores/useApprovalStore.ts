/**
 * useApprovalStore — 工具审批全局状态（跨 Tab 单例）
 *
 * 审批不是任何 Tab 的专属逻辑：对话、工作区、任务中心共享同一份 pending 集合。
 * 数据流：轮询（兜底）+ resolve 后即时移除；后续可叠加 Gateway 推送加速。
 *
 * @module packages/frontend/src/stores/useApprovalStore
 */

import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import {
  approvalsApi,
  type ApprovalRequest,
  type ApprovalDecision,
} from '../api/modules/approvalsApi'
import { uiSound } from '../services/ui/uiSound'
import { useCompositorStore } from './useCompositorStore'
import { createApprovalPolling, samePendingSet } from './approvalPolling'

const POLL_INTERVAL_MS = 4_000

export const useApprovalStore = defineStore('approval', () => {
  const pending = ref<Map<string, ApprovalRequest>>(new Map())
  const isResolving = ref<Record<string, boolean>>({})
  const resolvedIds = new Set<string>()
  let stateRevision = 0
  const polling = createApprovalPolling(refresh, POLL_INTERVAL_MS)

  /** 未完成审批数量（全局角标） */
  const pendingCount = computed(() => pending.value.size)

  /** 按 Agent 过滤的 pending 视图（新到旧排序） */
  function forAgent(agentId: string): ApprovalRequest[] {
    return [...pending.value.values()]
      .filter((request) => request.agentId === agentId)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
  }

  /** 按 Agent + Thread 过滤（对话流内嵌用） */
  function forThread(agentId: string, threadId: string): ApprovalRequest[] {
    return forAgent(agentId).filter(
      (request) => request.threadId === threadId || request.sessionId === threadId,
    )
  }

  /** 刷新 pending 集合（与后端状态对齐） */
  async function refresh(): Promise<void> {
    const revision = stateRevision
    try {
      const res = await approvalsApi.list({ status: 'pending' })
      if (revision !== stateRevision) return
      const next = new Map(
        (res.data?.requests ?? [])
          .filter((request) => request.status === 'pending' && !resolvedIds.has(request.id))
          .map((request) => [request.id, request]),
      )
      // 轮询结果与当前集合一致时保留原 Map，避免每轮兜底都触发审批列表与角标重算。
      if (!samePendingSet(pending.value, next)) pending.value = next
    } catch {
      // 后端未就绪时静默，等待下一轮
    }
  }

  /** 决策（可选附言），成功后从 pending 移除 */
  async function resolve(id: string, decision: ApprovalDecision, message?: string): Promise<void> {
    if (isResolving.value[id]) return
    isResolving.value = { ...isResolving.value, [id]: true }
    try {
      await approvalsApi.resolve(id, decision, message)
      remove(id)
    } finally {
      isResolving.value = { ...isResolving.value, [id]: false }
    }
  }

  /** 接收 Gateway 新审批；全局轮询补齐未投递到当前席位的其他角色审批。 */
  function receive(request: ApprovalRequest): void {
    if (request.status !== 'pending' || resolvedIds.has(request.id)) return
    stateRevision++
    const isNew = !pending.value.has(request.id)
    const map = new Map(pending.value)
    map.set(request.id, request)
    pending.value = map
    if (isNew) void uiSound.play('approval.required')
  }

  /** 接收 Gateway 审批完成事件并即时移除。 */
  function remove(id: string): void {
    stateRevision++
    // 已完成决策不能被较早发出的轮询响应或迟到推送重新放回队列。
    resolvedIds.add(id)
    if (resolvedIds.size > 2048) resolvedIds.delete(resolvedIds.values().next().value!)
    const map = new Map(pending.value)
    map.delete(id)
    pending.value = map
    useCompositorStore().dispose(`conversation-approval:${id}`)
  }

  /** 启动全局轮询（在 MainView 挂载时调用一次） */
  function startPolling(): void {
    polling.start()
  }

  function stopPolling(): void {
    polling.stop()
  }

  return {
    pending,
    pendingCount,
    isResolving,
    forAgent,
    forThread,
    refresh,
    resolve,
    receive,
    remove,
    startPolling,
    stopPolling,
    setPollingPaused: polling.setPaused,
  }
})
