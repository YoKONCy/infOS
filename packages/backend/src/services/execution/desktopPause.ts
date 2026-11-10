import type { ConversationExecutionPause } from '@infos/shared'

const DESKTOP_TOOLS = new Set([
  'take_screenshot',
  'automation_execute',
  'desktop_direct',
  'activate_window',
  'open_application',
  'home_files',
  'home_shelf',
  'delete_file',
  'write_file',
  'edit_file',
  'home_declare',
])
const PAUSE_CODE =
  /^(?:DESKTOP_(WAITING|CANCELLED|INPUT_MONITOR_UNAVAILABLE|BRIDGE_CLOSED|RESULT_UNCERTAIN)|HOME_CONFIRMATION_REQUIRED)$/

type DesktopObservation = {
  name: string
  output: string
  isError: boolean
  callId?: string
}

/** 只解释桌面工具产生的控制权错误，普通日志中的同名文字不能暂停执行。 */
function desktopControlError(input: DesktopObservation) {
  if (!input.isError || !DESKTOP_TOOLS.has(input.name)) return undefined
  let code: string | undefined
  let message = input.output.slice(0, 500)
  try {
    const parsed = JSON.parse(input.output)
    const error = parsed?.error ?? parsed
    if (typeof error === 'string') message = error.slice(0, 500)
    if (typeof error?.code === 'string') code = error.code
    if (typeof error?.message === 'string') message = error.message
  } catch {
    /* 旧桌面工具也可能直接返回错误文字。 */
  }
  if (!code) {
    const match = /\b(DESKTOP_[A-Z_]+):\s*([^\n]*)/.exec(message)
    code = match?.[1]
    message = match?.[2] ?? message
  }
  return code ? { code, message } : undefined
}

export function isDesktopControlInterruption(input: DesktopObservation): boolean {
  const error = desktopControlError(input)
  return !!error && (PAUSE_CODE.test(error.code) || error.code === 'DESKTOP_USER_BUSY')
}

export function desktopPauseFromObservation(
  input: DesktopObservation,
): ConversationExecutionPause | undefined {
  const error = desktopControlError(input)
  if (!error || !PAUSE_CODE.test(error.code)) return undefined
  return {
    kind: 'desktop',
    ...error,
    toolName: input.name,
    callId: input.callId ?? input.name,
    pausedAt: new Date().toISOString(),
  }
}
