import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ResourceVersions } from '@infos/shared/resource-versions'

const base = path.resolve('TEMP/resource-versions')
let root: string, resources: ResourceVersions
beforeEach(async () => {
  await mkdir(base, { recursive: true })
  root = await mkdtemp(path.join(base, 'version-'))
  resources = new ResourceVersions(root)
  await mkdir(path.join(root, 'skills'), { recursive: true })
  await writeFile(path.join(root, 'skills', 'SKILL.md'), '原版技能')
})
afterEach(async () => {
  if (!root.startsWith(base + path.sep)) throw new Error('测试清理路径越界')
  await rm(root, { recursive: true, force: true })
})
describe('用户资源备份与手动切换', () => {
  it('登记应用不修改运行目录，重启后生效，随后可恢复原始版本', async () => {
    const revision = await resources.checkout('skills')
    await writeFile(path.join(revision.candidateDirectory, 'SKILL.md'), '候选技能')
    await resources.schedule(revision.id, 'apply')
    expect(await readFile(path.join(root, 'skills', 'SKILL.md'), 'utf8')).toBe('原版技能')
    const boot = await resources.beginBoot()
    expect(await readFile(path.join(root, 'skills', 'SKILL.md'), 'utf8')).toBe('候选技能')
    await resources.cleanShutdown(boot.id)
    await resources.schedule(revision.id, 'rollback')
    const restored = await resources.beginBoot()
    expect(restored.safeMode).toBe(false)
    expect(await readFile(path.join(root, 'skills', 'SKILL.md'), 'utf8')).toBe('原版技能')
    expect(await readFile(path.join(revision.candidateDirectory, 'SKILL.md'), 'utf8')).toBe(
      '候选技能',
    )
    await resources.cleanShutdown(restored.id)
  })
  it('冻结候选内容，登记后的编辑不会偷偷改变待应用版本', async () => {
    const revision = await resources.checkout('skills')
    await writeFile(path.join(revision.candidateDirectory, 'SKILL.md'), '用户审核的版本')
    await resources.schedule(revision.id, 'apply')
    await writeFile(path.join(revision.candidateDirectory, 'SKILL.md'), '登记后又改的版本')
    const boot = await resources.beginBoot()
    expect(await readFile(path.join(root, 'skills', 'SKILL.md'), 'utf8')).toBe('用户审核的版本')
    await resources.cleanShutdown(boot.id)
  })
  it('取消后可重新编辑，原目录外部修改会阻止覆盖', async () => {
    const revision = await resources.checkout('skills')
    await resources.schedule(revision.id, 'apply')
    await resources.cancel(revision.id)
    await writeFile(path.join(revision.candidateDirectory, 'other.md'), '新文件')
    expect(await resources.changes(revision.id)).toEqual([{ file: 'other.md', kind: 'added' }])
    await writeFile(path.join(root, 'skills', 'SKILL.md'), '用户同时修改了原目录')
    await expect(resources.schedule(revision.id, 'apply')).rejects.toThrow(
      'RESOURCE_SOURCE_CHANGED',
    )
  })
  it('普通异常退出不自动进入恢复模式，只有用户选择安全启动才暂停拓展', async () => {
    await resources.beginBoot()
    const next = await resources.beginBoot()
    expect(next.safeMode).toBe(false)
    await resources.setSafeMode(true)
    expect((await resources.beginBoot()).safeMode).toBe(true)
    await resources.setSafeMode(false)
    await resources.cleanShutdown(next.id)
    const clean = await resources.beginBoot()
    expect(clean.safeMode).toBe(false)
    await resources.cleanShutdown(clean.id)
  })
  it('拒绝链接与未知类别，缺失候选不能当成空目录应用', async () => {
    await expect(resources.checkout('../logs' as any)).rejects.toThrow('RESOURCE_KIND_INVALID')
    const revision = await resources.checkout('skills')
    await symlink(
      path.join(root, 'skills'),
      path.join(revision.candidateDirectory, 'link'),
      'junction',
    )
    await expect(resources.schedule(revision.id, 'apply')).rejects.toThrow('RESOURCE_PATH_INVALID')
    await rm(revision.candidateDirectory, { recursive: true, force: true })
    await expect(resources.schedule(revision.id, 'apply')).rejects.toThrow()
  })
  it('不快照可重建依赖，也不替换业务数据库', async () => {
    await mkdir(path.join(root, 'packages', 'example', 'node_modules'), { recursive: true })
    await writeFile(path.join(root, 'packages', 'example', 'node_modules', 'cache.txt'), '依赖缓存')
    await writeFile(path.join(root, 'infos.db'), '模拟业务数据库')
    const revision = await resources.checkout('packages')
    await expect(
      readFile(path.join(revision.candidateDirectory, 'example', 'node_modules', 'cache.txt')),
    ).rejects.toThrow()
    await resources.schedule(revision.id, 'apply')
    const boot = await resources.beginBoot()
    expect(await readFile(path.join(root, 'infos.db'), 'utf8')).toBe('模拟业务数据库')
    await resources.cleanShutdown(boot.id)
  })
  it('切换中途退出后恢复基线、保留现场并阻止自动再次加载候选', async () => {
    const revision = await resources.checkout('skills')
    await writeFile(path.join(revision.candidateDirectory, 'SKILL.md'), '故障候选')
    await resources.schedule(revision.id, 'apply')
    const file = path.join(resources.root, 'state.json')
    const state = JSON.parse(await readFile(file, 'utf8'))
    const old = path.join(root, '.resource-old-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
    await rename(path.join(root, 'skills'), old)
    state.switching = {
      id: revision.id,
      action: 'apply',
      old,
      next: path.join(root, '.resource-next-interrupted'),
    }
    await writeFile(file, JSON.stringify(state))
    const boot = await resources.beginBoot()
    expect(boot.safeMode).toBe(true)
    expect(await readFile(path.join(root, 'skills', 'SKILL.md'), 'utf8')).toBe('原版技能')
    expect((await resources.view()).pending).toEqual([])
    expect(await readFile(path.join(old, 'SKILL.md'), 'utf8')).toBe('原版技能')
    await resources.cleanShutdown(boot.id)
  })
  it('索引损坏时保留原件与快照，恢复入口仍能安全启动', async () => {
    const revision = await resources.checkout('skills')
    await writeFile(path.join(resources.root, 'state.json'), '模拟损坏索引')
    expect((await resources.view()).safeMode).toBe(true)
    expect((await readdir(resources.root)).some((name) => name.endsWith('.invalid.json'))).toBe(
      true,
    )
    expect(await readFile(path.join(revision.candidateDirectory, 'SKILL.md'), 'utf8')).toBe(
      '原版技能',
    )
    expect((await resources.beginBoot()).safeMode).toBe(true)
  })
  it('不同宿主实例并发创建候选不会覆盖版本记录', async () => {
    const other = new ResourceVersions(root)
    const revisions = await Promise.all([resources.checkout('skills'), other.checkout('custom')])
    expect(new Set(revisions.map((revision) => revision.id)).size).toBe(2)
    expect((await other.view()).revisions).toHaveLength(2)
  })
  it('冻结快照被外部修改时拒绝应用，取消未应用版本后不误判为资源切换故障', async () => {
    const revision = await resources.checkout('skills')
    await resources.schedule(revision.id, 'apply')
    await writeFile(
      path.join(resources.root, revision.id, 'release', 'SKILL.md'),
      '被修改的冻结版本',
    )
    await expect(resources.beginBoot()).rejects.toThrow('RESOURCE_SOURCE_CHANGED')
    expect(await readFile(path.join(root, 'skills', 'SKILL.md'), 'utf8')).toBe('原版技能')
    await resources.cancel(revision.id)
    expect((await resources.beginBoot()).safeMode).toBe(false)
  })
  it('清除旧实现因残留启动标记产生的无来源恢复状态，保留全部候选记录', async () => {
    const revision = await resources.checkout('skills')
    const file = path.join(resources.root, 'state.json')
    const state = JSON.parse(await readFile(file, 'utf8'))
    state.safeMode = true
    state.boot = { id: '旧启动标记', pid: 99999999 }
    await writeFile(file, JSON.stringify(state))
    expect((await resources.beginBoot()).safeMode).toBe(false)
    expect((await resources.view()).revisions.map((entry) => entry.id)).toContain(revision.id)
    expect(await readFile(path.join(revision.candidateDirectory, 'SKILL.md'), 'utf8')).toBe(
      '原版技能',
    )
  })
})
