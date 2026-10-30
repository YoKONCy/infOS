<script setup lang="ts">
import { getDisplayLocale } from '../i18n/index'

import { t as __t } from '../i18n/index'

import { copyClientText } from '../lib/clientPlatform'

/** Electron 客户端专属启动与维护中心。 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { PixelIcon } from '../components/pixel'
import AsyncMarkdown from '../components/markdown/AsyncMarkdown.vue'
import { OnboardingOverlay } from '../components/overlays'
import CustomTitleBar from '../components/layout/CustomTitleBar.vue'
import InfosLogo from '../components/brands/InfosLogo.vue'
import { useLauncher, type CheckItem } from '../composables/launcher/useLauncher'
import StartupDiagnosticDialog from '../components/launcher/StartupDiagnosticDialog.vue'
import { getLauncherSteps } from '../composables/launcher/onboardingScripts'
import { useAgentStore, useNotificationStore } from '../stores'
import { getApiBaseUrl } from '../api/transport'
import { invoke, listen, send } from '../utils/ipcAdapter'
import { useMainNav } from '../composables/main/useMainNav'

interface ClientInfo {
  version: string
  edition: 'development' | 'portable' | 'steam' | 'release'
  isPackaged: boolean
  platform: string
  architecture: string
  osVersion: string
  osName: string
  hostname: string
  cpuModel: string
  cpuCores: number
  memoryUsed: number
  memoryTotal: number
  uptime: number
  electronVersion: string
  chromiumVersion: string
  nodeVersion: string
  dataPath: string
  logsPath: string
  appPath: string
  windows: { launcher: boolean; dashboard: boolean; pet: boolean }
  development: {
    available: boolean
    branch?: string
    commit?: string
    dirty?: boolean
    projectPath?: string
    updateCommand?: string
    error?: string
  }
}

interface UpdateState {
  phase:
    | 'idle'
    | 'checking'
    | 'available'
    | 'downloading'
    | 'downloaded'
    | 'installing'
    | 'up-to-date'
    | 'error'
  canInstall?: boolean
  deployment?: 'installed' | 'portable' | 'unsupported'
  currentVersion: string
  latestVersion?: string
  selectedVersion?: string
  selectedTag?: string
  progress: number
  message: string
  checkedAt?: string
}

interface ReleaseNotice {
  tagName: string
  version?: string
  name: string
  body: string
  publishedAt: string
  htmlUrl: string
  prerelease: boolean
  cached?: boolean
}

const tabs = [
  {
    id: 'launch',
    code: '01',
    get label() {
      return __t('ui.navigation', '启动')
    },
    icon: 'power',
  },
  {
    id: 'environment',
    code: '02',
    get label() {
      return __t('ui.navigation', '运行环境')
    },
    icon: 'cpu',
  },
  {
    id: 'updates',
    code: '03',
    get label() {
      return __t('ui.navigation', '版本公告')
    },
    icon: 'download',
  },
  {
    id: 'about',
    code: '04',
    get label() {
      return __t('ui.navigation', '关于')
    },
    icon: 'info',
  },
] as const

type TabId = (typeof tabs)[number]['id']
const appVersion = __APP_VERSION__
const activeTab = ref<TabId>('launch')
const agentStore = useAgentStore()
const notification = useNotificationStore()
const { theme, toggleTheme } = useMainNav()
const launchMenuOpen = ref(false)
const launchTrigger = ref<HTMLButtonElement | null>(null)
const launchMenu = ref<HTMLElement | null>(null)
const launchPlacement = ref({ left: '0px', top: '0px' })
const launchMenuBelow = ref(true)
const launcherSteps = computed(getLauncherSteps)
const tutorialLaunchStep = ref(false)

async function showLaunchMenu() {
  if (launchMenuOpen.value) {
    launchMenuOpen.value = false
    return
  }
  const box = launchTrigger.value?.getBoundingClientRect()
  if (!box) return
  launchPlacement.value = { left: '0px', top: '0px' }
  launchMenuOpen.value = true
  await nextTick()
  const menu = launchMenu.value
  if (!menu) return
  // 使用布局尺寸，避免入场缩放动画影响菜单与按钮的对齐。
  const width = menu.offsetWidth
  const height = menu.offsetHeight
  launchMenuBelow.value = box.bottom + height + 10 <= window.innerHeight - 12
  launchPlacement.value = {
    left: `${Math.max(12, Math.min(window.innerWidth - width - 12, box.right - width))}px`,
    top: `${Math.max(12, launchMenuBelow.value ? box.bottom + 10 : box.top - height - 10)}px`,
  }
  menu.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
}
function dismissLaunchMenu(event?: Event) {
  if (
    event &&
    (launchMenu.value?.contains(event.target as Node) ||
      launchTrigger.value?.contains(event.target as Node))
  )
    return
  launchMenuOpen.value = false
}
function launchMenuKey(event: KeyboardEvent) {
  if (event.key === 'Tab') {
    dismissLaunchMenu()
    return
  }
  if (event.key === 'Escape') {
    dismissLaunchMenu()
    launchTrigger.value?.focus()
    return
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const buttons = [...(launchMenu.value?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
  const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
  const index =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? buttons.length - 1
        : (current + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length
  buttons[index]?.focus()
}
const clientInfo = ref<ClientInfo | null>(null)
const updateState = ref<UpdateState | null>(null)
const release = ref<ReleaseNotice | null>(null)
const loadingInfo = ref(false)
const loadingRelease = ref(false)
const switchingAgent = ref('')
let stopUpdateListener: (() => void) | null = null

const {
  phase,
  checks,
  errorMessage,
  errorHint,
  diagnostic,
  retry,
  startLaunch,
  enterApp,
  enteringText,
  showEula,
  acceptEula,
  declineEula,
  triggerEula,
  showOnboarding,
  finishOnboarding,
  triggerOnboarding,
  launchDesktopOnboarding,
  desktopGuidePending,
  onboardingLaunching,
} = useLauncher()
const showDiagnostic = ref(false)
watch(diagnostic, () => {
  showDiagnostic.value = false
})
const backendSignal = computed(() => {
  if (diagnostic.value?.stage === 'backend') {
    return { status: 'error', label: __t('ui.launcher', '连接失败') }
  }
  return ['ready', 'entering', 'done'].includes(phase.value)
    ? { status: 'ok', label: __t('ui.navigation', '服务在线') }
    : { status: 'pending', label: __t('ui.navigation', '正在连接') }
})
const diagnosticReport = computed(() => {
  const detail = diagnostic.value
  if (!detail) return ''
  return [
    __t('ui.launcher', '客户端版本：{0}', [clientInfo.value?.version ?? appVersion]),
    __t('ui.launcher', '发生时间：{0}', [formatDate(detail.createdAt)]),
    detail.logPath ? __t('ui.launcher', '日志：{0}', [detail.logPath]) : '',
    detail.error,
    detail.logTail,
  ]
    .filter(Boolean)
    .join('\n\n')
})

/** 卡片文案只由状态枚举生成，错误对象和日志永远不参与卡片布局。 */
function checkStatusLabel(status: CheckItem['status']): string {
  return {
    pending: __t('ui.launcher', '等待检测'),
    running: __t('ui.launcher', '检测中'),
    ok: __t('ui.launcher', '已通过'),
    warn: __t('ui.launcher', '待确认'),
    error: __t('ui.launcher', '未就绪'),
  }[status]
}
const launchesDesktopGuide = computed(
  () => desktopGuidePending.value || (showOnboarding.value && tutorialLaunchStep.value),
)

const editionName = computed(
  () =>
    ({
      get development() {
        return __t('ui.navigation', '开发版')
      },
      get portable() {
        return __t('ui.navigation', '便携版')
      },
      get steam() {
        return __t('ui.navigation', 'Steam 版')
      },
      get release() {
        return __t('ui.navigation', '正式版')
      },
    })[clientInfo.value?.edition ?? 'development'],
)

const checkFriendlyLabel: Record<string, string> = {
  get backend() {
    return __t('ui.navigation', '后台服务')
  },
  get database() {
    return __t('ui.navigation', '数据存储')
  },
  get model() {
    return __t('ui.navigation', 'AI 模型')
  },
  get memory() {
    return __t('ui.navigation', '记忆系统')
  },
  get extension() {
    return __t('ui.navigation', '伙伴配置')
  },
}

const healthyChecks = computed(() => checks.value.filter((item) => item.status === 'ok').length)
const totalChecks = computed(() => checks.value.length)
const environmentWarning = computed(() =>
  checks.value.some((item) => item.status === 'error' || item.status === 'warn'),
)
const hasUpdate = computed(
  () => updateState.value?.phase === 'available' || updateState.value?.phase === 'downloaded',
)

