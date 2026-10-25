import type { KernelCapabilityDefinition } from '@infos/shared'
import { WEB_PAGE_OPERATIONS } from '@infos/shared'

const READ_OPERATIONS = new Set([
  'inspect',
  'extract',
  'screenshot',
  'elementScreenshot',
  'listTargets',
  'domQuery',
  'frameQuery',
  'sourceSearch',
  'networkQuery',
  'runtimeStatus',
])
const ELEVATED_OPERATIONS = new Set([
  'type',
  'sendKeys',
  'setValue',
  'storage',
  'emulate',
  'evaluate',
  'networkBody',
  'networkConfigure',
  'uploadFile',
  'downloadConfigure',
])

export const WEB_PAGE_CAPABILITY: KernelCapabilityDefinition = {
  capabilityType: 'web.page',
  contractVersion: '1.0',
  operations: Object.fromEntries(
    WEB_PAGE_OPERATIONS.map((operation) => [
      operation,
      {
        risk: READ_OPERATIONS.has(operation)
          ? 'read'
          : ELEVATED_OPERATIONS.has(operation)
            ? 'elevated'
            : 'interact',
        idempotency: READ_OPERATIONS.has(operation) ? 'safe' : 'unsafe',
      },
    ]),
  ),
}

export const AUDIO_TTS_GENERATE_CAPABILITY: KernelCapabilityDefinition = {
  capabilityType: 'audio.tts.generate',
  contractVersion: '1.0',
  operations: {
    generate: { risk: 'interact', idempotency: 'keyed' },
  },
}

/** 文档后台渲染无需桌面 Input Seat，也不复用用户正在浏览的页面。 */
export const DOCUMENT_RENDER_CAPABILITY: KernelCapabilityDefinition = {
  capabilityType: 'document.render',
  contractVersion: '1.0',
  operations: { renderPdf: { risk: 'interact', idempotency: 'safe' } },
}

export const AUDIO_OUTPUT_CAPABILITY: KernelCapabilityDefinition = {
  capabilityType: 'audio.output',
  contractVersion: '1.0',
  operations: {
    play: { risk: 'interact', idempotency: 'keyed' },
    stop: { risk: 'interact', idempotency: 'safe' },
    status: { risk: 'read', idempotency: 'safe' },
  },
}

/** 系统完成提醒无需 Input Seat，不占用桌面控制权限。 */
export const COMPLETION_ALERT_CAPABILITY: KernelCapabilityDefinition = {
  capabilityType: 'client.completion-alert',
  contractVersion: '1.0',
  operations: { notify: { risk: 'interact', idempotency: 'keyed' } },
}

export const SYSTEM_SHELL_CAPABILITY: KernelCapabilityDefinition = {
  capabilityType: 'system.shell',
  contractVersion: '1.0',
  operations: {
    create: { risk: 'root', idempotency: 'unsafe' },
    list: { risk: 'read', idempotency: 'safe' },
    get: { risk: 'read', idempotency: 'safe' },
    read: { risk: 'read', idempotency: 'safe' },
    wait: { risk: 'read', idempotency: 'safe' },
    write: { risk: 'root', idempotency: 'unsafe' },
    interrupt: { risk: 'root', idempotency: 'safe' },
    kill: { risk: 'root', idempotency: 'safe' },
    close: { risk: 'root', idempotency: 'safe' },
  },
}

export const DESKTOP_ENVIRONMENT_CAPABILITY: KernelCapabilityDefinition = {
  capabilityType: 'desktop.environment',
  contractVersion: '1.0',
  operations: {
    runtimeDiagnostics: { risk: 'read', idempotency: 'safe' },
    control: { risk: 'interact', idempotency: 'unsafe' },
    statusCard: { risk: 'read', idempotency: 'safe' },
    screenCapture: { risk: 'elevated', idempotency: 'safe' },
    clipboardRead: { risk: 'elevated', idempotency: 'safe' },
    clipboardWrite: { risk: 'elevated', idempotency: 'unsafe' },
    activeWindow: { risk: 'read', idempotency: 'safe' },
    listWindows: { risk: 'read', idempotency: 'safe' },
    activateWindow: { risk: 'interact', idempotency: 'unsafe' },
    applicationLaunch: { risk: 'elevated', idempotency: 'unsafe' },
    mousePosition: { risk: 'read', idempotency: 'safe' },
    mouseAction: { risk: 'elevated', idempotency: 'unsafe' },
    keyboardAction: { risk: 'elevated', idempotency: 'unsafe' },
  },
}
