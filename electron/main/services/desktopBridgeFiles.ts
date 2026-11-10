/** @file 桥接像素临时文件的归属校验与迟到清理。 @platform ELECTRON */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 只登记主进程生成的像素临时文件；不能让桥接回音指定任意待删路径。 */
export function bridgeTemporaryFile(
  operation: string,
  input: Record<string, unknown>,
): string | undefined {
  if (!['capture', 'ocr'].includes(operation) || typeof input.path !== 'string') return undefined
  const file = path.resolve(input.path),
    root = path.resolve(os.tmpdir(), 'infos-desktop')
  const equal =
    process.platform === 'win32'
      ? path.dirname(file).toLowerCase() === root.toLowerCase()
      : path.dirname(file) === root
  return equal &&
    /^(capture|ocr)-[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}\.bgra$/i.test(path.basename(file))
    ? file
    : undefined
}
export function removeBridgeTemporaryFile(file: string): boolean {
  try {
    fs.rmSync(file, { force: true })
    return true
  } catch {
    return false
  }
}
