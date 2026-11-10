<script setup lang="ts">
import { t as __t } from '../../../i18n/index'

/**
 * StrongholdTab — 据点 Tab (重制版)
 *
 * 三栏空间结构:
 * - 左侧: 「我的据点」品牌头 + 房间导航
 * - 中间: 房间工作台 (房间概况 + 环境状态 + 据点聊天)
 * - 右侧: 成员雷达 (本房间成员 + 据点居民 + 管家)
 *
 * 设计语言: Arc 现代骨架 + 像素萌系品牌细节
 * - 中性色骨架, 品牌色仅用于选中态与头像
 * - 成员展示真实名字与角色头像, 不再使用裸 agentId
 *
 * @see .docs/S06_UI_UX_DESIGN_SPEC.md §13.6
 */
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useMobileLayout } from '../../../composables/ui/useMobileLayout'
import { PixelIcon, PButton, PDialog } from '../../pixel'
import HistoryExportDialog from '../../chat/HistoryExportDialog.vue'
import StrongholdChat from '../../stronghold/StrongholdChat.vue'
import { useStronghold } from '../../../composables/useStronghold'
import type { Room } from '../../../api/modules/strongholdApi'
import { strongholdApi } from '../../../api/modules/strongholdApi'
import {
  buildStrongholdMarkdown,
  downloadMarkdown,
  type HistoryExportOptions,
} from '../../../utils/historyExport'
import { useNotificationStore } from '../../../stores/useNotificationStore'

defineOptions({ name: 'StrongholdTab' })

const notification = useNotificationStore()
const showHistoryExport = ref(false)
const isExportingHistory = ref(false)

const {
  facilities,
  rooms,
  currentFacility,
  currentRoom,
  isLoading,
  agentsStatus,
  agentProfiles,
  currentRoomAgents,
  messages,
  isLoadingMessages,
  isSendingMessage,
  isAwaitingReply,
  activeRound,
  replyStatus,
  selectFacility,
  selectRoom,
  sendMessage,
  deleteMessage,
  callButler,
} = useStronghold()

async function exportCurrentHistory(_options: HistoryExportOptions): Promise<void> {
  if (!currentRoom.value) return
  isExportingHistory.value = true
  try {
    const response = await strongholdApi.getProjection(currentRoom.value.id, 1000)
    if (!response.data) throw new Error('服务端未返回据点房间历史')
    const participantNames = Object.fromEntries(
      [...agentProfiles.value].map(([agentId, profile]) => [agentId, profile.name]),
    )
    const title = __t('ui.navigation', '{0}-据点历史', [currentRoom.value.name])
    downloadMarkdown(
      title,
      buildStrongholdMarkdown({
        title,
        participantNames,
        messages: response.data.messages,
      }),
    )
    showHistoryExport.value = false
    notification.toast(__t('ui.navigation', '据点房间历史已导出到客户端'), { type: 'success' })
  } catch (error) {
    notification.toast(
      error instanceof Error ? error.message : __t('ui.navigation', '历史记录导出失败'),
      {
        type: 'error',
      },
    )
  } finally {
    isExportingHistory.value = false
  }
}

// ── 侧边栏收起状态 ──

const { isMobile } = useMobileLayout()
const isLeftCollapsed = ref(isMobile.value)
const isRightCollapsed = ref(isMobile.value)
function dismissMobilePanels() {
  isLeftCollapsed.value = true
  isRightCollapsed.value = true
}
function selectMobileRoom(room: Room) {
  selectRoom(room)
  if (isMobile.value) isLeftCollapsed.value = true
}
watch(isMobile, (value) => {
  if (value) {
    isLeftCollapsed.value = true
    isRightCollapsed.value = true
  }
})
watch(currentRoom, () => {
  if (isMobile.value) isLeftCollapsed.value = true
})
function closeMobilePanels(event: KeyboardEvent) {
  if (isMobile.value && event.key === 'Escape') {
    isLeftCollapsed.value = true
    isRightCollapsed.value = true
  }
}
onMounted(() => window.addEventListener('keydown', closeMobilePanels))
onBeforeUnmount(() => window.removeEventListener('keydown', closeMobilePanels))

function toggleLeft(): void {
  isLeftCollapsed.value = !isLeftCollapsed.value
  if (isMobile.value) isRightCollapsed.value = true
}

function toggleRight(): void {
  isRightCollapsed.value = !isRightCollapsed.value
  if (isMobile.value) isLeftCollapsed.value = true
}

// ── 房间环境变量 ──

/** 环境变量图标映射 (据点房间默认环境字段) */
const ENV_ICONS: Record<string, string> = {
  光照: 'sun',
  温度: 'fire',
  音乐: 'music',
  清洁度: 'sparkle',
}

interface EnvChip {
  key: string
  value: string
  icon: string
}

/** 解析房间环境变量为 chip 列表 (解析失败时静默回退为空) */
const roomEnvChips = computed<EnvChip[]>(() => {
  const raw = currentRoom.value?.environmentJson
  if (!raw) return []
  try {
    const env = JSON.parse(raw) as Record<string, unknown>
    return Object.entries(env).map(([key, value]) => ({
      key,
      value: String(value),
      icon: ENV_ICONS[key] ?? 'star',
    }))
  } catch {
    return []
  }
})

// ── 成员头像堆叠 (房间头部) ──

/** 头部最多展示的头像数 */
const HEADER_MEMBER_LIMIT = 4

const headerMemberStack = computed(() => currentRoomAgents.value.slice(0, HEADER_MEMBER_LIMIT))
const headerMemberOverflow = computed(() =>
  Math.max(0, currentRoomAgents.value.length - HEADER_MEMBER_LIMIT),
)

// ── 房间成员数 ──

/** 获取房间当前成员数 */
function roomAgentCount(room: Room): number {
  return room.agents?.length ?? 0
}

// ── @ 提及候选（当前房间在场的成员，供 CHAR OPS @ 弹窗选人） ──

