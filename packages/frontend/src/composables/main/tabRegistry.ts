/**
 * tabRegistry — 前端领域模块
 *
 * 集中管理该领域的数据转换、状态边界与外部交互。
 * 调用方依赖这里的稳定契约，不直接耦合底层传输或运行时实现。
 */
import type { Component } from 'vue'

export type TabModule = { default: Component }
export type TabLoader = () => Promise<TabModule>

const loaders: Record<string, TabLoader> = {
  chat: () => import('../../components/main/tabs/ChatTab.vue'),
  workspace: () => import('../../components/main/tabs/WorkspaceTab.vue'),
  overview: () => import('../../components/dashboard/tabs/OverviewTab.vue'),
  logs: () => import('../../components/dashboard/tabs/LogsTab.vue'),
  memories: () => import('../../components/dashboard/tabs/MemoriesTab.vue'),
  knowledge: () => import('../../components/dashboard/tabs/KnowledgeTab.vue'),
  tasks: () => import('../../components/dashboard/tabs/TasksTab.vue'),
  stronghold: () => import('../../components/main/tabs/StrongholdTab.vue'),
  agent_config: () => import('../../components/dashboard/tabs/AgentConfigTab.vue'),
  user_settings: () => import('../../components/dashboard/tabs/UserSettingsTab.vue'),
  model_config: () => import('../../components/dashboard/tabs/ModelConfigTab.vue'),
  prompts: () => import('../../components/dashboard/tabs/PromptManagementTab.vue'),
  voice_config: () => import('../../components/dashboard/tabs/VoiceTab.vue'),
  mcp_config: () => import('../../components/integrations/ToolsExtensionsTab.vue'),
  distributed: () => import('../../components/dashboard/tabs/DistributedTab.vue'),
  backups: () => import('../../components/dashboard/tabs/BackupsTab.vue'),
  social: () => import('../../components/dashboard/tabs/SocialTab.vue'),
  terminal: () => import('../../components/dashboard/tabs/TerminalTab.vue'),
  system_reset: () => import('../../components/dashboard/tabs/ResetTab.vue'),
}

const pending = new Map<string, Promise<TabModule>>()
const ready = new Set<string>()

export function getTabLoader(id: string): TabLoader | undefined {
  const loader = loaders[id]
  if (!loader) return undefined
  return () => preloadTab(id)
}

export function isTabReady(id: string): boolean {
  return ready.has(id)
}

/** 同一 Tab 的下载、解析和模块执行始终复用同一个 Promise。 */
export function preloadTab(id: string): Promise<TabModule> {
  const cached = pending.get(id)
  if (cached) return cached
  const loader = loaders[id]
  if (!loader) return Promise.reject(new Error(`未知 Tab: ${id}`))
  const promise = loader()
    .then((module) => {
      ready.add(id)
      return module
    })
    .catch((error) => {
      pending.delete(id)
      throw error
    })
  pending.set(id, promise)
  return promise
}

/** 首屏完成后逐个预热常用页面，不并发挤占启动阶段的主线程。 */
export function warmTabsWhenIdle(ids: readonly string[], canLoad: () => boolean): () => void {
  let stopped = false
  let index = 0
  let idle: number | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const schedule = () => {
    if (stopped || index >= ids.length) return
    timer = setTimeout(() => {
      if (stopped) return
      if (document.hidden || !canLoad()) {
        schedule()
        return
      }
      const load = () => {
        if (stopped) return
        if (document.hidden || !canLoad()) {
          schedule()
          return
        }
        void preloadTab(ids[index++]!)
          .catch(() => {})
          .finally(schedule)
      }
      if (typeof requestIdleCallback === 'function') idle = requestIdleCallback(load)
      else load()
    }, 1500)
  }
  schedule()
  return () => {
    stopped = true
    clearTimeout(timer)
    if (idle !== undefined && typeof cancelIdleCallback === 'function') cancelIdleCallback(idle)
  }
}