function formatBytes(bytes: number): string {
  if (!bytes) return '—'
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

function formatDate(value: string): string {
  return value ? new Date(value).toLocaleString(getDisplayLocale()) : __t('ui.navigation', '未知')
}

async function refreshClientInfo(): Promise<void> {
  loadingInfo.value = true
  try {
    clientInfo.value = (await invoke('get-client-info')) as ClientInfo
    updateState.value = (await invoke('get-update-state')) as UpdateState
  } catch (error) {
    notification.toast(
      __t('ui.navigation', '客户端环境检测失败：{0}', [
        error instanceof Error ? error.message : String(error),
      ]),
      'error',
    )
  } finally {
    loadingInfo.value = false
  }
}

async function loadRelease(): Promise<void> {
  loadingRelease.value = true
  try {
    release.value = (await invoke('get-latest-release')) as ReleaseNotice
  } catch (error) {
    notification.toast(
      __t('ui.navigation', '版本公告获取失败：{0}', [
        error instanceof Error ? error.message : String(error),
      ]),
      'warning',
    )
  } finally {
    loadingRelease.value = false
  }
}

async function selectAgent(agentId: string): Promise<void> {
  if (switchingAgent.value || agentId === agentStore.activeAgentId) return
  switchingAgent.value = agentId
  try {
    await agentStore.switchAgent(agentId)
  } catch (error) {
    notification.toast(
      __t('ui.navigation', '切换角色失败：{0}', [
        error instanceof Error ? error.message : String(error),
      ]),
      'error',
    )
  } finally {
    switchingAgent.value = ''
  }
}

async function launch(target: 'pet' | 'app'): Promise<void> {
  dismissLaunchMenu()
  const success = await enterApp(target)
  if (!success) notification.toast(__t('ui.navigation', '启动失败，请稍后重试'), 'error')
  await refreshClientInfo()
}
async function primaryLaunch(): Promise<void> {
  if (launchesDesktopGuide.value) {
    dismissLaunchMenu()
    const success = await launchDesktopOnboarding()
    if (!success) notification.toast(__t('ui.navigation', '启动失败，请稍后重试'), 'error')
    await refreshClientInfo()
    return
  }
  await showLaunchMenu()
}

async function checkUpdate(): Promise<void> {
  try {
    updateState.value = (await invoke('check-client-update')) as UpdateState
  } catch (error) {
    showUpdateError(error)
  }
}

async function downloadUpdate(): Promise<void> {
  try {
    updateState.value = (await invoke('download-client-update')) as UpdateState
  } catch (error) {
    showUpdateError(error)
  }
}

async function installUpdate(): Promise<void> {
  try {
    await invoke('install-client-update')
    updateState.value = (await invoke('get-update-state')) as UpdateState
  } catch (error) {
    showUpdateError(error)
  }
}

function showUpdateError(error: unknown): void {
  notification.toast(__t('ui.navigation', '更新操作失败：{0}', [String(error)]), 'error')
}

async function copyUpdateCommand(): Promise<void> {
  const command = clientInfo.value?.development.updateCommand
  if (!command) return
  await copyClientText(command)
  notification.toast(__t('ui.navigation', '开发更新命令已复制'), 'success')
}

function handleOnboardingStep(step: { tab?: string; action?: string }): void {
  tutorialLaunchStep.value = step.action === 'launch-desktop'
  if (step.tab && tabs.some((tab) => tab.id === step.tab)) activeTab.value = step.tab as TabId
}

let launcherDisposed = false
let firstFrameRequest: number | undefined
onMounted(async () => {
  document.addEventListener('pointerdown', dismissLaunchMenu)
  window.addEventListener('resize', dismissLaunchMenu)
  window.addEventListener('scroll', dismissLaunchMenu, true)
  await nextTick()
  if (launcherDisposed) return
  // 壳层等待 Vue 排版后的真实帧；不把全部网络检查当作首帧，也不使用 DOM 加载代替。
  firstFrameRequest = requestAnimationFrame(() => {
    firstFrameRequest = requestAnimationFrame(() => {
      firstFrameRequest = undefined
      if (!launcherDisposed) send('startup:launcher-ready')
    })
  })
  await Promise.all([agentStore.fetchAgents(), refreshClientInfo(), startLaunch()])
  void loadRelease()
  stopUpdateListener = await listen('client-update-state', (payload) => {
    updateState.value = payload as UpdateState
  })
})

onUnmounted(() => {
  launcherDisposed = true
  if (firstFrameRequest !== undefined) cancelAnimationFrame(firstFrameRequest)
  stopUpdateListener?.()
  document.removeEventListener('pointerdown', dismissLaunchMenu)
  window.removeEventListener('resize', dismissLaunchMenu)
  window.removeEventListener('scroll', dismissLaunchMenu, true)
})
</script>

<template>
  <div class="launcher-shell" :class="{ 'launcher-dark': theme === 'dark' }">
    <CustomTitleBar :is-work-mode="theme === 'dark'" />
    <StartupDiagnosticDialog
      v-model="showDiagnostic"
      :report="diagnosticReport"
      :dark="theme === 'dark'"
    />

    <OnboardingOverlay
      v-model:visible="showOnboarding"
      :steps="launcherSteps"
      @finish="finishOnboarding"
      @skip="finishOnboarding"
      @step="handleOnboardingStep"
    />

    <header class="launcher-head">
      <div class="launcher-brand">
        <div class="brand-mark"><InfosLogo variant="mark" /></div>
        <div>
          <InfosLogo class="launcher-wordmark" variant="wordmark" />
          <span>{{ __t('ui.navigation', '启动器') }}</span>
        </div>
      </div>
      <div class="global-signals">
        <button
          class="ghost-action"
          type="button"
          :title="
            theme === 'dark' ? __t('ui.navigation', '切换浅色') : __t('ui.navigation', '切换深色')
          "
          @click="toggleTheme"
        >
          <PixelIcon :name="theme === 'dark' ? 'sun' : 'moon'" size="xs" />
        </button>
        <span class="signal">
          <i :class="backendSignal.status" />
          {{ backendSignal.label }}
        </span>
        <span class="badge">{{ editionName }}</span>
        <span class="ver">v{{ clientInfo?.version ?? appVersion }}</span>
      </div>
    </header>

    <nav id="launcher-tabs" class="launcher-tabs" :aria-label="__t('ui.navigation', '启动器页面')">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        :class="{ active: activeTab === tab.id }"
        @click="activeTab = tab.id"
      >
        <span class="tab-code">{{ tab.code }}</span>
        <PixelIcon :name="tab.icon" size="sm" />
        <strong>{{ tab.label }}</strong>
        <i v-if="tab.id === 'environment' && environmentWarning" class="tab-signal warn" />
        <i v-if="tab.id === 'updates' && hasUpdate" class="tab-signal update" />
      </button>
    </nav>

    <main class="launcher-content">
      <!-- 启动 -->
      <section v-if="activeTab === 'launch'" class="page launch-page">
        <div class="page-head">
          <div>
            <span class="page-eyebrow">{{ __t('ui.navigation', '今天和谁一起') }}</span>
            <h1>{{ __t('ui.navigation', '选择你的伙伴') }}</h1>
            <p>
              {{ __t('ui.navigation', '选中的伙伴会出现在主界面和桌面，下次启动也会记住哦。') }}
            </p>
          </div>
          <div class="check-score">
            <strong>{{ healthyChecks }}/{{ totalChecks }}</strong>
            <span>{{ __t('ui.navigation', '启动检查通过') }}</span>
          </div>
        </div>

        <div id="launcher-agent-stage" class="agent-stage">
          <article class="active-agent-card">
            <div class="active-avatar">
              <img
                v-if="agentStore.currentAgent?.avatarUrl"
                :src="`${getApiBaseUrl()}${agentStore.currentAgent.avatarUrl}`"
                :alt="agentStore.currentAgent.name"
              />
              <span v-else>{{ agentStore.currentAgent?.name?.[0] ?? '?' }}</span>
            </div>
            <div class="active-copy">
              <small>{{ __t('ui.navigation', '当前伙伴') }}</small>
              <h2>{{ agentStore.currentAgent?.name ?? __t('ui.navigation', '还没选伙伴') }}</h2>
              <p>
                {{
                  agentStore.currentAgent?.description ||
                  __t('ui.navigation', '点右侧选一个伙伴，它就会在桌面和主界面陪伴你。')
                }}
              </p>
              <div class="active-meta">
                <span>
                  <i class="ok" />
                  {{ __t('ui.navigation', '已连接到客户端') }}
                </span>
                <span class="mono">{{ agentStore.activeAgentId }}</span>
              </div>
            </div>
          </article>

          <div class="agent-picker">
            <button
              v-for="agent in agentStore.agents"
              :key="agent.id"
              :class="{ active: agent.id === agentStore.activeAgentId }"
              :disabled="switchingAgent === agent.id"
              @click="selectAgent(agent.id)"
            >
              <span class="picker-avatar">
                <img
                  v-if="agent.avatarUrl"
                  :src="`${getApiBaseUrl()}${agent.avatarUrl}`"
                  :alt="agent.name"
                />
                <i v-else>{{ agent.name?.[0] ?? '?' }}</i>
              </span>
              <strong>{{ agent.name }}</strong>
              <small class="mono">{{ agent.id }}</small>
              <PixelIcon v-if="agent.id === agentStore.activeAgentId" name="check" size="xs" />
            </button>
          </div>
        </div>

        <section v-if="errorMessage" class="launch-recovery" aria-live="polite" aria-atomic="true">
          <span class="recovery-icon" aria-hidden="true"><PixelIcon name="alert" size="sm" /></span>
          <div class="recovery-message">
            <h2>{{ errorMessage }}</h2>
            <p>{{ errorHint }}</p>
          </div>
          <div class="recovery-actions">
            <button
              type="button"
              class="recovery-retry"
              :disabled="phase === 'connecting' || phase === 'entering'"
              @click="retry"
            >
              <PixelIcon name="refresh" size="xs" />
              {{ __t('ui.launcher', '重试启动') }}
            </button>
            <button type="button" class="recovery-details" @click="showDiagnostic = true">
              <PixelIcon name="terminal" size="xs" />
              {{ __t('ui.launcher', '查看诊断') }}
            </button>
          </div>
        </section>
        <div class="launch-bottom">
          <div id="launcher-readiness" class="check-list">
            <div
              v-for="item in checks"
              :key="item.id"
              class="check-card"
              :data-status="item.status"
            >
              <span class="check-card-label">
                <i :class="item.status" aria-hidden="true" />
                <span>{{ checkFriendlyLabel[item.id] ?? item.label }}</span>
              </span>
              <strong>{{ checkStatusLabel(item.status) }}</strong>
            </div>
          </div>
          <div class="launch-actions">
            <button
              id="launcher-primary-action"
              ref="launchTrigger"
              class="primary-action"
              :class="{ 'is-open': launchMenuOpen }"
              type="button"
              :aria-haspopup="launchesDesktopGuide ? undefined : 'menu'"
              :aria-expanded="launchesDesktopGuide ? undefined : launchMenuOpen"
              :aria-controls="launchesDesktopGuide ? undefined : 'launcher-start-menu'"
              :disabled="!['ready', 'done'].includes(phase) || onboardingLaunching"
              @click="primaryLaunch"
              @keydown.down.prevent="primaryLaunch"
            >
              <span class="launch-power" aria-hidden="true">
                <PixelIcon name="power" size="sm" />
              </span>
              <strong>
                {{ phase === 'entering' ? enteringText : __t('ui.navigation', '启动') }}
              </strong>
              <span
                v-if="!launchesDesktopGuide"
                class="launch-chevron"
                :class="{ open: launchMenuOpen }"
              >
                <PixelIcon name="chevron-down" size="xs" />
              </span>
            </button>
          </div>
        </div>
      </section>

      <!-- 运行环境 -->
      <section
        v-else-if="activeTab === 'environment'"
        id="launcher-environment-content"
        class="page"
      >
        <div class="page-head">
          <div>
            <span class="page-eyebrow">{{ __t('ui.navigation', '这台电脑的情况') }}</span>
            <h1>{{ __t('ui.navigation', '运行环境') }}</h1>
            <p>{{ __t('ui.navigation', '看看客户端的运行状态，出问题时也能更快定位。') }}</p>
          </div>
          <button class="ghost-action" :disabled="loadingInfo" @click="refreshClientInfo">
            <PixelIcon name="refresh" size="xs" />
            {{ __t('ui.navigation', '重新检测') }}
          </button>
        </div>

        <div class="diagnostic-grid">
          <article class="env-card">
            <header>
              <PixelIcon name="desktop" size="sm" />
              <div>
                <strong>{{ __t('ui.navigation', '客户端') }}</strong>
                <span class="mono">APP</span>
              </div>
            </header>
            <dl>
              <div>
                <dt>{{ __t('ui.navigation', '版本') }}</dt>
                <dd class="mono">{{ clientInfo?.version }}</dd>
              </div>
              <div>
                <dt>{{ __t('ui.navigation', '渠道') }}</dt>
                <dd>{{ editionName }}</dd>
              </div>
              <div>
                <dt>{{ __t('ui.navigation', '形式') }}</dt>
                <dd>
                  {{
                    clientInfo?.isPackaged
                      ? __t('ui.navigation', '安装包')
                      : __t('ui.navigation', '源码运行')
                  }}
                </dd>
              </div>
              <div>
                <dt>{{ __t('ui.navigation', '设备名') }}</dt>
                <dd class="mono">{{ clientInfo?.hostname }}</dd>
              </div>
            </dl>
          </article>
          <article class="env-card">
            <header>
              <PixelIcon name="cpu" size="sm" />
              <div>
                <strong>{{ __t('ui.navigation', '电脑') }}</strong>
                <span class="mono">SYSTEM</span>
              </div>
            </header>
            <dl>
              <div>
                <dt>{{ __t('ui.navigation', '系统') }}</dt>
                <dd>{{ clientInfo?.osName }} {{ clientInfo?.osVersion }}</dd>
              </div>
              <div>
                <dt>{{ __t('ui.navigation', '架构') }}</dt>
                <dd class="mono">{{ clientInfo?.architecture }}</dd>
              </div>
              <div>
                <dt>{{ __t('ui.navigation', '处理器') }}</dt>
                <dd>{{ clientInfo?.cpuModel }}</dd>
              </div>
              <div>
                <dt>{{ __t('ui.navigation', '内存') }}</dt>
                <dd class="mono">
                  {{ formatBytes(clientInfo?.memoryUsed ?? 0) }} /
                  {{ formatBytes(clientInfo?.memoryTotal ?? 0) }}
                </dd>
              </div>
            </dl>
          </article>
          <article class="env-card">
            <header>
              <PixelIcon name="code" size="sm" />
              <div>
                <strong>{{ __t('ui.navigation', '运行时') }}</strong>
                <span class="mono">RUNTIME</span>
              </div>
            </header>
            <dl>
              <div>
                <dt>Electron</dt>
                <dd class="mono">{{ clientInfo?.electronVersion }}</dd>
              </div>
              <div>
                <dt>Chromium</dt>
                <dd class="mono">{{ clientInfo?.chromiumVersion }}</dd>
              </div>
              <div>
                <dt>Node.js</dt>
                <dd class="mono">{{ clientInfo?.nodeVersion }}</dd>
              </div>
              <div>
                <dt>{{ __t('ui.navigation', '后台服务') }}</dt>
                <dd :class="phase === 'ready' ? 'ok-text' : 'warn-text'">
                  {{
                    phase === 'ready'
                      ? __t('ui.navigation', '已连接')
                      : __t('ui.navigation', '连接中')
                  }}
                </dd>
              </div>
            </dl>
          </article>
          <article class="env-card">
            <header>
              <PixelIcon name="layout" size="sm" />
              <div>
                <strong>{{ __t('ui.navigation', '窗口') }}</strong>
                <span class="mono">WINDOWS</span>
              </div>
            </header>
            <dl>
              <div>
                <dt>{{ __t('ui.navigation', '启动器') }}</dt>
                <dd>{{ __t('ui.navigation', '已打开') }}</dd>
              </div>
              <div>
                <dt>{{ __t('ui.navigation', '主界面') }}</dt>
                <dd>
                  {{
                    clientInfo?.windows.dashboard
                      ? __t('ui.navigation', '已打开')
                      : __t('ui.navigation', '未打开')
                  }}
                </dd>
              </div>
              <div>
                <dt>{{ __t('ui.navigation', '桌宠') }}</dt>
                <dd>
                  {{
                    clientInfo?.windows.pet
                      ? __t('ui.navigation', '已打开')
                      : __t('ui.navigation', '未打开')
                  }}
                </dd>
              </div>
              <div>
                <dt>{{ __t('ui.navigation', '桌面能力') }}</dt>
                <dd>
                  {{
                    phase === 'ready'
                      ? __t('ui.navigation', '可用')
                      : __t('ui.navigation', '等待服务')
                  }}
                </dd>
              </div>
            </dl>
          </article>
        </div>
      </section>

      <!-- 版本公告 -->
      <section v-else-if="activeTab === 'updates'" class="page updates-page">
        <div class="page-head update-head">
          <div>
            <span class="page-eyebrow">{{ __t('ui.navigation', '新版本有什么变化') }}</span>
            <h1>{{ __t('ui.navigation', '版本公告') }}</h1>
            <p>{{ __t('ui.navigation', '先看看这次更新了什么，再决定要不要升级。') }}</p>
          </div>
          <div class="release-identity">
            <span>{{ release?.tagName || 'LATEST' }}</span>
            <strong>
              {{
                release ? formatDate(release.publishedAt) : __t('ui.navigation', '正在连接 GitHub…')
              }}
            </strong>
          </div>
        </div>

        <div class="release-workspace">
          <article id="launcher-release-notice" class="release-notice">
            <header class="release-notice__head">
              <div class="release-symbol"><PixelIcon name="sparkle" size="md" /></div>
              <div>
                <small>{{ __t('ui.navigation', '最新版本公告') }}</small>
                <h2>{{ release?.name ?? __t('ui.navigation', '正在获取版本公告…') }}</h2>
                <p v-if="release">
                  {{ __t('ui.navigation', '发布于') }} {{ formatDate(release.publishedAt) }}
                  <em v-if="release.cached">{{ __t('ui.navigation', '离线缓存') }}</em>
                </p>
              </div>
              <button
                :disabled="loadingRelease"
                :title="__t('ui.navigation', '刷新公告')"
                @click="loadRelease"
              >
                <PixelIcon name="refresh" size="xs" />
              </button>
            </header>
            <div class="release-notice__body">
              <AsyncMarkdown v-if="release?.body" :content="release.body" />
              <div v-else class="release-empty">
                <PixelIcon name="download" size="lg" />
                <span>{{ __t('ui.navigation', '正在读取 GitHub Release…') }}</span>
              </div>
            </div>
            <footer v-if="release">
              <span>{{ __t('ui.navigation', '内容来自项目的 GitHub Release') }}</span>
              <button @click="invoke('open-external-url', { url: release.htmlUrl })">
                {{ __t('ui.navigation', '在网页里看') }}
                <PixelIcon name="external-link" size="xs" />
              </button>
            </footer>
          </article>

          <aside class="update-console">
            <header>
              <div>
                <span class="mono">CLIENT UPDATE</span>
                <strong>{{ __t('ui.navigation', '客户端更新') }}</strong>
              </div>
              <b>{{ editionName }}</b>
            </header>
            <div class="version-stack">
              <div>
                <small>{{ __t('ui.navigation', '当前版本') }}</small>
                <strong class="mono">v{{ clientInfo?.version }}</strong>
              </div>
              <PixelIcon name="arrow-right" size="sm" />
              <div>
                <small>{{ __t('ui.navigation', '最新版本') }}</small>
                <strong class="mono">
                  {{
                    updateState?.selectedVersion || updateState?.latestVersion
                      ? `v${updateState.selectedVersion ?? updateState.latestVersion}`
                      : release?.tagName || '—'
                  }}
                </strong>
              </div>
            </div>
            <div class="update-state-line">
              <i :class="updateState?.phase" />
              <div>
                <strong>
                  {{ updateState?.message ?? __t('ui.navigation', '正在读取更新状态') }}
                </strong>
                <span>{{ __t('ui.navigation', '当前是') }}{{ editionName }}</span>
              </div>
            </div>
            <div v-if="updateState?.phase === 'downloading'" class="progress-track">
              <i :style="{ width: `${updateState.progress}%` }" />
              <span>{{ updateState.progress }}%</span>
            </div>

            <div v-if="clientInfo?.edition === 'development'" class="development-box">
              <header>
                <PixelIcon name="code" size="xs" />
                <strong>{{ __t('ui.navigation', '开发工作区') }}</strong>
              </header>
              <dl>
                <div>
                  <dt>{{ __t('ui.navigation', '分支') }}</dt>
                  <dd class="mono">
                    {{ clientInfo.development.branch ?? __t('ui.navigation', '未知') }}
                  </dd>
                </div>
                <div>
                  <dt>{{ __t('ui.navigation', '提交') }}</dt>
                  <dd class="mono">
                    {{ clientInfo.development.commit ?? __t('ui.navigation', '未知') }}
                  </dd>
                </div>
                <div>
                  <dt>{{ __t('ui.navigation', '状态') }}</dt>
                  <dd :class="clientInfo.development.dirty ? 'warn-text' : 'ok-text'">
                    {{
                      clientInfo.development.dirty
                        ? __t('ui.navigation', '有本地修改')
                        : __t('ui.navigation', '工作区干净')
                    }}
                  </dd>
                </div>
              </dl>
              <p>{{ __t('ui.navigation', '开发版请手动更新代码。') }}</p>
            </div>

            <div class="update-actions">
              <template v-if="clientInfo?.edition === 'development'">
                <button class="ghost-action" @click="invoke('open-client-path', 'app')">
                  {{ __t('ui.navigation', '打开目录') }}
                </button>
                <button class="primary-small" @click="copyUpdateCommand">
                  {{ __t('ui.navigation', '复制更新命令') }}
                </button>
              </template>
              <template v-else-if="clientInfo?.edition === 'steam'">
                <button class="ghost-action" disabled>
                  {{ __t('ui.navigation', '由 Steam 管理更新') }}
                </button>
              </template>
              <template v-else>
                <button
                  class="ghost-action"
                  :disabled="
                    ['checking', 'downloading', 'installing'].includes(updateState?.phase ?? '')
                  "
                  @click="checkUpdate"
                >
                  {{ __t('ui.navigation', '检查更新') }}
                </button>
                <button
                  v-if="
                    updateState?.phase === 'available' ||
                    (updateState?.phase === 'error' && !updateState.canInstall)
                  "
                  class="primary-small"
                  @click="downloadUpdate"
                >
                  {{ __t('ui.navigation', '下载更新') }}
                </button>
                <button
                  v-if="
                    updateState?.phase === 'downloaded' ||
                    (updateState?.canInstall && updateState.phase !== 'installing')
                  "
                  class="primary-small"
                  @click="installUpdate"
                >
                  {{ __t('ui.navigation', '安装并重启') }}
                </button>
              </template>
            </div>
          </aside>
        </div>
      </section>

      <!-- 关于 -->
      <section v-else class="page about-page">
        <div class="page-head">
          <div>
            <span class="page-eyebrow">{{ __t('ui.navigation', '关于这个伙伴') }}</span>
            <h1>{{ __t('ui.navigation', '关于客户端') }}</h1>
            <p>{{ __t('ui.navigation', '项目入口、数据位置和客户端协议都在这里。') }}</p>
          </div>
        </div>
        <div class="about-hero">
          <div class="about-logo"><InfosLogo variant="mark" /></div>
          <div>
            <span class="mono">INFRASTRUCTURE · INFOMORPH · INFINITY</span>
            <h2>{{ __t('ui.navigation', '萌动链接：PeroperoChat！') }}</h2>
            <p>Your Warm, and Infinite Companion</p>
          </div>
          <strong class="mono">v{{ clientInfo?.version ?? appVersion }}</strong>
        </div>
        <div class="about-grid">
          <button @click="invoke('open-external-url', { url: 'https://github.com/YoKONCy/infOS' })">
            <PixelIcon name="code" size="sm" />
            <span>
              <strong>{{ __t('ui.navigation', '项目主页') }}</strong>
              <small>GitHub Repository</small>
            </span>
          </button>
          <button
            @click="invoke('open-external-url', { url: 'https://github.com/YoKONCy/infOS/issues' })"
          >
            <PixelIcon name="chat" size="sm" />
            <span>
              <strong>{{ __t('ui.navigation', '问题反馈') }}</strong>
              <small>Issues & Feedback</small>
            </span>
          </button>
          <button @click="invoke('open-client-path', 'data')">
            <PixelIcon name="database" size="sm" />
            <span>
              <strong>{{ __t('ui.navigation', '数据目录') }}</strong>
              <small class="mono">{{ clientInfo?.dataPath }}</small>
            </span>
          </button>
          <button @click="invoke('open-client-path', 'logs')">
            <PixelIcon name="file" size="sm" />
            <span>
              <strong>{{ __t('ui.navigation', '日志目录') }}</strong>
              <small class="mono">{{ clientInfo?.logsPath }}</small>
            </span>
          </button>
          <button @click="triggerEula">
            <PixelIcon name="shield" size="sm" />
            <span>
              <strong>{{ __t('ui.navigation', '用户协议') }}</strong>
              <small>{{ __t('ui.navigation', '重新查看 EULA') }}</small>
            </span>
          </button>
          <button @click="triggerOnboarding">
            <PixelIcon name="book" size="sm" />
            <span>
              <strong>{{ __t('ui.navigation', '新手引导') }}</strong>
              <small>{{ __t('ui.navigation', '重新看一遍引导') }}</small>
            </span>
          </button>
        </div>
      </section>
    </main>

    <Teleport to="body">
      <div v-if="showEula" class="eula-mask" :class="{ 'launcher-dark': theme === 'dark' }">
        <div class="eula-dialog">
          <header class="eula-head">
            <div class="eula-icon"><PixelIcon name="shield" size="lg" /></div>
            <div>
              <h2>
                {{ __t('ui.navigation', '用户许可协议') }}
                <em>REQUIRED</em>
              </h2>
              <span class="mono">END USER LICENSE AGREEMENT</span>
            </div>
          </header>

          <div class="eula-body">
            <p class="eula-welcome">
              <PixelIcon name="heart" size="xs" />
              {{ __t('ui.navigation', '欢迎使用 萌动链接：PeroperoChat！（以下简称“本软件”）。') }}
            </p>
            <p>
              {{
                __t(
                  'ui.navigation',
                  '在使用本软件之前，请您务必仔细阅读并理解《最终用户许可协议》（以下简称“本协议”）。本软件是一个开源项目，我们鼓励社区共建与共享。',
                )
              }}
            </p>

            <h4>{{ __t('ui.navigation', '1. 开源许可与分发') }}</h4>
            <p>
              {{
                __t(
                  'ui.navigation',
                  '本软件基于开源协议发布，您可以自由地查看、修改和分发源代码，但须遵守对应的开源许可条款。再分发时请保留原始版权声明与许可信息。',
                )
              }}
            </p>

            <h4>{{ __t('ui.navigation', '2. AI 生成内容免责声明') }}</h4>
            <p>
              {{
                __t(
                  'ui.navigation',
                  '本软件作为工具平台，集成并调用第三方大语言模型（LLM）服务。所有由 AI 生成的文字、图像及其他内容均由模型自动产出，不代表开发者的观点或立场。开发者不对 AI 生成内容的准确性、合法性或适用性承担任何责任。您应自行甄别并审慎使用 AI 生成的内容，因使用 AI 输出内容所产生的一切后果由用户自行承担。',
                )
              }}
            </p>

            <h4>{{ __t('ui.navigation', '3. 隐私与数据安全') }}</h4>
            <p>
              {{
                __t(
                  'ui.navigation',
                  '本软件高度重视您的隐私。您的对话记录、角色配置和个人数据默认仅存储在本地设备上，不会被上传至开发者的服务器。若您配置了第三方 API（如 LLM 接口），相关数据将依据该第三方服务的隐私政策进行处理，请知悉。',
                )
              }}
            </p>

            <h4>{{ __t('ui.navigation', '4. 使用规范') }}</h4>
            <p>
              {{
                __t(
                  'ui.navigation',
                  '您不得利用本软件从事任何违反所在地区法律法规的活动，包括但不限于生成和传播违法有害信息。请遵守社区公约，共同维护友善、健康的使用环境。',
                )
              }}
            </p>

            <h4>{{ __t('ui.navigation', '5. 免责与风险提示') }}</h4>
            <p>
              {{
                __t(
                  'ui.navigation',
                  '本软件按“原样”提供，不附带任何形式的明示或暗示担保。开发者不对因使用或无法使用本软件而导致的任何直接或间接损失承担责任。本软件可能集成第三方组件，其稳定性与安全性由各自维护者负责。',
                )
              }}
            </p>

            <p class="eula-note">
              <PixelIcon name="check" size="xs" />
              {{ __t('ui.navigation', '点击“同意并继续”即表示您已阅读并同意上述所有条款喵~') }}
            </p>
          </div>

          <footer class="eula-foot">
            <button class="eula-button eula-decline" @click="declineEula">
              {{ __t('ui.navigation', '拒绝并退出') }}
            </button>
            <button class="eula-button eula-accept" @click="acceptEula">
              <PixelIcon name="check" size="xs" />
              <span>{{ __t('ui.navigation', '同意并继续') }}</span>
            </button>
          </footer>
        </div>
      </div>
    </Teleport>
    <Teleport to="body">
      <Transition name="launch-menu">
        <div
          v-if="launchMenuOpen"
          id="launcher-start-menu"
          ref="launchMenu"
          class="launcher-start-menu"
          :class="{ 'launcher-dark': theme === 'dark', 'opens-below': launchMenuBelow }"
          :style="launchPlacement"
          role="menu"
          @keydown="launchMenuKey"
        >
          <button type="button" role="menuitem" @click="launch('pet')">
            <i class="launch-mode-icon" aria-hidden="true"><PixelIcon name="heart" size="sm" /></i>
            <span>{{ __t('ui.navigation', '桌宠模式') }}</span>
            <PixelIcon name="arrow-right" size="xs" />
          </button>
          <button type="button" role="menuitem" @click="launch('app')">
            <i class="launch-mode-icon is-app" aria-hidden="true">
              <PixelIcon name="layout" size="sm" />
            </i>
            <span>{{ __t('ui.navigation', '应用模式') }}</span>
            <PixelIcon name="arrow-right" size="xs" />
          </button>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
/* 浅色沿用原有视觉风格，启动操作单独提供两种主题的按钮配色。 */
.launcher-shell,
.eula-mask,
.launcher-start-menu {
  --launcher-action-top: #ffe1ee;
  --launcher-action-bottom: #f6bfd8;
  --launcher-action-text: #73334e;
  --launcher-action-edge: #be829e;
  --launcher-action-shadow: rgba(124, 71, 95, 0.2);
  --launcher-action-highlight: rgba(255, 255, 255, 0.8);
  --launcher-start-surface: #fffdfd;
  --launcher-start-edge: var(--color-moe-cocoa);
  --launcher-start-shadow: rgba(45, 27, 30, 0.2);
  --launcher-start-tint: #ffe4f2;
  --launcher-start-hover: #fff3f8;
  --launcher-start-icon: #b43770;
  --launcher-start-highlight: #fff;
}
.launcher-shell {
  --launcher-recovery-bg: #fff5f8;
  --launcher-recovery-edge: #deb4c5;
  --launcher-recovery-accent: #934562;
  --px: 2px;
  --cocoa: var(--color-moe-cocoa);
  --cocoa-soft: rgba(45, 27, 30, 0.18);
  --pink: var(--color-pink-face);
  --pink-deep: var(--color-pink-shadow);
  --sky: var(--color-sky-face);
  --sky-deep: var(--color-sky-shadow);
  --purple: var(--color-purple-face);
  position: relative;
  height: 100vh;
  padding-top: 32px;
  overflow: hidden;
  background:
    radial-gradient(circle at 12% 16%, rgba(249, 168, 212, 0.2), transparent 30%),
    radial-gradient(circle at 88% 84%, rgba(167, 216, 240, 0.26), transparent 34%),
    linear-gradient(135deg, #fff5fb 0%, #f2faff 55%, #faf7ff 100%);
  color: var(--ui-text-primary);
  font-family: var(--ui-font-sans);
}

/* ── 顶部品牌栏 ── */
.launcher-head {
  position: relative;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 66px;
  padding: 0 26px;
  border-bottom: 2px solid var(--cocoa);
  background: rgba(255, 255, 255, 0.9);
}
.launcher-brand {
  display: flex;
  align-items: center;
  gap: 11px;
}
.brand-mark {
  width: 40px;
  height: 40px;
  overflow: hidden;
}
.brand-mark .infos-logo {
  width: 100%;
  height: 100%;
}
.launcher-brand div:last-child {
  display: flex;
  flex-direction: column;
}
.launcher-wordmark {
  width: 98px;
  height: 31px;
}
.launcher-brand span {
  margin-top: 1px;
  color: var(--ui-text-secondary);
  font: 800 10px var(--ui-font-pixel);
  letter-spacing: 0.2em;
}

.global-signals {
  display: flex;
  align-items: center;
  gap: 8px;
}
.signal,
.badge,
.ver {
  display: flex;
  align-items: center;
  min-height: 26px;
  padding: 0 10px;
  border: 2px solid var(--cocoa);
  border-radius: 4px;
  background: #fff;
  font: 800 11px var(--ui-font-pixel);
  box-shadow: 2px 2px 0 0 var(--cocoa-soft);
}
.signal {
  gap: 6px;
}
.signal i,
.active-meta i {
  width: 8px;
  height: 8px;
  background: var(--color-amber-face);
}
.signal i.ok,
.active-meta i.ok {
  background: var(--color-emerald-face);
}
.badge {
  background: var(--sky);
  color: #fff;
}
.ver {
  color: var(--ui-text-secondary);
  font-family: var(--ui-font-mono);
}

/* ── 顶部 Tab ── */
.launcher-tabs {
  position: relative;
  z-index: 2;
  display: flex;
  align-items: stretch;
  gap: 8px;
  height: 58px;
  padding: 8px 26px;
  border-bottom: 2px solid var(--cocoa);
  background: rgba(255, 255, 255, 0.72);
  backdrop-filter: blur(8px);
}
.launcher-tabs button {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 156px;
  padding: 0 14px;
  border: 2px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: var(--ui-text-secondary);
  font-size: 13px;
  cursor: pointer;
  transition:
    transform 0.12s ease,
    background 0.12s ease;
}
.launcher-tabs button:hover {
  background: rgba(249, 168, 212, 0.12);
  transform: translateY(-1px);
}
.launcher-tabs button.active {
  border-color: var(--cocoa);
  background: linear-gradient(180deg, #ffe4f2, #ffd1ea);
  color: #831843;
  box-shadow: 3px 3px 0 0 var(--cocoa-soft);
  transform: translateY(-1px);
}
.launcher-tabs button.active::after {
  position: absolute;
  right: 6px;
  bottom: -6px;
  left: 6px;
  height: 3px;
  background: linear-gradient(90deg, var(--pink-deep), var(--sky-deep));
  content: '';
}
.tab-code {
  font: 800 11px var(--ui-font-mono);
  color: var(--ui-text-tertiary);
}
.launcher-tabs button.active .tab-code {
  color: #831843;
}
.launcher-tabs button strong {
  font: 800 13px var(--ui-font-pixel);
  letter-spacing: 0.02em;
}
.tab-signal {
  position: absolute;
  top: 10px;
  right: 10px;
  width: 8px;
  height: 8px;
}
.tab-signal.warn {
  background: var(--color-amber-face);
}
.tab-signal.update {
  background: var(--sky);
}

/* ── 内容区 ── */
.launcher-content {
  position: relative;
  z-index: 1;
  height: calc(100vh - 156px);
  overflow: hidden;
}
.page {
  width: min(1380px, 100%);
  height: 100%;
  margin: 0 auto;
  padding: 24px 32px 40px;
  overflow: auto;
}

.page-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 18px;
}
.page-eyebrow {
  color: var(--pink-deep);
  font: 900 11px var(--ui-font-mono);
  letter-spacing: 0.12em;
}
.page-head h1 {
  margin: 5px 0 4px;
  color: var(--ui-text-primary);
  font-size: 24px;
  letter-spacing: -0.01em;
}
.page-head p {
  margin: 0;
  color: var(--ui-text-secondary);
  font-size: 13px;
}
.check-score {
  padding: 8px 13px;
  border: 2px solid var(--cocoa);
  background: #fff;
  box-shadow: 3px 3px 0 0 var(--cocoa-soft);
  text-align: right;
}
.check-score strong {
  display: block;
  color: var(--sky-deep);
  font: 800 22px var(--ui-font-pixel);
}
.check-score span {
  color: var(--ui-text-secondary);
  font-size: 11px;
}

/* ── 启动页 ── */
.agent-stage {
  display: grid;
  grid-template-columns: minmax(320px, 0.9fr) 1.4fr;
  gap: 16px;
}
.active-agent-card {
  display: flex;
  align-items: center;
  gap: 18px;
  min-height: 158px;
  padding: 18px;
  border: 2px solid var(--cocoa);
  background: linear-gradient(135deg, #fff, #ffeef8);
  box-shadow: 5px 5px 0 0 var(--cocoa-soft);
}
.active-avatar {
  position: relative;
  width: 100px;
  height: 100px;
  flex-shrink: 0;
  overflow: hidden;
  border: 2px solid var(--cocoa);
  background: var(--pink);
  box-shadow:
    inset 0 0 0 4px #fff,
    3px 3px 0 0 var(--cocoa-soft);
}
.active-avatar img,
.picker-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.active-avatar span {
  display: grid;
  height: 100%;
  place-items: center;
  color: #fff;
  font-size: 40px;
  font-weight: 900;
}
.active-copy {
  min-width: 0;
}
.active-copy small {
  color: var(--pink-deep);
  font: 900 10px var(--ui-font-pixel);
  letter-spacing: 0.1em;
}
.active-copy h2 {
  margin: 6px 0;
  font-size: 26px;
}
.active-copy p {
  margin: 0;
  color: var(--ui-text-secondary);
  font-size: 13px;
  line-height: 1.5;
}
.active-meta {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 13px;
  color: var(--ui-text-secondary);
  font-size: 11px;
}
.active-meta span {
  display: flex;
  align-items: center;
  gap: 6px;
}
.active-meta .mono,
.mono {
  font-family: var(--ui-font-mono);
}

.agent-picker {
  display: grid;
  grid-template-columns: repeat(3, minmax(120px, 1fr));
  gap: 10px;
  align-content: start;
}
.agent-picker button {
  position: relative;
  display: grid;
  grid-template-columns: 46px 1fr auto;
  grid-template-rows: 1fr 1fr;
  align-items: center;
  column-gap: 10px;
  min-height: 76px;
  padding: 10px;
  border: 2px solid var(--cocoa);
  background: rgba(255, 255, 255, 0.92);
  box-shadow: 3px 3px 0 0 var(--cocoa-soft);
  text-align: left;
  cursor: pointer;
  transition:
    transform 0.12s ease,
    background 0.12s ease;
}
.agent-picker button:hover {
  background: #fef2f9;
  transform: translateY(-2px);
}
.agent-picker button.active {
  background: #ffe4f2;
  box-shadow: 4px 4px 0 0 var(--pink-deep);
}
.agent-picker button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.picker-avatar {
  grid-row: 1 / 3;
  width: 44px;
  height: 44px;
  overflow: hidden;
  border: 2px solid var(--cocoa);
  background: var(--sky);
}
.picker-avatar i {
  display: grid;
  height: 100%;
  place-items: center;
  color: #fff;
  font-style: normal;
  font-weight: 900;
}
.agent-picker strong {
  align-self: end;
  font-size: 13px;
}
.agent-picker small {
  align-self: start;
  overflow: hidden;
  color: var(--ui-text-tertiary);
  font: 10px var(--ui-font-mono);
  text-overflow: ellipsis;
}

.launch-bottom {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  margin-top: 18px;
}
.check-list {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  flex: 1;
  min-width: 0;
  gap: 8px;
}
.check-list .check-card {
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: flex-start;
  min-width: 0;
  min-height: 66px;
  gap: 6px;
  padding: 10px 12px;
  overflow: hidden;
  border: 2px solid var(--cocoa);
  background: #fff;
  box-shadow: 2px 2px 0 0 var(--cocoa-soft);
  font-size: 12px;
}
.check-card-label {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  width: 100%;
  color: var(--ui-text-secondary);
  font-size: 11px;
}
.check-card-label > span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.check-list i {
  width: 6px;
  height: 6px;
  flex-shrink: 0;
  background: var(--ui-text-disabled);
}
.check-list i.ok {
  background: var(--color-emerald-face);
}
.check-list i.warn,
.check-list i.running {
  background: var(--color-amber-face);
}
.check-list i.error {
  background: var(--color-red-face);
}
.check-list strong {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ui-text-secondary);
  font-size: 12px;
  font-weight: 700;
}
.check-list .check-card[data-status='error'] {
  border-color: var(--launcher-recovery-edge);
  background: var(--launcher-recovery-bg);
}
.check-card[data-status='error'] strong {
  color: var(--launcher-recovery-accent);
}
.signal i.error {
  background: var(--launcher-recovery-accent);
}
.launch-recovery {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr) auto;
  align-items: center;
  gap: 14px;
  min-width: 0;
  margin-top: 18px;
  padding: 16px 18px;
  border: 1px solid var(--launcher-recovery-edge);
  border-left-width: 3px;
  border-radius: 4px;
  background: var(--launcher-recovery-bg);
}
.recovery-icon {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border: 1px solid var(--launcher-recovery-edge);
  border-radius: 3px;
  color: var(--launcher-recovery-accent);
}
.recovery-message {
  min-width: 0;
}
.recovery-message h2 {
  margin: 0;
  color: var(--ui-text-primary);
  font-size: 14px;
  font-weight: 800;
}
.recovery-message p {
  margin: 5px 0 0;
  color: var(--ui-text-secondary);
  font-size: 12px;
  line-height: 1.6;
}
.recovery-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}
.recovery-actions button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 34px;
  padding: 7px 10px;
  border: 1px solid transparent;
  border-radius: 3px;
  background: transparent;
  font: 700 12px var(--ui-font-sans);
  white-space: nowrap;
  cursor: pointer;
}
.recovery-actions .recovery-retry {
  border-color: var(--launcher-recovery-edge);
  background: var(--launcher-start-surface);
  color: var(--launcher-recovery-accent);
}
.recovery-details {
  color: var(--ui-text-secondary);
}
.recovery-actions button:hover:not(:disabled) {
  background: var(--launcher-start-hover);
}
.recovery-actions button:disabled {
  opacity: 0.5;
  cursor: default;
}
.recovery-actions button:focus-visible {
  outline: 2px solid var(--launcher-recovery-accent);
  outline-offset: 3px;
}

