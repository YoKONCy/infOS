/** 桌面执行状态仅描述控制权，不表示业务任务已经完成。 */
export interface DesktopControlState {
  phase: 'idle' | 'running' | 'paused' | 'unavailable'
  epoch: number
  reason?: string
  agentId?: string
  threadId?: string
  taskId?: string
  targetTitle?: string
  stopShortcut: string
  /** 正在准备 Windows 桌面组件（首次使用或更新后编译 C#，约 10–20 秒）。 */
  preparing?: boolean
  /** 「桌面操作」总开关（广播时一起带上，各处状态条据此实时更新）。 */
  enabled?: boolean
}

export interface DesktopControlSettings {
  enabled: boolean
  stopShortcut: string
}

/** 「眼睛」的偏好：截图质量（JPEG 1–100，PNG 更小时自动用 PNG）。 */
export interface DesktopVisionSettings {
  imageQuality: number
  /** 观察的有效期（秒）：超过后引用该 observationId 的操作要求重新观察。 */
  observationTtlSec: number
}

export interface DesktopWindowInfo {
  windowId: string
  title: string
  processName: string
  pid: number
  bounds: { x: number; y: number; width: number; height: number }
  /** 窗口类名（系统读取）：识别经典控制面板（CabinetWClass）、对话框（#32770）。 */
  className?: string
}

/** 目标窗口状态：截不到图或操作不了时据此说明原因。 */
export interface DesktopWindowState {
  /** 已最小化：截不到画面。 */
  minimized: boolean
  /** 被其他窗口挡住了一部分：整屏裁剪的截图会混入上层窗口。 */
  occluded: boolean
  /** 以更高权限（例如管理员）运行：模拟输入会被 Windows 拦下。 */
  elevated: boolean
}

export interface DesktopElementInfo {
  id: string
  name: string
  role: string
  enabled: boolean
  patterns: string[]
  bounds: { x: number; y: number; width: number; height: number }
  /** 当前值（输入框内容等，密码框不读）。 */
  value?: string
  /** UIA AutomationId（系统读取），参与识别发送、付款等按钮。 */
  automationId?: string
}

/** 界面里的文字内容（标签、状态栏、表格单元、文档正文等）；bounds 为物理像素。 */
export interface DesktopTextInfo {
  role: string
  text: string
  bounds: { x: number; y: number; width: number; height: number }
}
