import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, mkdir, open, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { createGzip, createGunzip } from 'node:zlib'
import type { BackupManifest, BackupRow } from './backupTypes'

const MAGIC = Buffer.from('INFOSB1\n')
const MAX_BYTES = 20 * 1024 ** 3
const MAX_LINE = 32 * 1024 ** 2
const MAX_FILES = 100_000
const derive = promisify(scrypt)

/** 包内路径采用平台无关的相对路径，禁止 Windows 别名、设备名和目录穿越。 */
export function safeBackupPath(value: string): string {
  if (!value || value.length > 1024 || /[\\:\x00-\x1f]/.test(value) || value.startsWith('/'))
    throw new Error('BACKUP_PATH_INVALID')
  const parts = value.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))
    throw new Error('BACKUP_PATH_INVALID')
  return value
}

export async function fileDigest(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

/** NDJSON 分块压缩与可选口令加密，附件不整体读入内存。 */
export async function writeBackupArchive(
  output: string,
  manifest: BackupManifest,
  root: string,
  records: AsyncIterable<{ table: string; row: BackupRow }>,
  password = '',
): Promise<void> {
  const salt = randomBytes(16), iv = randomBytes(12)
  const header = Buffer.from(JSON.stringify({ encrypted: Boolean(password), salt: salt.toString('base64'), iv: iv.toString('base64') }))
  const size = Buffer.alloc(4)
  size.writeUInt32BE(header.length)
  await writeFile(output, Buffer.concat([MAGIC, size, header]), { mode: 0o600, flag: 'wx' })
  async function* lines() {
    const manifestLine = JSON.stringify({ type: 'manifest', value: manifest }) + '\n'
    if (Buffer.byteLength(manifestLine) > MAX_LINE || manifest.files.length > MAX_FILES || manifest.files.reduce((sum, file) => sum + file.size, 0) > MAX_BYTES) throw new Error('BACKUP_SIZE_INVALID')
    yield manifestLine
    for await (const record of records) {
      const line = JSON.stringify({ type: 'record', ...record }) + '\n'
      if (Buffer.byteLength(line) > MAX_LINE) throw new Error('BACKUP_RECORD_TOO_LARGE')
      yield line
    }
    for (const file of manifest.files) {
      yield JSON.stringify({ type: 'file', path: file.path }) + '\n'
      for await (const chunk of createReadStream(path.join(root, safeBackupPath(file.path)), { highWaterMark: 256 * 1024 }))
        yield JSON.stringify({ type: 'chunk', data: (chunk as Buffer).toString('base64') }) + '\n'
      yield '{"type":"end"}\n'
    }
  }
  const destination = createWriteStream(output, { flags: 'a' })
  if (password) {
    const key = await derive(password, salt, 32) as Buffer
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(Buffer.concat([MAGIC, size, header]))
    await pipeline(Readable.from(lines()), createGzip(), cipher, destination)
    const file = await open(output, 'a')
    try { await file.write(cipher.getAuthTag()) } finally { await file.close() }
  } else await pipeline(Readable.from(lines()), createGzip(), destination)
  if ((await stat(output)).size > MAX_BYTES) throw new Error('BACKUP_SIZE_INVALID')
}

/** 只在私有暂存区解包；校验完成之前不得将文件安装到业务目录。 */
export async function readBackupArchive(input: string, root: string, password = ''): Promise<BackupManifest> {
  const file = await open(input, 'r')
  let start: number, header: { encrypted: boolean; salt: string; iv: string }, authenticated: Buffer
  const bytes = (await file.stat()).size
  try {
    const prefix = Buffer.alloc(12)
    if ((await file.read(prefix, 0, 12, 0)).bytesRead !== 12 || !prefix.subarray(0, 8).equals(MAGIC)) throw new Error('BACKUP_FORMAT_INVALID')
    const length = prefix.readUInt32BE(8)
    if (length > 4096 || length < 2 || bytes > MAX_BYTES || bytes < 12 + length) throw new Error('BACKUP_SIZE_INVALID')
    const buffer = Buffer.alloc(length)
    if ((await file.read(buffer, 0, length, 12)).bytesRead !== length) throw new Error('BACKUP_FORMAT_INVALID')
    header = JSON.parse(buffer.toString())
    if (!header || typeof header.encrypted !== 'boolean') throw new Error('BACKUP_FORMAT_INVALID')
    authenticated = Buffer.concat([prefix, buffer])
    start = 12 + length
  } finally { await file.close() }
  let decipher: ReturnType<typeof createDecipheriv> | undefined
  if (header.encrypted) {
    if (!password) throw new Error('BACKUP_PASSWORD_REQUIRED')
    if (typeof header.salt !== 'string' || typeof header.iv !== 'string') throw new Error('BACKUP_FORMAT_INVALID')
    const salt = Buffer.from(header.salt, 'base64'), iv = Buffer.from(header.iv, 'base64')
    if (salt.length !== 16 || iv.length !== 12 || bytes < start + 16) throw new Error('BACKUP_FORMAT_INVALID')
    const key = await derive(password, salt, 32) as Buffer
    const decryptor = createDecipheriv('aes-256-gcm', key, iv)
    decryptor.setAAD(authenticated)
    const handle = await open(input, 'r')
    const tag = Buffer.alloc(16)
    try { await handle.read(tag, 0, 16, bytes - 16) } finally { await handle.close() }
    decryptor.setAuthTag(tag)
    decipher = decryptor
  }
  const source = createReadStream(input, { start, end: bytes - (header.encrypted ? 17 : 1) })
  if (decipher) source.once('error', (error) => decipher!.destroy(error))
  const compressed: Readable = decipher ? source.pipe(decipher) : source
  let expanded = 0, lineBytes = 0
  const limit = new Transform({ transform(chunk: Buffer, _encoding, done) {
    expanded += chunk.length
    for (const byte of chunk) {
      lineBytes = byte === 10 ? 0 : lineBytes + 1
      if (lineBytes > MAX_LINE) return done(new Error('BACKUP_RECORD_TOO_LARGE'))
    }
    done(expanded > MAX_BYTES * 2 ? new Error('BACKUP_SIZE_INVALID') : null, chunk)
  } })
  const gunzip = createGunzip()
  const completion = pipeline(compressed, gunzip, limit)
  // 消费行时也立即挂接拒绝处理，解密或压缩损坏不能形成未处理异常。
  void completion.catch(() => {})
  const lines = createInterface({ input: limit, crlfDelay: Infinity })
  let manifest: BackupManifest | undefined
  const seen = new Set<string>(), tableCounts: Record<string, number> = Object.create(null)
  const recordFiles = new Map<string, Awaited<ReturnType<typeof open>>>()
  let recordBytes = 0
  const descriptors = new Map<string, BackupManifest['files'][number]>()
  let current: { descriptor: BackupManifest['files'][number]; handle: Awaited<ReturnType<typeof open>>; hash: ReturnType<typeof createHash>; size: number } | undefined
  try {
    for await (const line of lines) {
      const item = JSON.parse(line)
      if (!manifest) {
        if (item.type !== 'manifest' || item.value?.format !== 'infos.backup' || item.value.version !== 1) throw new Error('BACKUP_FORMAT_INVALID')
        manifest = item.value as BackupManifest
        if (!/^[a-f0-9-]{36}$/i.test(manifest.id) || !Array.isArray(manifest.files) || manifest.files.length > MAX_FILES || !manifest.tables || typeof manifest.tables !== 'object' || Array.isArray(manifest.tables) || Object.keys(manifest.tables).length > 100 || Object.entries(manifest.tables).some(([table, count]) => !/^[a-z][a-z_]*$/.test(table) || !Number.isSafeInteger(count) || count < 0 || count > 500_000)) throw new Error('BACKUP_FORMAT_INVALID')
        const paths = new Set<string>()
        let total = 0
        for (const descriptor of manifest.files) {
          safeBackupPath(descriptor.path)
          if (paths.has(descriptor.path) || !Number.isSafeInteger(descriptor.size) || descriptor.size < 0 || !/^[a-f0-9]{64}$/.test(descriptor.sha256) || (descriptor.mode !== undefined && (!Number.isInteger(descriptor.mode) || descriptor.mode < 0 || descriptor.mode > 0o777))) throw new Error('BACKUP_FORMAT_INVALID')
          paths.add(descriptor.path)
          descriptors.set(descriptor.path, descriptor)
          total += descriptor.size
        }
        if (total > MAX_BYTES) throw new Error('BACKUP_SIZE_INVALID')
        await mkdir(path.join(root, 'records'), { recursive: true, mode: 0o700 })
      } else if (item.type === 'record' && !current) {
        recordBytes += Buffer.byteLength(line)
        if (recordBytes > 256 * 1024 ** 2 || !/^[a-z][a-z_]*$/.test(item.table) || !Object.hasOwn(manifest.tables, item.table) || !item.row || typeof item.row !== 'object' || Array.isArray(item.row)) throw new Error('BACKUP_RECORD_INVALID')
        tableCounts[item.table] = (tableCounts[item.table] ?? 0) + 1
        if (tableCounts[item.table]! > manifest.tables[item.table]!) throw new Error('BACKUP_RECORD_INVALID')
        let output = recordFiles.get(item.table)
        if (!output) { output = await open(path.join(root, 'records', `${item.table}.jsonl`), 'wx', 0o600); recordFiles.set(item.table, output) }
        await output.writeFile(JSON.stringify(item.row) + '\n')
      } else if (item.type === 'file' && !current) {
        const descriptor = descriptors.get(item.path)
        if (!descriptor || seen.has(descriptor.path)) throw new Error('BACKUP_FILE_INVALID')
        const target = path.join(root, 'files', descriptor.path)
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
        current = { descriptor, handle: await open(target, 'wx', 0o600), hash: createHash('sha256'), size: 0 }
      } else if (item.type === 'chunk' && current) {
        if (typeof item.data !== 'string') throw new Error('BACKUP_FILE_INVALID')
        const data = Buffer.from(item.data, 'base64')
        current.size += data.length
        if (current.size > current.descriptor.size) throw new Error('BACKUP_SIZE_INVALID')
        current.hash.update(data)
        await current.handle.writeFile(data)
      } else if (item.type === 'end' && current) {
        await current.handle.close()
        if (current.size !== current.descriptor.size || current.hash.digest('hex') !== current.descriptor.sha256) throw new Error('BACKUP_CHECKSUM_INVALID')
        await chmod(path.join(root, 'files', current.descriptor.path), 0o600 | ((current.descriptor.mode ?? 0) & 0o100))
        seen.add(current.descriptor.path)
        current = undefined
      } else throw new Error('BACKUP_FORMAT_INVALID')
    }
    await completion
    if (!manifest || current || seen.size !== manifest.files.length || Object.entries(manifest.tables).some(([table, count]) => (tableCounts[table] ?? 0) !== count)) throw new Error('BACKUP_INCOMPLETE')
    return manifest
  } finally {
    for (const handle of recordFiles.values()) await handle.close().catch(() => {})
    await current?.handle.close().catch(() => {})
    lines.close()
    limit.destroy()
    compressed.destroy()
    source.destroy()
  }
}

export async function* readBackupRows(root: string, table: string): AsyncGenerator<BackupRow> {
  yield* readBackupRowFile(path.join(root, 'records', `${table}.jsonl`))
}

export async function* readBackupRowFile(file: string): AsyncGenerator<BackupRow> {
  if (!(await stat(file).catch(() => null))) return
  const source = createReadStream(file)
  const lines = createInterface({ input: source, crlfDelay: Infinity })
  try { for await (const line of lines) yield JSON.parse(line) as BackupRow }
  finally { lines.close(); source.destroy() }
}
