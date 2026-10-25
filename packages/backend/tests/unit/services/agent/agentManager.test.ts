import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentManager } from '@infos/backend/services/agent/agentManager'
import type { PathResolver } from '@infos/backend/core/pathResolver'

type ConfigRepositoryMock = {
  get: ReturnType<typeof vi.fn>
  getJson: ReturnType<typeof vi.fn>
}

function createAgent(
  root: string,
  id: string,
  config: Record<string, unknown>,
  files: Record<string, string> = {},
) {
  const agentDir = join(root, id)
  // AIOS: personas 目录已废弃，人设统一由 system_prompt.md 管理
  mkdirSync(agentDir, { recursive: true })
  writeFileSync(join(agentDir, 'agent.json'), JSON.stringify(config, null, 2), 'utf-8')
  for (const [relativePath, content] of Object.entries(files)) {
    writeFileSync(join(agentDir, relativePath), content, 'utf-8')
  }
}

function createResolver(appRoot: string, dataRoot: string): PathResolver {
  return {
    resolve: vi.fn((alias: string) => {
      if (alias === '@app/backend/src/assets/agents') return appRoot
      if (alias === '@data/agents') return dataRoot
      if (alias === '@data/principals') return join(dataRoot, 'principals')
      throw new Error(`测试 PathResolver未处理逻辑路径: ${alias}`)
    }),
    getWorkspaceRoot: vi.fn((agentId: string) =>
      join(dataRoot, 'principals', agentId, 'workspace'),
    ),
  } as unknown as PathResolver
}

