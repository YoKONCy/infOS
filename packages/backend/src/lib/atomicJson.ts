import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'

const transientRename = (error: unknown) =>
  ['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')

/** 独立临时文件避免并发覆盖；Windows 短暂占用时有界重试，保留上一份记录。 */
export async function writeAtomicJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' })
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(temporary, file)
        return
      } catch (error) {
        if (attempt >= 5 || !transientRename(error)) throw error
        await delay(20 * 2 ** attempt)
      }
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

/** 同步凭据接口必须在返回前落盘；短暂文件占用有界等待，失败时仍保留旧凭据。 */
export function writeAtomicJsonSync(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' })
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(temporary, file)
        return
      } catch (error) {
        if (attempt >= 5 || !transientRename(error)) throw error
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * 2 ** attempt)
      }
    }
  } finally {
    try {
      rmSync(temporary, { force: true })
    } catch {
      /* 清理失败不能覆盖原始写入错误。 */
    }
  }
}
