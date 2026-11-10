import { contextBridge, ipcRenderer } from 'electron'

/**
 * 右下角「家」通知窗口：只能收到主进程整理好的通知内容，回传按钮动作与内容高度。
 * 不提供通用 IPC，也拿不到后端凭据；动作是否合法由主进程按当前通知再核对一遍。
 */
contextBridge.exposeInMainWorld('homeNotice', {
  onState: (listener: (state: unknown) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, state: unknown) => listener(state)
    ipcRenderer.on('home-notice:state', wrapped)
    return () => ipcRenderer.off('home-notice:state', wrapped)
  },
  ready: () => ipcRenderer.send('home-notice:ready'),
  action: (action: unknown) => ipcRenderer.send('home-notice:action', action),
  resize: (height: number) => ipcRenderer.send('home-notice:resize', height),
})
