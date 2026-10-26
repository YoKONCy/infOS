/** 开屏只接收显示状态与有限操作，不开放主应用的通用 IPC。 */
export type StartupPhase = 'opening' | 'connection' | 'backend' | 'launcher' | 'ready' | 'failed'
export type StartupFailureKind = 'backend' | 'launcher' | 'shell'
export type StartupSplashAction = 'retry' | 'logs' | 'quit' | 'cancel-connection'

export interface StartupConnectionView {
  id: number
  mode: 'local' | 'remote'
  origin: string
  capabilityEndpoint: string
  busy: boolean
  error: string
  restartRequired: boolean
}

export interface StartupSplashState {
  revision: number
  phase: StartupPhase
  language: string
  connection: StartupConnectionView | null
  connectionLabels: Record<string, string>
  labels: {
    brandCaption: string
    loading: string
    title: string
    message: string
    retry: string
    logs: string
    quit: string
    close: string
  }
}
