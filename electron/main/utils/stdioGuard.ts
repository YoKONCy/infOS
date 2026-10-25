/** 标准输出可能由安装器或终端创建；对端退出后只停用该输出通道。 */
type Channel = 'stdout' | 'stderr'
type Output = Pick<NodeJS.WriteStream, 'on' | 'destroyed' | 'writable' | 'writableEnded'>

export function createStdioGuard(outputs: Partial<Record<Channel, Output>>) {
  const failed = new Set<Channel>()
  for (const channel of ['stdout', 'stderr'] as const) {
    const stream = outputs[channel]
    if (!stream) {
      failed.add(channel)
      continue
    }
    // 异步 error 事件只属于这两个日志输出流，不能扩大为全局忽略网络 EPIPE。
    stream.on('error', () => {
      failed.add(channel)
    })
    stream.on('close', () => {
      failed.add(channel)
    })
  }
  return {
    write(channel: Channel, output: () => void): boolean {
      const stream = outputs[channel]
      if (
        !stream ||
        failed.has(channel) ||
        stream.destroyed ||
        stream.writableEnded ||
        !stream.writable
      )
        return false
      try {
        output()
        return true
      } catch {
        failed.add(channel)
        return false
      }
    },
  }
}

// 入口最先加载此模块，覆盖 env 等模块初始化期间的输出。
const outputs: Partial<Record<Channel, Output>> = {}
for (const channel of ['stdout', 'stderr'] as const) {
  try {
    outputs[channel] = process[channel]
  } catch {
    /* 无控制台的宿主可能不提供标准流。 */
  }
}
export const stdioGuard = createStdioGuard(outputs)
