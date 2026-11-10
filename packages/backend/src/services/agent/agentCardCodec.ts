/** infOS 角色卡编解码；外部资源只在完整校验后交给持久层。 */
import { deflateSync, inflateRawSync } from 'node:zlib'
import { zipSync } from 'fflate'
import { z } from 'zod'

export const CARD_LIMITS = {
  file: 64 * 1024 * 1024,
  total: 128 * 1024 * 1024,
  entry: 32 * 1024 * 1024,
  files: 512,
}
export class AgentCardError extends Error {
  constructor(public readonly reason: 'INVALID' | 'LIMIT' | 'CONFLICT' | 'UNSUPPORTED' = 'INVALID') {
    super(`AGENT_CARD_${reason}`)
  }
}
const invalid = (): never => {
  throw new AgentCardError()
}
const limit = (): never => {
  throw new AgentCardError('LIMIT')
}
const text = (max: number) => z.string().max(max)
const manifestSchema = z
  .object({
    format: z.literal('infos.agent-card'),
    version: z.literal(1),
    agentId: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9_-]+$/),
    name: text(100).min(1),
    worldbooks: z.array(z.never()).max(0).default([]),
  })
  .strict()
export type AgentCardManifest = z.infer<typeof manifestSchema>
export interface AgentCard {
  manifest: AgentCardManifest
  files: Map<string, Buffer>
}
const decoder = new TextDecoder('utf-8', { fatal: true })
export function parseCardJson(data: Uint8Array): unknown {
  try {
    return JSON.parse(decoder.decode(data), (key, value: unknown) => {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') invalid()
      return value
    })
  } catch {
    return invalid()
  }
}

/** 同时收窄目录、扩展名和 Windows 文件名语义，避免跨平台落盘歧义。 */
export function validateResourcePath(name: string): void {
  if (
    name.length > 240 ||
    !name ||
    /[\\<>:"|?*]/.test(name) ||
    [...name].some((char) => char.charCodeAt(0) < 32)
  )
    invalid()
  const segments = name.split('/')
  if (
    segments.length > 12 ||
    segments.some(
      (s) =>
        !s ||
        s === '.' ||
        s === '..' ||
        /[. ]$/.test(s) ||
        /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(s) ||
        s.toLowerCase() === 'workspace',
    )
  )
    invalid()
  if (!/\.(json|md|txt|yaml|yml|png|jpg|jpeg|webp|gif)$/i.test(name)) invalid()
}

const configSchema = z
  .object({
    name: text(100).min(1),
    description: text(20000).optional(),
    agent_id: text(100).optional(),
    owner_appellation: text(100).optional(),
    public_profile: z.record(z.string(), z.string()).optional(),
    traits: z
      .object({ social: z.array(z.string()).optional() })
      .passthrough()
      .optional(),
    social_traits: z.array(z.string()).optional(),
    social: z.record(z.string(), z.unknown()).optional(),
    tool_policies: z.record(z.string(), z.unknown()).optional(),
    channel_patches: z.record(z.string(), z.string()).optional(),
    waifu_texts: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .passthrough()

export function validateCard(card: AgentCard): AgentCard {
  if (Array.isArray(card.manifest?.worldbooks) && card.manifest.worldbooks.length)
    throw new AgentCardError('UNSUPPORTED')
  const result = manifestSchema.safeParse(card.manifest)
  if (!result.success) return invalid()
  card.manifest = result.data
  validateResourcePath(`${card.manifest.agentId}.json`)
  if (
    card.files.size === 0 ||
    card.files.size + 1 > CARD_LIMITS.files
  )
    invalid()
  let total = Buffer.byteLength(JSON.stringify(card.manifest))
  if (total > CARD_LIMITS.entry) limit()
  const names = new Set<string>()
  for (const [name, data] of card.files) {
    validateResourcePath(name)
    const key = name.toLowerCase()
    if (
      names.has(key) ||
      [...names].some((n) => n.startsWith(`${key}/`) || key.startsWith(`${n}/`))
    )
      invalid()
    names.add(key)
    if (data.length > CARD_LIMITS.entry) limit()
    total += data.length
    if (total > CARD_LIMITS.total) limit()
    if (/\.json$/i.test(name)) parseCardJson(data)
    if (/\.png$/i.test(name)) pngChunks(data)
    if (
      /\.jpe?g$/i.test(name) &&
      (data.length < 4 ||
        data.readUInt16BE(0) !== 0xffd8 ||
        data.readUInt16BE(data.length - 2) !== 0xffd9)
    )
      invalid()
    if (
      /\.webp$/i.test(name) &&
      (data.length < 12 ||
        data.toString('ascii', 0, 4) !== 'RIFF' ||
        data.toString('ascii', 8, 12) !== 'WEBP' ||
        data.readUInt32LE(4) !== data.length - 8)
    )
      invalid()
    if (
      /\.gif$/i.test(name) &&
      (data.length < 14 ||
        !['GIF87a', 'GIF89a'].includes(data.toString('ascii', 0, 6)) ||
        data[data.length - 1] !== 0x3b ||
        data.readUInt16LE(6) * data.readUInt16LE(8) < 1 ||
        data.readUInt16LE(6) * data.readUInt16LE(8) > 16_777_216)
    )
      invalid()
  }
  const config = card.files.get('agent.json') ?? card.files.get('config.json')
  if (!config || !configSchema.safeParse(parseCardJson(config)).success) return invalid()
  if ((parseCardJson(config) as { name: string }).name !== card.manifest.name) invalid()
  return card
}

/** CRC 同时用于 PNG 块和 ZIP 条目，损坏数据不会静默进入书库。 */
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  return crc >>> 0
})
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of data) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255]!
  return (crc ^ 0xffffffff) >>> 0
}
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(data.length + 12)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, -4)), out.length - 4)
  return out
}

