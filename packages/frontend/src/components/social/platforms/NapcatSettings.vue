<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { t as __t } from '../../../i18n/index'
import { PixelIcon, PButton } from '../../pixel'
import { invoke, isElectron, listen } from '../../../utils/ipcAdapter'
import { useNotificationStore } from '../../../stores'
import { logger } from '../../../lib/logger'
import { useSocialConnectionStatus } from '../../../composables/social/useSocialConnectionStatus'
import SocialAdapterTerminal from '../../terminal/SocialAdapterTerminal.vue'
const notification = useNotificationStore()
const napcatInstalled = ref(false)
const napcatRunning = ref(false)
const napcatVersion = ref<string | null>(null)
const napcatTargetVersion = ref('')
const napcatUpdateAvailable = ref(false)
const napcatBusy = ref(false)
const napcatWebUi = ref('stopped')
const napcatWebUiError = ref('')
const logsOpen = ref(false)
let unlistenNapCat: (() => void) | undefined
let disposed = false
function applyNapCatStatus(value: unknown) {
  const status = value as {
    running?: boolean
    webUi?: string
    webUiError?: string
    version?: string | null
    targetVersion?: string
    updateAvailable?: boolean
    installing?: boolean
  } | null
  if (!status || disposed) return
  napcatRunning.value = status.running === true
  napcatWebUi.value = status.webUi ?? (status.running ? napcatWebUi.value : 'stopped')
  napcatWebUiError.value = status.webUiError ?? ''
  napcatVersion.value = status.version ?? null
  napcatTargetVersion.value = status.targetVersion ?? ''
  napcatUpdateAvailable.value = status.updateAvailable === true
  if (typeof status.installing === 'boolean') napcatInstalling.value = status.installing
}
const napcatChecking = ref(false)
const napcatInstalling = ref(false)
const {
  connected: adapterConnected,
  error: connectionError,
  refresh: refreshConnection,
} = useSocialConnectionStatus(() => 'qq')

/** 是否为 Electron 环境 (进程管理仅 Electron 可用) */
const canManageProcess = isElectron()

/** 检查 NapCat 安装状态 */
async function checkNapCat(): Promise<void> {
  napcatChecking.value = true
  try {
    const installed = await invoke('check-napcat')
    napcatInstalled.value = !!installed
    applyNapCatStatus(await invoke('napcat-status'))

    await refreshConnection()
  } catch {
    napcatInstalled.value = false
  } finally {
    napcatChecking.value = false
  }
}

/** 安装 NapCat */
async function installNapCat(update = false): Promise<void> {
  if (napcatInstalling.value || napcatBusy.value) return
  napcatInstalling.value = true
  try {
    const result = await invoke(update ? 'update-napcat' : 'install-napcat')
    if (!result)
      throw new Error(
        update ? 'NapCat 更新失败，请查看运行日志' : 'NapCat 安装失败，请查看运行日志',
      )
    napcatInstalled.value = true
    applyNapCatStatus(await invoke('napcat-status'))
    notification.toast(
      update
        ? __t('ui.settings', 'NapCat 已更新，可以启动了')
        : __t('ui.settings', 'NapCat 已安装'),
      { type: 'success' },
    )
  } catch (e) {
    logger.error('SocialTab', __t('logs.frontend.settings', 'NapCat 安装或更新失败'), e)
    notification.toast(
      e instanceof Error ? e.message : __t('ui.settings', 'NapCat 安装或更新失败'),
      { type: 'error' },
    )
  } finally {
    napcatInstalling.value = false
  }
}

/** 启动 NapCat */
async function startNapCat(): Promise<void> {
  if (napcatBusy.value) return
  napcatBusy.value = true
  try {
    if (!(await refreshConnection())) throw new Error(connectionError.value || '社交服务尚未就绪')
    await invoke('start-napcat')
    applyNapCatStatus(await invoke('napcat-status'))
  } catch (e) {
    logger.error('SocialTab', __t('logs.frontend.settings', 'NapCat 启动失败'), e)
    notification.toast(e instanceof Error ? e.message : __t('ui.settings', 'NapCat 启动失败'), {
      type: 'error',
      get title() {
        return __t('ui.settings', '启动失败')
      },
    })
  } finally {
    napcatBusy.value = false
  }
}

