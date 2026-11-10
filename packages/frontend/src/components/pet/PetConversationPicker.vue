<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import '@infos/shared/i18n/catalogs/petConversations'
import { t, appLocale } from '../../i18n'
import { agentApi, type AgentListItem } from '../../api/modules/agentApi'
import { threadsApi, type ThreadInfo } from '../../api/modules/threadsApi'
import { getApiBaseUrl } from '../../api/transport'
import PetHudIcon from './PetHudIcon.vue'
import MainThreadCard from '../chat/MainThreadCard.vue'
import { threadDisplayName } from '../../utils/threadPresentation'

const props = defineProps<{
  agentId: string
  petName: string
  threadId?: string | null
  threadTitle?: string
  threadKind?: 'main' | 'side'
  switching?: boolean
}>()
const emit = defineEmits<{
  'select-agent': [id: string, complete: (success: boolean) => void]
  'select-thread': [id: string, complete: (success: boolean) => void]
  'new-thread': [complete: (success: boolean) => void]
  'focus-input': []
}>()
const tr = (source: string, values: readonly unknown[] = []) =>
  t('ui.pet-conversations', source, values)
const opened = ref<'agents' | 'threads' | null>(null)
const agents = ref<AgentListItem[]>([])
const threads = ref<ThreadInfo[]>([])
const mainThread = computed(() => threads.value.find((thread) => thread.threadKind === 'main'))
const sideThreads = computed(() => threads.value.filter((thread) => thread.threadKind !== 'main'))
const page = ref(1)
const total = ref(0)
const loading = ref(false)
const failed = ref(false)
const choosing = ref(false)
const selectionError = ref('')
const list = ref<HTMLElement | null>(null)
const agentButton = ref<HTMLButtonElement | null>(null)
const threadButton = ref<HTMLButtonElement | null>(null)
const blocked = computed(() => props.switching || choosing.value)
const currentAgent = computed(() => agents.value.find((agent) => agent.id === props.agentId))
const title = computed(() =>
  props.threadId
    ? threadDisplayName(threads.value.find((thread) => thread.id === props.threadId) ?? {
        threadKind: props.threadKind, title: props.threadTitle,
      })
    : tr('选择会话'),
)
let generation = 0
let disposed = false
function avatar(agent?: AgentListItem) {
  return agent?.avatarUrl ? `${getApiBaseUrl()}${agent.avatarUrl}` : undefined
}
async function load(more = false) {
  const mode = opened.value
  if (!mode) return
  const version = ++generation
  const agentId = props.agentId
  loading.value = true
  failed.value = false
  try {
    if (mode === 'agents') {
      const response = await agentApi.list()
      if (disposed || version !== generation || agentId !== props.agentId) return
      agents.value = (response.data || []).filter((agent) => agent.isEnabled)
    } else {
      const next = more ? page.value + 1 : 1
      const response = await threadsApi.list({
        agentId,
        channel: 'desktop',
        purpose: 'conversation',
        page: next,
        pageSize: 20,
      })
      if (disposed || version !== generation || agentId !== props.agentId) return
      const rows = (response.data?.items || []).filter((thread) => thread.status === 'active')
      threads.value = more
        ? [
            ...threads.value,
            ...rows.filter((row) => !threads.value.some((item) => item.id === row.id)),
          ]
        : rows
      page.value = next
      total.value = response.data?.total || 0
    }
    await nextTick()
    if (!more && version === generation)
      list.value
        ?.querySelector<HTMLElement>('[aria-current="true"], [aria-pressed="true"]')
        ?.focus({ preventScroll: true })
  } catch {
    if (version === generation && !disposed) failed.value = true
  } finally {
    if (version === generation && !disposed) loading.value = false
  }
}
function toggle(mode: 'agents' | 'threads') {
  if (blocked.value) return
  generation++
  if (opened.value === mode) {
    opened.value = null
    loading.value = false
    return
  }
  opened.value = mode
  selectionError.value = ''
  if (mode === 'threads') {
    threads.value = []
    page.value = 1
    total.value = 0
  }
  void load()
}
function escape() {
  const button = opened.value === 'agents' ? agentButton.value : threadButton.value
  generation++
  opened.value = null
  loading.value = false
  button?.focus()
}
function complete(success: boolean) {
  if (disposed) return
  choosing.value = false
  if (success) {
    opened.value = null
    emit('focus-input')
  } else selectionError.value = '切换失败，请重试'
}
function choose(id: string) {
  if (blocked.value) return
  choosing.value = true
  selectionError.value = ''
  if (opened.value === 'agents') emit('select-agent', id, complete)
  else emit('select-thread', id, complete)
}
function create() {
  if (blocked.value) return
  choosing.value = true
  selectionError.value = ''
  emit('new-thread', (success) => {
    complete(success)
    if (!success && !disposed) selectionError.value = '新建失败，请重试'
  })
}
function date(thread: ThreadInfo) {
  const value = thread.lastMessageAt || thread.createdAt
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime())
    ? ''
    : new Intl.DateTimeFormat(appLocale.value, { month: 'short', day: 'numeric' }).format(parsed)
}
watch(
  () => props.agentId,
  () => {
    generation++
    opened.value = null
    threads.value = []
    loading.value = false
  },
)
onBeforeUnmount(() => {
  disposed = true
  generation++
})
</script>

