<script setup lang="ts">
import { getDisplayLocale } from '../../i18n/index'

import { t as __t } from '../../i18n/index'

/**
 * UpdateCenterDialog — Electron Release 更新二级页面
 *
 * 显示当前版本与全部可用 Release；用户选择目标版本后下载，
 * 下载完成按钮切换为“安装”，安装时应用完整退出。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { PixelIcon, PButton } from '../pixel'
import { invoke, isElectron, listen } from '../../utils/ipcAdapter'

export type ReleaseChannel = 'stable' | 'rc' | 'alpha' | 'beta' | 'hotfix'

interface UpdateRelease {
  tagName: string
  version: string
  name: string
  body: string
  publishedAt: string
  htmlUrl: string
  channel: ReleaseChannel
  prerelease: boolean
  assetName: string
  assetSize: number
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
  deployment: 'installed' | 'portable' | 'unsupported'
  currentVersion: string
  selectedVersion?: string
  selectedTag?: string
  progress: number
  transferredBytes?: number
  totalBytes?: number
  message: string
  checkedAt?: string
  canInstall?: boolean
  logPath?: string
  lastInstallError?: string
}

const props = defineProps<{
  modelValue: boolean
  currentVersion: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
}>()

const state = ref<UpdateState | null>(null)
const releases = ref<UpdateRelease[]>([])
const selectedTag = ref('')
const actionBusy = ref(false)
const actionError = ref('')
let stopUpdateListener: (() => void) | null = null

const selectedRelease = computed(
  () => releases.value.find((release) => release.tagName === selectedTag.value) ?? null,
)

const channelMeta: Record<ReleaseChannel, { label: string; className: string }> = {
  stable: {
    get label() {
      return __t('ui.navigation', '正式版')
    },
    className: 'channel-stable',
  },
  rc: {
    get label() {
      return __t('ui.navigation', '预发版')
    },
    className: 'channel-rc',
  },
  alpha: {
    get label() {
      return __t('ui.navigation', '构建版')
    },
    className: 'channel-alpha',
  },
  beta: {
    get label() {
      return __t('ui.navigation', '测试版')
    },
    className: 'channel-beta',
  },
  hotfix: {
    get label() {
      return __t('ui.navigation', '热补丁')
    },
    className: 'channel-hotfix',
  },
}

const canUpdate = computed(
  () => state.value?.deployment !== 'unsupported' && Boolean(selectedRelease.value),
)
const isDownloading = computed(() => state.value?.phase === 'downloading')
const isInstalling = computed(() => state.value?.phase === 'installing')
const isDownloaded = computed(
  () =>
    Boolean(state.value?.canInstall ?? state.value?.phase === 'downloaded') &&
    state.value?.selectedTag === selectedTag.value,
)
const actionLabel = computed(() => {
  if (isDownloading.value) return __t('ui.navigation', '下载中')
  if (isInstalling.value) return __t('ui.navigation', '正在准备安装')
  if (isDownloaded.value) return __t('ui.navigation', '安装')
  return __t('ui.navigation', '下载')
})

function close(): void {
  if (isDownloading.value || isInstalling.value || actionBusy.value) return
  emit('update:modelValue', false)
}

function formatDate(value: string): string {
  return value
    ? new Date(value).toLocaleString(getDisplayLocale(), { hour12: false })
    : __t('ui.navigation', '未知')
}

function formatBytes(bytes = 0): string {
  if (!bytes) return __t('ui.navigation', '未知大小')
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`
}

function releaseSummary(body: string): string {
  const plain = body
    .replace(/```[\s\S]*?```/g, '')
    .replace(/[#>*_`[\]()~-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return plain || __t('ui.navigation', '该版本没有填写更新说明。')
}

async function loadCachedReleases(): Promise<void> {
  const result = await invoke('get-client-update-releases')
  releases.value = Array.isArray(result) ? (result as UpdateRelease[]) : []
  if (!selectedTag.value || !releases.value.some((item) => item.tagName === selectedTag.value)) {
    selectedTag.value = releases.value[0]?.tagName ?? ''
  }
}

async function checkUpdates(): Promise<void> {
  if (actionBusy.value || isDownloading.value || isInstalling.value) return
  actionBusy.value = true
  actionError.value = ''
  try {
    state.value = (await invoke('check-client-update')) as UpdateState
    await loadCachedReleases()
  } catch (error) {
    await showActionFailure(error)
  } finally {
    actionBusy.value = false
  }
}

async function runAction(): Promise<void> {
  if (!selectedRelease.value || actionBusy.value) return
  actionBusy.value = true
  actionError.value = ''
  try {
    if (isDownloaded.value) {
      await invoke('install-client-update')
      state.value = (await invoke('get-update-state')) as UpdateState
      return
    }
    state.value = (await invoke('download-client-update', {
      tagName: selectedRelease.value.tagName,
    })) as UpdateState
  } catch (error) {
    await showActionFailure(error)
  } finally {
    actionBusy.value = false
  }
}

async function showActionFailure(error: unknown): Promise<void> {
  try {
    state.value = (await invoke('get-update-state')) as UpdateState
  } catch {
    // 主进程不可达时仍在当前窗口显示错误，不让点击操作变成未处理的拒绝。
  }
  actionError.value = __t('ui.navigation', '更新操作失败：{0}', [
    error instanceof Error ? error.message : String(error),
  ])
}

async function openUpdateLocation(target: 'logs' | 'release'): Promise<void> {
  try {
    if (target === 'logs') await invoke('open-client-path', 'logs')
    else await invoke('open-external-url', 'https://github.com/YoKONCy/infOS/releases')
  } catch (error) {
    await showActionFailure(error)
  }
}

async function initialize(): Promise<void> {
  if (!isElectron()) return
  state.value = {
    phase: 'checking',
    deployment: 'unsupported',
    currentVersion: props.currentVersion,
    progress: 0,
    get message() {
      return __t('ui.navigation', '正在获取更新状态…')
    },
  }
  try {
    state.value = (await invoke('get-update-state')) as UpdateState
    await loadCachedReleases()
    if (!releases.value.length && state.value.deployment !== 'unsupported') {
      await checkUpdates()
    }
  } catch (error) {
    state.value = {
      ...state.value,
      phase: 'error',
      get message() {
        return __t('ui.navigation', '获取更新失败：{0}', [
          error instanceof Error ? error.message : String(error),
        ])
      },
    }
  }
}

watch(
  () => props.modelValue,
  (visible) => {
    if (visible) void initialize()
  },
)

onMounted(async () => {
  if (!isElectron()) return
  stopUpdateListener = await listen('client-update-state', (payload) => {
    state.value = payload as UpdateState
    actionError.value = ''
  })
  if (props.modelValue) await initialize()
})

onUnmounted(() => stopUpdateListener?.())
</script>

<template>
  <Teleport to="body">
    <Transition name="update-center">
      <div v-if="modelValue" class="update-overlay" @mousedown.self="close">
        <section
          class="update-page"
          role="dialog"
          aria-modal="true"
          :aria-label="__t('ui.navigation', '应用更新中心')"
        >
          <header class="update-head">
            <div class="update-head-mark">
              <PixelIcon name="download" size="lg" />
            </div>
            <div class="update-head-title">
              <span class="font-pixel">SYSTEM UPDATE</span>
              <h2 class="font-pixel">{{ __t('ui.navigation', '应用更新中心') }}</h2>
              <p>{{ __t('ui.navigation', '选择 Release 版本并更新客户端本体') }}</p>
            </div>
            <button
              class="update-close"
              :disabled="isDownloading || isInstalling || actionBusy"
              :title="__t('ui.navigation', '关闭')"
              @click="close"
            >
              <PixelIcon name="close" size="sm" />
            </button>
          </header>

          <div class="version-strip">
            <div class="version-cell">
              <span>{{ __t('ui.navigation', '当前版本') }}</span>
              <strong class="font-pixel">v{{ state?.currentVersion ?? currentVersion }}</strong>
            </div>
            <PixelIcon name="chevron-right" size="sm" class="version-arrow" />
            <div class="version-cell version-cell-latest">
              <span>{{ __t('ui.navigation', '可用版本') }}</span>
              <strong class="font-pixel">
                {{
                  releases.length
                    ? __t('ui.navigation', '{0} 个', [releases.length])
                    : state?.phase === 'up-to-date'
                      ? __t('ui.navigation', '已是最新')
                      : __t('ui.navigation', '待检查')
                }}
              </strong>
            </div>
            <div class="deployment-badge">
              {{
                state?.deployment === 'portable'
                  ? __t('ui.navigation', '便携版更新')
                  : state?.deployment === 'installed'
                    ? __t('ui.navigation', '安装版更新')
                    : __t('ui.navigation', '当前形态不支持')
              }}
            </div>
            <PButton
              variant="ghost"
              size="sm"
              :loading="state?.phase === 'checking'"
              :disabled="isDownloading || isInstalling || actionBusy"
              @click="checkUpdates"
            >
              <PixelIcon name="refresh" size="xs" />
              {{ __t('ui.navigation', '重新检查') }}
            </PButton>
          </div>

          <div class="update-content">
            <div class="release-list">
              <div class="release-list-title">
                <span class="font-pixel">AVAILABLE RELEASES</span>
                <small>
                  {{ __t('ui.navigation', '仅显示适用于当前')
                  }}{{
                    state?.deployment === 'portable'
                      ? __t('ui.navigation', '便携版')
                      : __t('ui.navigation', '安装版')
                  }}{{ __t('ui.navigation', '的更新包') }}
                </small>
              </div>

              <button
                v-for="release in releases"
                :key="release.tagName"
                :class="[
                  'release-card',
                  { 'release-card-selected': release.tagName === selectedTag },
                ]"
                :disabled="isDownloading || isInstalling || actionBusy"
                @click="selectedTag = release.tagName"
              >
                <span class="release-select-box">
                  <PixelIcon v-if="release.tagName === selectedTag" name="check" size="xs" />
                </span>
                <span class="release-main">
                  <span class="release-version-row">
                    <strong class="font-pixel">v{{ release.version }}</strong>
                    <span :class="['channel-tag', channelMeta[release.channel].className]">
                      {{ channelMeta[release.channel].label }}
                    </span>
                  </span>
                  <span class="release-name">{{ release.name }}</span>
                  <span class="release-meta">
                    {{ formatDate(release.publishedAt) }} · {{ formatBytes(release.assetSize) }}
                  </span>
                </span>
              </button>

              <div v-if="!releases.length" class="release-empty">
                <PixelIcon
                  :name="state?.phase === 'checking' ? 'loader' : 'check'"
                  size="lg"
                  :animation="state?.phase === 'checking' ? 'spin' : ''"
                />
                <span>{{ state?.message ?? __t('ui.navigation', '尚未检查更新') }}</span>
              </div>
            </div>

            <div class="release-detail">
              <template v-if="selectedRelease">
                <div class="detail-head">
                  <div>
                    <span class="detail-kicker font-pixel">RELEASE NOTE</span>
                    <h3 class="font-pixel">v{{ selectedRelease.version }}</h3>
                  </div>
                  <span
                    :class="[
                      'channel-tag channel-tag-large',
                      channelMeta[selectedRelease.channel].className,
                    ]"
                  >
                    {{ channelMeta[selectedRelease.channel].label }}
                  </span>
                </div>
                <p class="detail-summary">{{ releaseSummary(selectedRelease.body) }}</p>
                <dl class="asset-info">
                  <dt>{{ __t('ui.navigation', '更新包') }}</dt>
                  <dd>{{ selectedRelease.assetName }}</dd>
                  <dt>{{ __t('ui.navigation', '文件大小') }}</dt>
                  <dd>{{ formatBytes(selectedRelease.assetSize) }}</dd>
                  <dt>{{ __t('ui.navigation', '发布时间') }}</dt>
                  <dd>{{ formatDate(selectedRelease.publishedAt) }}</dd>
                </dl>
              </template>
              <div v-else class="detail-placeholder">
                <PixelIcon name="inbox" size="2xl" />
                <span>{{ __t('ui.navigation', '没有可用更新') }}</span>
              </div>
            </div>
          </div>

          <div
            v-if="state?.lastInstallError && state.phase !== 'error'"
            class="update-install-warning"
            role="alert"
          >
            <span>{{ state.lastInstallError }}</span>
            <PButton size="sm" variant="ghost" @click="openUpdateLocation('logs')">
              {{ __t('ui.navigation', '打开更新日志目录') }}
            </PButton>
          </div>
          <footer class="update-footer">
            <div class="update-status">
              <span class="status-light" :class="`status-${state?.phase ?? 'idle'}`" />
              <span :role="actionError || state?.phase === 'error' ? 'alert' : 'status'">
                {{ actionError || state?.message || __t('ui.navigation', '更新服务初始化中') }}
              </span>
              <button
                v-if="state?.phase === 'error' || actionError"
                @click="openUpdateLocation('logs')"
              >
                {{ __t('ui.navigation', '打开更新日志目录') }}
              </button>
              <button
                v-if="state?.phase === 'error' || actionError"
                @click="openUpdateLocation('release')"
              >
                {{ __t('ui.navigation', '前往发布页手动下载') }}
              </button>
            </div>

            <div v-if="isDownloading || isDownloaded" class="download-progress">
              <div class="progress-track">
                <div class="progress-fill" :style="{ width: `${state?.progress ?? 0}%` }" />
              </div>
              <span class="font-pixel">{{ state?.progress ?? 0 }}%</span>
              <small v-if="state?.totalBytes">
                {{ formatBytes(state.transferredBytes) }} / {{ formatBytes(state.totalBytes) }}
              </small>
            </div>

            <PButton
              variant="primary"
              :disabled="!canUpdate || isDownloading || isInstalling || actionBusy"
              :loading="isDownloading || isInstalling || actionBusy"
              class="update-action"
              @click="runAction"
            >
              <PixelIcon :name="isDownloaded ? 'power' : 'download'" size="xs" />
              {{ actionLabel }}
            </PButton>
          </footer>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.update-overlay {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: grid;
  place-items: center;
  padding: 36px;
  background: rgba(3, 7, 18, 0.76);
  backdrop-filter: blur(8px);
}

.update-page {
  width: min(940px, 94vw);
  height: min(720px, 88vh);
  display: flex;
  flex-direction: column;
  color: var(--ui-text-primary);
  background: var(--ui-bg-canvas);
  border: 3px solid var(--ui-border-strong);
  box-shadow:
    8px 8px 0 rgba(14, 165, 233, 0.25),
    0 24px 80px rgba(0, 0, 0, 0.5);
  overflow: hidden;
}

.update-head {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 18px 20px;
  border-bottom: 2px solid var(--ui-border-strong);
  background: linear-gradient(90deg, rgba(14, 165, 233, 0.1), rgba(139, 92, 246, 0.08));
}

.update-head-mark {
  display: grid;
  width: 48px;
  height: 48px;
  place-items: center;
  color: #0ea5e9;
  border: 2px solid #0ea5e9;
  box-shadow: 3px 3px 0 rgba(14, 165, 233, 0.25);
}

.update-head-title {
  min-width: 0;
}
.update-head-title > span {
  font-size: 9px;
  color: #0ea5e9;
  letter-spacing: 0.16em;
}
.update-head-title h2 {
  margin: 4px 0;
  font-size: 20px;
}
.update-head-title p {
  margin: 0;
  font-size: 11px;
  color: var(--ui-text-tertiary);
}

.update-close {
  display: grid;
  width: 34px;
  height: 34px;
  margin-left: auto;
  place-items: center;
  color: var(--ui-text-secondary);
  background: transparent;
  border: 1px solid var(--ui-border-default);
  cursor: pointer;
}
.update-close:hover:not(:disabled) {
  color: #f43f5e;
  border-color: #f43f5e;
}
.update-close:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.version-strip {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 20px;
  border-bottom: 1px solid var(--ui-border-default);
  background: var(--ui-bg-surface);
}

.version-cell {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.version-cell span {
  font-size: 9px;
  color: var(--ui-text-tertiary);
}
.version-cell strong {
  font-size: 12px;
  color: var(--ui-text-secondary);
}
.version-cell-latest strong {
  color: #0ea5e9;
}
.version-arrow {
  color: var(--ui-text-tertiary);
}
.deployment-badge {
  margin-left: auto;
  padding: 4px 8px;
  font-size: 10px;
  color: #7c3aed;
  border: 1px solid rgba(139, 92, 246, 0.4);
  background: rgba(139, 92, 246, 0.08);
}

.update-content {
  display: grid;
  grid-template-columns: 43% 57%;
  flex: 1;
  min-height: 0;
}

.release-list {
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 16px;
  gap: 8px;
  overflow-y: auto;
  border-right: 1px solid var(--ui-border-default);
}

.release-list-title {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 4px;
}
.release-list-title > span {
  font-size: 10px;
  color: var(--ui-text-secondary);
}
.release-list-title small {
  font-size: 9px;
  color: var(--ui-text-tertiary);
}

.release-card {
  display: flex;
  gap: 10px;
  padding: 12px;
  text-align: left;
  color: var(--ui-text-primary);
  background: var(--ui-bg-surface);
  border: 1px solid var(--ui-border-default);
  cursor: pointer;
  transition: 0.15s ease;
}
.release-card:hover:not(:disabled) {
  transform: translateX(2px);
  border-color: #38bdf8;
}
.release-card-selected {
  border-color: #0ea5e9;
  background: rgba(14, 165, 233, 0.07);
  box-shadow: 3px 3px 0 rgba(14, 165, 233, 0.15);
}
.release-card:disabled {
  cursor: not-allowed;
}
.release-select-box {
  display: grid;
  flex: 0 0 18px;
  width: 18px;
  height: 18px;
  place-items: center;
  color: #0ea5e9;
  border: 2px solid #0ea5e9;
}
.release-main {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 5px;
}
.release-version-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.release-version-row strong {
  font-size: 12px;
}
.release-name {
  font-size: 11px;
  color: var(--ui-text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.release-meta {
  font-size: 9px;
  color: var(--ui-text-tertiary);
}

.channel-tag {
  padding: 2px 6px;
  font-size: 9px;
  font-weight: 800;
  border: 1px solid currentColor;
}
.channel-tag-large {
  padding: 4px 8px;
}
.channel-stable {
  color: #10b981;
  background: rgba(16, 185, 129, 0.09);
}
.channel-rc {
  color: #8b5cf6;
  background: rgba(139, 92, 246, 0.1);
}
.channel-alpha {
  color: #f97316;
  background: rgba(249, 115, 22, 0.1);
}
.channel-beta {
  color: #0ea5e9;
  background: rgba(14, 165, 233, 0.1);
}
.channel-hotfix {
  color: #f43f5e;
  background: rgba(244, 63, 94, 0.1);
}

.release-empty,
.detail-placeholder {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--ui-text-tertiary);
  font-size: 11px;
}

.release-detail {
  min-width: 0;
  padding: 22px;
  overflow-y: auto;
}
.detail-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--ui-border-default);
}
.detail-kicker {
  font-size: 9px;
  color: #8b5cf6;
  letter-spacing: 0.14em;
}
.detail-head h3 {
  margin: 6px 0 0;
  font-size: 20px;
}
.detail-summary {
  margin: 18px 0;
  font-size: 12px;
  line-height: 1.8;
  color: var(--ui-text-secondary);
}
.asset-info {
  display: grid;
  grid-template-columns: 72px 1fr;
  gap: 9px;
  padding: 12px;
  font-size: 10px;
  border: 1px dashed var(--ui-border-default);
  background: rgba(148, 163, 184, 0.04);
}
.asset-info dt {
  color: var(--ui-text-tertiary);
}
.asset-info dd {
  min-width: 0;
  margin: 0;
  color: var(--ui-text-secondary);
  overflow-wrap: anywhere;
}

.update-footer {
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 14px 20px;
  border-top: 2px solid var(--ui-border-strong);
  background: var(--ui-bg-surface);
}
.update-status {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  min-width: 190px;
  font-size: 10px;
  color: var(--ui-text-tertiary);
}
.status-light {
  width: 7px;
  height: 7px;
  background: #94a3b8;
}
.status-available,
.status-downloaded {
  background: #10b981;
  box-shadow: 0 0 8px rgba(16, 185, 129, 0.7);
}
.status-checking,
.status-downloading,
.status-installing {
  background: #0ea5e9;
  box-shadow: 0 0 8px rgba(14, 165, 233, 0.7);
}
.status-error {
  background: #f43f5e;
}
.update-install-warning {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 12px 20px;
  color: var(--ui-danger);
  background: var(--ui-bg-surface);
  border-top: 1px solid var(--ui-border-default);
  font-size: 12px;
}

.download-progress {
  display: grid;
  grid-template-columns: minmax(120px, 1fr) 38px auto;
  align-items: center;
  gap: 8px;
  flex: 1;
}
.progress-track {
  height: 10px;
  padding: 2px;
  border: 1px solid var(--ui-border-strong);
  background: var(--ui-bg-canvas);
}
.progress-fill {
  height: 100%;
  background: repeating-linear-gradient(90deg, #0ea5e9 0 8px, #38bdf8 8px 12px);
  transition: width 0.18s;
}
.download-progress > span {
  font-size: 9px;
  color: #0ea5e9;
}
.download-progress small {
  font-size: 9px;
  color: var(--ui-text-tertiary);
}
.update-action {
  min-width: 108px;
  margin-left: auto;
}

.update-center-enter-active,
.update-center-leave-active {
  transition: opacity 0.18s ease;
}
.update-center-enter-active .update-page,
.update-center-leave-active .update-page {
  transition:
    transform 0.18s ease,
    opacity 0.18s ease;
}
.update-center-enter-from,
.update-center-leave-to {
  opacity: 0;
}
.update-center-enter-from .update-page,
.update-center-leave-to .update-page {
  transform: translateY(10px) scale(0.985);
  opacity: 0;
}

@media (max-width: 760px) {
  .update-overlay {
    padding: 12px;
  }
  .update-page {
    width: 100%;
    height: 94vh;
  }
  .update-content {
    grid-template-columns: 1fr;
    overflow-y: auto;
  }
  .release-list {
    max-height: 42vh;
    border-right: 0;
    border-bottom: 1px solid var(--ui-border-default);
  }
  .version-strip {
    flex-wrap: wrap;
  }
  .deployment-badge {
    margin-left: 0;
  }
  .update-footer {
    flex-wrap: wrap;
  }
  .download-progress {
    order: 3;
    flex-basis: 100%;
  }
}
</style>