const mentionCandidates = computed(() =>
  currentRoomAgents.value.map((agent) => ({
    agentId: agent.agentId,
    name: agent.name,
    avatarUrl: agent.avatarUrl,
  })),
)

// ── 管家弹窗 ──

const showButler = ref(false)
const butlerQuery = ref('')
const isCalling = ref(false)

/** 快捷指令 (对应 ButlerService 的自然语言映射) */
const shortcuts = [
  {
    get label() {
      return __t('ui.navigation', '查看状态')
    },
    cmd: '查看当前据点状态',
  },
  {
    get label() {
      return __t('ui.navigation', '召唤全员')
    },
    cmd: '把所有成员叫到这里来',
  },
  {
    get label() {
      return __t('ui.navigation', '检查环境')
    },
    cmd: '扫描当前房间环境',
  },
]

function applyShortcut(cmd: string): void {
  butlerQuery.value = cmd
}

/** 召唤指定成员: 自动填入管家指令并打开弹窗 */
function summonAgent(name: string): void {
  butlerQuery.value = `把 ${name} 叫到这里来`
  showButler.value = true
}

function openButler(): void {
  showButler.value = true
  butlerQuery.value = ''
}

async function submitButler(): Promise<void> {
  if (!butlerQuery.value.trim()) return
  isCalling.value = true
  try {
    await callButler(butlerQuery.value)
  } finally {
    showButler.value = false
    butlerQuery.value = ''
    isCalling.value = false
  }
}
</script>

