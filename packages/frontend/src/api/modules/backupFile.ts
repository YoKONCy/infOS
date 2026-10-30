import { t } from '../../i18n'

/** 只读文件头，选择大备份时不将正文加载进浏览器内存。 */
export async function inspectBackupFile(file: Blob): Promise<{ encrypted: boolean; prefix: string }> {
  const invalid = () => new Error(t('ui.backup', '此文件不是完整的 infOS 备份，请重新选择'))
  if (file.size < 12 || file.size > 20 * 1024 ** 3) throw invalid()
  const bytes = new Uint8Array(await file.slice(0, 12 + 4096 + 10).arrayBuffer())
  if (bytes.length < 12 || new TextDecoder().decode(bytes.subarray(0, 8)) !== 'INFOSB1\n')
    throw invalid()
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8)
  const start = 12 + length
  if (length < 2 || length > 4096 || bytes.length < start + 10) throw invalid()
  let header: { encrypted: boolean }
  try {
    header = JSON.parse(new TextDecoder().decode(bytes.subarray(12, start)))
  } catch {
    throw invalid()
  }
  if (!header || typeof header.encrypted !== 'boolean' || (header.encrypted && file.size < start + 26))
    throw invalid()
  return { encrypted: header.encrypted, prefix: btoa(String.fromCharCode(...bytes)) }
}