.launch-actions {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 9px;
}
.primary-action,
.ghost-action,
.primary-small {
  border: 2px solid var(--cocoa);
  border-radius: 4px;
  font-weight: 800;
  cursor: pointer;
}
.primary-action {
  display: grid;
  grid-template-columns: 30px 1fr 23px;
  align-items: center;
  gap: 13px;
  min-width: 164px;
  height: 48px;
  padding: 7px 10px 7px 7px;
  border-color: var(--launcher-start-edge);
  border-radius: 4px;
  background: var(--launcher-start-surface);
  color: var(--ui-text-primary);
  box-shadow:
    inset 0 1px 0 var(--launcher-start-highlight),
    3px 3px 0 var(--launcher-start-shadow);
  transition:
    transform 160ms ease,
    box-shadow 160ms ease,
    background 160ms ease;
}
.primary-action:hover:not(:disabled):not(:active):not(.is-open) {
  background: var(--launcher-start-hover);
  transform: translateY(-1px);
  box-shadow:
    inset 0 1px 0 var(--launcher-start-highlight),
    3px 4px 0 var(--launcher-start-shadow);
}
.primary-action:active:not(:disabled),
.primary-action.is-open:not(:disabled) {
  transform: translate(2px, 2px);
  background: var(--launcher-start-hover);
  box-shadow:
    inset 0 1px 0 var(--launcher-start-highlight),
    1px 1px 0 var(--launcher-start-shadow);
}
.primary-action:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  box-shadow: none;
}
.primary-action strong {
  text-align: left;
  font: 800 14px var(--ui-font-pixel);
  letter-spacing: 0.08em;
}
.launch-power {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border: 1px solid color-mix(in srgb, var(--launcher-start-icon) 22%, transparent);
  border-radius: 3px;
  background: var(--launcher-start-tint);
  color: var(--launcher-start-icon);
}
.launch-chevron {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  height: 18px;
  border-left: 1px solid var(--ui-border-default);
  color: var(--ui-text-secondary);
}
.launch-chevron :deep(svg) {
  transition: transform 180ms ease;
}
.launch-chevron.open :deep(svg) {
  transform: rotate(180deg);
}
.ghost-action {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 13px;
  background: #fff;
  color: var(--ui-text-primary);
  font-size: 12px;
  box-shadow: 3px 3px 0 0 var(--cocoa-soft);
  transition:
    transform 0.1s ease,
    box-shadow 0.1s ease;
}
.ghost-action:active {
  transform: translate(2px, 2px);
  box-shadow: 1px 1px 0 0 var(--cocoa-soft);
}
.ghost-action:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.primary-small {
  padding: 10px 14px;
  border-color: var(--launcher-action-edge);
  background: linear-gradient(180deg, var(--launcher-action-top), var(--launcher-action-bottom));
  color: var(--launcher-action-text);
  font-size: 12px;
  box-shadow:
    inset 0 1px 0 var(--launcher-action-highlight),
    0 3px 0 var(--launcher-action-shadow);
}