async function openNapCatDashboard(): Promise<void> {
  if (napcatBusy.value) return
  napcatBusy.value = true
  try {
    await invoke('open-napcat-dashboard')
    applyNapCatStatus(await invoke('napcat-status'))
  } catch (e) {
    notification.toast(e instanceof Error ? e.message : __t('ui.settings', '管理页打开失败'), {
      type: 'error',
      get title() {
        return __t('ui.settings', '打开失败')
      },
    })
  } finally {
    napcatBusy.value = false
  }
}

/** 停止 NapCat */
async function stopNapCat(): Promise<void> {
  if (napcatBusy.value) return
  napcatBusy.value = true
  try {
    await invoke('stop-napcat')
    napcatRunning.value = false
    napcatWebUi.value = 'stopped'
  } catch (e) {
    logger.error('SocialTab', __t('logs.frontend.settings', 'NapCat 停止失败'), e)
  } finally {
    napcatBusy.value = false
  }
}

onMounted(async () => {
  if (!canManageProcess) return
  const stop = await listen('napcat-state-changed', applyNapCatStatus)
  if (disposed) stop()
  else {
    unlistenNapCat = stop
    await checkNapCat()
  }
})
onUnmounted(() => {
  disposed = true
  unlistenNapCat?.()
})
</script>
<template>
  <!-- 中部：NapCat 配置面板 (仅 Electron) -->
  <div v-if="canManageProcess" class="sp-config">
    <div class="sp-config-row">
      <!-- 安装状态 -->
      <div class="sp-config-block">
        <div class="sp-block-header">
          <PixelIcon name="download" size="xs" />
          <span>{{ __t('ui.settings', '进程管理') }}</span>
        </div>
        <div class="sp-block-body">
          <div class="sp-status-line">
            <span class="sp-label">{{ __t('ui.settings', '安装状态') }}</span>
            <span :class="['sp-value', napcatInstalled ? 'sp-ok' : 'sp-na']">
              {{
                napcatChecking
                  ? __t('ui.settings', '检查中...')
                  : napcatInstalled
                    ? __t('ui.settings', '已安装')
                    : __t('ui.settings', '未安装')
              }}
            </span>
          </div>
          <div class="sp-status-line">
            <span class="sp-label">{{ __t('ui.settings', '进程状态') }}</span>
            <span :class="['sp-value', napcatRunning ? 'sp-ok' : 'sp-na']">
              {{ napcatRunning ? __t('ui.settings', '运行中') : __t('ui.settings', '已停止') }}
            </span>
          </div>
          <div v-if="napcatInstalled" class="sp-status-line">
            <span class="sp-label">{{ __t('ui.settings', '版本') }}</span>
            <span class="sp-value">
              {{ napcatVersion ? `v${napcatVersion}` : __t('ui.settings', '未知') }}
            </span>
          </div>
          <div class="sp-status-line">
            <span class="sp-label">{{ __t('ui.settings', '管理页面') }}</span>
            <span :class="['sp-value', napcatWebUi === 'ready' ? 'sp-ok' : 'sp-na']">
              {{
                napcatWebUi === 'ready'
                  ? __t('ui.settings', '已就绪')
                  : napcatWebUi === 'starting'
                    ? __t('ui.settings', '准备中')
                    : napcatWebUi === 'error'
                      ? __t('ui.settings', '暂不可用')
                      : __t('ui.settings', '未启动')
              }}
            </span>
          </div>
          <div class="sp-status-line">
            <span class="sp-label">{{ __t('ui.settings', 'Bot 连接') }}</span>
            <span :class="['sp-value', adapterConnected ? 'sp-ok' : 'sp-na']">
              {{ adapterConnected ? __t('ui.settings', '已连接') : __t('ui.settings', '未连接') }}
            </span>
          </div>
          <p v-if="connectionError" role="alert" class="sp-na">{{ connectionError }}</p>
          <p v-if="napcatWebUiError" role="alert" class="sp-na">{{ napcatWebUiError }}</p>
          <div class="sp-actions">
            <PButton
              v-if="!napcatInstalled"
              size="sm"
              :disabled="napcatInstalling || napcatChecking"
              @click="installNapCat()"
            >
              <PixelIcon name="download" size="xs" />
              {{
                napcatInstalling ? __t('ui.settings', '安装中...') : __t('ui.settings', '一键安装')
              }}
            </PButton>
            <template v-else>
              <PButton
                v-if="!napcatRunning"
                size="sm"
                variant="primary"
                :disabled="napcatBusy || napcatInstalling"
                @click="startNapCat"
              >
                <PixelIcon name="flash" size="xs" />
                {{ __t('ui.settings', '启动') }}
              </PButton>
              <PButton v-else size="sm" variant="ghost" :disabled="napcatBusy" @click="stopNapCat">
                <PixelIcon name="alert" size="xs" />
                {{ __t('ui.settings', '停止') }}
              </PButton>
              <PButton
                v-if="napcatRunning"
                size="sm"
                variant="secondary"
                :disabled="napcatBusy"
                @click="openNapCatDashboard"
              >
                <PixelIcon name="desktop" size="xs" />
                {{ __t('ui.settings', '打开管理页') }}
              </PButton>
            </template>
            <PButton
              v-if="napcatInstalled && napcatUpdateAvailable"
              size="sm"
              variant="secondary"
              :disabled="napcatRunning || napcatBusy || napcatInstalling"
              :title="
                napcatRunning
                  ? __t('ui.settings', '停止 NapCat 后更新')
                  : __t('ui.settings', '更新到 v{0}', [napcatTargetVersion])
              "
              @click="installNapCat(true)"
            >
              <PixelIcon name="download" size="xs" />
              {{
                napcatInstalling
                  ? __t('ui.settings', '更新中…')
                  : __t('ui.settings', '更新至 v{0}', [napcatTargetVersion])
              }}
            </PButton>
            <PButton size="sm" variant="ghost" :disabled="napcatChecking" @click="checkNapCat">
              <PixelIcon name="refresh" size="xs" />
            </PButton>
          </div>
        </div>
      </div>

      <!-- 连接信息 -->
      <div class="sp-config-block">
        <div class="sp-block-header">
          <PixelIcon name="settings" size="xs" />
          <span>{{ __t('ui.settings', '连接配置') }}</span>
        </div>
        <div class="sp-block-body">
          <div class="sp-status-line">
            <span class="sp-label">{{ __t('ui.settings', 'WS 端点') }}</span>
            <span class="sp-value sp-mono">ws://127.0.0.1:9120/api/social/ws?platform=qq</span>
          </div>
          <div class="sp-status-line">
            <span class="sp-label">{{ __t('ui.settings', '协议') }}</span>
            <span class="sp-value">{{ __t('ui.settings', 'OneBot v11 (反向 WS)') }}</span>
          </div>
          <div class="sp-hint">
            {{
              __t('ui.settings', '本机 NapCat 会自动配置连接；QQ 登录与验证在管理标签页中完成。')
            }}
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- Docker 模式提示 -->
  <div v-if="!canManageProcess" class="sp-config">
    <div class="sp-config-row">
      <div class="sp-config-block sp-full">
        <div class="sp-block-header">
          <PixelIcon name="terminal" size="xs" />
          <span>{{ __t('ui.settings', 'Docker 模式') }}</span>
        </div>
        <div class="sp-block-body">
          <div class="sp-status-line">
            <span class="sp-label">{{ __t('ui.settings', 'WS 端点') }}</span>
            <span class="sp-value sp-mono">ws://&lt;host&gt;:9120/api/social/ws?platform=qq</span>
          </div>
          <div class="sp-status-line">
            <span class="sp-label">{{ __t('ui.settings', '连接状态') }}</span>
            <span :class="['sp-value', adapterConnected ? 'sp-ok' : 'sp-na']">
              {{
                adapterConnected
                  ? __t('ui.settings', '已连接')
                  : __t('ui.settings', '等待外部 NapCat 连接...')
              }}
            </span>
          </div>
          <div class="sp-hint">
            {{
              __t(
                'ui.settings',
                'Docker 模式下请在外部独立运行 NapCat，并配置反向 WS 连接到后端容器',
              )
            }}
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- 适配器运行终端属于概览与账号 -->
  <section class="sp-terminal" :class="{ 'sp-terminal-open': logsOpen }">
    <button
      type="button"
      class="sp-block-header sp-terminal-toggle"
      :aria-expanded="logsOpen"
      aria-controls="social-adapter-terminal"
      @click="logsOpen = !logsOpen"
    >
      <PixelIcon name="terminal" size="xs" />
      {{ __t('ui.settings', '运行日志与排障') }}
    </button>
    <div v-if="logsOpen" id="social-adapter-terminal" class="sp-terminal-content">
      <SocialAdapterTerminal />
    </div>
  </section>
</template>
<style scoped src="../socialPanel.css"></style>
