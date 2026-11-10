import { randomUUID } from 'node:crypto'
import type { HomeSettings, HomeMapEntry, HomeShelfItem } from '@infos/shared'
import type { HomeRepository } from '../../repositories/home.repo'
import { contentHash, HomeStorage } from './homeStorage'
import { HomeError } from './homeErrors'

/** 只接受地点与用途；凭据、联系方式及身份号码不能进入家的地图。 */
export function assertMapPrivacy(
  value: Pick<HomeMapEntry, 'name' | 'location' | 'purpose'>,
  blockedTerms: string[] = [],
) {
  const text = `${value.name}\n${value.location}\n${value.purpose}`
  if (
    blockedTerms.some((term) => text.toLowerCase().includes(term.toLowerCase())) ||
    /password|passwd|secret|api[_ -]?key|access[_ -]?token|bearer\s|密码|密碼|口令|私钥|私鑰|身份证|身分證|-----BEGIN|eyJ[\w-]+\.[\w-]+\.[\w-]+|[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:\+?\d[\s-]?){11,}|[?&](?:token|key|auth|code)=|:\/\/[^/\s]+:[^/\s]+@/i.test(
      text,
    )
  )
    throw new HomeError('HOME_PRIVATE')
}

export class HomeBelongingsService {
  constructor(
    private repo: HomeRepository,
    private storage: HomeStorage,
    private limits: () => HomeSettings,
    private now = Date.now,
  ) {}
  shelf(agentId: string, includeDeleted = false) {
    return this.repo
      .list<HomeShelfItem>('shelf', agentId)
      .filter((row) => includeDeleted || !row.deletedAt)
  }
  putShelf(
    agentId: string,
    from: 'user' | 'agent',
    input: { kind: HomeShelfItem['kind']; name: string; value?: string; content?: Buffer },
  ) {
    if (
      !input.name.trim() ||
      input.name.length > 200 ||
      !['file', 'image', 'text', 'url'].includes(input.kind)
    )
      throw new HomeError('HOME_INVALID')
    const binary = input.kind === 'file' || input.kind === 'image'
    if ((binary && !input.content) || (!binary && input.value === undefined))
      throw new HomeError('HOME_INVALID')
    if (input.kind === 'url') {
      try {
        const url = new URL(input.value!)
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
          throw new Error()
      } catch {
        throw new HomeError('HOME_INVALID')
      }
    }
    const size = binary ? input.content!.length : Buffer.byteLength(input.value!)
    const all = this.shelf(agentId, true)
    if (
      all.length >= this.limits().shelfMaxItems ||
      all.reduce((sum, row) => sum + row.size, size) > this.limits().shelfMaxBytes ||
      size > this.limits().fileMaxBytes
    )
      throw new HomeError('HOME_LIMIT')
    if (binary) this.storage.reserve([input.content!])
    const item: HomeShelfItem = {
      id: randomUUID(),
      agentId,
      from,
      to: from === 'user' ? 'agent' : 'user',
      kind: input.kind,
      name: input.name,
      value: binary ? undefined : input.value,
      hash: binary ? contentHash(input.content!) : undefined,
      size,
      createdAt: this.now(),
    }
    this.repo.put('shelf', item, item.createdAt)
    return item
  }
  takeShelf(agentId: string, id: string) {
    const item = this.repo.get<HomeShelfItem>('shelf', id)
    if (!item || item.agentId !== agentId || item.deletedAt) throw new HomeError('HOME_NOT_FOUND')
    return {
      ...item,
      content: item.hash ? this.storage.blob(item.hash).toString('base64') : undefined,
    }
  }
  deleteShelf(agentId: string, id: string) {
    const item = this.takeShelf(agentId, id)
    const { content: _content, ...value } = item
    this.repo.put('shelf', { ...value, deletedAt: this.now() })
    return { id, recycled: true }
  }
  restoreShelf(agentId: string, id: string) {
    const item = this.repo.get<HomeShelfItem>('shelf', id)
    if (!item || item.agentId !== agentId) throw new HomeError('HOME_NOT_FOUND')
    const value = { ...item, deletedAt: undefined }
    this.repo.put('shelf', value)
    return value
  }
  /** 地图回收物复用检查点保留期限，读取和修改前清理到期记录。 */
  private pruneMap(): void {
    for (const row of this.repo.list<HomeMapEntry>('map'))
      if (
        row.deletedAt !== undefined &&
        row.deletedAt + this.limits().checkpointRetentionMs <= this.now()
      )
        this.repo.remove('map', row.id)
  }
  map(agentId: string, query = '', includeDeleted = false) {
    this.pruneMap()
    return this.repo
      .list<HomeMapEntry>('map', agentId)
      .filter((row) => includeDeleted || row.deletedAt === undefined)
      .filter((row) =>
        `${row.name}\n${row.location}\n${row.purpose}`.toLowerCase().includes(query.toLowerCase()),
      )
  }
  putMap(
    agentId: string,
    input: Omit<HomeMapEntry, 'agentId' | 'updatedAt' | 'id' | 'deletedAt'> & { id?: string },
  ) {
    this.pruneMap()
    if (
      ![input.name, input.location, input.purpose].every((value) => value.length <= 1000) ||
      !input.name.trim() ||
      !input.location.trim()
    )
      throw new HomeError('HOME_INVALID')
    assertMapPrivacy(input, this.limits().mapBlockedTerms)
    if (input.id) {
      const previous = this.repo.get<HomeMapEntry>('map', input.id)
      if (!previous || previous.agentId !== agentId || previous.deletedAt !== undefined)
        throw new HomeError('HOME_NOT_FOUND')
    } else if (this.map(agentId, '', true).length >= this.limits().mapMaxItems)
      throw new HomeError('HOME_LIMIT')
    const row: HomeMapEntry = {
      ...input,
      id: input.id ?? randomUUID(),
      agentId,
      updatedAt: this.now(),
      deletedAt: undefined,
    }
    this.repo.put('map', row)
    return row
  }
  deleteMap(agentId: string, id: string) {
    this.pruneMap()
    const row = this.repo.get<HomeMapEntry>('map', id)
    if (!row || row.agentId !== agentId || row.deletedAt !== undefined)
      throw new HomeError('HOME_NOT_FOUND')
    this.repo.put('map', { ...row, deletedAt: this.now() })
    return { id, recycled: true }
  }
  restoreMap(agentId: string, id: string) {
    this.pruneMap()
    const row = this.repo.get<HomeMapEntry>('map', id)
    if (!row || row.agentId !== agentId) throw new HomeError('HOME_NOT_FOUND')
    assertMapPrivacy(row, this.limits().mapBlockedTerms)
    const value = { ...row, deletedAt: undefined }
    this.repo.put('map', value)
    return value
  }
}
