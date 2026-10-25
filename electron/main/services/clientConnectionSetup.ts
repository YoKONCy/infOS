interface ConnectionSetupHost {
  selectConnection(activate?: boolean, error?: string): Promise<void>
  focusConnection(): boolean
}

let host: ConnectionSetupHost | undefined

/** 启动与运行中的设置入口共用开屏宿主，不再创建连接专用窗口。 */
export function configureConnectionSetup(value: ConnectionSetupHost): void {
  host = value
}

export function showConnectionSetup(activate = true, error = ''): Promise<void> {
  if (!host) return Promise.reject(new Error('CONNECTION_HOST_UNAVAILABLE'))
  return host.selectConnection(activate, error)
}

export function focusConnectionSetup(): boolean {
  return host?.focusConnection() ?? false
}
