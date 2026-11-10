<script setup lang="ts">
import { t as __t } from '../../i18n/index'

/**
 * WorkspaceSessionDrawer — 会话切换抽屉
 *
 * 点击右侧 Agent 协作栏顶部「与 xxx 协作」或收起态角色图标时，从右侧滑入。
 * 会话按 Agent 分组排版，点击即可切换当前会话；切换逻辑与对话 Tab 完全一致。
 */
import { ref, watch } from 'vue'
import { PixelIcon } from '../pixel'
import MotionList from '../motion/MotionList.vue'
import MotionSkeleton from '../motion/MotionSkeleton.vue'
import MainThreadCard from '../chat/MainThreadCard.vue'
import { threadDisplayName } from '../../utils/threadPresentation'
import { threadsApi, type ThreadInfo } from '../../api/modules/threadsApi'
import { useAgentStore, useThreadStore, useNotificationStore } from '../../stores'
import { getApiBaseUrl } from '../../api/transport'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ 'update:open': [value: boolean] }>()

const agentStore = useAgentStore()
const threadStore = useThreadStore()
const notify = useNotificationStore()

interface AgentThreadGroup {
  agent: { id: string; name: string; avatarUrl?: string }
  threads: ThreadInfo[]
  mainThread?: ThreadInfo
}

const groups = ref<AgentThreadGroup[]>([])
const isLoading = ref(false)
/** 切换/新建锁：进行中禁止再次触发，避免并发请求竞态。 */
const isSwitching = ref(false)
/** 请求序号：每次切换/新建递增，用于丢弃过期的异步响应。 */
let switchGeneration = 0

function avatarUrlOf(agent: { avatarUrl?: string }): string {
  return agent.avatarUrl ? `${getApiBaseUrl()}${agent.avatarUrl}` : ''
}

/** 相对时间格式化，与对话 Tab 保持一致。 */
function formatTime(iso: string | null): string {
  if (!iso) return ''
  const date = new Date(iso)
  const diffMs = Date.now() - date.getTime()
  const mins = Math.floor(diffMs / 60000)
  if (mins < 1) return __t('ui.workspace', '刚刚')
  if (mins < 60) return __t('ui.workspace', '{0}分钟前', [mins])
  const hours = Math.floor(mins / 60)
  if (hours < 24) return __t('ui.workspace', '{0}小时前', [hours])
  const days = Math.floor(hours / 24)
  if (days < 7) return __t('ui.workspace', '{0}天前', [days])
  return `${date.getMonth() + 1}/${date.getDate()}`
}

/** 按 Agent 分组拉取 desktop 会话列表。 */
async function loadGroups(): Promise<void> {
  if (!props.open) return
  isLoading.value = true
  try {
    if (!agentStore.agents.length) await agentStore.fetchAgents()
    const loaded: AgentThreadGroup[] = await Promise.all(
      agentStore.agents.map(async (agent) => {
        try {
          const res = await threadsApi.list({ agentId: agent.id, channel: 'desktop', pageSize: 20 })
          const items = res.data?.items ?? []
          return {
            agent,
            mainThread: items.find((thread) => thread.threadKind === 'main'),
            threads: items.filter((thread) => thread.threadKind !== 'main'),
          }
        } catch {
          return { agent, threads: [] }
        }
      }),
    )
    // 只展示有会话的角色；若当前角色确实没有会话，仍保留其分组以便新建。
    groups.value = loaded.filter(
      (group) => group.mainThread || group.threads.length > 0 || group.agent.id === agentStore.activeAgentId,
    )
  } finally {
    isLoading.value = false
  }
}

/** 切换会话：与对话 Tab 同一套 threadStore 逻辑，聊天区会自动联动刷新。 */
async function selectThread(agentId: string, thread: ThreadInfo): Promise<void> {
  if (isSwitching.value) return // 已有切换进行中，忽略重复点击
  const generation = ++switchGeneration
  isSwitching.value = true
  try {
    // 先加载目标会话消息（threadsApi.get 与角色无关），再切换角色。
    // 这样 ChatContainer 的 watch 触发时 threadId 已就位，走 loadThreadMessages 而非 loadLatestHistory，避免竞态覆盖。
    await threadStore.loadThreadMessages(thread.id, agentId)
    if (generation !== switchGeneration) return // 已被更新的操作取代，丢弃过期响应
    if (agentStore.activeAgentId !== agentId) await agentStore.switchAgent(agentId)
    if (generation !== switchGeneration) return
    notify.toast(
      __t('ui.workspace', '已切换到「{0}」', [threadDisplayName(thread)]),
      { type: 'success' },
    )
    emit('update:open', false)
  } catch (error) {
    notify.toast(error instanceof Error ? error.message : __t('ui.workspace', '切换会话失败'), {
      type: 'error',
    })
  } finally {
    if (generation === switchGeneration) isSwitching.value = false
  }
}