<template>
  <div class="stronghold-tab-root">
    <!-- 一体化面板容器 -->
    <div class="stronghold-panel">
      <nav v-if="isMobile" class="sh-mobile-toolbar" :aria-label="__t('ui.navigation', '据点面板')">
        <button :aria-expanded="!isLeftCollapsed" @click="toggleLeft">
          {{ __t('ui.navigation', '房间') }}
        </button>
        <span>{{ currentRoom?.name || __t('ui.navigation', '选择房间') }}</span>
        <button :aria-expanded="!isRightCollapsed" @click="toggleRight">
          {{ __t('ui.navigation', '成员') }}
        </button>
      </nav>
      <button
        v-if="isMobile && (!isLeftCollapsed || !isRightCollapsed)"
        class="sh-mobile-backdrop"
        :aria-label="__t('ui.navigation', '关闭据点面板')"
        @click="dismissMobilePanels"
      />
      <!-- ═══ 左侧: 据点品牌头 + 房间导航 ═══ -->
      <aside class="sh-left" :class="{ 'sh-left--collapsed': isLeftCollapsed }">
        <button
          class="sh-toggle sh-toggle-left"
          :title="
            isLeftCollapsed
              ? __t('ui.navigation', '展开房间导航')
              : __t('ui.navigation', '收起房间导航')
          "
          @click="toggleLeft"
        >
          <PixelIcon :name="isLeftCollapsed ? 'chevron-right' : 'chevron-left'" size="xs" />
        </button>

        <template v-if="!isLeftCollapsed">
          <!-- 品牌头: 「我的据点」入口 -->
          <div class="sh-brand">
            <!-- 据点徽章: 异形五边形 + 组合几何堡垒 -->
            <svg
              class="sh-brand-mark"
              viewBox="0 0 48 48"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden="true"
            >
              <defs>
                <linearGradient id="sh-brand-grad" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0" stop-color="var(--sh-brand-grad-a)" />
                  <stop offset="1" stop-color="var(--sh-brand-grad-b)" />
                </linearGradient>
              </defs>
              <!-- 像素描边: 外层五边形 -->
              <path
                d="M24 2 L44.92 17.2 L36.93 41.8 L11.07 41.8 L3.08 17.2 Z"
                fill="var(--sh-brand-frame)"
              />
              <!-- 渐变主体: 内层五边形 + 高光描边 -->
              <path
                d="M24 6 L41.15 18.42 L34.6 38.6 L13.4 38.6 L6.85 18.42 Z"
                fill="url(#sh-brand-grad)"
              />
              <path
                d="M24 6 L41.15 18.42 L34.6 38.6 L13.4 38.6 L6.85 18.42 Z"
                stroke="var(--sh-brand-glow-line)"
                stroke-width="0.7"
                opacity="0.5"
                fill="none"
              />
              <!-- 内嵌图案: 屋顶 + 房体 + 门 -->
              <path
                d="M16.4 24.4 L31.6 24.4 L24 13.4 Z"
                fill="var(--sh-brand-glyph)"
                opacity="0.95"
              />
              <rect
                x="16.4"
                y="24.4"
                width="15.2"
                height="10"
                fill="var(--sh-brand-glyph)"
                opacity="0.95"
              />
              <rect
                x="22.1"
                y="27.6"
                width="3.8"
                height="6.8"
                rx="1.9"
                fill="var(--sh-brand-door)"
              />
              <!-- 星钻点缀 -->
              <path
                d="M33.2 7.4 L35.2 10.9 L38.7 12.9 L35.2 14.9 L33.2 18.4 L31.2 14.9 L27.7 12.9 L31.2 10.9 Z"
                fill="var(--sh-brand-gem)"
              />
            </svg>
            <div class="sh-brand-text">
              <h2 class="sh-brand-title">
                {{ currentFacility?.name ?? __t('ui.navigation', '我的据点') }}
              </h2>
              <span class="sh-brand-sub">HOME BASE · STRONGHOLD</span>
            </div>
          </div>

          <!-- 多设施选择器 (仅当存在多个设施时显示) -->
          <div v-if="facilities.length > 1" class="sh-fac-selector">
            <button
              v-for="fac in facilities"
              :key="fac.id"
              class="sh-fac-chip"
              :class="{ 'sh-fac-chip--active': currentFacility?.id === fac.id }"
              :title="fac.name"
              @click="selectFacility(fac)"
            >
              {{ fac.name }}
            </button>
          </div>

          <!-- 房间列表 -->
          <div class="sh-rooms">
            <div class="sh-rooms-header">
              <span class="sh-rooms-title">{{ __t('ui.navigation', '房间') }}</span>
              <span class="sh-rooms-title-en">ROOMS</span>
            </div>

            <div v-if="isLoading" class="sh-loading">
              <PixelIcon name="refresh" size="md" animation="spin" />
              <span>{{ __t('ui.navigation', '正在巡视据点...') }}</span>
            </div>

            <template v-else>
              <button
                v-for="room in rooms"
                :key="room.id"
                class="sh-room"
                :class="{ 'sh-room--active': currentRoom?.id === room.id }"
                @click="selectMobileRoom(room)"
              >
                <div
                  class="sh-room-icon"
                  :class="{ 'sh-room-icon--active': currentRoom?.id === room.id }"
                >
                  <PixelIcon
                    :name="currentRoom?.id === room.id ? 'door-open' : 'door-closed'"
                    size="sm"
                  />
                </div>
                <div class="sh-room-info">
                  <span class="sh-room-name">{{ room.name }}</span>
                  <span class="sh-room-desc">
                    {{ room.description || __t('ui.navigation', '这里还没有留下说明') }}
                  </span>
                </div>
                <span v-if="roomAgentCount(room) > 0" class="sh-room-count">
                  {{ roomAgentCount(room) }}
                </span>
              </button>

              <div v-if="rooms.length === 0" class="sh-empty-rooms">
                <PixelIcon name="paw" size="md" />
                <span>{{ __t('ui.navigation', '据点还没有房间喵～') }}</span>
              </div>
            </template>
          </div>
        </template>

        <!-- 收起态: 只显示房间图标 -->
        <template v-else>
          <div class="sh-collapsed-rooms">
            <div
              class="sh-collapsed-brand"
              :title="currentFacility?.name ?? __t('ui.navigation', '我的据点')"
            >
              <!-- 迷你五边形据点徽章 -->
              <svg
                class="sh-brand-mark--sm"
                viewBox="0 0 48 48"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                aria-hidden="true"
              >
                <defs>
                  <linearGradient id="sh-brand-grad-sm" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0" stop-color="var(--sh-brand-grad-a)" />
                    <stop offset="1" stop-color="var(--sh-brand-grad-b)" />
                  </linearGradient>
                </defs>
                <path
                  d="M24 2 L44.92 17.2 L36.93 41.8 L11.07 41.8 L3.08 17.2 Z"
                  fill="var(--sh-brand-frame)"
                />
                <path
                  d="M24 6 L41.15 18.42 L34.6 38.6 L13.4 38.6 L6.85 18.42 Z"
                  fill="url(#sh-brand-grad-sm)"
                />
                <path
                  d="M16.4 24.4 L31.6 24.4 L24 13.4 Z"
                  fill="var(--sh-brand-glyph)"
                  opacity="0.95"
                />
                <rect
                  x="16.4"
                  y="24.4"
                  width="15.2"
                  height="10"
                  fill="var(--sh-brand-glyph)"
                  opacity="0.95"
                />
                <rect
                  x="22.1"
                  y="27.6"
                  width="3.8"
                  height="6.8"
                  rx="1.9"
                  fill="var(--sh-brand-door)"
                />
              </svg>
            </div>
            <button
              v-for="room in rooms"
              :key="room.id"
              class="sh-collapsed-room"
              :class="{ 'sh-collapsed-room--active': currentRoom?.id === room.id }"
              :title="room.name"
              @click="selectMobileRoom(room)"
            >
              <PixelIcon
                :name="currentRoom?.id === room.id ? 'door-open' : 'door-closed'"
                size="sm"
              />
            </button>
          </div>
        </template>
      </aside>

      <!-- ═══ 中间: 房间工作台 ═══ -->
      <main class="sh-main" :inert="isMobile && (!isLeftCollapsed || !isRightCollapsed)">
        <template v-if="currentRoom">
          <!-- 房间概况头 -->
          <header class="sh-main-header">
            <div class="sh-main-room">
              <div class="sh-main-room-icon">
                <PixelIcon name="door-open" size="sm" />
              </div>
              <div class="sh-main-room-text">
                <h1 class="sh-main-room-name">
                  {{ currentRoom.name }}
                  <span v-if="currentFacility" class="sh-main-fac-badge">
                    {{ currentFacility.name }}
                  </span>
                </h1>
                <p class="sh-main-room-desc">
                  {{ currentRoom.description || __t('ui.navigation', '这里是据点的一个房间') }}
                </p>
              </div>
            </div>

            <div class="sh-main-aside">
              <PButton
                variant="ghost"
                size="sm"
                :disabled="messages.length === 0"
                :title="__t('ui.navigation', '导出当前房间历史')"
                @click="showHistoryExport = true"
              >
                <PixelIcon name="download" size="xs" />
                {{ __t('ui.navigation', '导出') }}
              </PButton>
              <!-- 环境状态 chips -->
              <div v-if="roomEnvChips.length > 0" class="sh-env-chips">
                <span
                  v-for="chip in roomEnvChips"
                  :key="chip.key"
                  class="sh-env-chip"
                  :title="`${chip.key}: ${chip.value}`"
                >
                  <PixelIcon :name="chip.icon" size="xs" />
                  <span class="sh-env-chip-value">{{ chip.value }}</span>
                </span>
              </div>

              <!-- 在场成员头像堆叠 -->
              <div v-if="currentRoomAgents.length > 0" class="sh-member-stack">
                <span
                  v-for="agent in headerMemberStack"
                  :key="agent.agentId"
                  class="sh-member-face"
                  :title="__t('ui.navigation', '{0} · 在本房间', [agent.name])"
                >
                  <img v-if="agent.avatarUrl" :src="agent.avatarUrl" :alt="agent.name" />
                  <span v-else class="sh-member-face-fallback">{{ agent.name[0] }}</span>
                </span>
                <span v-if="headerMemberOverflow > 0" class="sh-member-face sh-member-face--more">
                  +{{ headerMemberOverflow }}
                </span>
              </div>
            </div>
          </header>

          <!-- 聊天区 -->
          <div class="sh-main-chat">
            <StrongholdChat
              :key="currentRoom.id"
              :messages="messages"
              :profiles="agentProfiles"
              :mention-candidates="mentionCandidates"
              :is-loading="isLoadingMessages"
              :is-sending="isSendingMessage"
              :is-awaiting-reply="isAwaitingReply"
              :round-state="activeRound"
              :reply-status="replyStatus"
              :participant-count="currentRoomAgents.length"
              :room-name="currentRoom.name"
              :room-id="currentRoom.id"
              @send="sendMessage"
              @delete="deleteMessage"
            />
          </div>
        </template>

        <!-- 未选择房间 -->
        <div v-else class="sh-empty">
          <div class="sh-empty-icon">
            <PixelIcon name="home" size="3xl" />
          </div>
          <h3 class="sh-empty-title">{{ __t('ui.navigation', '请选择一个房间') }}</h3>
          <p class="sh-empty-sub">
            {{ __t('ui.navigation', '从左侧房间导航中选择要去的地方，和角色们聊聊吧') }}
          </p>
        </div>
      </main>

      <!-- ═══ 右侧: 成员雷达 ═══ -->
      <aside class="sh-right" :class="{ 'sh-right--collapsed': isRightCollapsed }">
        <button
          class="sh-toggle sh-toggle-right"
          :title="
            isRightCollapsed
              ? __t('ui.navigation', '展开成员雷达')
              : __t('ui.navigation', '收起成员雷达')
          "
          @click="toggleRight"
        >
          <PixelIcon :name="isRightCollapsed ? 'chevron-left' : 'chevron-right'" size="xs" />
        </button>

        <template v-if="!isRightCollapsed">
          <div class="sh-right-header">
            <div class="sh-right-title-wrap">
              <span class="sh-right-title">{{ __t('ui.navigation', '成员态势') }}</span>
              <span class="sh-right-title-en">MEMBERS</span>
            </div>
            <div class="sh-butler-call-btn">
              <PButton variant="primary" size="sm" @click="openButler">
                <PixelIcon name="bot" size="xs" />
                {{ __t('ui.navigation', '呼叫管家') }}
              </PButton>
            </div>
          </div>

          <div class="sh-right-body">
            <!-- 本房间成员 -->
            <section class="sh-section">
              <div class="sh-section-header">
                <span class="sh-section-title">{{ __t('ui.navigation', '本房间') }}</span>
                <span class="sh-section-count">
                  {{ currentRoomAgents.length }} {{ __t('ui.navigation', '位') }}
                </span>
              </div>
              <div v-if="currentRoomAgents.length > 0" class="sh-roommates">
                <div v-for="agent in currentRoomAgents" :key="agent.agentId" class="sh-roommate">
                  <div class="sh-avatar">
                    <img v-if="agent.avatarUrl" :src="agent.avatarUrl" :alt="agent.name" />
                    <span v-else class="sh-avatar-fallback">{{ agent.name[0] }}</span>
                    <span class="sh-avatar-dot" />
                  </div>
                  <div class="sh-roommate-info">
                    <span class="sh-roommate-name">{{ agent.name }}</span>
                    <span class="sh-roommate-status">{{ __t('ui.navigation', '在本房间') }}</span>
                  </div>
                </div>
              </div>
              <div v-else class="sh-empty-agents">
                <PixelIcon name="paw" size="sm" />
                <span>{{ __t('ui.navigation', '这个房间还没人哦') }}</span>
              </div>
            </section>

            <!-- 据点全部居民 -->
            <section class="sh-section">
              <div class="sh-section-header">
                <span class="sh-section-title">{{ __t('ui.navigation', '据点居民') }}</span>
                <span class="sh-section-count sh-section-count--all">
                  {{ agentsStatus.length }} {{ __t('ui.navigation', '位') }}
                </span>
              </div>
              <div class="sh-residents">
                <button
                  v-for="agent in agentsStatus"
                  :key="agent.agentId"
                  class="sh-resident"
                  :title="__t('ui.navigation', '召唤 {0} 到当前房间', [agent.name])"
                  @click="summonAgent(agent.name)"
                >
                  <div class="sh-avatar sh-avatar--sm">
                    <img v-if="agent.avatarUrl" :src="agent.avatarUrl" :alt="agent.name" />
                    <span v-else class="sh-avatar-fallback">{{ agent.name[0] }}</span>
                  </div>
                  <div class="sh-resident-info">
                    <span class="sh-resident-name">{{ agent.name }}</span>
                    <span class="sh-resident-loc">
                      {{ __t('ui.navigation', '在') }} {{ agent.roomName }}
                    </span>
                  </div>
                  <PixelIcon name="send" size="xs" class="sh-resident-summon" />
                </button>
              </div>
            </section>
          </div>
        </template>

        <!-- 收起态: 只显示成员头像 -->
        <template v-else>
          <div class="sh-collapsed-members">
            <div
              v-for="agent in currentRoomAgents.slice(0, 5)"
              :key="agent.agentId"
              class="sh-collapsed-member"
              :title="agent.name"
            >
              <img v-if="agent.avatarUrl" :src="agent.avatarUrl" :alt="agent.name" />
              <span v-else>{{ agent.name[0] }}</span>
            </div>
          </div>
        </template>
      </aside>
    </div>

    <HistoryExportDialog
      v-model="showHistoryExport"
      :allow-structured-content="false"
      :disabled="isExportingHistory"
      @confirm="exportCurrentHistory"
    />

    <!-- ═══ 管家弹窗 ═══ -->
    <PDialog v-model="showButler" :title="__t('ui.navigation', '呼叫管家')">
      <div class="sh-butler-dialog">
        <p class="sh-butler-dialog-sub">
          {{ __t('ui.navigation', '告诉管家你想做什么，它会帮你管理房间和成员。') }}
        </p>

        <!-- 快捷指令 -->
        <div class="sh-butler-shortcuts">
          <button
            v-for="s in shortcuts"
            :key="s.label"
            class="sh-butler-shortcut"
            @click="applyShortcut(s.cmd)"
          >
            {{ s.label }}
          </button>
        </div>

        <textarea
          v-model="butlerQuery"
          class="sh-butler-input"
          :placeholder="__t('ui.navigation', '例如: 把娜娜叫到客厅来...')"
          @keydown.ctrl.enter="submitButler"
        />
        <div class="sh-butler-hint">{{ __t('ui.navigation', 'Ctrl + Enter 发送') }}</div>

        <div class="sh-butler-actions">
          <PButton variant="ghost" @click="showButler = false">
            {{ __t('ui.navigation', '取消') }}
          </PButton>
          <PButton
            variant="primary"
            :disabled="!butlerQuery.trim() || isCalling"
            @click="submitButler"
          >
            {{ isCalling ? __t('ui.navigation', '发送中...') : __t('ui.navigation', '发送指令') }}
          </PButton>
        </div>
      </div>
    </PDialog>
  </div>
