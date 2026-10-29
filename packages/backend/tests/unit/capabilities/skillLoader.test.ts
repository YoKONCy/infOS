import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SkillLoader } from '@infos/backend/capabilities/skillLoader'
import { AppError } from '@infos/backend/lib/appError'

vi.mock('@infos/backend/lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}))

describe('SkillLoader', () => {
  let rootDir: string
  let builtinDir: string
  let extensionDir: string
  let userDir: string

  beforeEach(() => {
    rootDir = join(tmpdir(), `infos-skill-${Date.now()}-${Math.random()}`)
    builtinDir = join(rootDir, 'builtin')
    extensionDir = join(rootDir, 'extension')
    userDir = join(rootDir, 'user')
    mkdirSync(join(builtinDir, 'diary', 'references'), { recursive: true })
    mkdirSync(join(builtinDir, 'brief'), { recursive: true })
    mkdirSync(userDir, { recursive: true })
    writeFileSync(
      join(builtinDir, 'diary', 'SKILL.md'),
      `---
name: diary
description: 记录每日总结
requiredTools:
  - memory.write
  - file.write
category: memory
tags:
  - diary
  - memory
parameters: {"topic":"主题"}
dependsOnSkills:
  - summarize
---
请围绕 {{topic}} 写日记。`,
      'utf-8',
    )
    writeFileSync(join(builtinDir, 'diary', 'references', 'guide.md'), '参考资料', 'utf-8')
    writeFileSync(
      join(builtinDir, 'brief', 'SKILL.md'),
      `---
name: brief
description: 简报
requiredTools: search, summarize
tags: report, brief
---
生成简报`,
      'utf-8',
    )
  })

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true })
  })

  describe('清单与内容加载', () => {
    it('应当扫描 SKILL.md 并解析 manifest 字段', () => {
      const loader = new SkillLoader([builtinDir], userDir)

      const manifest = loader.getManifest('diary')
      const all = loader.getAllManifests()

      expect(manifest).toMatchObject({
        id: 'diary',
        name: 'diary',
        description: '记录每日总结',
        requiredTools: ['memory.write', 'file.write'],
        category: 'memory',
        tags: ['diary', 'memory'],
        parameters: { topic: '主题' },
        dependsOnSkills: ['summarize'],
        metadata: {},
        allowedTools: [],
      })
      expect(all.map((item) => item.id).sort()).toEqual(['brief', 'diary'])
    })

    it('应当兼容逗号分隔的列表字段和默认字段', () => {
      const loader = new SkillLoader([builtinDir], userDir)

      const manifest = loader.getManifest('brief')

      expect(manifest).toMatchObject({
        id: 'brief',
        name: 'brief',
        description: '简报',
        requiredTools: ['search', 'summarize'],
        category: 'general',
        tags: ['report', 'brief'],
      })
    })

    it('带 BOM 与 CRLF 换行的 SKILL.md 也能识别 frontmatter', () => {
      mkdirSync(join(builtinDir, 'crlf'), { recursive: true })
      writeFileSync(
        join(builtinDir, 'crlf', 'SKILL.md'),
        '\uFEFF---\r\nname: crlf\r\ndescription: Windows 保存的技能\r\n---\r\n正文\r\n',
        'utf-8',
      )
      const loader = new SkillLoader([builtinDir], userDir)

      expect(loader.getManifest('crlf')).toMatchObject({
        name: 'crlf',
        description: 'Windows 保存的技能',
      })
      expect(loader.loadSkillContent('crlf').trim()).toBe('正文')
    })

    it('应解析标准多行YAML、元数据并安全读取资源', () => {
      const loader = new SkillLoader([builtinDir], userDir)
      const manifest = loader.getManifest('diary')

      expect(manifest?.rootPath).toBe(join(builtinDir, 'diary'))
      expect(loader.listResources('diary')).toEqual(['references/guide.md'])
      expect(loader.readResource('diary', 'references/guide.md')).toBe('参考资料')
      expect(loader.readResource('diary', '../brief/SKILL.md')).toBeNull()
    })

    it('loadSkillContent 应当返回 frontmatter 之后的正文并命中缓存', () => {
      const loader = new SkillLoader([builtinDir], userDir)

      const first = loader.loadSkillContent('diary')
      writeFileSync(join(builtinDir, 'diary', 'SKILL.md'), '被缓存覆盖', 'utf-8')
      const second = loader.loadSkillContent('diary')

      expect(first).toBe('请围绕 {{topic}} 写日记。')
      expect(second).toBe(first)
    })

    it('loadSkillContentWithParams 应当替换已提供参数并保留未提供占位符', () => {
      const loader = new SkillLoader([builtinDir], userDir)

      const content = loader.loadSkillContentWithParams('diary', { topic: '测试覆盖率' })
      const missing = loader.loadSkillContentWithParams('missing', { topic: '测试' })

      expect(content).toBe('请围绕 测试覆盖率 写日记。')
      expect(missing).toBeNull()
    })

    it('loadReference 应当读取参考文件，不存在时返回 null', () => {
      const loader = new SkillLoader([builtinDir], userDir)

      const found = loader.loadReference('diary', 'guide.md')
      const missing = loader.loadReference('diary', 'missing.md')

      expect(found).toBe('参考资料')
      expect(missing).toBeNull()
    })
  })

  describe('目录管理', () => {
    it('addDirs 应当追加扫描新目录且忽略重复目录', () => {
      mkdirSync(join(extensionDir, 'paint'), { recursive: true })
      writeFileSync(
        join(extensionDir, 'paint', 'SKILL.md'),
        `---
name: paint
description: 生成图像
---
画图`,
        'utf-8',
      )
      const loader = new SkillLoader([builtinDir], userDir)

      loader.addDirs([extensionDir, extensionDir])

      expect(loader.getManifest('paint')).toMatchObject({
        id: 'paint',
        name: 'paint',
        description: '生成图像',
      })
    })

    it('reloadAll 应当清空旧缓存并重新扫描', () => {
      const loader = new SkillLoader([builtinDir], userDir)
      loader.loadSkillContent('diary')
      writeFileSync(join(builtinDir, 'diary', 'SKILL.md'), '无 frontmatter 内容', 'utf-8')

      loader.reloadAll()
      const content = loader.loadSkillContent('diary')

      expect(loader.getManifest('diary')).toBeUndefined()
      expect(content).toBe('无 frontmatter 内容')
    })
  })

  describe('导入与删除', () => {
    it('importFromPath 应当验证并复制本地 Skill 到用户目录', () => {
      const sourceDir = join(rootDir, 'source-skill')
      mkdirSync(sourceDir, { recursive: true })
      writeFileSync(
        join(sourceDir, 'SKILL.md'),
        `---
name: source-skill
description: 用户导入
---
内容`,
        'utf-8',
      )
      const loader = new SkillLoader([builtinDir, userDir], userDir)

      const folderName = loader.importFromPath(sourceDir)

      expect(folderName).toBe('source-skill')
      expect(loader.getManifest('source-skill')).toMatchObject({
        name: 'source-skill',
        description: '用户导入',
      })
    })

    it('importFromPath 来源无效时应当抛出验证错误', () => {
      const loader = new SkillLoader([builtinDir, userDir], userDir)

      expect(() => loader.importFromPath(join(rootDir, 'missing'))).toThrow(AppError)
    })

    it('importFromPath 来源没有 SKILL.md 时应当抛出验证错误', () => {
      const sourceDir = join(rootDir, 'invalid-skill')
      mkdirSync(sourceDir, { recursive: true })
      const loader = new SkillLoader([builtinDir, userDir], userDir)

      expect(() => loader.importFromPath(sourceDir)).toThrow(Error)
    })

    it('importFromPath 目标已存在时应当抛出重复错误', () => {
      const sourceDir = join(rootDir, 'diary')
      mkdirSync(sourceDir, { recursive: true })
      writeFileSync(
        join(sourceDir, 'SKILL.md'),
        '---\nname: diary\ndescription: 重复Skill\n---\n内容',
        'utf-8',
      )
      mkdirSync(join(userDir, 'diary'), { recursive: true })
      const loader = new SkillLoader([builtinDir, userDir], userDir)

      try {
        loader.importFromPath(sourceDir)
        throw new Error('应当抛出重复错误')
      } catch (error) {
        expect(error).toMatchObject({ code: 'ALREADY_EXISTS' })
      }
    })

    it('deleteById 应当只删除用户目录中的 Skill 并重新扫描', () => {
      const userSkillDir = join(userDir, 'custom')
      mkdirSync(userSkillDir, { recursive: true })
      writeFileSync(
        join(userSkillDir, 'SKILL.md'),
        '---\nname: custom\ndescription: 自定义Skill\n---\n内容',
        'utf-8',
      )
      const loader = new SkillLoader([builtinDir, userDir], userDir)
      expect(loader.getManifest('custom')).toBeDefined()

      loader.deleteById('custom')

      expect(loader.getManifest('custom')).toBeUndefined()
    })

    it('deleteById 删除不存在用户 Skill 时应当抛出 NOT_FOUND', () => {
      const loader = new SkillLoader([builtinDir, userDir], userDir)

      try {
        loader.deleteById('missing')
        throw new Error('应当抛出不存在错误')
      } catch (error) {
        expect(error).toMatchObject({ code: 'NOT_FOUND' })
      }
    })
  })
})
