import { t as __t } from '../../i18n/index'
/**
 * useLauncher — 启动器流程 composable
 *
 * 管理启动流程状态机: connecting → checking → ready → entering → done
 *
 * 正确流程:
 *   主进程启动后端 → 等待后端就绪 → EULA → 系统检查 → 就绪 → 新手引导(可选)
 *   → 选择启动方式 → 隐藏 Launcher → 拉起桌宠或主界面
 *
 * 桌宠与主界面共用同一个启动流程。
 *
 * @module packages/frontend/src/composables/launcher/useLauncher
 */
import { ref, computed } from 'vue'
import { systemApi } from '../../api/modules/systemApi'
import { configApi } from '../../api/modules/configApi'
import { invoke, isElectron } from '../../utils/ipcAdapter'
import { logger } from '../../lib/logger'
import { completeOnboarding, loadOnboardingFlow, queueDesktopOnboarding } from './onboardingFlow'
import { createLaunchDiagnostic, type LaunchDiagnostic } from '../../lib/launcherDiagnostics'
import { runLauncherCheck, type CheckItem } from './launcherChecks'

export type LaunchPhase = 'connecting' | 'checking' | 'ready' | 'entering' | 'done'

export type { CheckItem } from './launcherChecks'

export function useLauncher() {
  const phase = ref<LaunchPhase>('connecting')
  const progress = ref(0)
  const diagnostic = ref<LaunchDiagnostic | null>(null)
  // 用户提示只来自固定词条，原始异常与日志只存放在独立诊断数据中。
  const errorMessage = computed(() => {
    if (!diagnostic.value) return ''
    return diagnostic.value.stage === 'agreement'
      ? __t('ui.launcher', '暂时无法保存协议状态')
      : __t('ui.launcher', '暂时无法启动')
  })
  const errorHint = computed(() =>
    diagnostic.value?.stage === 'agreement'
      ? __t('ui.launcher', '请稍后重试，或查看诊断信息。')
      : __t('ui.launcher', '本次启动未完成。你可以重试，或查看诊断信息。'),
  )

  /** 启动进度文字 (entering 阶段专用) */
  const enteringText = ref('正在启动...')

  const showEula = ref(false)
  const eulaChecked = ref(false)

  const showOnboarding = ref(false)
  const onboardingCompleted = ref(false)
  const desktopGuidePending = ref(false)
  const onboardingLaunching = ref(false)

  const checks = ref<CheckItem[]>([
    {
      id: 'backend',
      get label() {
        return __t('ui.launcher', '后端服务')
      },
      status: 'pending',
    },
    {
      id: 'database',
      get label() {
        return __t('ui.launcher', '数据库连接')
      },
      status: 'pending',
    },
    {
      id: 'model',
      get label() {
        return __t('ui.launcher', '模型可用性')
      },
      status: 'pending',
    },
    {
      id: 'memory',
      get label() {
        return __t('ui.launcher', '记忆系统')
      },
      status: 'pending',
    },
    {
      id: 'extension',
      get label() {
        return __t('ui.launcher', 'Agent 系统')
      },
      status: 'pending',
    },
  ])

  const allChecksOk = computed(() =>
    checks.value.every((c) => c.status === 'ok' || c.status === 'warn'),
  )
  const hasError = computed(() => checks.value.some((c) => c.status === 'error'))

  // ── EULA 操作 ──

  /**
   * 检查 EULA 状态
   * 搬迁自 v1: LauncherView.loadConfig() → config.eula_accepted 检查
   */
  async function checkEulaStatus(): Promise<void> {
    try {
      const res = await configApi.get('eula_accepted')
      const accepted = res.data?.value === 'true'
      if (!accepted) {
        showEula.value = true
      } else {
        eulaChecked.value = true
        // EULA 已接受 → 检查引导状态 (否则 onboardingCompleted 永远是 false)
        await checkOnboardingStatus()
      }
    } catch {
      // 配置不存在 = 新用户 → 需要 EULA
      showEula.value = true
    }
  }

  /**
   * 用户同意 EULA
   * 搬迁自 v1: LauncherView.handleAcceptEula()
   */
  async function acceptEula(): Promise<void> {
    try {
      await configApi.set('eula_accepted', 'true')
      showEula.value = false
      eulaChecked.value = true
      diagnostic.value = null

      // 检查引导状态 — EULA 通过后才可能触发引导
      await checkOnboardingStatus()
      await runChecks()
    } catch (e) {
      logger.error('Launcher', __t('logs.frontend.launcher', '保存 EULA 状态失败'), e)
      diagnostic.value = createLaunchDiagnostic('agreement', e)
    }
  }

  /**
   * 用户拒绝 EULA → 退出应用
   * 搬迁自 v1: LauncherView.handleDeclineEula()
   */
  async function declineEula(): Promise<void> {
    await invoke('quit-app')
  }

  // ── 新手引导操作 ──

  /** 检查新手引导是否已完成 */
  async function checkOnboardingStatus(): Promise<void> {
    try {
      const flow = await loadOnboardingFlow()
      onboardingCompleted.value = flow.stage !== 'launcher'
      desktopGuidePending.value = flow.stage === 'desktop'
    } catch {
      // 配置不存在 = 新用户
      onboardingCompleted.value = false
    }
  }

  /**
   * 引导完成回调
   * 搬迁自 v1: LauncherView.handleOnboardingFinish()
   */
  async function finishOnboarding(): Promise<void> {
    showOnboarding.value = false
    await completeOnboarding()
    onboardingCompleted.value = true
    desktopGuidePending.value = false
  }

  /** 最后一步点击真实启动按钮，先交接进度，再打开桌面主界面。 */
  async function launchDesktopOnboarding(): Promise<boolean> {
    if (onboardingLaunching.value || !['ready', 'done'].includes(phase.value)) return false
    onboardingLaunching.value = true
    try {
      if (!desktopGuidePending.value) await queueDesktopOnboarding()
      desktopGuidePending.value = true
      const success = await enterApp('app')
      if (success) showOnboarding.value = false
      return success
    } finally {
      onboardingLaunching.value = false
    }
  }

  /** 逐项执行检查 */
  async function runChecks(): Promise<void> {
    phase.value = 'checking'

    for (let i = 0; i < checks.value.length; i++) {
      const item = checks.value[i]!
      item.status = 'running'

      await runLauncherCheck(item)

      progress.value = Math.round(((i + 1) / checks.value.length) * 100)
    }

    phase.value = hasError.value ? 'checking' : 'ready'
    if (hasError.value) {
      diagnostic.value = createLaunchDiagnostic(
        'backend',
        checks.value.find((item) => item.status === 'error')?.message,
      )
    }

    // 就绪后，如果引导未完成，自动触发引导
    if (phase.value === 'ready' && !onboardingCompleted.value && eulaChecked.value) {
      showOnboarding.value = true
    }
  }

  /** 开始启动流程 */
  let launchInProgress = false
  async function startLaunch(): Promise<void> {
    if (launchInProgress) return
    launchInProgress = true
    try {
      await performLaunch()
    } catch (error) {
      diagnostic.value = createLaunchDiagnostic('backend', error)
      const backendCheck = checks.value.find((item) => item.id === 'backend')
      if (backendCheck) {
        backendCheck.status = 'error'
        backendCheck.message = __t('ui.launcher', '启动失败，请查看诊断详情')
      }
      phase.value = 'checking'
    } finally {
      launchInProgress = false
    }
  }

  async function performLaunch(): Promise<void> {
    phase.value = 'connecting'
    progress.value = 0
    diagnostic.value = null
    showEula.value = false
    checks.value.forEach((c) => {
      c.status = 'pending'
      c.message = undefined
    })

    // Electron 主进程会随应用自动拉起后端；启动器先等待后端，再读取 EULA/角色等热更新配置
    if (isElectron()) {
      const backendCheck = checks.value.find((item) => item.id === 'backend')
      if (backendCheck) backendCheck.status = 'running'
      // 与主进程初始化共用同一次启动；用户重试时真正重新拉起已退出的后端。
      const started = (await invoke('start-backend')) as {
        ready?: boolean
        attempted?: boolean
      } | null
      const backendReady = started?.attempted ? started.ready === true : await waitForBackend(30000)
      if (!backendReady) {
        const fallback = __t('ui.launcher', '后端服务启动超时')
        let detail = createLaunchDiagnostic('backend', fallback)
        try {
          const status = (await invoke('get-backend-logs')) as {
            error?: string
            logTail?: string
            logPath?: string
          }
          detail = createLaunchDiagnostic(
            'backend',
            status.error || fallback,
            status.logTail,
            status.logPath,
          )
        } catch {
          // 主进程诊断不可用时保留超时提示。
        }
        diagnostic.value = detail
        const backendCheck = checks.value.find((c) => c.id === 'backend')
        if (backendCheck) {
          backendCheck.status = 'error'
          backendCheck.message = __t('ui.launcher', '启动失败，请查看诊断详情')
        }
        phase.value = 'checking'
        return
      }
      if (backendCheck) backendCheck.status = 'ok'
    }

    await checkEulaStatus()
    if (showEula.value) {
      phase.value = 'checking'
      return
    }

    // 给 UI 一点缓冲时间展示 connecting 动画
    await new Promise((r) => setTimeout(r, 400))
    await runChecks()
  }

  /**
   * 进入应用 — 按用户选择显示桌宠或主界面。
   *
   * Electron: 确认后端可用 → 隐藏 Launcher → 拉起 Pet3D 桌宠窗口。
   * Browser/Docker: 直接跳转到 /app。
   *
   * @returns 是否成功启动
   */
  async function enterApp(target: 'pet' | 'app' = 'pet'): Promise<boolean> {
    if (phase.value === 'entering') return false
    phase.value = 'entering'
    if (desktopGuidePending.value) {
      try {
        desktopGuidePending.value = (await loadOnboardingFlow()).stage === 'desktop'
      } catch {
        /* 读取失败时仍按待接续的桌面导览启动。 */
      }
      if (desktopGuidePending.value) target = 'app'
    }

    if (!isElectron()) {
      // Docker/浏览器模式: 后端已经独立运行，直接跳转
      enteringText.value = '正在进入...'
      phase.value = 'done'
      window.location.hash = '/app'
      return true
    }

    try {
      enteringText.value = '正在确认后端服务状态...'
      const backendReady = await waitForBackend(30000)
      if (!backendReady) {
        throw new Error('后端服务未就绪')
      }

      enteringText.value = target === 'pet' ? '正在召唤伙伴...' : '正在打开主界面...'
      // 两种启动方式共用隐藏动作；失败时重新显示启动器，保留重试入口。
      await invoke('hide-launcher')
      await invoke(target === 'pet' ? 'open-pet-window' : 'open-dashboard-window')
      enteringText.value = '欢迎回来，主人！'

      phase.value = 'done'
      return true
    } catch (e) {
      logger.error('Launcher', __t('logs.frontend.launcher', '启动流程出错'), e)
      enteringText.value = '启动出错，请重试'
      diagnostic.value = createLaunchDiagnostic('launch', e)
      // 恢复就绪状态，允许用户重试。
      phase.value = 'ready'
      await invoke('window-show')
      return false
    }
  }

  /**
   * 轮询等待后端 health 接口就绪
   * @param timeoutMs 超时时间 (毫秒)
   * @returns 是否在超时前就绪
   */
  async function waitForBackend(timeoutMs: number): Promise<boolean> {
    const start = Date.now()
    const interval = 1000 // 每秒检测一次

    while (Date.now() - start < timeoutMs) {
      try {
        const res = await systemApi.health()
        if (res.data?.status === 'ok') {
          logger.info('Launcher', __t('logs.frontend.launcher', '后端已就绪!'))
          return true
        }
      } catch {
        // 后端尚未就绪，继续等待
      }
      await new Promise((r) => setTimeout(r, interval))
    }

    return false
  }

  /** 重试 */
  function retry(): void {
    void startLaunch()
  }

  /** 手动触发 EULA 弹窗 */
  function triggerEula(): void {
    showEula.value = true
  }

  /** 手动触发新手引导 */
  function triggerOnboarding(): void {
    desktopGuidePending.value = false
    showOnboarding.value = true
  }

  return {
    // 原有
    phase,
    progress,
    errorMessage,
    errorHint,
    diagnostic,
    checks,
    allChecksOk,
    hasError,
    startLaunch,
    enterApp,
    retry,
    // 启动进度文字
    enteringText,
    // EULA
    showEula,
    acceptEula,
    declineEula,
    triggerEula,
    // 引导
    showOnboarding,
    finishOnboarding,
    triggerOnboarding,
    launchDesktopOnboarding,
    desktopGuidePending,
    onboardingLaunching,
  }
}
