import { Worker } from 'node:worker_threads'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/** 完整 SQLite 校验隔离到线程，文件路径由私有解包目录提供，取消时等待线程退出。 */
export async function checkBackupIntegrity(file: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  const worker = new Worker(
    `
    const { parentPort, workerData } = require('node:worker_threads');
    try {
      const Database = require(workerData.entry);
      const db = new Database(workerData.file, { readonly: true, fileMustExist: true });
      try {
        if (db.pragma('integrity_check', { simple: true }) !== 'ok')
          throw new Error('BACKUP_DATABASE_INVALID');
      } finally { db.close(); }
      parentPort.postMessage({ ok: true });
    } catch { parentPort.postMessage({ ok: false }); }
  `,
    {
      eval: true,
      workerData: { entry: require.resolve('better-sqlite3'), file },
      resourceLimits: { maxOldGenerationSizeMb: 128 },
    },
  )
  let abort: (() => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      abort = () => reject(signal?.reason ?? new Error('BACKUP_IMPORT_CANCELLED'))
      signal?.addEventListener('abort', abort, { once: true })
      timer = setTimeout(() => reject(new Error('BACKUP_IMPORT_TIMEOUT')), 30 * 60_000)
      timer.unref()
      worker.once('message', (message: { ok: boolean }) => {
        if (message.ok) resolve()
        else reject(new Error('BACKUP_DATABASE_INVALID'))
      })
      worker.once('error', () => reject(new Error('BACKUP_DATABASE_INVALID')))
      worker.once('exit', () => reject(new Error('BACKUP_DATABASE_INVALID')))
      if (signal?.aborted) abort()
    })
  } finally {
    if (timer) clearTimeout(timer)
    if (abort) signal?.removeEventListener('abort', abort)
    await worker.terminate()
  }
}
