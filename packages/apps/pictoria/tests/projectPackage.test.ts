import { describe, expect, it } from 'vitest'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import {
  exportProjectPackage,
  readProjectPackage,
  remapProjectAssets,
} from '../client/src/services/projectPackage'
import type { Project } from '../client/src/types'
const project: Project = {
  id: 'source',
  title: '画布',
  revision: 7,
  viewport: { x: 15, y: -20, scale: 1.5 },
  items: [
    {
      id: 'image',
      x: 10,
      y: 20,
      content: {
        version: 1,
        kind: 'asset',
        assetId: 'old',
        width: 300,
        height: 260,
        candidateGroupId: 'run',
      },
    },
    {
      id: 'run',
      x: 0,
      y: 0,
      content: {
        version: 1,
        kind: 'run',
        width: 300,
        height: 180,
        state: 'completed',
        runId: 'old-task',
        outputIds: ['old', 'text'],
        primaryAssetId: 'old',
      },
    },
  ],
  creation: {
    stepId: 'edit',
    text: '',
    inputsByStep: { edit: { image: { assetId: 'reference' } } },
  },
}
const contents = new Uint8Array([0, 1, 127, 128, 255])
const read = async (id: string) => ({
  info: { id, name: `${id}.png`, mimeType: 'image/png', sizeBytes: contents.length },
  bytes: contents,
})
describe('完整项目包', () => {
  it('保存原始字节、视口及创建栏引用，并将所有素材引用重映射到新项目', async () => {
    const blob = await exportProjectPackage(project, read),
      result = await readProjectPackage(new Uint8Array(await blob.arrayBuffer()))
    expect(result.manifest.assets.map((asset) => asset.id)).toEqual(['old', 'reference'])
    expect(result.files['assets/0']).toEqual(contents)
    const copy = remapProjectAssets(
      result.manifest.project,
      new Map([
        ['old', { id: 'new', name: 'new.png', mimeType: 'image/png', sizeBytes: 5 }],
        [
          'reference',
          { id: 'new-reference', name: 'ref.png', mimeType: 'image/png', sizeBytes: 5 },
        ],
      ]),
    )
    expect(copy.id).not.toBe('source')
    expect(copy.revision).toBe(0)
    expect(copy.viewport).toEqual({ x: 15, y: -20, scale: 1.5 })
    expect(copy.items[0]?.content.assetId).toBe('new')
    expect(copy.items[1]?.content.outputIds).toEqual(['new', 'text'])
    expect(copy.items[1]?.content.runId).toBeUndefined()
    expect(copy.creation?.inputsByStep.edit).toEqual({ image: { assetId: 'new-reference' } })
  })
  it('拒绝字节被篡改、缺失素材、非法路径及循环分组', async () => {
    const files = unzipSync(
      new Uint8Array(await (await exportProjectPackage(project, read)).arrayBuffer()),
    )
    const corrupt = { ...files, 'assets/0': new Uint8Array([9, 9, 9, 9, 9]) }
    await expect(readProjectPackage(zipSync(corrupt))).rejects.toThrow('PACKAGE_INVALID')
    const missing = { ...files }
    delete missing['assets/0']
    await expect(readProjectPackage(zipSync(missing))).rejects.toThrow('PACKAGE_INVALID')
    await expect(readProjectPackage(zipSync({ ...files, '../escape': contents }))).rejects.toThrow(
      'PACKAGE_INVALID',
    )
    const manifest = JSON.parse(strFromU8(files['project.json']!))
    manifest.project.items.push({
      id: 'loop',
      x: 0,
      y: 0,
      content: { kind: 'group', groupId: 'loop', width: 300, height: 300 },
    })
    await expect(
      readProjectPackage(zipSync({ ...files, 'project.json': strToU8(JSON.stringify(manifest)) })),
    ).rejects.toThrow('PACKAGE_INVALID')
  })
  it('不把运行中的任务误导出为可迁移完成项目', async () => {
    const active = structuredClone(project)
    active.items[1]!.content.state = 'running'
    await expect(exportProjectPackage(active, read)).rejects.toThrow('PACKAGE_TASK_ACTIVE')
  })
})