/** 为指定角色新建 desktop 会话并立即进入。 */
async function createThread(agentId: string): Promise<void> {
  if (isSwitching.value) return
  const generation = ++switchGeneration
  isSwitching.value = true
  try {
    // 先创建并切换到新 thread，再切角色，保持与 selectThread 相同的先后顺序。
    await threadStore.createNewThread(agentId, 'desktop')
    if (generation !== switchGeneration) return
    if (agentStore.activeAgentId !== agentId) await agentStore.switchAgent(agentId)
    if (generation !== switchGeneration) return
    emit('update:open', false)
  } catch (error) {
    notify.toast(error instanceof Error ? error.message : __t('ui.workspace', '新建会话失败'), {
      type: 'error',
    })
  } finally {
    if (generation === switchGeneration) isSwitching.value = false
  }
}

function close(): void {
  emit('update:open', false)
}

watch(
  () => props.open,
  (open) => {
    if (open) void loadGroups()
  },
)
</script>

<template>
  <Teleport to="body">
    <Transition name="drawer">
      <div v-if="open" class="session-drawer-layer" @click.self="close">
        <aside class="session-drawer" role="dialog" :aria-label="__t('ui.workspace', '切换会话')">
          <header class="session-drawer__header">
            <div class="session-drawer__title">
              <PixelIcon name="chat" size="sm" />
              <strong>{{ __t('ui.workspace', '切换会话') }}</strong>
              <span>SESSION SWITCHER</span>
            </div>
            <button :title="__t('ui.workspace', '关闭')" @click="close">
              <PixelIcon name="close" size="sm" />
            </button>
          </header>

          <div class="session-drawer__body">
            <MotionSkeleton
              v-if="isLoading"
              variant="list"
              :rows="4"
              :label="__t('ui.workspace', '正在加载会话…')"
            />

            <section v-for="group in groups" :key="group.agent.id" class="agent-group">
              <header class="agent-group__header">
                <span class="agent-group__avatar">
                  <img
                    v-if="avatarUrlOf(group.agent)"
                    :src="avatarUrlOf(group.agent)"
                    :alt="group.agent.name"
                  />
                  <span v-else>{{ group.agent.name.charAt(0).toUpperCase() }}</span>
                </span>
                <strong>{{ group.agent.name }}</strong>
                <i>{{ group.threads.length + (group.mainThread ? 1 : 0) }}</i>
                <button
                  :title="__t('ui.workspace', '新建会话')"
                  :disabled="isSwitching"
                  @click="createThread(group.agent.id)"
                >
                  <PixelIcon name="plus" size="xs" />
                </button>
              </header>

              <MainThreadCard
                v-if="group.mainThread"
                class="agent-group__main"
                compact
                :active="threadStore.threadId === group.mainThread.id && group.agent.id === agentStore.activeAgentId"
                :disabled="isSwitching"
                @select="group.mainThread && selectThread(group.agent.id, group.mainThread)"
              />
              <MotionList v-if="group.threads.length" class="agent-group__threads">
                <button
                  v-for="thread in group.threads"
                  :key="thread.id"
                  class="thread-item"
                  :disabled="isSwitching"
                  :class="{
                    'thread-item--active':
                      threadStore.threadId === thread.id &&
                      group.agent.id === agentStore.activeAgentId,
                  }"
                  @click="selectThread(group.agent.id, thread)"
                >
                  <span class="thread-item__title">
                    {{ threadDisplayName(thread) }}
                  </span>
                  <span class="thread-item__meta">
                    <span>{{ thread.messageCount }} {{ __t('ui.workspace', '条消息') }}</span>
                    <span>{{ formatTime(thread.lastMessageAt) }}</span>
                  </span>
                </button>
              </MotionList>
              <p v-else-if="!group.mainThread" class="agent-group__empty">
                {{ __t('ui.workspace', '暂无会话，点击「+」新建') }}
              </p>
            </section>

            <p v-if="!isLoading && !groups.length" class="session-drawer__empty">
              {{ __t('ui.workspace', '还没有任何会话') }}
            </p>
          </div>
        </aside>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* 遮罩铺满视口，但卡片通过 padding 留出顶部安全边距，避免顶到 Electron 标题栏。 */
.session-drawer-layer {
  position: fixed;
  inset: 0;
  z-index: var(--ui-z-modal);
  display: flex;
  justify-content: flex-end;
  align-items: flex-start;
  padding: 56px 20px 20px;
  background: var(--ui-overlay-backdrop);
  backdrop-filter: blur(var(--ui-overlay-blur));
}

.session-drawer {
  display: flex;
  width: min(420px, calc(100vw - 40px));
  height: 100%;
  max-height: calc(100vh - 76px);
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--ui-border-default);
  border-radius: var(--ui-radius-xl);
  background: var(--ui-bg-surface);
  box-shadow: var(--ui-shadow-panel);
}

