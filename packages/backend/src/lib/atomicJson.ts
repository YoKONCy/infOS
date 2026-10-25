import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

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
        if (
          attempt >= 5 ||
          !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')
        )
          throw error
        await delay(20 * 2 ** attempt)
      }
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}
