import { computed, onMounted, ref, watch } from 'vue'
import type { HomeScope } from '@infos/shared'
import { t as __t } from '../../../i18n/index'
import { threadsApi, type ThreadInfo } from '../../../api/modules/threadsApi'
import { useAgentStore } from '../../../stores/useAgentStore'
import { homeErrorText } from './homeFormat'
import { threadDisplayName } from '../../../utils/threadPresentation'

/**
 * 「桌面与家」里「她的地方」和「信任」共用的角色与对话选择。
 * 后端只接受该角色仍在进行中的桌面对话；没有对话时 scope 为 null，面板只提示不请求。
 */
export function useHomeScope() {
  const agents = useAgentStore()
  const agentId = ref(agents.activeAgentId || 'pero')
  const threads = ref<ThreadInfo[]>([])
  const sessionId = ref('')
  const error = ref('')
  const loading = ref(false)

  const agentOptions = computed(() =>
    (agents.agents.length ? agents.agents : [{ id: agentId.value, name: agentId.value }]).map(
      (agent) => ({ value: agent.id, label: agent.name || agent.id }),
    ),
  )
  const sessionOptions = computed(() =>
    threads.value.length
      ? threads.value.map((thread) => ({
          value: thread.id,
          label: threadDisplayName(thread),
        }))
      : [{ value: '', label: __t('ui.desktop', '没有进行中的对话') }],
  )
  const scope = computed<HomeScope | null>(() =>
    sessionId.value ? { agentId: agentId.value, sessionId: sessionId.value } : null,
  )

  async function loadThreads() {
    loading.value = true
    try {
      const result = await threadsApi.list({
        agentId: agentId.value,
        channel: 'desktop',
        purpose: 'conversation',
        pageSize: 50,
      })
      threads.value = (result.data?.items ?? []).filter((thread) => thread.status === 'active')
      if (!threads.value.some((thread) => thread.id === sessionId.value))
        sessionId.value = threads.value[0]?.id ?? ''
      error.value = ''
    } catch (cause) {
      error.value = homeErrorText(cause)
    } finally {
      loading.value = false
    }
  }
  onMounted(() => {
    if (!agents.agents.length) void agents.fetchAgents()
  })
  watch(agentId, loadThreads, { immediate: true })

  return { agentId, sessionId, agentOptions, sessionOptions, scope, error, loading, loadThreads }
}

export type HomeScopeState = ReturnType<typeof useHomeScope>
