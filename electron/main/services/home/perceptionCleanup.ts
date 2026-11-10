import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 只清理自有临时文件名；1 小时内文件可能仍被原生 OCR 持有。 */
export function cleanupPerceptionMedia(): void {
  const directory = path.join(os.tmpdir(), 'infos-desktop')
  try {
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
      if (!entry.isFile() || !/^(capture|ocr)-[0-9a-f-]{36}\.bgra$/i.test(entry.name)) continue
      const file = path.join(directory, entry.name)
      if (Date.now() - fs.statSync(file).mtimeMs > 3_600_000) fs.rmSync(file, {force: true})
    }
  } catch { /* 目录不存在或仍占用时留给下一次清理。 */ }
}
