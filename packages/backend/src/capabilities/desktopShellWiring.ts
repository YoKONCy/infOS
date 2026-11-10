/**
 * 桌面外壳、桌面安全与「手」直通通道在应用容器中的装配。
 */
import type { KernelNodeId } from '@infos/shared'
import type { AppContext } from '../container'
import type { CapabilityDirectory } from '../kernel/capabilityDirectory'
import type { CapabilityHandleRegistry } from '../kernel/capabilityHandleRegistry'
import type { LifecycleScope } from '../kernel/lifecycleScope'
import type { ThemeService } from '../services/theme/themeService'
import type { DesktopAutomationProvider } from '../tools/desktopAutomation'
import { setDesktopSafetyProvider } from '../tools/desktopSafety'
import { setShellToolDeps } from '../tools/shell'
import type { DesktopCapabilityRuntime } from './desktopCapabilityRuntime'
import { ShellCapabilityRuntime } from './shellCapabilityRuntime'

/** 阶段 3：外壳工具绑定 Electron desktop.shell（infOS 自身窗口与主题，不受桌面操作总开关约束）。 */
export function startShellCapabilities(
  capabilityDirectory: CapabilityDirectory,
  capabilityHandles: CapabilityHandleRegistry,
  localNodeId: KernelNodeId,
  kernelLifecycle: LifecycleScope,
): ShellCapabilityRuntime {
  const shellCapabilities = new ShellCapabilityRuntime(
    capabilityDirectory,
    capabilityHandles,
    localNodeId,
  )
  void shellCapabilities.start()
  kernelLifecycle.defer(() => shellCapabilities.stop())
  return shellCapabilities
}

/** 总开关在客户端；经 control/status 读取，旧客户端不回传 enabled 时按关闭处理。 */
export function desktopControlEnabledProbe(
  desktopCapabilities: DesktopCapabilityRuntime,
): () => Promise<boolean> {
  return async () => {
    if (!desktopCapabilities.isOperationAvailable('control')) return false
    const status = await desktopCapabilities.invoke(
      'control',
      { action: 'status' },
      {
        principalId: 'system',
        correlationId: 'desktop-control-status',
        deadline: new Date(Date.now() + 2000).toISOString(),
      },
      AbortSignal.timeout(2000),
    )
    return (status as { enabled?: unknown } | null)?.enabled === true
  }
}

/** 外壳工具（窗口、主题）经 desktop.shell 调用客户端。 */
export function wireShellTools(
  shellCapabilities: ShellCapabilityRuntime,
  themeService: ThemeService,
): void {
  setShellToolDeps({
    isAvailable: () => shellCapabilities.isAvailable(),
    themes: themeService,
    invoke: (operation, input, toolContext) =>
      shellCapabilities.invoke(
        operation,
        input,
        {
          principalId: 'system',
          correlationId: toolContext.toolCallId ?? `desktop-shell:${Date.now()}`,
          executionId: toolContext.executionId,
          processId: toolContext.processId,
          deadline: toolContext.deadline,
        },
        toolContext.signal,
      ),
  })
}

/** 阶段 2：任务预批与分区设置经 desktop.environment/control 交给客户端判断与审批。 */
export function wireDesktopSafety(ctx: AppContext): void {
  setDesktopSafetyProvider({
    isAvailable: () => ctx.desktopCapabilities.isOperationAvailable('control'),
    control: (input, toolContext) =>
      ctx.desktopCapabilities.invoke(
        'control',
        {
          ...input,
          __desktopCaller: {
            agentId: toolContext.agentId,
            threadId: toolContext.threadId,
            taskId: toolContext.taskId,
            // 家的声明与授权按任务区分：普通回合用 pairId，与 home_* 工具一致。
            homeTaskId: toolContext.taskId ?? toolContext.pairId,
          },
        },
        {
          principalId: 'system',
          correlationId: toolContext.toolCallId ?? `desktop-safety:${Date.now()}`,
          executionId: toolContext.executionId,
          processId: toolContext.processId,
          deadline: toolContext.deadline,
        },
        toolContext.signal,
      ),
  })
}

/** 「手」的直通通道：剪贴板、媒体键、默认浏览器打开网址；调用方身份与键鼠动作相同，客户端同样过护栏。 */
export function desktopDirectChannel(
  ctx: AppContext,
): NonNullable<DesktopAutomationProvider['direct']> {
  return async (args, context) =>
    ctx.desktopCapabilities.invoke(
      'desktopDirect',
      {
        ...args,
        __desktopCaller: {
          agentId: context.agentId,
          threadId: context.threadId,
          taskId: context.taskId,
          homeTaskId: context.taskId ?? context.pairId,
          executionMode: context.executionMode,
        },
      },
      {
        principalId: 'system',
        correlationId: context.toolCallId ?? `desktop-direct:${Date.now()}`,
        executionId: context.executionId,
        processId: context.processId,
        deadline: context.deadline,
      },
      context.signal,
    )
}