</template>

<style scoped>
/* ═══════════════════════════════════════════════════════════════
 * 根容器
 * ═══════════════════════════════════════════════════════════════ */

.stronghold-tab-root {
  width: 100%;
  height: 100%;
  padding: 14px;
  background:
    radial-gradient(circle at 12% 8%, rgba(139, 92, 246, 0.06) 0%, transparent 30%),
    radial-gradient(circle at 88% 84%, rgba(236, 72, 153, 0.05) 0%, transparent 32%),
    var(--ui-bg-canvas);
}

[data-theme='dark'] .stronghold-tab-root {
  background:
    radial-gradient(circle at 12% 10%, rgba(167, 139, 250, 0.09) 0%, transparent 32%),
    radial-gradient(circle at 88% 82%, rgba(244, 114, 182, 0.06) 0%, transparent 34%),
    var(--ui-bg-canvas);
}

/* ═══════════════════════════════════════════════════════════════
 * 一体化面板
 * ═══════════════════════════════════════════════════════════════ */

.stronghold-panel {
  display: flex;
  width: 100%;
  height: 100%;
  background: var(--ui-bg-surface);
  border: 1px solid var(--ui-border-default);
  border-radius: var(--ui-radius-xl);
  box-shadow: var(--ui-shadow-md);
  overflow: hidden;
}

