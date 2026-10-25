import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import path from 'node:path'
import { protectedResourceWrite } from '@infos/backend/services/debug/resourceWritePolicy'
const base = path.resolve('TEMP/resource-versions')
let root: string
beforeEach(async () => {
  await mkdir(base, { recursive: true })
  root = await mkdtemp(path.join(base, 'policy-'))
})
afterEach(async () => {
  if (!root.startsWith(base + path.sep)) throw new Error('测试清理路径越界')
  await rm(root, { recursive: true, force: true })
})
describe('普通文件工具的资源候选策略', () => {
  it('保护运行资源及备份，允许候选目录和普通工作区', async () => {
    expect(await protectedResourceWrite(root, path.join(root, 'skills', 'test.md'))).toBe('skills')
    const revision = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    expect(
      await protectedResourceWrite(
        root,
        path.join(root, 'resource-versions', revision, 'base', 'test.md'),
      ),
    ).toBe('resource-versions')
    expect(
      await protectedResourceWrite(
        root,
        path.join(root, 'resource-versions', revision, 'candidate', 'test.md'),
      ),
    ).toBeUndefined()
    expect(
      await protectedResourceWrite(
        root,
        path.join(root, 'principals', 'pero', 'workspace', 'test.md'),
      ),
    ).toBeUndefined()
  })
  it('工作区链接指向运行目录也不能绕过候选流程', async () => {
    await mkdir(path.join(root, 'packages'))
    await mkdir(path.join(root, 'workspace'))
    await symlink(path.join(root, 'packages'), path.join(root, 'workspace', 'linked'), 'junction')
    expect(
      await protectedResourceWrite(root, path.join(root, 'workspace', 'linked', 'test.js')),
    ).toBe('packages')
  })
})
