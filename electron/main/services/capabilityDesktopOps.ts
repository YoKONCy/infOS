/**
 * @file 能力节点 `desktop.environment` 里我们自加的分支（从 capabilityProvider.ts 原样挪出，
 * 让作者文件只留调用，减少合并上游时的冲突）。
 *
 * - 护栏控制（`control` 的其余动作）；
 * - Windows 截图：持续盯窗口、带「耳朵」附注的普通观察；
 * - 窗口列表标注 infOS 自己的窗口；
 * - 切换窗口与启动应用：手动模式确认、本机护栏、后端许可；
 * - 观察类输出按「感知」设置过滤。
 *
 * @platform ELECTRON
 */
import { executeApplicationLaunch, resolveApplicationLaunch } from './applicationLauncher'
import { isWatchRequest } from './desktopWatchService'
import { attachHeard, handleHomeWatch } from './home/homeCapability'
import { desktopControl, type DesktopCaller } from './desktopControl'
import { windowsDesktop } from './windowsDesktop'
import { shellCapability } from './shellHost'
import {
  authorizeApplicationLaunch,
  confirmManualStep,
  guardApplicationPlan,
  handleGuardControl,
  launchIntent,
  type GuardOutcome,
} from './desktopGuard'
import { buildDesktopIntent } from '../home/homeDesktopPermit'
import { uniqueWindow } from './desktopControlGuard'
import { screenshotWindowId } from './screenshotWindowId'

/** `control` 里除状态与恢复之外的动作交给护栏（声明、授权、关闭总开关等）。 */
export function handleDesktopGuardControl(
  input: Record<string, unknown>,
  caller: DesktopCaller,
): ReturnType<typeof handleGuardControl> {
  return handleGuardControl(input, caller, {
    enabled: () => desktopControl.configuration().enabled,
    disable: () => {
      desktopControl.update({ enabled: false })
    },
  })
}

/** Windows 下的截图：持续盯窗口，或一次普通观察（附带「耳朵」听到的内容）。 */
export async function observeWindowsScreen(
  input: Record<string, unknown>,
  caller: DesktopCaller,
): Promise<unknown> {
  // 持续盯窗口（陪看的基础）：只读，不切前台，不进动作队列。
  if (isWatchRequest(input.watch))
    return handleHomeWatch(
      caller,
      screenshotWindowId(input.windowId, shellCapability),
      input.watch as Record<string, unknown>,
    )
  return attachHeard(
    caller,
    await desktopControl.observe(
      { ...input, windowId: screenshotWindowId(input.windowId, shellCapability) },
      caller,
    ),
  )
}

/** 窗口列表：infOS 自己的窗口额外标注 infosWindowId，与截图、shell_window 共用同一套 ID。 */
export async function listWindowsWithInfosIds<T extends { windowId?: string }>(
  list: () => Promise<T[]>,
): Promise<Array<T | (T & { infosWindowId: string })>> {
  const own = process.platform === 'win32' ? shellCapability.nativeWindowIds() : new Map()
  return (await list()).map((window) =>
    window.windowId && own.has(window.windowId)
      ? { ...window, infosWindowId: own.get(window.windowId) }
      : window,
  )
}

/** 切换到唯一匹配的窗口；手动模式下先请用户点一次。 */
export async function activateDesktopWindow(
  input: Record<string, unknown>,
  caller: DesktopCaller,
): Promise<string> {
  const target = String(input.target ?? '')
  // 手动模式：切换窗口也要用户点一次（先找到唯一窗口，审批说明用系统读到的程序名和标题）。
  if (caller.executionMode === 'manual') {
    const window = uniqueWindow(await windowsDesktop.windows(), target)
    await confirmManualStep(
      caller,
      { program: window.processName, title: window.title },
      buildDesktopIntent(
        {
          program: window.processName,
          title: window.title,
          windowId: window.windowId,
          pid: window.pid,
        },
        { action: 'activate' },
      ),
    )
  }
  return desktopControl.mutate(caller, async (actionSignal) => {
    const match = uniqueWindow(await windowsDesktop.windows(), target)
    const result = await windowsDesktop.request<{ title: string }>(
      'activate',
      { windowId: match.windowId },
      actionSignal,
    )
    return result.title
  })
}

/** 启动应用：先解析唯一目标并审批，再占用桌面执行同一份计划。 */
export async function launchDesktopApplication(
  input: Record<string, unknown>,
  caller: DesktopCaller,
  signal: AbortSignal,
): Promise<unknown> {
  // 审批在占用桌面之前完成：用户点击弹窗不会被当作“接管电脑”。
  const plan = Object.freeze(
    await resolveApplicationLaunch(String(input.appName ?? input.app_name ?? ''), undefined, signal),
  )
  const outcome: GuardOutcome = { prompted: false }
  await guardApplicationPlan(caller, plan, undefined, outcome)
  // 手动模式：本机护栏没弹框（信任、预批、只提醒）时也要用户点一次「允许这一次」。
  if (
    await confirmManualStep(
      caller,
      { program: plan.program ?? plan.target, title: plan.title },
      launchIntent(plan),
      outcome.prompted,
    )
  ) {
    outcome.prompted = true
    outcome.answer = 'once'
  }
  // 后端许可：按程序归入 app / terminal / settings；启动前消费，启动后如实上报。
  const permit = await authorizeApplicationLaunch(caller, plan, outcome.answer, undefined, signal)
  signal.throwIfAborted()
  return desktopControl.mutate(caller, async (actionSignal) => {
    actionSignal.throwIfAborted()
    await permit.consume()
    try {
      actionSignal.throwIfAborted()
      const result = await executeApplicationLaunch(plan, undefined, actionSignal)
      void permit.complete('success')
      actionSignal.throwIfAborted()
      return result
    } catch (error) {
      void permit.complete('failed', String(error).slice(0, 200))
      throw error
    }
  })
}

/** 观察类输出（desktop.environment）按「感知」设置过滤后再交给后端。 */
export async function filterDesktopEnvironmentOutput(output: unknown): Promise<unknown> {
  const { filterObservationOutput } = await import('./home/perceptionFilter')
  const { homeSettings } = await import('./home/homeSettings')
  return filterObservationOutput(output, homeSettings.section('perception'))
}