/** 无头像时使用不依赖外部文件的默认图。 */
export function defaultCardImage(): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(64, 0)
  header.writeUInt32BE(64, 4)
  header[8] = 8
  header[9] = 6
  const pixels = Buffer.alloc(64 * (1 + 64 * 4))
  for (let y = 0; y < 64; y++)
    for (let x = 0; x < 64; x++) {
      const p = y * 257 + 1 + x * 4
      const face = x > 15 && x < 48 && y > 14 && y < 51
      pixels[p] = face ? 160 : 55
      pixels[p + 1] = face ? 211 : 65
      pixels[p + 2] = face ? 245 : 90
      pixels[p + 3] = 255
    }
  return Buffer.concat([
    pngSignature,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
function pngChunks(png: Buffer): Array<{ type: string; data: Buffer; raw: Buffer }> {
  if (png.length > CARD_LIMITS.file) limit()
  if (!png.subarray(0, 8).equals(pngSignature)) invalid()
  const chunks = []
  let pos = 8
  let ended = false
  for (; pos < png.length; ) {
    if (pos + 12 > png.length || ended) invalid()
    const size = png.readUInt32BE(pos)
    const end = pos + 12 + size
    if (end > png.length) invalid()
    const type = png.toString('ascii', pos + 4, pos + 8)
    if (
      !/^[A-Za-z]{4}$/.test(type) ||
      crc32(png.subarray(pos + 4, end - 4)) !== png.readUInt32BE(end - 4)
    )
      invalid()
    const data = png.subarray(pos + 8, end - 4)
    if (chunks.length === 0 && (type !== 'IHDR' || size !== 13)) invalid()
    if (
      type === 'IHDR' &&
      (chunks.length !== 0 ||
        data.readUInt32BE(0) < 1 ||
        data.readUInt32BE(4) < 1 ||
        data.readUInt32BE(0) * data.readUInt32BE(4) > 16_777_216)
    )
      invalid()
    chunks.push({ type, data, raw: png.subarray(pos, end) })
    if (chunks.length > 4096) limit()
    ended = type === 'IEND'
    if (ended && size !== 0) invalid()
    pos = end
  }
  if (!ended || !chunks.some((c) => c.type === 'IDAT')) invalid()
  return chunks
}
const cardKeyword = Buffer.from('infos-agent\0', 'ascii')
export function writePngCard(png: Buffer, zip: Buffer): Buffer {
  const chunks = pngChunks(png).filter(
    (c) => !(c.type === 'tEXt' && c.data.subarray(0, cardKeyword.length).equals(cardKeyword)),
  )
  const data = Buffer.concat([cardKeyword, Buffer.from(zip.toString('base64'), 'ascii')])
  const output = Buffer.concat([
    pngSignature,
    ...chunks.slice(0, -1).map((c) => c.raw),
    chunk('tEXt', data),
    chunks[chunks.length - 1]!.raw,
  ])
  if (output.length > CARD_LIMITS.file) limit()
  return output
}
export function readPngCard(png: Buffer): Buffer {
  const blocks = pngChunks(png).filter(
    (c) => c.type === 'tEXt' && c.data.subarray(0, cardKeyword.length).equals(cardKeyword),
  )
  if (blocks.length !== 1) invalid()
  const encoded = blocks[0]!.data.subarray(cardKeyword.length).toString('latin1')
  if (!encoded || encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) invalid()
  const zip = Buffer.from(encoded, 'base64')
  if (zip.toString('base64') !== encoded) invalid()
  return zip
}

export function encodeCardZip(input: AgentCard): Buffer {
  const card = validateCard(input)
  const files: Record<string, Uint8Array> = Object.create(null)
  files['agent-card.json'] = Buffer.from(JSON.stringify(card.manifest))
  for (const [name, data] of card.files) files[`agent/${name}`] = data
  const zip = Buffer.from(zipSync(files, { level: 6 }))
  if (zip.length > CARD_LIMITS.file) limit()
  return zip
}

/** 先检查中央目录，再以限制输出的解压接口读取每个条目；不向磁盘解压。 */
export function decodeCard(input: Buffer): AgentCard {
  if (input.length > CARD_LIMITS.file) limit()
  const zip = input.subarray(0, 8).equals(pngSignature) ? readPngCard(input) : input
  try {
    const end = zip.length - 22
    if (
      end < 0 ||
      zip.readUInt32LE(end) !== 0x06054b50 ||
      zip.readUInt16LE(end + 20) !== 0 ||
      zip.readUInt32LE(end + 4) !== 0
    )
      invalid()
    const count = zip.readUInt16LE(end + 10)
    if (zip.readUInt16LE(end + 8) !== count || count === 0) invalid()
    if (count > CARD_LIMITS.files) limit()
    let pos = zip.readUInt32LE(end + 16)
    if (pos + zip.readUInt32LE(end + 12) !== end) invalid()
    let total = 0
    const extracted = new Map<string, Buffer>()
    const localRanges: Array<[number, number]> = []
    for (let i = 0; i < count; i++) {
      if (pos + 46 > end || zip.readUInt32LE(pos) !== 0x02014b50) invalid()
      const flags = zip.readUInt16LE(pos + 8),
        method = zip.readUInt16LE(pos + 10)
      const crc = zip.readUInt32LE(pos + 16),
        packed = zip.readUInt32LE(pos + 20),
        size = zip.readUInt32LE(pos + 24)
      const length = zip.readUInt16LE(pos + 28),
        extra = zip.readUInt16LE(pos + 30),
        comment = zip.readUInt16LE(pos + 32)
      const local = zip.readUInt32LE(pos + 42)
      if (
        pos + 46 + length + extra + comment > end ||
        (flags & ~0x800) !== 0 ||
        ![0, 8].includes(method) ||
        zip.readUInt16LE(pos + 34) !== 0 ||
        ((zip.readUInt32LE(pos + 38) >>> 16) & 0xf000) === 0xa000
      )
        invalid()
      const name = decoder.decode(zip.subarray(pos + 46, pos + 46 + length))
      if (name !== 'agent-card.json') {
        if (!name.startsWith('agent/')) invalid()
        validateResourcePath(name.slice(6))
      }
      if (
        extracted.has(name) ||
        [...extracted.keys()].some((n) => n.toLowerCase() === name.toLowerCase())
      )
        invalid()
      if (size > CARD_LIMITS.entry || total + size > CARD_LIMITS.total) limit()
      total += size
      if (
        local + 30 > zip.readUInt32LE(end + 16) ||
        zip.readUInt32LE(local) !== 0x04034b50 ||
        zip.readUInt16LE(local + 6) !== flags ||
        zip.readUInt16LE(local + 8) !== method ||
        zip.readUInt32LE(local + 14) !== crc ||
        zip.readUInt32LE(local + 18) !== packed ||
        zip.readUInt32LE(local + 22) !== size ||
        zip.readUInt16LE(local + 26) !== length
      )
        invalid()
      const start = local + 30 + length + zip.readUInt16LE(local + 28),
        stop = start + packed
      if (
        stop > zip.readUInt32LE(end + 16) ||
        !zip
          .subarray(local + 30, local + 30 + length)
          .equals(zip.subarray(pos + 46, pos + 46 + length)) ||
        localRanges.some(([a, b]) => local < b && stop > a)
      )
        invalid()
      localRanges.push([local, stop])
      const data =
        method === 0
          ? Buffer.from(zip.subarray(start, stop))
          : inflateRawSync(zip.subarray(start, stop), { maxOutputLength: Math.max(1, size) })
      if (data.length !== size || crc32(data) !== crc) invalid()
      extracted.set(name, data)
      pos += 46 + length + extra + comment
    }
    let covered = 0
    for (const [start, stop] of localRanges.sort((a, b) => a[0] - b[0])) {
      if (start !== covered) invalid()
      covered = stop
    }
    if (covered !== zip.readUInt32LE(end + 16) || pos !== end || !extracted.has('agent-card.json'))
      invalid()
    const manifest = parseCardJson(extracted.get('agent-card.json')!) as AgentCardManifest
    extracted.delete('agent-card.json')
    return validateCard({
      manifest,
      files: new Map([...extracted].map(([name, data]) => [name.slice(6), data])),
    })
  } catch (error) {
    if (error instanceof AgentCardError) throw error
    return invalid()
  }
}
