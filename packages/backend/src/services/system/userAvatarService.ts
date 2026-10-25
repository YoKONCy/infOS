import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import type { ConfigRepository } from '../../repositories/config.repo'
import type { PathResolver } from '../../core/pathResolver'
import { AppError } from '../../lib/appError'

export const USER_AVATAR_MAX_BYTES = 5 * 1024 * 1024
const RESOURCE_KEY = 'ui.ownerAvatar.resource'
const RESOURCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** 客户端裁切与编码；服务端只管理上传后的头像资源，不接受客户端文件路径。 */
export class UserAvatarService {
  private mutations: Promise<unknown> = Promise.resolve()

  constructor(
    private paths: Pick<PathResolver, 'resolve'>,
    private config: Pick<ConfigRepository, 'get' | 'set' | 'delete'>,
  ) {}

  profile(): Promise<{ version: string | null; name: string }> {
    return this.mutate(() => this.readProfile())
  }

  private async readProfile(): Promise<{ version: string | null; name: string }> {
    const version = await this.currentResource()
    const exists = version
      ? await stat(this.filePath(version)).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null
          throw error
        })
      : null
    return {
      version: exists?.isFile() ? version : null,
      name: (await this.config.get('owner.name')) ?? '',
    }
  }

  async save(file: File): Promise<{ version: string | null; name: string }> {
    if (file.size === 0 || file.size > USER_AVATAR_MAX_BYTES)
      throw new AppError('PAYLOAD_TOO_LARGE', { message: '头像文件应大于 0 且不超过 5MB' })
    const bytes = Buffer.from(await file.arrayBuffer())
    // 只接收客户端导出的 512px 方形 PNG，不依据扩展名、MIME 或外部 URL 寻址。
    if (
      bytes.length < 45 ||
      !bytes.subarray(0, 8).equals(PNG_SIGNATURE) ||
      bytes.readUInt32BE(8) !== 13 ||
      bytes.subarray(12, 16).toString('ascii') !== 'IHDR' ||
      bytes.readUInt32BE(16) !== 512 ||
      bytes.readUInt32BE(20) !== 512 ||
      bytes.subarray(-8, -4).toString('ascii') !== 'IEND'
    )
      throw new AppError('UNSUPPORTED_MEDIA_TYPE', {
        message: '请上传客户端裁切生成的 512px PNG 头像',
      })

    return this.mutate(async () => {
      const previous = await this.currentResource()
      const version = randomUUID()
      const target = this.filePath(version)
      await mkdir(path.dirname(target), { recursive: true })
      try {
        await writeFile(target, bytes, { flag: 'wx' })
        // 资源完整写入后才切换引用；配置保存失败时保留旧头像。
        await this.config.set(RESOURCE_KEY, version)
      } catch (error) {
        await unlink(target).catch(() => undefined)
        throw error
      }
      if (previous) await unlink(this.filePath(previous)).catch(() => undefined)
      return this.readProfile()
    })
  }

  read(): Promise<Buffer> {
    return this.mutate(async () => {
      const version = await this.currentResource()
      if (!version) throw new AppError('NOT_FOUND')
      try {
        return await readFile(this.filePath(version))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new AppError('NOT_FOUND')
        throw error
      }
    })
  }

  remove(): Promise<{ version: string | null; name: string }> {
    return this.mutate(async () => {
      const previous = await this.currentResource()
      await this.config.delete(RESOURCE_KEY)
      if (previous) await unlink(this.filePath(previous)).catch(() => undefined)
      return this.readProfile()
    })
  }

  private async currentResource(): Promise<string | null> {
    const value = await this.config.get(RESOURCE_KEY)
    return value && RESOURCE_ID.test(value) ? value : null
  }

  private filePath(version: string): string {
    return path.join(this.paths.resolve('@data/ui/owner-avatar'), `${version}.png`)
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.mutations.catch(() => undefined).then(operation)
    this.mutations = current
    return current
  }
}