describe('AgentManager', () => {
  const fixtureRoot = resolve('TEMP/agent-manager')
  let rootDir: string
  let builtinDir: string
  let dataDir: string
  let configRepo: ConfigRepositoryMock

  beforeEach(() => {
    mkdirSync(fixtureRoot, { recursive: true })
    rootDir = mkdtempSync(join(fixtureRoot, 'run-'))
    builtinDir = join(rootDir, 'builtin')
    dataDir = join(rootDir, 'data')
    mkdirSync(builtinDir, { recursive: true })
    mkdirSync(dataDir, { recursive: true })
    configRepo = {
      get: vi.fn(),
      getJson: vi.fn(),
    }
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    if (!resolve(rootDir).startsWith(fixtureRoot + sep)) throw new Error('测试目录超出 TEMP 范围')
    rmSync(rootDir, { recursive: true, force: true })
  })

  it('恢复模式仍加载用户角色和工坊角色，并保留用户覆盖优先级', () => {
    vi.stubEnv('INFOS_RESOURCE_SAFE_MODE', '1')
    createAgent(builtinDir, 'pero', { name: '内置角色' })
    createAgent(dataDir, 'keromi', { name: '用户角色' }, { 'system_prompt.md': '用户角色人设' })
    createAgent(dataDir, 'pero', { name: '用户覆盖' })
    const workshop = join(rootDir, 'workshop')
    createAgent(join(workshop, 'agents'), 'workshop-role', { name: '工坊角色' })
    const resolver = createResolver(builtinDir, dataDir)
    resolver.getRoots = vi.fn(() => [workshop])
    const manager = new AgentManager(resolver, configRepo as never)
    expect(manager.getAgent('keromi')?.name).toBe('用户角色')
    expect(manager.getAgent('workshop-role')?.name).toBe('工坊角色')
    expect(manager.getAgent('pero')?.name).toBe('用户覆盖')
    expect(manager.getAgentDetail('keromi')?.systemPrompt).toBe('用户角色人设')
  })

  it('PathResolver残留逻辑别名时不得向仓库写入 Workspace', () => {
    createAgent(builtinDir, 'broken-agent', { name: '损坏路径测试' })
    const leakedPath = resolve('@data', 'principals', 'broken-agent', 'workspace')
    const invalidResolver = {
      resolve: vi.fn((alias: string) => {
        if (alias === '@app/backend/src/assets/agents') return builtinDir
        if (alias === '@data/agents') return dataDir
        if (alias === '@data/principals') return '@data/principals'
        throw new Error(`测试 PathResolver未处理逻辑路径: ${alias}`)
      }),
    } as unknown as PathResolver

    const manager = new AgentManager(invalidResolver, configRepo as never)
    expect(manager.getAgent('broken-agent')).toBeDefined()
    expect(existsSync(leakedPath)).toBe(false)
  })

  it('应当扫描内置与用户 Agent 并加载人设、头像和台词', () => {
    createAgent(
      builtinDir,
      'pero',
      {
        name: 'Pero',
        description: '猫猫助手',
        // AIOS: personas 字段已废弃，人设统一由 system_prompt.md 管理
        traits: { work: ['认真'], social: ['可爱'] },
        social: { use_stickers: true, qq_id: '123' },
        tool_policies: { file: 'allow' },
        waifu_texts: { idle: '喵' },
      },
      {
        'system_prompt.md': '你是 Pero，一只猫猫助手。',
        'avatar.png': 'png',
      },
    )
    createAgent(dataDir, 'custom', { name: 'Custom', description: '用户角色' })
    const manager = new AgentManager(createResolver(builtinDir, dataDir), configRepo as never)

    const pero = manager.getAgent('PERO')
    const agents = manager.listAgents()

    // AIOS: workPersona/socialPersona 已移除，改用 promptPath 指向 system_prompt.md
    expect(pero).toMatchObject({
      id: 'pero',
      name: 'Pero',
      description: '猫猫助手',
      socialTraits: ['可爱'],
      socialBinding: { qq_id: '123' },
      toolPolicies: { file: 'allow' },
      waifuTexts: { idle: '喵' },
    })
    expect(pero?.promptPath).toContain('system_prompt.md')
    expect(pero?.avatarPath).toContain('avatar.png')
    expect(agents.map((agent) => agent.id).sort()).toEqual(['custom', 'pero'])
    expect(manager.enabledAgents).toEqual(new Set(['pero', 'custom']))
    expect(manager.getDefaultAgent()?.id).toBe('pero')
  })

  it('应读取、标准化并保存角色公开档案', () => {
    createAgent(builtinDir, 'pero', {
      name: 'Pero',
      public_profile: {
        gender: ' 女 ',
        identity: '据点助手',
        appearance: 123,
        personality: '',
        private_note: '不得公开',
      },
    })
    const manager = new AgentManager(createResolver(builtinDir, dataDir))

    expect(manager.getAgentDetail('pero')?.publicProfile).toEqual({
      gender: '女',
      identity: '据点助手',
    })

    manager.updateAgent('pero', {
      publicProfile: {
        appearance: '蓝色短发',
        personality: '活泼可靠',
      },
    })

    expect(manager.getAgent('pero')?.publicProfile).toEqual({
      appearance: '蓝色短发',
      personality: '活泼可靠',
    })
    const saved = JSON.parse(readFileSync(join(dataDir, 'pero', 'agent.json'), 'utf-8')) as Record<
      string,
      unknown
    >
    expect(saved.public_profile).toEqual({
      appearance: '蓝色短发',
      personality: '活泼可靠',
    })
  })

  it('旧角色缺少公开档案时应回退为空对象', () => {
    createAgent(dataDir, 'custom', { name: 'Custom' })
    const manager = new AgentManager(createResolver(builtinDir, dataDir))

    expect(manager.getAgentDetail('custom')?.publicProfile).toEqual({})
  })

  it('应导出官方和用户角色的静态资源并排除运行期工作区', () => {
    createAgent(
      builtinDir,
      'pero',
      { name: 'Pero' },
      { 'system_prompt.md': '官方人格', 'avatar.png': 'avatar' },
    )
    createAgent(dataDir, 'custom', { name: 'Custom' }, { 'system_prompt.md': '用户人格' })
    mkdirSync(join(builtinDir, 'pero', 'workspace'), { recursive: true })
    writeFileSync(join(builtinDir, 'pero', 'workspace', 'secret.txt'), '运行期数据', 'utf8')
    const manager = new AgentManager(createResolver(builtinDir, dataDir))

    const builtinPackage = manager.exportAgentPackage('pero')
    const userPackage = manager.exportAgentPackage('custom')

    expect(builtinPackage).toMatchObject({
      format: 'infos.agent-package',
      version: 1,
      agentId: 'pero',
      fileName: 'pero.infos-agent.zip',
    })
    expect(builtinPackage.files.map((file) => file.path)).toEqual([
      'agent.json',
      'avatar.png',
      'system_prompt.md',
    ])
    expect(userPackage.files.some((file) => file.path === 'agent.json')).toBe(true)
    expect(() => manager.exportAgentPackage('missing')).toThrow(Error)
  })

  it('保存内置角色时应修复缺少清单的残留用户副本目录', () => {
    createAgent(
      builtinDir,
      'nana',
      { name: 'Nana', description: '原始描述' },
      { 'system_prompt.md': '原始人格', 'capabilities.yaml': 'agent: nana' },
    )
    mkdirSync(join(dataDir, 'nana'), { recursive: true })
    const manager = new AgentManager(createResolver(builtinDir, dataDir))

    const updated = manager.updateAgent('nana', {
      description: '更新后的描述',
      systemPrompt: '更新后的人格',
    })

    expect(updated.description).toBe('更新后的描述')
    expect(existsSync(join(dataDir, 'nana', 'agent.json'))).toBe(true)
    expect(existsSync(join(dataDir, 'nana', 'capabilities.yaml'))).toBe(true)
    expect(updated.configPath).toBe(join(dataDir, 'nana', 'agent.json'))
  })

  it('应当启用与禁用 Agent 并拒绝非法状态', () => {
    createAgent(builtinDir, 'pero', { name: 'Pero' })
    createAgent(dataDir, 'custom', { name: 'Custom' })
    const manager = new AgentManager(createResolver(builtinDir, dataDir))

    // AIOS: setActiveAgent 已移除，defaultAgentId 永远是 pero，不能禁用默认 Agent
    const disableDefault = manager.disableAgent('pero')
    const disableCustom = manager.disableAgent('custom')
    const enableMissing = manager.enableAgent('missing')
    const enableCustom = manager.enableAgent('custom')

    expect(disableDefault).toBe(false) // 不能禁用默认 Agent
    expect(disableCustom).toBe(true) // custom 非默认，可以禁用
    expect(enableMissing).toBe(false)
    expect(enableCustom).toBe(true)
  })

  it('应当创建和删除用户自定义 Agent', () => {
    createAgent(builtinDir, 'pero', { name: 'Pero' })
    const manager = new AgentManager(createResolver(builtinDir, dataDir))

    const created = manager.createAgent({ id: 'NewCat', name: '新猫', description: '新角色' })
    manager.deleteAgent('newcat')

    expect(created).toMatchObject({ id: 'newcat', name: '新猫', description: '新角色' })
    expect(manager.getAgent('newcat')).toBeUndefined()
    expect(() => manager.createAgent({ id: 'pero', name: '重复' })).toThrow(Error)
  })

  it('应当拒绝删除默认 Agent、内置 Agent 和不存在的 Agent', () => {
    createAgent(builtinDir, 'pero', { name: 'Pero' })
    createAgent(dataDir, 'custom', { name: 'Custom' })
    const manager = new AgentManager(createResolver(builtinDir, dataDir))

    expect(() => manager.deleteAgent('missing')).toThrow(Error)
    // AIOS: pero 是默认 Agent，不能删除（setActiveAgent 已移除，无法切换默认）
    expect(() => manager.deleteAgent('pero')).toThrow(Error)
    // custom 是用户自定义且非默认，可以删除
    expect(() => manager.deleteAgent('custom')).not.toThrow()
  })

  it('应当合并动态台词并应用社交覆盖配置', async () => {
    createAgent(builtinDir, 'pero', {
      name: 'Pero',
      social: { enabled: false },
      waifu_texts: { idle: '静态', work: '工作' },
    })
    configRepo.getJson.mockResolvedValue({ idle: '动态' })
    configRepo.get.mockImplementation(async (key: string) => {
      if (key.endsWith('.enabled')) return 'true'
      if (key.endsWith('.qq_id')) return '456'
      return undefined
    })
    const manager = new AgentManager(createResolver(builtinDir, dataDir), configRepo as never)

    const texts = await manager.getWaifuTexts('pero')
    await manager.applySocialOverrides('pero')

    expect(texts).toEqual({ idle: '动态', work: '工作' })
    expect(manager.getAgent('pero')?.socialBinding).toMatchObject({ enabled: true, qq_id: '456' })
    await expect(manager.getWaifuTexts('missing')).resolves.toBeNull()
  })

  it('应当兼容旧动态字段并按层级合并静态台词', async () => {
    createAgent(builtinDir, 'pero', {
      name: 'Pero',
      waifu_texts: {
        welcome: { morning: '默认早安', noon: '默认午安' },
        randTextures: { noClothes: '默认没衣服', success: '默认换装成功' },
      },
    })
    configRepo.getJson.mockResolvedValue({
      welcome_timeRanges_morning: '动态早安',
      randTexturesSuccess: '动态换装成功',
    })
    const manager = new AgentManager(createResolver(builtinDir, dataDir), configRepo as never)

    await expect(manager.getWaifuTexts('pero')).resolves.toMatchObject({
      welcome: { morning: '动态早安', noon: '默认午安' },
      randTextures: { noClothes: '默认没衣服', success: '动态换装成功' },
    })
  })

  it('旧默认头像副本应使用新官方头像，导出时也使用新图且不改写用户文件', () => {
    createAgent(builtinDir, 'pero', { name: 'Pero' }, { 'avatar.png': '新版官方头像' })
    createAgent(dataDir, 'pero', { name: '我的 Pero' })
    const legacyAvatar = readFileSync(
      new URL('../../../../../../.github/character-art/legacy-avatars/pero.jpg', import.meta.url),
    )
    const userAvatarPath = join(dataDir, 'pero', 'avatar.jpg')
    writeFileSync(userAvatarPath, legacyAvatar)
    const manager = new AgentManager(createResolver(builtinDir, dataDir))

    expect(manager.getAgent('pero')?.name).toBe('我的 Pero')
    expect(manager.getAvatarData('pero')?.buffer.toString()).toBe('新版官方头像')
    expect(manager.getAvatarData('pero')?.mime).toBe('image/png')
    expect(manager.getAvatarUrl('pero')).toMatch(/^\/agents\/pero\/avatar\?v=/)
    expect(readFileSync(userAvatarPath).equals(legacyAvatar)).toBe(true)
    const exported = manager.exportAgentPackage('pero')
    expect(exported.files.some((file) => file.path === 'avatar.jpg')).toBe(false)
    expect(
      Buffer.from(
        exported.files.find((file) => file.path === 'avatar.png')!.contentBase64,
        'base64',
      ).toString(),
    ).toBe('新版官方头像')

    // 新资源不可用时仍保留旧头像，避免回退逻辑导致头像消失。
    rmSync(join(builtinDir, 'pero', 'avatar.png'))
    manager.reloadAgents()
    expect(manager.getAvatarData('pero')?.buffer.equals(legacyAvatar)).toBe(true)
  })

  it('用户上传的不同头像不得被官方头像更新覆盖', () => {
    createAgent(builtinDir, 'pero', { name: 'Pero' }, { 'avatar.png': '新版官方头像' })
    createAgent(dataDir, 'pero', { name: '我的 Pero' }, { 'avatar.png': '用户自选头像' })
    const manager = new AgentManager(createResolver(builtinDir, dataDir))

    expect(manager.getAvatarData('pero')?.buffer.toString()).toBe('用户自选头像')
    expect(manager.getAvatarUrl('pero')).toBe('/agents/pero/avatar')
    const exported = manager.exportAgentPackage('pero')
    expect(
      Buffer.from(
        exported.files.find((file) => file.path === 'avatar.png')!.contentBase64,
        'base64',
      ).toString(),
    ).toBe('用户自选头像')
  })

  it('应当读取头像数据并识别用户 Agent', () => {
    createAgent(builtinDir, 'pero', { name: 'Pero' }, { 'avatar.webp': 'webp-data' })
    createAgent(dataDir, 'custom', { name: 'Custom' })
    const manager = new AgentManager(createResolver(builtinDir, dataDir))

    const avatar = manager.getAvatarData('pero')

    expect(avatar?.buffer.toString()).toBe('webp-data')
    expect(avatar?.mime).toBe('image/webp')
    expect(manager.getAvatarUrl('pero')).toBe('/agents/pero/avatar')
    expect(manager.getAvatarUrl('custom')).toBeUndefined()
    expect(manager.getAvatarUrl('missing')).toBeUndefined()
    rmSync(join(builtinDir, 'pero', 'avatar.webp'))
    expect(manager.getAvatarUrl('pero')).toBeUndefined()
    expect(manager.getAvatarData('missing')).toBeNull()
    expect(manager.isUserAgent('pero')).toBe(false)
    expect(manager.isUserAgent('custom')).toBe(true)
    expect(manager.isUserAgent('missing')).toBe(false)
  })
})
