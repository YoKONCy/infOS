/** @file 只读观察的停止信号，与具体截图解耦，避免控制器与 watch 循环依赖。 @platform ELECTRON */
const listeners = new Set<(reason: string) => void>()
export function onDesktopObservationStop(listener: (reason: string) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export function stopDesktopObservations(reason: string): void {
  for (const listener of listeners) {
    try {
      listener(reason)
    } catch {
      /* 单个观察器故障不能阻断暂停和输入清理。 */
    }
  }
}