[data-theme='dark'] .stronghold-panel {
  background: rgba(26, 29, 39, 0.95);
  border-color: rgba(139, 92, 246, 0.2);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
}

/* ═══════════════════════════════════════════════════════════════
 * 通用: 收起按钮
 * ═══════════════════════════════════════════════════════════════ */

.sh-toggle {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  width: 22px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: var(--ui-bg-surface-soft);
  color: var(--ui-text-tertiary);
  cursor: pointer;
  z-index: 2;
  font-size: 10px;
}

.sh-toggle:hover {
  color: var(--ui-accent-primary);
}

.sh-toggle-left {
  right: 0;
  border-left: 1px solid var(--ui-border-subtle);
}

.sh-toggle-right {
  left: 0;
  border-right: 1px solid var(--ui-border-subtle);
}

/* ═══════════════════════════════════════════════════════════════
 * 左侧: 品牌头 + 房间导航
 * ═══════════════════════════════════════════════════════════════ */

.sh-left {
  position: relative;
  width: 236px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: var(--ui-bg-surface-soft);
  border-right: 1px solid var(--ui-border-subtle);
  transition: width var(--ui-duration-normal) var(--ui-ease-standard);
}

[data-theme='dark'] .sh-left {
  background: rgba(15, 16, 26, 0.5);
  border-right-color: rgba(139, 92, 246, 0.12);
}

.sh-left--collapsed {
  width: 60px;
}

/* ── 品牌头: 「我的据点」入口卡 ── */

.sh-brand {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 18px 16px 14px;
  border-bottom: 1px solid var(--ui-border-subtle);
}

/* 据点徽章: 异形五边形 + 组合几何堡垒 (浅色: 粉紫渐变 + 可可描边 + 粉光晕) */
.sh-brand-mark {
  --sh-brand-frame: var(--color-moe-cocoa);
  --sh-brand-grad-a: #ec4899;
  --sh-brand-grad-b: #8b5cf6;
  --sh-brand-glow-line: rgba(255, 255, 255, 0.85);
  --sh-brand-glyph: #ffffff;
  --sh-brand-door: #be185d;
  --sh-brand-gem: #fbbf24;
  width: 44px;
  height: 44px;
  flex-shrink: 0;
  display: block;
  filter: drop-shadow(0 0 6px rgba(236, 72, 153, 0.35));
  animation: sh-brand-breathe 3.2s ease-in-out infinite;
}

/* 深色: 深紫霓虹渐变 + 紫描边 + 更强光晕 */
[data-theme='dark'] .sh-brand-mark {
  --sh-brand-frame: var(--ui-accent-purple);
  --sh-brand-grad-a: #6d28d9;
  --sh-brand-grad-b: #a78bfa;
  --sh-brand-glow-line: rgba(196, 181, 253, 0.7);
  --sh-brand-glyph: #ede9fe;
  --sh-brand-door: #4c1d95;
  --sh-brand-gem: #fbbf24;
  filter: drop-shadow(0 0 10px rgba(167, 139, 250, 0.55));
  animation-name: sh-brand-breathe-dark;
}

