import { contextBridge, ipcRenderer } from 'electron'
import type { StartupSplashAction, StartupSplashState } from '../shared/startupSplash'
import type { ConnectionInput } from '../main/services/clientConnection'

// 开屏仅开放显示状态、连接配置提交与有限操作，不提供通用 IPC 或已保存的凭据。
contextBridge.exposeInMainWorld('startupSplash', {
  getState: (): Promise<StartupSplashState> => ipcRenderer.invoke('startup-splash:state'),
  onState: (listener: (state: StartupSplashState) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, state: StartupSplashState) =>
      listener(state)
    ipcRenderer.on('startup-splash:changed', wrapped)
    return () => ipcRenderer.off('startup-splash:changed', wrapped)
  },
  painted: () => ipcRenderer.send('startup-splash:painted'),
  failed: () => ipcRenderer.send('startup-splash:render-failed'),
  saveConnection: (input: ConnectionInput): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('startup-splash:save-connection', input),
  action: (action: StartupSplashAction) => {
    if (
      action === 'retry' ||
      action === 'logs' ||
      action === 'quit' ||
      action === 'cancel-connection'
    )
      ipcRenderer.send('startup-splash:action', action)
  },
})
