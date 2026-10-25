import { computed, onActivated, onBeforeUnmount, onDeactivated, ref, watch } from 'vue'
import { workspaceApi, type WorkspaceFileNode } from '../../api/modules/approvalsApi'
import type { WorkspaceTreeNode } from '../../components/workspace/WorkspaceTreeBranch.vue'
import { t } from '../../i18n'

/** 只扫描根目录与展开分支；可见性、请求合并和会话隔离由同一处管理。 */
export function useWorkspaceTreeData(
  session: () => { agentId: string; threadId: string },
  active: () => boolean,
) {
  const roots = ref<WorkspaceTreeNode[]>([])
  const rootPath = ref('')
  const loading = ref(false)
  const error = ref('')
  const activated = ref(true)
  const visible = ref(!document.hidden)
  const enabled = computed(
    () =>
      active() && activated.value && visible.value && !!session().agentId && !!session().threadId,
  )
  let revision = 0
  let pending = false
  let disposed = false
  let failures = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let flight: Promise<void> | undefined
  const directoryRevisions = new WeakMap<WorkspaceTreeNode, number>()

  function clearTimer() {
    if (timer) clearTimeout(timer)
    timer = undefined
  }
  function current(token: number) {
    return !disposed && token === revision && enabled.value
  }
  function merge(previous: WorkspaceTreeNode[], next: WorkspaceFileNode[]): WorkspaceTreeNode[] {
    const byPath = new Map(previous.map((node) => [node.path, node]))
    return next.map((node) => {
      const existing = byPath.get(node.path)
      return existing?.type === node.type ? Object.assign(existing, node) : { ...node }
    })
  }
  function schedule() {
    clearTimer()
    if (enabled.value && !disposed)
      timer = setTimeout(() => void refresh(), Math.min(30000, 5000 * 2 ** failures))
  }
  async function refresh(): Promise<void> {
    if (!enabled.value || disposed) return
    pending = true
    if (flight) return flight
    clearTimer()
    const token = revision
    const scope = { ...session() }
    loading.value = true
    const restore = async (nodes: WorkspaceTreeNode[]): Promise<void> => {
      for (const node of nodes) {
        if (!current(token)) return
        if (node.type !== 'directory' || !node.expanded || node.loading) continue
        const directoryRevision = directoryRevisions.get(node) ?? 0
        try {
          const response = await workspaceApi.listDir(scope, node.path)
          if (!current(token)) return
          if (directoryRevision !== (directoryRevisions.get(node) ?? 0)) continue
          node.children = merge(node.children ?? [], response.data?.nodes ?? [])
          if (node.expanded) await restore(node.children)
        } catch {
          // 展开目录被外部删除时保留其余分支，下次根目录扫描会移除旧节点。
          if (current(token) && directoryRevision === (directoryRevisions.get(node) ?? 0))
            node.children = undefined
        }
      }
    }
    flight = (async () => {
      do {
        pending = false
        try {
          const response = await workspaceApi.listDir(scope)
          if (!current(token)) return
          if (!response.data) throw new Error('WORKSPACE_TREE_EMPTY_RESPONSE')
          roots.value = merge(roots.value, response.data.nodes)
          rootPath.value = response.data.root
          await restore(roots.value)
          if (!current(token)) return
          failures = 0
          error.value = ''
        } catch {
          if (!current(token)) return
          failures = Math.min(failures + 1, 3)
          error.value = t('ui.workspace', '文件列表暂时无法刷新，将自动重试')
          pending = false
        }
      } while (pending && current(token))
    })().finally(() => {
      if (token !== revision || disposed) return
      flight = undefined
      loading.value = false
      schedule()
    })
    return flight
  }
  async function toggle(node: WorkspaceTreeNode) {
    const directoryRevision = (directoryRevisions.get(node) ?? 0) + 1
    directoryRevisions.set(node, directoryRevision)
    node.expanded = !node.expanded
    if (!node.expanded) {
      node.loading = false
      return
    }
    const token = revision
    const scope = { ...session() }
    node.loading = true
    try {
      const response = await workspaceApi.listDir(scope, node.path)
      if (current(token) && directoryRevision === directoryRevisions.get(node))
        node.children = merge(node.children ?? [], response.data?.nodes ?? [])
    } catch {
      if (current(token)) error.value = t('ui.workspace', '文件列表暂时无法刷新，将自动重试')
    } finally {
      if (directoryRevision === directoryRevisions.get(node)) node.loading = false
    }
  }
  function resume() {
    const next = !document.hidden
    const changed = visible.value !== next
    visible.value = next
    if (!changed && enabled.value) void refresh()
  }
  watch(
    () => [session().agentId, session().threadId],
    () => {
      ++revision
      flight = undefined
      pending = false
      failures = 0
      loading.value = false
      roots.value = []
      rootPath.value = ''
      error.value = ''
      clearTimer()
      void refresh()
    },
    { immediate: true },
  )
  watch(enabled, (value) => {
    clearTimer()
    if (value) void refresh()
    else {
      ++revision
      flight = undefined
      pending = false
      loading.value = false
    }
  })
  window.addEventListener('focus', resume)
  window.addEventListener('infos:gateway-ready', resume)
  document.addEventListener('visibilitychange', resume)
  onActivated(() => {
    activated.value = true
  })
  onDeactivated(() => {
    activated.value = false
    clearTimer()
  })
  onBeforeUnmount(() => {
    disposed = true
    ++revision
    clearTimer()
    window.removeEventListener('focus', resume)
    window.removeEventListener('infos:gateway-ready', resume)
    document.removeEventListener('visibilitychange', resume)
  })
  return { roots, rootPath, loading, error, refresh, toggle }
}