.session-drawer__header {
  display: flex;
  min-height: 56px;
  flex-shrink: 0;
  align-items: center;
  justify-content: space-between;
  padding: 0 14px;
  border-bottom: 1px solid var(--ui-border-subtle);
  background: var(--ui-bg-elevated);
}

.session-drawer__title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  color: var(--ui-accent-primary);
}
.session-drawer__title strong {
  color: var(--ui-text-primary);
  font-size: 14px;
}
.session-drawer__title span {
  color: var(--ui-text-tertiary);
  font: 700 8px var(--ui-font-mono);
  letter-spacing: 0.1em;
}

.session-drawer__header > button {
  display: grid;
  width: 30px;
  height: 30px;
  place-items: center;
  border: 1px solid transparent;
  border-radius: var(--ui-radius-sm);
  background: transparent;
  color: var(--ui-text-tertiary);
  cursor: pointer;
}
.session-drawer__header > button:hover {
  border-color: var(--ui-border-default);
  background: var(--ui-bg-hover);
  color: var(--ui-accent-primary);
}

.session-drawer__body {
  min-height: 0;
  flex: 1;
  overflow-y: auto;
  padding: 12px;
}

.session-drawer__loading,
.session-drawer__empty {
  display: flex;
  min-height: 160px;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 10px;
  color: var(--ui-text-tertiary);
  font-size: 11px;
}

.agent-group {
  margin-bottom: 14px;
}
.agent-group__header {
  display: flex;
  min-height: 38px;
  align-items: center;
  gap: 8px;
  padding: 4px 6px 6px;
}
.agent-group__avatar {
  display: grid;
  width: 26px;
  height: 26px;
  flex-shrink: 0;
  place-items: center;
  overflow: hidden;
  border: 1px solid var(--ui-border-subtle);
  border-radius: var(--ui-radius-sm);
  background: linear-gradient(135deg, var(--ui-accent-primary-soft), var(--ui-accent-purple-soft));
  color: var(--ui-accent-primary);
  font-family: var(--ui-font-pixel);
  font-weight: 900;
}
.agent-group__avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.agent-group__header strong {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  color: var(--ui-text-primary);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.agent-group__header i {
  display: grid;
  min-width: 18px;
  height: 18px;
  place-items: center;
  border-radius: 9px;
  background: var(--ui-bg-hover);
  color: var(--ui-text-secondary);
  font-size: 9px;
  font-style: normal;
}
.agent-group__header > button {
  display: grid;
  width: 26px;
  height: 26px;
  place-items: center;
  border: 1px solid transparent;
  border-radius: var(--ui-radius-xs);
  background: transparent;
  color: var(--ui-text-tertiary);
  cursor: pointer;
}
.agent-group__header > button:hover {
  border-color: var(--ui-border-default);
  background: var(--ui-bg-hover);
  color: var(--ui-accent-sky);
}

.agent-group__main {
  margin-bottom: 8px;
}
.agent-group__threads {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.thread-item {
  display: flex;
  min-height: 44px;
  flex-direction: column;
  justify-content: center;
  gap: 3px;
  padding: 6px 10px;
  border: 1px solid transparent;
  border-radius: var(--ui-radius-sm);
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.thread-item:hover {
  border-color: var(--ui-border-subtle);
  background: var(--ui-bg-hover);
}
.thread-item--active {
  border-color: color-mix(in srgb, var(--ui-accent-sky) 22%, var(--ui-border-subtle));
  background: var(--ui-accent-sky-soft);
}
.thread-item__title {
  overflow: hidden;
  color: var(--ui-text-primary);
  font-size: 12px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.thread-item--active .thread-item__title {
  color: var(--ui-accent-sky);
}
.thread-item__meta {
  display: flex;
  gap: 10px;
  color: var(--ui-text-tertiary);
  font-size: 9px;
}
.agent-group__empty {
  margin: 0;
  padding: 10px;
  color: var(--ui-text-tertiary);
  font-size: 10px;
}

/* 切换/新建进行中：锁定所有会话操作，防止并发竞态。 */
.thread-item:disabled,
.agent-group__header > button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.thread-item:disabled:hover,
.agent-group__header > button:disabled:hover {
  border-color: transparent;
  background: transparent;
}

/* 抽屉滑入动效 */
.drawer-enter-active,
.drawer-leave-active {
  transition: opacity var(--ui-duration-panel) var(--ui-ease-emphasized);
}
.drawer-enter-active .session-drawer,
.drawer-leave-active .session-drawer {
  transition: transform var(--ui-duration-panel) var(--ui-ease-emphasized);
}
.drawer-enter-from,
.drawer-leave-to {
  opacity: 0;
}
.drawer-enter-from .session-drawer,
.drawer-leave-to .session-drawer {
  /* 多滑出右侧 padding 距离，保证卡片完全移出视口再淡出 */
  transform: translateX(calc(100% + 20px));
}
</style>