/* ── 运行环境页 ── */
.diagnostic-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 14px;
}
.env-card {
  padding: 16px;
  border: 2px solid var(--cocoa);
  background: #fff;
  box-shadow: 4px 4px 0 0 var(--cocoa-soft);
}
.env-card header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-bottom: 12px;
  border-bottom: 2px solid var(--cocoa-soft);
  color: var(--sky-deep);
}
.env-card header div {
  display: flex;
  flex-direction: column;
}
.env-card header strong {
  color: var(--ui-text-primary);
  font-size: 15px;
}
.env-card header span {
  color: var(--ui-text-tertiary);
  font: 800 10px var(--ui-font-mono);
  letter-spacing: 0.1em;
}
.env-card dl {
  margin: 10px 0 0;
}
.env-card dl div {
  display: flex;
  justify-content: space-between;
  gap: 18px;
  padding: 8px 2px;
  border-bottom: 1px dashed var(--ui-border-default);
  font-size: 13px;
}
.env-card dt {
  color: var(--ui-text-tertiary);
}
.env-card dd {
  max-width: 72%;
  margin: 0;
  color: var(--ui-text-primary);
  font-size: 12px;
  text-align: right;
}
.env-card dd.mono {
  font-family: var(--ui-font-mono);
}
.ok-text {
  color: var(--color-emerald-shadow) !important;
}
.warn-text {
  color: var(--color-amber-shadow) !important;
}