/* 收起态: 迷你五边形据点徽章 (与主徽章配色一致) */
.sh-brand-mark--sm {
  --sh-brand-frame: var(--color-moe-cocoa);
  --sh-brand-grad-a: #ec4899;
  --sh-brand-grad-b: #8b5cf6;
  --sh-brand-glow-line: rgba(255, 255, 255, 0.85);
  --sh-brand-glyph: #ffffff;
  --sh-brand-door: #be185d;
  width: 30px;
  height: 30px;
  display: block;
  filter: drop-shadow(0 0 5px rgba(236, 72, 153, 0.35));
}

[data-theme='dark'] .sh-brand-mark--sm {
  --sh-brand-frame: var(--ui-accent-purple);
  --sh-brand-grad-a: #6d28d9;
  --sh-brand-grad-b: #a78bfa;
  --sh-brand-glow-line: rgba(196, 181, 253, 0.7);
  --sh-brand-glyph: #ede9fe;
  --sh-brand-door: #4c1d95;
  filter: drop-shadow(0 0 7px rgba(167, 139, 250, 0.5));
}

/* 徽章呼吸光晕: 强化「据点有生命」的氛围 */
@keyframes sh-brand-breathe {
  50% {
    filter: drop-shadow(0 0 9px rgba(236, 72, 153, 0.5));
  }
}

@keyframes sh-brand-breathe-dark {
  50% {
    filter: drop-shadow(0 0 14px rgba(167, 139, 250, 0.7));
  }
}

@media (prefers-reduced-motion: reduce) {
  .sh-brand-mark {
    animation: none;
  }
}

.sh-brand-text {
  min-width: 0;
  flex: 1;
}

.sh-brand-title {
  margin: 0;
  font-family: var(--ui-font-pixel), 'Zpix', monospace;
  font-size: 17px;
  font-weight: 900;
  line-height: 1.3;
  letter-spacing: 0.02em;
  background: linear-gradient(135deg, var(--ui-text-primary) 30%, var(--ui-accent-primary));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

[data-theme='dark'] .sh-brand-title {
  background: linear-gradient(135deg, var(--ui-text-primary) 30%, var(--ui-accent-purple));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.sh-brand-sub {
  display: block;
  margin-top: 2px;
  font-size: 8px;
  font-weight: 700;
  letter-spacing: 0.18em;
  color: var(--ui-text-tertiary);
}

/* ── 多设施选择器 ── */

.sh-fac-selector {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--ui-border-subtle);
}

.sh-fac-chip {
  padding: 4px 10px;
  border: 1px solid var(--ui-border-default);
  border-radius: var(--ui-radius-full);
  background: transparent;
  color: var(--ui-text-secondary);
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  transition: all var(--ui-duration-fast) var(--ui-ease-standard);
}

.sh-fac-chip:hover {
  border-color: var(--ui-accent-primary);
  color: var(--ui-accent-primary);
}

.sh-fac-chip--active {
  border-color: var(--ui-accent-primary);
  background: var(--ui-accent-primary-soft);
  color: var(--ui-accent-primary);
}

/* ── 房间列表 ── */

.sh-rooms {
  flex: 1;
  overflow-y: auto;
  padding: 12px 10px;
}

.sh-rooms-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 2px 8px 8px;
}

.sh-rooms-title {
  font-size: 12px;
  font-weight: 700;
  color: var(--ui-text-secondary);
}

.sh-rooms-title-en {
  font-size: 8px;
  font-weight: 800;
  letter-spacing: 0.18em;
  color: var(--ui-text-tertiary);
}

.sh-room {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 9px 10px;
  margin-bottom: 3px;
  border: 1px solid transparent;
  border-radius: var(--ui-radius-md);
  background: transparent;
  cursor: pointer;
  text-align: left;
  transition: all var(--ui-duration-fast) var(--ui-ease-standard);
}

.sh-room:hover {
  background: var(--ui-bg-hover);
}

/* 选中态: 淡色底 + 品牌光轨, 与主导航语言一致 */
.sh-room--active {
  background: var(--ui-bg-active);
  border-color: rgba(236, 72, 153, 0.25);
  box-shadow: inset 3px 0 0 0 var(--ui-accent-primary);
}

[data-theme='dark'] .sh-room--active {
  border-color: rgba(167, 139, 250, 0.3);
  box-shadow: inset 3px 0 0 0 var(--ui-accent-purple);
}

.sh-room-icon {
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--ui-radius-sm);
  background: var(--ui-bg-surface);
  border: 1px solid var(--ui-border-subtle);
  color: var(--ui-text-tertiary);
  transition: all var(--ui-duration-fast) var(--ui-ease-standard);
}

.sh-room-icon--active {
  background: var(--ui-accent-primary);
  border-color: var(--ui-accent-primary);
  color: #fff;
}

[data-theme='dark'] .sh-room-icon--active {
  background: var(--ui-accent-purple);
  border-color: var(--ui-accent-purple);
}