<template>
  <div
    class="pet-conversation-picker"
    :aria-busy="switching || loading"
    @keydown.esc.stop.prevent="escape"
  >
    <div class="pet-conversation-picker__bar">
      <button
        ref="agentButton"
        type="button"
        class="pet-conversation-picker__agent"
        :disabled="blocked"
        :title="tr('切换角色')"
        :aria-label="tr('切换角色')"
        :aria-expanded="opened === 'agents'"
        @click="toggle('agents')"
      >
        <img v-if="avatar(currentAgent)" :src="avatar(currentAgent)" alt="" />
        <PetHudIcon v-else name="heart" size="xs" />
        <span>{{ petName }}</span>
        <PetHudIcon name="chevron-down" size="xs" />
      </button>
      <button
        ref="threadButton"
        type="button"
        class="pet-conversation-picker__thread"
        :class="{ 'pet-conversation-picker__thread--main': threadKind === 'main' }"
        :disabled="blocked"
        :title="title"
        :aria-label="tr('切换会话')"
        :aria-expanded="opened === 'threads'"
        @click="toggle('threads')"
      >
        <PetHudIcon :name="threadKind === 'main' ? 'heart' : 'chat'" size="xs" />
        <span>{{ title }}</span>
        <PetHudIcon name="chevron-down" size="xs" />
      </button>
      <button
        type="button"
        class="pet-conversation-picker__new"
        :disabled="blocked"
        :title="tr('新会话')"
        :aria-label="tr('新会话')"
        @click="create"
      >
        <PetHudIcon name="plus" size="xs" />
      </button>
    </div>
    <Transition name="pet-picker">
      <div v-if="opened" class="pet-conversation-picker__drawer">
        <div class="pet-conversation-picker__caption">
          <span>{{ tr(opened === 'agents' ? '切换角色' : '切换会话') }}</span>
          <PetHudIcon name="sparkle" size="xs" />
        </div>
        <div
          ref="list"
          class="pet-conversation-picker__list"
          :class="{ 'is-agents': opened === 'agents' }"
        >
          <template v-if="opened === 'agents'">
            <button
              v-for="agent in agents"
              :key="agent.id"
              type="button"
              :disabled="blocked"
              :aria-pressed="agent.id === agentId"
              @click="choose(agent.id)"
            >
              <img v-if="avatar(agent)" :src="avatar(agent)" alt="" />
              <PetHudIcon v-else name="heart" size="sm" />
              <span>{{ agent.name }}</span>
              <PetHudIcon v-if="agent.id === agentId" name="check" size="xs" />
            </button>
          </template>
          <template v-else>
            <MainThreadCard
              v-if="mainThread"
              class="pet-conversation-picker__main"
              compact
              :active="mainThread.id === threadId"
              :disabled="blocked"
              @select="mainThread && choose(mainThread.id)"
            />
            <button
              v-for="thread in sideThreads"
              :key="thread.id"
              type="button"
              :disabled="blocked"
              :aria-pressed="thread.id === threadId"
              @click="choose(thread.id)"
            >
              <PetHudIcon name="chat" size="xs" />
              <span class="pet-conversation-picker__summary">
                <strong>{{ threadDisplayName(thread) }}</strong>
                <small>
                  {{ tr('{0} 条消息', [thread.messageCount]) }}
                  <time>{{ date(thread) }}</time>
                </small>
              </span>
              <PetHudIcon v-if="thread.id === threadId" name="check" size="xs" />
            </button>
          </template>
        </div>
        <div
          v-if="loading || failed || (opened === 'agents' ? !agents.length : !threads.length)"
          class="pet-conversation-picker__status"
          role="status"
        >
          <PetHudIcon :name="failed ? 'alert' : loading ? 'clock' : 'chat'" size="xs" />
          <span>
            {{
              tr(
                loading
                  ? '加载中…'
                  : failed
                    ? '加载失败'
                    : opened === 'agents'
                      ? '暂无其他角色'
                      : '暂无会话',
              )
            }}
          </span>
          <button v-if="failed" type="button" :disabled="loading" @click="load()">
            {{ tr('重试') }}
          </button>
        </div>
        <button
          v-else-if="opened === 'threads' && page * 20 < total"
          type="button"
          class="pet-conversation-picker__more"
          @click="load(true)"
        >
          {{ tr('更多会话') }}
          <PetHudIcon name="chevron-down" size="xs" />
        </button>
      </div>
    </Transition>
    <span v-if="blocked" class="pet-conversation-picker__switching" role="status">
      <i />
      {{ tr('切换中…') }}
    </span>
    <span v-else-if="selectionError" class="pet-conversation-picker__error" role="alert">
      <PetHudIcon name="alert" size="xs" />
      {{ tr(selectionError) }}
    </span>
  </div>
</template>

<style scoped src="./pet-conversation-picker.css" />