/* ── 版本公告页 ── */
.update-head {
  align-items: flex-start;
}
.release-identity {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
}
.release-identity span {
  padding: 4px 9px;
  border: 2px solid var(--cocoa);
  background: #ffe4f2;
  color: #831843;
  font: 800 10px var(--ui-font-mono);
  box-shadow: 2px 2px 0 0 var(--cocoa-soft);
}
.release-identity strong {
  color: var(--ui-text-tertiary);
  font: 600 11px var(--ui-font-mono);
}

.release-workspace {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 320px;
  gap: 16px;
  height: calc(100vh - 240px);
  min-height: 380px;
}
.release-notice,
.update-console {
  overflow: hidden;
  border: 2px solid var(--cocoa);
  background: #fff;
  box-shadow: 5px 5px 0 0 var(--cocoa-soft);
}
.release-notice {
  display: flex;
  min-width: 0;
  height: 100%;
  flex-direction: column;
  border-top: 4px solid var(--pink-deep);
}
.release-notice__head {
  display: grid;
  grid-template-columns: 48px minmax(0, 1fr) 30px;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  border-bottom: 2px solid var(--cocoa-soft);
  background: linear-gradient(100deg, #ffeef8, #fff);
}
.release-symbol {
  display: grid;
  width: 44px;
  height: 44px;
  place-items: center;
  border: 2px solid var(--cocoa);
  background: #fff;
  color: var(--pink-deep);
  box-shadow: 3px 3px 0 0 var(--cocoa-soft);
}
.release-notice__head small {
  color: var(--pink-deep);
  font: 900 10px var(--ui-font-pixel);
  letter-spacing: 0.08em;
}
.release-notice__head h2 {
  margin: 3px 0;
  color: var(--ui-text-primary);
  font-size: 18px;
}
.release-notice__head p {
  margin: 0;
  color: var(--ui-text-tertiary);
  font-size: 11px;
}
.release-notice__head em {
  margin-left: 8px;
  padding: 2px 6px;
  background: var(--color-amber-light);
  color: #78350f;
  font-style: normal;
}
.release-notice__head > button {
  display: grid;
  width: 30px;
  height: 30px;
  place-items: center;
  border: 2px solid var(--cocoa);
  border-radius: 4px;
  background: #fff;
  color: var(--ui-text-secondary);
  cursor: pointer;
}
.release-notice__body {
  min-height: 0;
  flex: 1;
  overflow: auto;
  padding: 14px 22px 20px;
  background: #fff;
}
.release-notice__body :deep(.async-markdown) {
  min-height: 100%;
}
.release-notice__body :deep(.md-body) {
  color: var(--ui-text-secondary);
  font: 400 14px/1.75 var(--ui-font-sans);
}
.release-notice__body :deep(.md-body h1) {
  padding-bottom: 8px;
  border-bottom: 2px solid var(--cocoa-soft);
  color: var(--ui-text-primary);
  font-size: 22px;
}
.release-notice__body :deep(.md-body h2) {
  margin-top: 1.2em;
  color: var(--pink-deep);
  font-size: 17px;
}
.release-notice__body :deep(.md-body h3) {
  color: var(--ui-text-primary);
  font-size: 15px;
}
.release-notice__body :deep(.md-body code) {
  border: 1px solid var(--ui-border-default);
  border-radius: 3px;
  background: #fafbfc;
  color: var(--ui-accent-purple);
  font-family: var(--ui-font-mono);
}
.release-notice__body :deep(.md-body pre) {
  border: 2px solid var(--cocoa);
  border-radius: 4px;
  background: #1e293b;
}
.release-notice__body :deep(.md-body pre code) {
  background: none;
  border: 0;
  color: #e2e8f0;
}
.release-notice__body :deep(.md-body th) {
  background: rgba(167, 216, 240, 0.35);
}
.release-notice__body :deep(.md-body blockquote) {
  border-left: 4px solid var(--pink-deep);
  border-radius: 0;
  background: #ffeef8;
}
.release-notice > footer {
  display: flex;
  min-height: 44px;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  border-top: 2px solid var(--cocoa-soft);
  background: #fafbfc;
  color: var(--ui-text-tertiary);
  font-size: 11px;
}
.release-notice > footer button {
  display: flex;
  align-items: center;
  gap: 5px;
  border: 0;
  background: transparent;
  color: var(--sky-deep);
  font-size: 12px;
  font-weight: 800;
  cursor: pointer;
}
.release-empty {
  display: flex;
  height: 100%;
  min-height: 220px;
  align-items: center;
  justify-content: center;
  gap: 9px;
  color: var(--ui-text-tertiary);
  font-size: 13px;
}

.update-console {
  align-self: stretch;
  padding: 16px;
}
.update-console > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 12px;
  border-bottom: 2px solid var(--cocoa-soft);
}
.update-console > header div {
  display: flex;
  flex-direction: column;
}
.update-console > header span {
  color: var(--ui-text-tertiary);
  font: 800 10px var(--ui-font-mono);
  letter-spacing: 0.08em;
}
.update-console > header strong {
  margin-top: 2px;
  font-size: 15px;
}
.update-console > header b {
  padding: 4px 8px;
  border: 2px solid var(--cocoa);
  background: var(--sky);
  color: #fff;
  font: 800 11px var(--ui-font-pixel);
}
.version-stack {
  display: grid;
  grid-template-columns: 1fr 18px 1fr;
  align-items: center;
  gap: 6px;
  padding: 16px 0;
}
.version-stack div {
  display: flex;
  min-width: 0;
  flex-direction: column;
}
.version-stack small {
  color: var(--ui-text-tertiary);
  font-size: 11px;
}
.version-stack strong {
  overflow: hidden;
  margin-top: 3px;
  color: var(--ui-text-primary);
  font: 800 14px var(--ui-font-mono);
  text-overflow: ellipsis;
}
.update-state-line {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 10px;
  border: 2px solid var(--cocoa-soft);
  background: #fafbfc;
}
.update-state-line > i {
  width: 9px;
  height: 9px;
  background: var(--ui-text-disabled);
}
.update-state-line > i.available,
.update-state-line > i.downloaded {
  background: var(--pink-deep);
  box-shadow: 0 0 0 3px rgba(219, 39, 119, 0.14);
}
.update-state-line > i.error {
  background: var(--color-red-face);
}
.update-state-line div {
  display: flex;
  flex-direction: column;
}
.update-state-line strong {
  font-size: 12px;
}
.update-state-line span {
  margin-top: 2px;
  color: var(--ui-text-tertiary);
  font-size: 11px;
}
.progress-track {
  position: relative;
  height: 12px;
  margin-top: 10px;
  border: 2px solid var(--cocoa);
  background: #fff;
}
.progress-track i {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, var(--pink-deep), var(--sky-deep));
}
.progress-track span {
  position: absolute;
  top: -4px;
  right: 6px;
  color: var(--ui-text-primary);
  font: 800 10px var(--ui-font-mono);
}
.development-box {
  margin-top: 12px;
  padding: 11px;
  border: 2px solid var(--color-amber-shadow);
  background: #fff7e0;
}
.development-box > header {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #78350f;
}
.development-box > header strong {
  font-size: 12px;
}
.development-box dl {
  margin: 8px 0;
}
.development-box dl div {
  display: flex;
  justify-content: space-between;
  padding: 4px 0;
  border-bottom: 1px dashed rgba(217, 119, 6, 0.3);
  font-size: 12px;
}
.development-box dt {
  color: #92400e;
}
.development-box dd {
  margin: 0;
  font-family: var(--ui-font-mono);
}
.development-box p {
  margin: 7px 0 0;
  color: #92400e;
  font-size: 11px;
  line-height: 1.5;
}
.update-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 14px;
}

