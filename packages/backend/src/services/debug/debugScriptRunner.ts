import { Worker } from 'node:worker_threads'

/** 独立 Worker 提供终止边界；经过审批的脚本仍具有本机 Node 代码权限。 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const pending = new Map(); let sequence = 0;
parentPort.on('message', message => {
  const call = pending.get(message.id); if (!call) return; pending.delete(message.id);
  message.error ? call.reject(new Error(message.error)) : call.resolve(message.value);
});
const proxy = path => new Proxy(function(){}, {
  get(_target, key) { if (key === 'then') return undefined; return proxy([...path, String(key)]); },
  apply(_target, _self, args) { return new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject }); parentPort.postMessage({ id, method: path.join('.'), args });
  }); }
});
const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
const localRequire = require('node:module').createRequire(workerData.filename);
Promise.resolve().then(() => new AsyncFunction('debug', 'require', workerData.code)(proxy([]), localRequire))
  .then(value => parentPort.postMessage({ done: true, value }), error => parentPort.postMessage({ done: true, error: String(error.stack || error).slice(-16000) }));
`

export async function runDebugScript(input: {
  code: string
  filename: string
  signal?: AbortSignal
  timeoutMs: number
  invoke(method: string, args: unknown[]): Promise<unknown>
}): Promise<unknown> {
  input.signal?.throwIfAborted()
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: { code: input.code, filename: input.filename },
    resourceLimits: { maxOldGenerationSizeMb: 96 },
    stdout: true,
    stderr: true,
  })
  let output = ''
  const capture = (chunk: Buffer) => {
    output = (output + chunk.toString('utf8')).slice(-8000)
  }
  worker.stdout?.on('data', capture)
  worker.stderr?.on('data', capture)
  try {
    const result = await new Promise<unknown>((resolve, reject) => {
      let done = false
      let calls = 0
      const finish = () => {
        done = true
        clearTimeout(timer)
        input.signal?.removeEventListener('abort', abort)
      }
      const abort = () => {
        finish()
        reject(new Error('DEBUG_CANCELLED'))
      }
      input.signal?.addEventListener('abort', abort, { once: true })
      const timer = setTimeout(() => {
        finish()
        reject(new Error('DEBUG_SCRIPT_TIMEOUT'))
      }, input.timeoutMs)
      worker.on('message', (message) => {
        if (done || !message || typeof message !== 'object') return
        if (message.done) {
          finish()
          if (message.error) {
            reject(new Error(message.error))
            return
          }
          try {
            const serialized = JSON.stringify(message.value) ?? 'null'
            if (serialized.length > 128000) throw new Error('DEBUG_RESULT_LIMIT')
            resolve(message.value)
          } catch (error) {
            reject(error)
          }
          return
        }
        if (
          typeof message.id !== 'number' ||
          typeof message.method !== 'string' ||
          !Array.isArray(message.args)
        )
          return
        try {
          if (++calls > 512 || JSON.stringify(message.args).length > 512000)
            throw new Error('DEBUG_RPC_LIMIT')
        } catch {
          finish()
          reject(new Error('DEBUG_RPC_LIMIT'))
          return
        }
        void Promise.resolve()
          .then(() => input.invoke(message.method, message.args))
          .then(
            (value) => {
              if (!done) worker.postMessage({ id: message.id, value })
            },
            (error) => {
              if (!done) worker.postMessage({ id: message.id, error: String(error) })
            },
          )
          .catch(() => undefined)
      })
      worker.once('error', (error) => {
        finish()
        reject(error)
      })
      worker.once('exit', (code) => {
        finish()
        reject(new Error(`DEBUG_WORKER_EXIT: ${code}`))
      })
      if (input.signal?.aborted) {
        finish()
        abort()
      }
    })
    return { result, output }
  } finally {
    await worker.terminate()
  }
}
