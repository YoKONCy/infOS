import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  WORLDBOOK_FILE_NAME,
  createWorldbookEntry,
  exportWorldbookFile,
  type WorldbookEntry,
} from '@infos/shared'
import { WorldbookService } from '@infos/backend/services/worldbook/worldbookService'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function setup() {
  const directory = mkdtempSync(path.join(tmpdir(), 'infos-worldbook-'))
  directories.push(directory)
  const service = new WorldbookService(path.join(directory, 'worldbooks'))
  service.initialize()
  return { directory, service }
}
const blue = (id: string, content = `${id} 内容`): WorldbookEntry => ({
  ...createWorldbookEntry(id),
  light: 'constant',
  content,
})
const activate = (service: WorldbookService, agentId = 'pero') =>
  service.activate({
    agentId,
    channel: 'desktop',
    messages: [{ role: 'user', content: '你好' }],
    charName: 'Pero',
    userName: '小明',
    seed: 's',
  })

describe('世界书书库', () => {
  it('新建、保存与重新加载；名称忽略大小写判重，修订号不一致时拒绝保存', () => {
    const { directory, service } = setup()
    const book = service.create({ name: '  星穹铁道 ', entries: [blue('a')] })
    expect(book).toMatchObject({ name: '星穹铁道', revision: 1 })
    expect(() => service.create({ name: '星穹铁道' })).toThrow(/同名/)
    expect(() => service.create({ name: '   ' })).toThrow(/不能为空/)
    const saved = service.save(book.id, { name: 'Star Rail', entries: [blue('b')], revision: 1 })
    expect(saved.revision).toBe(2)
    expect(() => service.save(book.id, { name: 'Star Rail', entries: [], revision: 1 })).toThrow(
      expect.objectContaining({ code: 'CONFLICT' }),
    )
    expect(() => service.create({ name: 'star rail' })).toThrow(/同名/)

    const reloaded = new WorldbookService(path.join(directory, 'worldbooks'))
    reloaded.initialize()
    expect(reloaded.get(book.id)).toMatchObject({ name: 'Star Rail', revision: 2 })
    expect(reloaded.get(book.id)?.entries.map((entry) => entry.id)).toEqual(['b'])
  })

  it('损坏的世界书文件被跳过，不影响其他书', () => {
    const { directory, service } = setup()
    const book = service.create({ name: '正常' })
    writeFileSync(path.join(directory, 'worldbooks', 'books', 'wb-broken.json'), '{ 坏了')
    const reloaded = new WorldbookService(path.join(directory, 'worldbooks'))
    reloaded.initialize()
    expect(reloaded.list().map((item) => item.id)).toEqual([book.id])
  })

  it('复制世界书携带条目；删除时清理全局启用列表与角色绑定', () => {
    const { service } = setup()
    const source = service.create({ name: '源', entries: [blue('a')] })
    const copy = service.duplicate(source.id, '源 副本')
    expect(copy.entries).toEqual(source.entries)
    service.saveSettings({ scanDepth: 3, tokenBudget: 0, globalBooks: [source.id, copy.id] })
    service.saveBinding('Pero', { primary: source.id, additional: [copy.id] })
    service.saveBinding('nova', { primary: copy.id, additional: [source.id] })
    service.remove(source.id)
    expect(service.getSettings().globalBooks).toEqual([copy.id])
    expect(service.getBinding('pero')).toEqual({ primary: null, additional: [copy.id] })
    expect(service.getBinding('nova')).toEqual({ primary: copy.id, additional: [] })
    expect(() => service.remove(source.id)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
  })

  it('保存绑定与设置时剔除不存在的书，主要世界书不会同时作为附加世界书', () => {
    const { service } = setup()
    const book = service.create({ name: '书' })
    expect(
      service.saveBinding('pero', { primary: book.id, additional: [book.id, 'wb-gone'] }),
    ).toEqual({
      primary: book.id,
      additional: [],
    })
    expect(service.saveBinding('pero', { primary: 'wb-gone', additional: [] }).primary).toBeNull()
    expect(
      service.saveSettings({ scanDepth: 0, tokenBudget: -5, globalBooks: ['wb-gone', book.id] }),
    ).toEqual({ scanDepth: 1, tokenBudget: 0, globalBooks: [book.id] })
  })

  it('全局世界书按单本增删，保存激活设置不覆盖全局列表', () => {
    const { service } = setup()
    const first = service.create({ name: '甲' })
    const second = service.create({ name: '乙' })
    service.addGlobalBook(first.id)
    // 另一个窗口仍以为列表为空，只提交扫描深度：不会把甲移除。
    service.saveSettings({ scanDepth: 4, tokenBudget: 0 })
    service.addGlobalBook(second.id)
    service.addGlobalBook(second.id)
    expect(service.getSettings()).toEqual({
      scanDepth: 4,
      tokenBudget: 0,
      globalBooks: [first.id, second.id],
    })
    expect(service.removeGlobalBook(first.id).globalBooks).toEqual([second.id])
    expect(service.removeGlobalBook('wb-gone').globalBooks).toEqual([second.id])
    expect(() => service.addGlobalBook('wb-gone')).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' }),
    )
  })

  it('角色绑定带上编辑前的绑定时，其他窗口已修改则拒绝保存', () => {
    const { service } = setup()
    const first = service.create({ name: '甲' })
    const second = service.create({ name: '乙' })
    const empty = { primary: null, additional: [] }
    service.saveBinding('pero', { primary: first.id, additional: [] }, empty)
    expect(() =>
      service.saveBinding('pero', { primary: null, additional: [second.id] }, empty),
    ).toThrow(expect.objectContaining({ code: 'CONFLICT' }))
    expect(service.getBinding('pero').primary).toBe(first.id)
    expect(
      service.saveBinding(
        'pero',
        { primary: first.id, additional: [second.id] },
        { primary: first.id, additional: [] },
      ),
    ).toEqual({ primary: first.id, additional: [second.id] })
  })

  it('激活顺序为全局、主要、附加，同一本书只计算一次', () => {
    const { service } = setup()
    const global = service.create({ name: '全局', entries: [blue('g')] })
    const primary = service.create({ name: '主要', entries: [blue('p')] })
    const extra = service.create({ name: '附加', entries: [blue('e')] })
    service.saveSettings({ scanDepth: 2, tokenBudget: 0, globalBooks: [global.id, primary.id] })
    service.saveBinding('pero', { primary: primary.id, additional: [extra.id] })
    expect(activate(service).content).toBe('g 内容\n\np 内容\n\ne 内容')
    expect(activate(service, 'nova').content).toBe('g 内容\n\np 内容')
  })

  it('导出主要世界书为酒馆格式；角色内嵌世界书只导入一次并绑定为主要世界书', () => {
    const { directory, service } = setup()
    expect(service.exportAgentBundle('pero')).toBeUndefined()
    const book = service.create({ name: '角色书', entries: [blue('a')] })
    service.saveBinding('pero', { primary: book.id, additional: [] })
    const bundle = service.exportAgentBundle('pero')!
    expect(bundle.path).toBe(WORLDBOOK_FILE_NAME)
    expect(JSON.parse(Buffer.from(bundle.contentBase64, 'base64').toString('utf-8'))).toEqual(
      exportWorldbookFile(book),
    )

    const agentDir = path.join(directory, 'agents', 'nova')
    mkdirSync(agentDir, { recursive: true })
    writeFileSync(
      path.join(agentDir, WORLDBOOK_FILE_NAME),
      Buffer.from(bundle.contentBase64, 'base64'),
    )
    service.importAgentBundle('Nova', agentDir)
    const imported = service.getBinding('nova').primary!
    expect(service.get(imported)).toMatchObject({ name: '角色书 (2)' })
    expect(service.get(imported)?.entries[0]).toMatchObject({
      light: 'constant',
      content: 'a 内容',
    })

    // 用户解绑后不会被同一份文件再次导入。
    service.saveBinding('nova', { primary: null, additional: [] })
    service.importAgentBundle('nova', agentDir)
    expect(service.getBinding('nova').primary).toBeNull()
    expect(service.list()).toHaveLength(2)

    // 已有主要世界书时不覆盖用户选择。
    const other = path.join(directory, 'agents', 'luna')
    mkdirSync(other, { recursive: true })
    writeFileSync(
      path.join(other, WORLDBOOK_FILE_NAME),
      readFileSync(path.join(agentDir, WORLDBOOK_FILE_NAME)),
    )
    service.saveBinding('luna', { primary: book.id, additional: [] })
    service.importAgentBundle('luna', other)
    expect(service.getBinding('luna').primary).toBe(book.id)
    expect(service.list()).toHaveLength(2)
  })

  it('删除角色时只移除绑定，书库保留', () => {
    const { service } = setup()
    const book = service.create({ name: '书' })
    service.saveBinding('pero', { primary: book.id, additional: [] })
    service.removeAgent('Pero')
    expect(service.getBinding('pero')).toEqual({ primary: null, additional: [] })
    expect(service.get(book.id)).toBeDefined()
  })

  it('角色删除后重新出现时复用已导入的内嵌世界书，不重复导入', () => {
    const { directory, service } = setup()
    const agentDir = path.join(directory, 'agents', 'pero')
    mkdirSync(agentDir, { recursive: true })
    writeFileSync(
      path.join(agentDir, WORLDBOOK_FILE_NAME),
      JSON.stringify(exportWorldbookFile(service.create({ name: '内置书', entries: [blue('a')] }))),
    )
    service.importAgentBundle('pero', agentDir)
    const imported = service.getBinding('pero').primary
    service.removeAgent('pero')
    service.importAgentBundle('pero', agentDir)
    expect(service.getBinding('pero').primary).toBe(imported)
    expect(service.list()).toHaveLength(2)
  })

  it('constructor、__proto__ 等角色 ID 可正常绑定、激活与重新加载', () => {
    const { directory, service } = setup()
    const book = service.create({ name: '书', entries: [blue('a')] })
    expect(service.getBinding('constructor')).toEqual({ primary: null, additional: [] })
    expect(activate(service, 'constructor').content).toBe('')
    for (const agentId of ['__proto__', 'constructor'])
      service.saveBinding(agentId, { primary: book.id, additional: [] })
    const reloaded = new WorldbookService(path.join(directory, 'worldbooks'))
    reloaded.initialize()
    for (const agentId of ['__proto__', 'constructor'])
      expect(activate(reloaded, agentId).content).toBe('a 内容')
    expect(reloaded.getBinding('primary')).toEqual({ primary: null, additional: [] })
  })

  it('命中测试使用草稿条目与全局扫描设置', () => {
    const { service } = setup()
    const result = service.test({
      entries: [{ ...createWorldbookEntry('a'), keys: ['剑'], content: '{{char}} 的剑' }],
      text: '拔剑',
      channel: 'desktop',
    })
    expect(result.hits).toMatchObject([{ bookId: 'draft', entryId: 'a', keyword: '剑' }])
    expect(result.content).toBe('{{char}} 的剑')
  })
})
