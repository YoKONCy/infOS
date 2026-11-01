import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate'
import { sha256 as digest } from '@noble/hashes/sha256'
import type { Project, Asset } from '../types'

const MAX_PACKAGE_BYTES = 256 * 1024 * 1024
const FORMAT = 'pictoria.project'
export interface PackedAsset {
  id: string
  path: string
  name: string
  mimeType: string
  sizeBytes: number
  sha256: string
}
export interface ProjectPackage {
  format: typeof FORMAT
  version: 1
  project: Project
  assets: PackedAsset[]
}
export function referencedAssets(value: unknown, ids = new Set<string>()): Set<string> {
  if (!value || typeof value !== 'object') return ids
  for (const [key, entry] of Object.entries(value)) {
    if ((key === 'assetId' || key === 'primaryAssetId') && typeof entry === 'string') ids.add(entry)
    else if (key === 'outputIds' && Array.isArray(entry))
      entry.filter((id) => typeof id === 'string' && id !== 'text').forEach((id) => ids.add(id))
    else if (key === 'inputOrder' && entry && typeof entry === 'object')
      Object.values(entry)
        .flat()
        .filter((id) => typeof id === 'string')
        .forEach((id) => ids.add(id as string))
    else if (key !== 'step' && key !== 'request') referencedAssets(entry, ids)
  }
  return ids
}
async function sha256(bytes: Uint8Array): Promise<string> {
  return Array.from(digest(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
export async function exportProjectPackage(
  project: Project,
  read: (id: string) => Promise<{ info: Asset; bytes: Uint8Array }>,
): Promise<Blob> {
  if (
    project.items.some(
      (item) =>
        item.content.kind === 'run' &&
        ['queued', 'running', 'waiting'].includes(item.content.state ?? ''),
    )
  )
    throw new Error('PACKAGE_TASK_ACTIVE')
  const files: Record<string, Uint8Array> = {},
    assets: PackedAsset[] = []
  let total = 0
  const resources = referencedAssets(project)
  if (resources.size > 2000) throw new Error('PACKAGE_TOO_LARGE')
  for (const id of resources) {
    const { info, bytes } = await read(id)
    total += bytes.byteLength
    if (total > MAX_PACKAGE_BYTES) throw new Error('PACKAGE_TOO_LARGE')
    const path = `assets/${assets.length}`
    assets.push({
      id,
      path,
      name: info.name,
      mimeType: info.mimeType,
      sizeBytes: bytes.byteLength,
      sha256: await sha256(bytes),
    })
    files[path] = bytes
  }
  const portable = JSON.parse(JSON.stringify(project)) as Project
  for (const item of portable.items) {
    delete item.content.request
  }
  files['project.json'] = strToU8(
    JSON.stringify({
      format: FORMAT,
      version: 1,
      project: portable,
      assets,
    } satisfies ProjectPackage),
  )
  const zip = zipSync(files, { level: 0 })
  if (zip.byteLength > MAX_PACKAGE_BYTES) throw new Error('PACKAGE_TOO_LARGE')
  return new Blob([new Uint8Array(zip)], { type: 'application/zip' })
}
/** 解压前校验声明尺寸及路径；先完整验证摘要，用户确认后才上传或替换项目。 */
export async function readProjectPackage(
  bytes: Uint8Array,
): Promise<{ manifest: ProjectPackage; files: Record<string, Uint8Array> }> {
  if (bytes.byteLength > MAX_PACKAGE_BYTES) throw new Error('PACKAGE_TOO_LARGE')
  let total = 0,
    count = 0,
    invalid = false
  const filenames = new Set<string>()
  const files = unzipSync(bytes, {
    filter: (entry) => {
      total += entry.originalSize
      count++
      const valid =
        !filenames.has(entry.name) &&
        count <= 2001 &&
        total <= MAX_PACKAGE_BYTES &&
        /^(project\.json|assets\/\d+)$/.test(entry.name)
      filenames.add(entry.name)
      if (!valid) invalid = true
      return valid
    },
  })
  if (invalid || !files['project.json']) throw new Error('PACKAGE_INVALID')
  const manifest = JSON.parse(strFromU8(files['project.json'])) as ProjectPackage
  if (
    manifest.format !== FORMAT ||
    manifest.version !== 1 ||
    !Array.isArray(manifest.assets) ||
    manifest.assets.length > 2000 ||
    !Array.isArray(manifest.project?.items) ||
    manifest.project.items.length > 2000 ||
    typeof manifest.project.title !== 'string' ||
    manifest.project.title.length > 120
  )
    throw new Error('PACKAGE_INVALID')
  const nodeIds = new Set<string>()
  const view = manifest.project.viewport
  if (
    view &&
    (![view.x, view.y, view.scale].every(Number.isFinite) || view.scale < 0.12 || view.scale > 3)
  )
    throw new Error('PACKAGE_INVALID')
  for (const item of manifest.project.items) {
    if (
      !item ||
      typeof item.id !== 'string' ||
      nodeIds.has(item.id) ||
      !Number.isFinite(item.x) ||
      !Number.isFinite(item.y) ||
      !['text', 'asset', 'run', 'draft', 'group'].includes(item.content?.kind) ||
      !Number.isFinite(item.content.width) ||
      !Number.isFinite(item.content.height) ||
      item.content.width < 1 ||
      item.content.height < 1 ||
      item.content.width > 100000 ||
      item.content.height > 100000 ||
      (item.content.kind === 'run' &&
        ['queued', 'running', 'waiting'].includes(item.content.state ?? ''))
    )
      throw new Error('PACKAGE_INVALID')
    nodeIds.add(item.id)
  }
  if (
    (manifest.project.edges?.length ?? 0) > 8000 ||
    manifest.project.edges?.some((edge) => !nodeIds.has(edge.source) || !nodeIds.has(edge.target))
  )
    throw new Error('PACKAGE_INVALID')
  for (const item of manifest.project.items) {
    const chain = new Set([item.id])
    let parent = item.content.groupId
    while (parent) {
      const group = manifest.project.items.find((entry) => entry.id === parent)
      if (chain.has(parent) || group?.content.kind !== 'group') throw new Error('PACKAGE_INVALID')
      chain.add(parent)
      parent = group.content.groupId
    }
  }
  const identifiers = new Set<string>(),
    paths = new Set<string>()
  for (const asset of manifest.assets) {
    const file = files[asset.path]
    if (
      !/^assets\/\d+$/.test(asset.path) ||
      typeof asset.id !== 'string' ||
      typeof asset.name !== 'string' ||
      typeof asset.mimeType !== 'string' ||
      identifiers.has(asset.id) ||
      paths.has(asset.path) ||
      !file ||
      file.byteLength !== asset.sizeBytes ||
      (await sha256(file)) !== asset.sha256
    )
      throw new Error('PACKAGE_INVALID')
    identifiers.add(asset.id)
    paths.add(asset.path)
  }
  for (const id of referencedAssets(manifest.project))
    if (!identifiers.has(id)) throw new Error('PACKAGE_ASSET_MISSING')
  return { manifest, files }
}
export function remapProjectAssets(project: Project, assets: Map<string, Asset>): Project {
  const rewrite = (value: unknown, field = ''): unknown => {
    if (typeof value === 'string')
      return ['assetId', 'primaryAssetId', 'outputIds', 'inputOrder'].includes(field)
        ? (assets.get(value)?.id ?? value)
        : value
    if (Array.isArray(value)) return value.map((item) => rewrite(item, field))
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        rewrite(entry, field === 'inputOrder' ? field : key),
      ]),
    )
  }
  const result = rewrite(project) as Project
  result.id = crypto.randomUUID()
  result.revision = 0
  result.collectionId = null
  result.dismissedRunIds = []
  for (const item of result.items) {
    delete item.content.request
    if (item.content.kind === 'run') {
      delete item.content.runId
      item.content.outputsResolved = true
    }
  }
  return result
}