/* ── 关于页 ── */
.about-hero {
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 22px;
  border: 2px solid var(--cocoa);
  background: linear-gradient(120deg, #fff, #ffeef8);
  box-shadow: 5px 5px 0 0 var(--cocoa-soft);
}
.about-logo {
  display: grid;
  width: 76px;
  height: 76px;
  overflow: hidden;
  place-items: center;
}
.about-logo .infos-logo {
  width: 100%;
  height: 100%;
}
.about-hero div:nth-child(2) {
  flex: 1;
}
.about-hero span {
  color: var(--pink-deep);
  font: 800 10px var(--ui-font-mono);
  letter-spacing: 0.08em;
}
.about-hero h2 {
  margin: 5px 0;
  font-size: 28px;
}
.about-hero p {
  margin: 0;
  color: var(--ui-text-secondary);
  font-size: 13px;
}
.about-hero > strong {
  color: var(--pink-deep);
  font: 800 18px var(--ui-font-mono);
}
.about-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
  margin-top: 18px;
}
.about-grid button {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  padding: 15px;
  border: 2px solid var(--cocoa);
  background: #fff;
  color: var(--sky-deep);
  box-shadow: 3px 3px 0 0 var(--cocoa-soft);
  text-align: left;
  cursor: pointer;
  transition:
    transform 0.12s ease,
    background 0.12s ease;
}
.about-grid button:hover {
  background: #fef2f9;
  transform: translateY(-2px);
}
.about-grid button span {
  display: flex;
  min-width: 0;
  flex-direction: column;
}
.about-grid strong {
  color: var(--ui-text-primary);
  font-size: 13px;
}
.about-grid small {
  overflow: hidden;
  color: var(--ui-text-tertiary);
  font: 11px var(--ui-font-mono);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── EULA ── */
.eula-mask {
  --cocoa: var(--color-moe-cocoa);
  --cocoa-soft: rgba(45, 27, 30, 0.18);
  --pink-deep: var(--color-pink-shadow);
  position: fixed;
  z-index: 300;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(45, 27, 30, 0.6);
  backdrop-filter: blur(4px);
}
.eula-dialog {
  display: flex;
  width: min(720px, calc(100vw - 48px));
  height: min(680px, calc(100vh - 48px));
  max-height: none;
  flex-direction: column;
  overflow: hidden;
  border: 2px solid var(--cocoa);
  background: #fff;
  box-shadow: 9px 9px 0 0 var(--cocoa-soft);
}
.eula-head {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 14px;
  min-height: 88px;
  padding: 16px 20px;
  border-bottom: 2px solid var(--cocoa);
  background: linear-gradient(100deg, #ffeef8, #fff);
}
.eula-icon {
  display: grid;
  width: 54px;
  height: 54px;
  flex-shrink: 0;
  place-items: center;
  border: 2px solid var(--cocoa);
  background: var(--pink-deep);
  color: #fff;
  box-shadow: 3px 3px 0 0 var(--cocoa-soft);
}
.eula-head h2 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  color: var(--ui-text-primary);
  font-size: 20px;
}
.eula-head h2 em {
  padding: 2px 7px;
  border: 2px solid var(--cocoa);
  background: #ffe4f2;
  color: #831843;
  font-style: normal;
  font: 800 10px var(--ui-font-pixel);
}
.eula-head span {
  display: block;
  margin-top: 3px;
  color: var(--ui-text-tertiary);
  font: 800 10px var(--ui-font-mono);
  letter-spacing: 0.1em;
}
.eula-body {
  min-height: 0;
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 18px 24px 20px;
  color: var(--ui-text-secondary);
  font-size: 14px;
  line-height: 1.8;
}
.eula-body .eula-welcome {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--pink-deep);
  font-weight: 700;
}
.eula-body h4 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 18px 0 8px;
  color: var(--ui-text-primary);
  font-size: 15px;
}
.eula-body h4::before {
  width: 8px;
  height: 8px;
  flex-shrink: 0;
  background: var(--pink-deep);
  box-shadow: 2px 2px 0 0 var(--cocoa-soft);
  content: '';
}
.eula-body p {
  margin: 0 0 8px;
}
.eula-body .eula-note {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 18px;
  padding-top: 14px;
  border-top: 2px solid var(--cocoa-soft);
  color: var(--ui-text-tertiary);
  font-size: 13px;
}
.eula-foot {
  display: flex;
  flex: 0 0 auto;
  justify-content: flex-end;
  gap: 10px;
  min-height: 72px;
  padding: 14px 20px;
  border-top: 2px solid var(--cocoa);
  background: #fafbfc;
}
.eula-button {
  display: inline-flex;
  min-width: 138px;
  align-items: center;
  justify-content: center;
  gap: 7px;
  height: 42px;
  padding: 0 18px;
  border: 2px solid var(--cocoa);
  border-radius: 4px;
  font: 800 13px var(--ui-font-sans);
  cursor: pointer;
}
.eula-button:active {
  transform: translate(2px, 2px);
}
.eula-decline {
  background: #fff;
  color: var(--ui-text-secondary);
  box-shadow: 3px 3px 0 0 var(--cocoa-soft);
}
.eula-decline:hover {
  background: #fff4f8;
  color: var(--pink-deep);
}
.eula-accept {
  min-width: 174px;
  background: var(--pink-deep);
  color: #fff;
  box-shadow: 3px 3px 0 0 #831843;
}
.eula-accept:hover {
  background: #be185d;
}
@media (max-width: 600px) {
  .eula-dialog {
    width: calc(100vw - 24px);
    height: calc(100vh - 24px);
  }
  .eula-head {
    padding: 12px 14px;
  }
  .eula-body {
    padding: 14px 16px;
    font-size: 13px;
  }
  .eula-foot {
    padding: 10px 14px;
  }
  .eula-button {
    min-width: 0;
    flex: 1;
  }
}

