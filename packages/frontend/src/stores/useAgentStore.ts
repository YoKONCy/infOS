/**
 * useAgentStore — Agent 全局状态
 *
 */

import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { agentApi } from '../api/modules/agentApi'
import { runtimeApi } from '../api/modules/runtimeApi'
import { invoke, isElectron, listen } from '../utils/ipcAdapter'
import type { AgentListItem } from '../api/modules/agentApi'

/**
 * 获取或创建当前窗口的唯一 ID
 *
 * 第七阶段修复（批次 C）：窗口级 Agent 状态需要 windowId 标识来源窗口。
 * windowId 持久化到 localStorage，确保窗口刷新后仍能绑定到同一 Agent。
 */
function getWindowId(): string {
  const KEY = 'infos:windowId'
  let windowId = localStorage.getItem(KEY)
  if (!windowId) {
    // 简单生成 UUID v4（避免引入 crypto 依赖）
    windowId = 'win-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
    localStorage.setItem(KEY, windowId)
  }
  return windowId
}

export const useAgentStore = defineStore('agent', () => {
  // ── 状态 ──
  const agents = ref<AgentListItem[]>([])
  const activeAgentId = ref<string>('pero')
  const isLoading = ref(false)
  const error = ref<string | null>(null)
  let clientAgentListenerBound = false

  async function bindClientAgentListener(): Promise<void> {
    if (!isElectron() || clientAgentListenerBound) return
    clientAgentListenerBound = true
    await listen('client-agent-changed', (payload) => {
      const agentId =
        typeof payload === 'object' && payload !== null
          ? String((payload as { agentId?: unknown }).agentId ?? '')
          : ''
      if (agentId && agents.value.some((agent) => agent.id === agentId)) {
        activeAgentId.value = agentId
        void runtimeApi.setWindowAgent(getWindowId(), agentId)
      }
    })
  }

  // ── 计算属性 ──
  const currentAgent = computed(
    () => agents.value.find((a) => a.id === activeAgentId.value) ?? null,
  )

  const enabledAgents = computed(() => agents.value.filter((a) => a.isEnabled))

  // ── 动作 ──

  /** 拉取所有 Agent 列表 */
  let fetchingAgents: Promise<void> | undefined
  function fetchAgents(): Promise<void> {
    if (fetchingAgents) return fetchingAgents
    fetchingAgents = loadAgents().finally(() => {
      fetchingAgents = undefined
    })
    return fetchingAgents
  }

  async function loadAgents() {
    isLoading.value = true
    error.value = null
    try {
      const res = await agentApi.list()
      agents.value = res.data ?? []
      await bindClientAgentListener()
      const clientDefault = isElectron() ? await invoke('get-client-default-agent') : null
      if (
        typeof clientDefault === 'string' &&
        agents.value.some((agent) => agent.id === clientDefault)
      ) {
        activeAgentId.value = clientDefault
        await runtimeApi.setWindowAgent(getWindowId(), clientDefault)
        return
      }
      // 后端 active 接口是所有入口的权威状态；刷新后必须以它同步本地选择。
      const backendActive = await agentApi.getActive()
      if (
        backendActive.data?.id &&
        agents.value.some((agent) => agent.id === backendActive.data!.id)
      ) {
        activeAgentId.value = backendActive.data.id
      }
    } catch (err) {
      error.value = (err as Error).message
    } finally {
      isLoading.value = false
    }
  }

  /**
   * 切换当前窗口的 Agent
   *
   * 第七阶段修复（批次 C）：
   * - 后端不再维护全局活跃 Agent，改为窗口级映射 (windowId → agentId)
   * - 通过 runtimeApi.setWindowAgent 注册映射，后端用于广播、Cron 通知等
   * - windowId 从 localStorage 获取/生成，窗口刷新后保持一致
   * - 仍同步本地 activeAgentId 状态供前端组件使用
   */
  async function switchAgent(agentId: string) {
    if (fetchingAgents) await fetchingAgents
    if (agentId === activeAgentId.value) return

    const windowId = getWindowId()
    await runtimeApi.setWindowAgent(windowId, agentId)
    activeAgentId.value = agentId
    if (isElectron()) await invoke('set-client-default-agent', { agentId })
    // 切换结果在界面上一眼可见，不再弹「已切换」的成功提示
    await fetchAgents()
  }

  return {
    agents,
    activeAgentId,
    isLoading,
    error,
    currentAgent,
    enabledAgents,
    fetchAgents,
    switchAgent,
  }
})