.sh-room-info {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.sh-room-name {
  font-size: 12px;
  font-weight: 700;
  color: var(--ui-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sh-room-desc {
  font-size: 10px;
  color: var(--ui-text-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sh-room-count {
  flex-shrink: 0;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--ui-radius-full);
  background: var(--ui-accent-primary-soft);
  color: var(--ui-accent-primary);
  font-size: 10px;
  font-weight: 800;
}

.sh-room--active .sh-room-count {
  background: var(--ui-accent-primary);
  color: #fff;
}

[data-theme='dark'] .sh-room-count {
  background: var(--ui-accent-purple-soft);
  color: var(--ui-accent-purple);
}

[data-theme='dark'] .sh-room--active .sh-room-count {
  background: var(--ui-accent-purple);
}

.sh-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 40px 0;
  color: var(--ui-text-tertiary);
  font-size: 11px;
}

.sh-empty-rooms {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 40px 0;
  color: var(--ui-text-tertiary);
  font-size: 11px;
}

/* ── 左侧收起态 ── */

.sh-collapsed-rooms {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 16px 0;
}

.sh-collapsed-brand {
  padding: 8px 0 14px;
  display: block;
  text-align: center;
}

.sh-collapsed-room {
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--ui-border-subtle);
  border-radius: var(--ui-radius-sm);
  background: transparent;
  color: var(--ui-text-tertiary);
  cursor: pointer;
  transition: all var(--ui-duration-fast) var(--ui-ease-standard);
}

.sh-collapsed-room:hover {
  color: var(--ui-accent-primary);
  border-color: var(--ui-accent-primary);
}

.sh-collapsed-room--active {
  background: var(--ui-accent-primary);
  border-color: var(--ui-accent-primary);
  color: #fff;
}

[data-theme='dark'] .sh-collapsed-room--active {
  background: var(--ui-accent-purple);
  border-color: var(--ui-accent-purple);
}

/* ═══════════════════════════════════════════════════════════════
 * 中间: 房间工作台
 * ═══════════════════════════════════════════════════════════════ */

.sh-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.sh-main-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 16px;
  padding: 14px 20px 12px;
  border-bottom: 1px solid var(--ui-border-subtle);
  background:
    repeating-linear-gradient(90deg, transparent, transparent 15px, rgba(139, 92, 246, 0.02) 16px),
    var(--ui-bg-surface-soft);
  flex-shrink: 0;
}

[data-theme='dark'] .sh-main-header {
  background: rgba(15, 16, 26, 0.4);
}

.sh-main-room {
  display: flex;
  flex: 1 1 180px;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.sh-main-room-icon {
  width: 38px;
  height: 38px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--ui-radius-md);
  background: linear-gradient(135deg, var(--ui-accent-primary-soft), var(--ui-accent-purple-soft));
  color: var(--ui-accent-primary);
}

[data-theme='dark'] .sh-main-room-icon {
  color: var(--ui-accent-purple);
}

.sh-main-room-text {
  min-width: 0;
}

.sh-main-room-name {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-family: var(--ui-font-pixel), 'Zpix', monospace;
  font-size: 15px;
  font-weight: 900;
  letter-spacing: 0.02em;
  color: var(--ui-text-primary);
  white-space: nowrap;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sh-main-fac-badge {
  padding: 2px 7px;
  border-radius: var(--ui-radius-full);
  background: var(--ui-accent-purple-soft);
  color: var(--ui-accent-purple);
  font-family: var(--ui-font-sans);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.04em;
  white-space: nowrap;
}

.sh-main-room-desc {
  margin: 2px 0 0;
  font-size: 11px;
  color: var(--ui-text-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 480px;
}

/* 右侧: 环境 chips + 成员堆叠。窄窗口时整组换到房间名下方，不再越出中栏压住右侧「成员态势」。 */
.sh-main-aside {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 14px;
  min-width: 0;
  margin-left: auto;
}

.sh-env-chips {
  display: flex;
  gap: 6px;
}

.sh-env-chip {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border: 1px solid var(--ui-border-subtle);
  border-radius: var(--ui-radius-sm);
  background: var(--ui-bg-surface);
  color: var(--ui-text-secondary);
  font-size: 10px;
  font-weight: 600;
}

.sh-env-chip .pixel-icon {
  color: var(--ui-accent-sky);
}

.sh-env-chip-value {
  max-width: 72px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sh-member-stack {
  display: flex;
  align-items: center;
  padding-left: 6px;
}

.sh-member-face {
  position: relative;
  width: 26px;
  height: 26px;
  margin-left: -6px;
  border-radius: 50%;
  border: 2px solid var(--ui-bg-surface);
  overflow: hidden;
  background: var(--ui-accent-purple-soft);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 800;
  color: var(--ui-accent-purple);
}

.sh-member-face img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.sh-member-face--more {
  background: var(--ui-bg-hover);
  color: var(--ui-text-secondary);
  font-size: 9px;
}

.sh-main-chat {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* 空状态 */
.sh-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding-bottom: 40px;
  color: var(--ui-text-tertiary);
}

.sh-empty-icon {
  width: 88px;
  height: 88px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 24px;
  background: linear-gradient(135deg, var(--ui-accent-purple-soft), var(--ui-accent-primary-soft));
  margin-bottom: 20px;
  color: var(--ui-accent-purple);
}

.sh-empty-title {
  margin: 0;
  font-family: var(--ui-font-pixel), 'Zpix', monospace;
  font-size: 16px;
  font-weight: 900;
  color: var(--ui-text-secondary);
}

.sh-empty-sub {
  margin-top: 8px;
  font-size: 12px;
}

/* ═══════════════════════════════════════════════════════════════
 * 右侧: 成员雷达
 * ═══════════════════════════════════════════════════════════════ */

.sh-right {
  position: relative;
  width: 260px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: var(--ui-bg-surface-soft);
  border-left: 1px solid var(--ui-border-subtle);
  transition: width var(--ui-duration-normal) var(--ui-ease-standard);
}

[data-theme='dark'] .sh-right {
  background: rgba(15, 16, 26, 0.5);
  border-left-color: rgba(139, 92, 246, 0.12);
}

.sh-right--collapsed {
  width: 60px;
}

.sh-right-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 14px 14px 12px;
  border-bottom: 1px solid var(--ui-border-subtle);
}

.sh-right-title-wrap {
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.sh-right-title {
  white-space: nowrap;
  font-size: 12px;
  font-weight: 700;
  color: var(--ui-text-primary);
}

.sh-right-title-en {
  font-size: 8px;
  font-weight: 800;
  letter-spacing: 0.16em;
  color: var(--ui-text-tertiary);
}

/* ── 「呼叫管家」按钮: 浅色模式保持默认 primary，深色模式换紫色科技配色 ── */

[data-theme='dark'] .sh-butler-call-btn :deep(.p-btn-primary) {
  background: linear-gradient(135deg, #6d28d9, #a78bfa);
  border-color: #7c3aed;
  color: #fff;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.35);
  box-shadow:
    3px 3px 0 rgba(0, 0, 0, 0.45),
    0 0 14px rgba(139, 92, 246, 0.35);
}

[data-theme='dark'] .sh-butler-call-btn :deep(.p-btn-primary:hover:not(:disabled)) {
  background: linear-gradient(135deg, #5b21b6, #8b5cf6);
  box-shadow:
    3px 3px 0 rgba(0, 0, 0, 0.45),
    0 0 18px rgba(139, 92, 246, 0.55);
}

.sh-right-body {
  flex: 1;
  overflow-y: auto;
  padding: 12px 10px;
}

.sh-section {
  margin-bottom: 20px;
}

.sh-section-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 2px 4px 8px;
}

.sh-section-title {
  font-size: 11px;
  font-weight: 700;
  color: var(--ui-text-secondary);
}

.sh-section-count {
  padding: 1px 7px;
  border-radius: var(--ui-radius-full);
  background: var(--ui-accent-primary-soft);
  color: var(--ui-accent-primary);
  font-size: 9px;
  font-weight: 800;
}

.sh-section-count--all {
  background: var(--ui-accent-purple-soft);
  color: var(--ui-accent-purple);
}

/* 头像 (共用) */
.sh-avatar {
  position: relative;
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  border-radius: 50%;
  overflow: visible;
  background: linear-gradient(135deg, var(--ui-accent-primary-soft), var(--ui-accent-purple-soft));
  display: flex;
  align-items: center;
  justify-content: center;
}

.sh-avatar img {
  width: 100%;
  height: 100%;
  border-radius: 50%;
  object-fit: cover;
}

.sh-avatar-fallback {
  font-size: 14px;
  font-weight: 800;
  color: var(--ui-accent-primary);
}

.sh-avatar-dot {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--ui-success);
  border: 2px solid var(--ui-bg-surface);
}

.sh-avatar--sm {
  width: 30px;
  height: 30px;
}

.sh-avatar--sm .sh-avatar-fallback {
  font-size: 12px;
}

/* 本房间成员卡 */
.sh-roommates {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.sh-roommate {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--ui-border-subtle);
  border-radius: var(--ui-radius-md);
  background: var(--ui-bg-surface);
  transition: all var(--ui-duration-fast) var(--ui-ease-standard);
}

.sh-roommate:hover {
  border-color: rgba(236, 72, 153, 0.3);
  box-shadow: var(--ui-shadow-sm);
}

.sh-roommate-info {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.sh-roommate-name {
  font-size: 12px;
  font-weight: 700;
  color: var(--ui-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sh-roommate-status {
  font-size: 10px;
  color: var(--ui-success);
}

.sh-empty-agents {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 18px 0;
  color: var(--ui-text-tertiary);
  font-size: 11px;
}

/* 据点居民列表 */
.sh-residents {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.sh-resident {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 6px 8px;
  border: none;
  border-radius: var(--ui-radius-sm);
  background: transparent;
  cursor: pointer;
  text-align: left;
  transition: all var(--ui-duration-fast) var(--ui-ease-standard);
}

.sh-resident:hover {
  background: var(--ui-bg-hover);
}

.sh-resident-info {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
}

.sh-resident-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--ui-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sh-resident-loc {
  font-size: 10px;
  color: var(--ui-text-tertiary);
}

.sh-resident-summon {
  flex-shrink: 0;
  color: var(--ui-text-tertiary);
  opacity: 0;
  transition: all var(--ui-duration-fast) var(--ui-ease-standard);
}

.sh-resident:hover .sh-resident-summon {
  opacity: 1;
  color: var(--ui-accent-primary);
}

/* 右侧收起态 */
.sh-collapsed-members {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 16px 0;
}

.sh-collapsed-member {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  overflow: hidden;
  background: var(--ui-accent-purple-soft);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 800;
  color: var(--ui-accent-purple);
}

.sh-collapsed-member img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

/* ═══════════════════════════════════════════════════════════════
 * 管家弹窗
 * ═══════════════════════════════════════════════════════════════ */

.sh-butler-dialog {
  padding: 6px 2px 2px;
}

.sh-butler-dialog-sub {
  margin: 0 0 12px;
  font-size: 12px;
  color: var(--ui-text-secondary);
}

.sh-butler-shortcuts {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 12px;
}

.sh-butler-shortcut {
  padding: 5px 10px;
  border: 1px solid var(--ui-border-default);
  border-radius: var(--ui-radius-full);
  background: transparent;
  color: var(--ui-text-secondary);
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  transition: all var(--ui-duration-fast) var(--ui-ease-standard);
}

.sh-butler-shortcut:hover {
  border-color: var(--ui-accent-purple);
  color: var(--ui-accent-purple);
  background: var(--ui-accent-purple-soft);
}

.sh-butler-input {
  width: 100%;
  height: 110px;
  padding: 10px 12px;
  border: 1px solid var(--ui-border-default);
  border-radius: var(--ui-radius-md);
  background: var(--ui-bg-surface-soft);
  color: var(--ui-text-primary);
  font-family: var(--ui-font-sans);
  font-size: 13px;
  line-height: 1.6;
  resize: none;
  outline: none;
  box-sizing: border-box;
  transition: border-color var(--ui-duration-fast);
}

.sh-butler-input:focus {
  border-color: var(--ui-accent-purple);
  box-shadow: 0 0 0 3px var(--ui-accent-purple-soft);
}

.sh-butler-input::placeholder {
  color: var(--ui-text-disabled);
}

.sh-butler-hint {
  margin-top: 6px;
  font-size: 10px;
  color: var(--ui-text-tertiary);
  text-align: right;
}

.sh-butler-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 14px;
}

/* 减少动画偏好 */
@media (prefers-reduced-motion: reduce) {
  .sh-left,
  .sh-right {
    transition: none;
  }
}
</style>
