/** Electron 给 IPC 错误加的技术前缀，给用户看时去掉，只留主进程写的那句话。 */
const IPC_ERROR_PREFIX = /^Error invoking remote method '[^']*':\s*(?:[A-Za-z]*Error:\s*)?/

export function stripIpcErrorPrefix(message: string): string {
  return message.replace(IPC_ERROR_PREFIX, '')
}
