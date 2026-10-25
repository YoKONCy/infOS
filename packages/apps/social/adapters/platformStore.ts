import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
const keys = new Map<string, Promise<Buffer>>()
const writes = new Map<string, Promise<unknown>>()

/** 平台凭据与协议游标不进入通用配置、消息正文或模型上下文。 */
export class PlatformStore {
  private key?: Buffer
  private file: string
  constructor(
    private root: string,
    identity: string,
  ) {
    this.file = join(root, `${createHash('sha256').update(identity).digest('hex')}.vault`)
  }
  private async encryptionKey(): Promise<Buffer> {
    if (this.key) return this.key
    const existing = keys.get(this.root)
    if (existing) return existing
    const pending = this.createKey().catch((error) => {
      keys.delete(this.root)
      throw error
    })
    keys.set(this.root, pending)
    return pending
  }
  private async createKey(): Promise<Buffer> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const file = join(this.root, 'platform.key')
    try {
      const handle = await open(file, 'wx', 0o600)
      try {
        await handle.writeFile(randomBytes(32))
        await handle.sync()
      } finally {
        await handle.close()
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const key = await readFile(file)
    if (key.length !== 32) throw new Error('SOCIAL_PRIVATE_STORAGE_INVALID')
    this.key = key
    return key
  }
  async read<T>(fallback: T): Promise<T> {
    await writes.get(this.file)?.catch(() => {})
    return this.readNow(fallback)
  }
  private async readNow<T>(fallback: T): Promise<T> {
    const key = await this.encryptionKey()
    let bytes: Buffer
    try {
      bytes = await readFile(this.file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(fallback)
      throw error
    }
    if (bytes.length < 29 || bytes[0] !== 1) throw new Error('SOCIAL_PRIVATE_STORAGE_INVALID')
    const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(1, 13))
    cipher.setAuthTag(bytes.subarray(13, 29))
    return JSON.parse(
      Buffer.concat([cipher.update(bytes.subarray(29)), cipher.final()]).toString('utf8'),
    ) as T
  }
  update<T>(fallback: T, change: (value: T) => void): Promise<T> {
    const write = (writes.get(this.file) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const value = await this.readNow(fallback)
        change(value)
        const nonce = randomBytes(12)
        const cipher = createCipheriv('aes-256-gcm', await this.encryptionKey(), nonce)
        const encrypted = Buffer.concat([
          cipher.update(JSON.stringify(value), 'utf8'),
          cipher.final(),
        ])
        const bytes = Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), encrypted])
        const temp = `${this.file}.${randomBytes(8).toString('hex')}.tmp`
        try {
          const handle = await open(temp, 'wx', 0o600)
          try {
            await handle.writeFile(bytes)
            await handle.sync()
          } finally {
            await handle.close()
          }
          await rename(temp, this.file)
        } finally {
          await rm(temp, { force: true }).catch(() => {})
        }
        return value
      })
    writes.set(this.file, write)
    void write
      .finally(() => {
        if (writes.get(this.file) === write) writes.delete(this.file)
      })
      .catch(() => {})
    return write
  }
}