@media (max-width: 820px) {
  .launcher-tabs button {
    min-width: 0;
    flex: 1;
    padding: 0 10px;
  }
  .launcher-tabs button .tab-code {
    display: none;
  }
  .agent-stage,
  .release-workspace {
    grid-template-columns: 1fr;
  }
  .release-workspace {
    height: auto;
  }
  .release-notice {
    height: 420px;
  }
  .diagnostic-grid {
    grid-template-columns: 1fr;
  }
  .about-grid {
    grid-template-columns: repeat(2, 1fr);
  }
  .check-list {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  .global-signals .signal {
    display: none;
  }
}

@media (max-width: 680px) {
  .launch-recovery {
    grid-template-columns: 30px minmax(0, 1fr);
    padding: 14px;
  }
  .recovery-icon {
    width: 30px;
    height: 30px;
  }
  .recovery-actions {
    grid-column: 2;
    justify-content: flex-start;
  }
  .launch-bottom {
    flex-direction: column;
    align-items: stretch;
  }
  .check-list {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .launch-actions {
    justify-content: flex-end;
  }
}

/* 启动菜单与按钮使用同一套主题色，角色区和页面布局保持原样。 */
.launcher-start-menu {
  position: fixed;
  z-index: 10000;
  width: 204px;
  max-width: calc(100vw - 24px);
  padding: 6px;
  border: 2px solid var(--launcher-start-edge);
  border-radius: 4px;
  background: var(--launcher-start-surface);
  color: var(--ui-text-primary);
  box-shadow:
    3px 3px 0 var(--launcher-start-shadow),
    var(--ui-shadow-sm);
  transform-origin: 80% 100%;
}
.launcher-start-menu.opens-below {
  transform-origin: 80% 0;
}
.launcher-start-menu button {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 9px 8px;
  border: 1px solid transparent;
  border-radius: 3px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: 600 13px var(--ui-font-sans);
  transition:
    background 160ms ease,
    border-color 160ms ease,
    color 160ms ease;
}
.launcher-start-menu button span {
  flex: 1;
  text-align: left;
}
.launcher-start-menu button:hover,
.launcher-start-menu button:focus-visible {
  outline: none;
  border-color: color-mix(in srgb, var(--launcher-start-icon) 18%, transparent);
  background: var(--launcher-start-hover);
  color: var(--ui-text-primary);
}
.launch-mode-icon {
  display: grid;
  flex: 0 0 28px;
  place-items: center;
  width: 28px;
  height: 28px;
  border: 1px solid var(--ui-border-subtle);
  border-radius: 3px;
  background: var(--launcher-start-tint);
  color: var(--launcher-start-icon);
}
.launch-mode-icon.is-app {
  background: var(--ui-accent-sky-soft);
  color: var(--ui-accent-sky);
}
.primary-action:focus-visible,
.launcher-start-menu button:focus-visible {
  outline: 2px solid var(--ui-focus-color);
  outline-offset: 3px;
}
.launch-menu-enter-active,
.launch-menu-leave-active {
  transition:
    opacity 0.18s ease,
    transform 0.22s cubic-bezier(0.2, 0.8, 0.2, 1);
}
.launch-menu-enter-from,
.launch-menu-leave-to {
  opacity: 0;
  transform: translateY(5px) scale(0.98);
}
.opens-below.launch-menu-enter-from,
.opens-below.launch-menu-leave-to {
  transform: translateY(-5px) scale(0.98);
}
@media (prefers-reduced-motion: reduce) {
  .launch-menu-enter-active,
  .launch-menu-leave-active,
  .primary-action,
  .launch-chevron :deep(svg),
  .launcher-start-menu button {
    transition: none;
  }
}
</style>

<style scoped src="../assets/launcher-dark.css"></style>
