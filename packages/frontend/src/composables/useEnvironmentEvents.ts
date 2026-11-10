import type { DesktopEnvironmentEvent } from '@infos/shared'
import { invoke, isElectron } from '../utils/ipcAdapter'

/**
 * 环境事件（桌面客户端，默认关闭）：
 * - 用户发消息前取走主进程信箱里记下的事件，随消息附带给后端，只进本轮模型上下文；
 * - 界面收到「后台任务完成」推送时转告主进程。
 * 浏览器里没有主进程信箱，两个函数都什么也不做。
 */
export async function takeEnvironmentEvents(
  agentId: string,
): Promise<DesktopEnvironmentEvent[] | undefined> {
  if (!isElectron() || !agentId) return undefined
  try {
    const events = await invoke('desktop-home:environment-take', agentId)
    return Array.isArray(events) && events.length
      ? (events as DesktopEnvironmentEvent[])
      : undefined
  } catch {
    // 取不到就当没有：环境事件只是锦上添花，不能挡住用户发消息。
    return undefined
  }
}

export function reportEnvironmentTask(agentId: string, taskId: string): void {
  if (!isElectron() || !agentId || !taskId) return
  void invoke('desktop-home:environment-task', { agentId, taskId }).catch(() => {})
}
