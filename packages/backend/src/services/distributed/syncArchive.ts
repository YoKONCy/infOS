import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open } from 'node:fs/promises'
import path from 'node:path'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGzip, createGunzip } from 'node:zlib'
import { safeBackupPath } from '../backup/backupArchive'
import type { FullSyncManifest } from './distributedSyncService'

const MAGIC = Buffer.from('INFOSS3\n')
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024
const CHUNK_BYTES = 256 * 1024

export function isSyncArchive(bytes: Buffer): boolean {
  return bytes.subarray(0, MAGIC.length).equals(MAGIC)
}

/** 只有清单转成 JSON，文件正文按清单顺序以原始字节分块压缩。 */
export async function writeSyncArchive(
  manifest: FullSyncManifest,
  files: ReadonlyMap<string, string>,
  signal?: AbortSignal,
): Promise<Buffer> {
  signal?.throwIfAborted()
  const metadata = Buffer.from(JSON.stringify(manifest))
  if (metadata.length > MAX_MANIFEST_BYTES) throw new Error('SYNC_MANIFEST_SIZE_LIMIT_EXCEEDED')
  const size = Buffer.alloc(4)
  size.writeUInt32BE(metadata.length)
  async function* chunks() {
    yield size
    yield metadata
    for (const descriptor of manifest.files) {
      signal?.throwIfAborted()
      const file = files.get(descriptor.path)
      if (!file) throw new Error(`SYNC_FILE_MISSING: ${descriptor.path}`)
      const hash = createHash('sha256')
      let bytes = 0
      for await (const chunk of createReadStream(file, { highWaterMark: CHUNK_BYTES, signal })) {
        bytes += chunk.length
        if (bytes > descriptor.sizeBytes)
          throw new Error(`SYNC_FILE_SIZE_MISMATCH: ${descriptor.path}`)
        hash.update(chunk)
        yield chunk
      }
      if (bytes !== descriptor.sizeBytes)
        throw new Error(`SYNC_FILE_SIZE_MISMATCH: ${descriptor.path}`)
      if (hash.digest('hex') !== descriptor.sha256)
        throw new Error(`SYNC_FILE_CHECKSUM_MISMATCH: ${descriptor.path}`)
    }
  }
  const compressed: Buffer[] = [MAGIC]
  await pipeline(
    Readable.from(chunks()),
    createGzip(),
    new Writable({
      write(chunk: Buffer, _encoding, done) {
        compressed.push(chunk)
        done()
      },
    }),
    { signal },
  )
  return Buffer.concat(compressed)
}

/** 只保留当前压缩流块；大文件读取不拼接正文，也不转换成长字符串。 */
class ArchiveReader {
  private remaining: Buffer = Buffer.alloc(0)

  constructor(private readonly source: AsyncIterator<Buffer>) {}

  async *take(length: number): AsyncGenerator<Buffer> {
    while (length > 0) {
      if (!this.remaining.length) {
        const next = await this.source.next()
        if (next.done) throw new Error('SYNC_BUNDLE_INCOMPLETE')
        this.remaining = next.value
        continue
      }
      const size = Math.min(length, this.remaining.length)
      yield this.remaining.subarray(0, size)
      this.remaining = this.remaining.subarray(size)
      length -= size
    }
  }

  async read(length: number): Promise<Buffer> {
    const parts: Buffer[] = []
    for await (const part of this.take(length)) parts.push(part)
    return Buffer.concat(parts, length)
  }

  async end(): Promise<void> {
    if (this.remaining.length || !(await this.source.next()).done)
      throw new Error('SYNC_BUNDLE_TRAILING_DATA')
  }
}

/** 先验证有界清单，再逐文件核对长度与摘要；可只校验，或写入隔离的导入目录。 */
export async function readSyncArchive(
  bytes: Buffer,
  validate: (manifest: FullSyncManifest) => void,
  output?: string,
): Promise<FullSyncManifest> {
  if (!isSyncArchive(bytes)) throw new Error('SYNC_BUNDLE_INVALID')
  const source = Readable.from([bytes.subarray(MAGIC.length)])
  const gunzip = createGunzip()
  const completion = pipeline(source, gunzip)
  void completion.catch(() => {})
  const reader = new ArchiveReader(gunzip[Symbol.asyncIterator]())
  try {
    const size = (await reader.read(4)).readUInt32BE(0)
    if (size < 2 || size > MAX_MANIFEST_BYTES)
      throw new Error('SYNC_MANIFEST_SIZE_LIMIT_EXCEEDED')
    const manifest = JSON.parse((await reader.read(size)).toString('utf8')) as FullSyncManifest
    if (manifest?.bundleVersion !== 3) throw new Error('SYNC_BUNDLE_VERSION_UNSUPPORTED')
    validate(manifest)
    for (const descriptor of manifest.files) {
      const normalized = safeBackupPath(descriptor.path.replaceAll('\\', '/'))
      // 资源恢复状态只属于本机；仍校验其正文，随后跳过安装。
      const excluded =
        normalized.split('/')[0] === 'resource-versions' ||
        normalized.split('/')[0]?.startsWith('.resource-')
      const target = output && !excluded ? path.join(output, normalized) : undefined
      if (target) await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
      const file = target ? await open(target, 'wx', 0o600) : undefined
      const hash = createHash('sha256')
      try {
        for await (const chunk of reader.take(descriptor.sizeBytes)) {
          hash.update(chunk)
          await file?.writeFile(chunk)
        }
      } finally {
        await file?.close()
      }
      if (hash.digest('hex') !== descriptor.sha256)
        throw new Error(`SYNC_FILE_CHECKSUM_MISMATCH: ${normalized}`)
    }
    await reader.end()
    await completion
    return manifest
  } finally {
    gunzip.destroy()
    source.destroy()
    await completion.catch(() => {})
  }
}
