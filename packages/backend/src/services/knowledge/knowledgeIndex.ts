import { createHash } from 'node:crypto'
import path from 'node:path'
import { mkdirSync, readdirSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import type { MemoryStoreRegistry } from '../../repositories/storeRegistry'
import type {
  KnowledgeRepository,
  KnowledgePartRow,
  KnowledgeDocumentRow,
} from '../../repositories/knowledge.repo'
import type { EmbeddingService } from '../embedding/embeddingService'
import { resolveRipgrepPath } from '../../tools/codeSearcher'
import type { KnowledgeSearchInput, KnowledgeSearchResult, KnowledgeSearchHit } from '@infos/shared'
import { fitKnowledgeText } from './knowledgeText'
import { tokenCounter } from '../tokenizer/tokenCounter'

type IndexedPart = { part: KnowledgePartRow; document: KnowledgeDocumentRow; hasVector?: boolean }
type MatchMethod = KnowledgeSearchHit['matchedBy'][number]

export function knowledgeEmbeddingKey(embedding: EmbeddingService): string {
  const config = embedding.getConfig()
  return createHash('sha256')
    .update(JSON.stringify([config.apiBase.replace(/\/+$/, ''), config.model, config.dimension]))
    .digest('hex')
}

export function validKnowledgeVector(value: unknown, dimension: number): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === dimension &&
    value.every((v) => typeof v === 'number' && Number.isFinite(v)) &&
    value.some((v) => v !== 0)
  )
}

/** SQLite 是资料主存；TDB 和 ripgrep 文本均为可重建的索引。 */
export class KnowledgeIndex {
  private entries = new Map<number, IndexedPart>()
  private key = ''
  private available = false

  constructor(
    private readonly repo: KnowledgeRepository,
    private readonly stores: MemoryStoreRegistry,
    private readonly embedding: EmbeddingService,
    private readonly sourceRoot: string,
  ) {}

  /** 配置切换不覆盖旧维度文件；旧索引等待显式重建，启动时也遵循此规则。 */
  configurationChanged(): void {
    this.available = false
    this.entries.clear()
    const current = this.stores.describeStore(this.stores.resolveSharedStorePath('knowledge'))
    if (current.exists && current.dimension !== this.stores.getDimension()) return
    this.rebuild()
  }

  rebuild(): void {
    this.available = false
    this.key = knowledgeEmbeddingKey(this.embedding)
    const store = this.stores.getSharedStore('knowledge')
    const entries = this.repo.readyParts()
    const keepIds = new Set(entries.map(({ part }) => part.id))
    let changed = false
    for (const id of store.allNodeIds())
      if (!keepIds.has(id)) {
        store.delete(id)
        changed = true
      }
    mkdirSync(this.sourceRoot, { recursive: true })
    const keep = new Set(entries.map(({ part }) => `${part.id}.txt`))
    // 只清理由本服务生成的数字文件，禁止递归删除资料目录。
    for (const name of readdirSync(this.sourceRoot))
      if (/^\d+\.txt$/.test(name) && !keep.has(name)) unlinkSync(path.join(this.sourceRoot, name))
    const previous = this.entries
    this.entries = new Map()
    for (const entry of entries) {
      const { part, document } = entry
      let vector: unknown
      try {
        vector =
          part.embeddingKey === this.key && part.embeddingJson
            ? JSON.parse(part.embeddingJson)
            : null
      } catch {
        vector = null
      }
      const hasVector =
        this.embedding.isAvailable && validKnowledgeVector(vector, this.stores.getDimension())
      const old = previous.get(part.id)
      const needsUpdate =
        !old ||
        old.document.revision !== document.revision ||
        old.hasVector !== hasVector ||
        old.part.embeddingJson !== part.embeddingJson ||
        old.part.embeddingKey !== part.embeddingKey ||
        !store.contains(part.id)
      if (needsUpdate) {
        store.upsertWithId(
          part.id,
          hasVector ? (vector as number[]) : Array(this.stores.getDimension()).fill(0),
          { documentId: document.id, hasVector },
        )
        changed = true
      }
      const body = document.content.slice(part.startOffset, part.endOffset)
      if (needsUpdate)
        store.indexText(
          part.id,
          `${document.title}\n${part.title}\n${part.summary}\n${JSON.parse(part.keywordsJson).join(' ')}\n${body}`,
        )
      const filename = path.join(this.sourceRoot, `${part.id}.txt`)
      if (!old || old.document.revision !== document.revision || !existsSync(filename))
        writeFileSync(filename, body, 'utf8')
      this.entries.set(part.id, { ...entry, hasVector })
    }
    if (changed || previous.size === 0) {
      store.buildTextIndex()
      store.flush()
    }
    this.available = true
  }

  resetPhysicalStore(): void {
    this.stores.resetSharedStore('knowledge')
    this.entries.clear()
    this.rebuild()
  }

  /** 统一维护入口在重置文件前等待在途访问，模型调用仍由上层调度。 */
  async resetPhysicalStoreForMaintenance(signal?: AbortSignal): Promise<void> {
    await this.stores.withMaintenance(
      this.stores.resolveSharedStorePath('knowledge'),
      () => {
        signal?.throwIfAborted()
        this.resetPhysicalStore()
      },
      signal,
    )
  }

  private current(entry: IndexedPart): boolean {
    const current = this.repo.version(entry.document.id)
    return current?.status === 'ready' && current.revision === entry.document.revision
  }

  async search(
    input: KnowledgeSearchInput,
    signal?: AbortSignal,
    options: { minVectorScore?: number; vector?: boolean } = {},
  ): Promise<KnowledgeSearchResult> {
    if (!this.available || this.key !== knowledgeEmbeddingKey(this.embedding)) this.rebuild()
    signal?.throwIfAborted()
    const version = this.repo.generation()
    const limit = Math.min(20, Math.max(1, Math.floor(input.limit ?? 5)))
    const keywords = input.keywords?.map((k) => k.trim()).filter(Boolean) ?? []
    const regex = input.regex?.trim()
    const ids = input.partIds?.map(Number)
    if (!keywords.length && !regex && !ids?.length) throw new Error('请提供关键词、正则或片段编号')
    if (input.offset !== undefined && (!input.expand || ids?.length !== 1))
      throw new Error('字符游标仅用于展开一个指定片段')
    const entries = new Map(
      [...this.entries].filter(
        ([id, entry]) =>
          (!input.documentId || entry.document.id === input.documentId) &&
          (!ids?.length || ids.includes(id)) &&
          this.current(entry),
      ),
    )
    const warnings: string[] = []
    const candidates = new Map<
      number,
      { score: number; methods: Set<MatchMethod>; position?: number }
    >()
    const add = (id: number, method: MatchMethod, rank: number, position?: number) => {
      if (!entries.has(id)) return
      const candidate = candidates.get(id) ?? { score: 0, methods: new Set<MatchMethod>() }
      candidate.score += 1 / (60 + rank)
      candidate.methods.add(method)
      if (position !== undefined) candidate.position = position
      candidates.set(id, candidate)
    }
    const store = this.stores.getSharedStore('knowledge')
    // 文档范围过滤在排名前完成，避免指定资料被全库候选挤掉。
    const recall = Math.max(
      1,
      input.documentId || ids?.length ? this.entries.size : Math.min(this.entries.size, 200),
    )
    if (ids?.length) ids.forEach((id, i) => add(id, 'id', i + 1))
    if (keywords.length) {
      const query = keywords.join(' ')
      store
        .searchHybrid(Array(this.stores.getDimension()).fill(0), query, recall, 0, -1, 0)
        .filter((hit) => hit.score > 0)
        .forEach((hit, i) => add(hit.id, 'bm25', i + 1))
      if (
        options.vector !== false &&
        this.embedding.isAvailable &&
        [...entries.values()].some((entry) => entry.hasVector)
      ) {
        const key = this.key
        try {
          const vector = await this.embedding.embedOne(query, signal)
          signal?.throwIfAborted()
          if (!this.embedding.isAvailable || key !== knowledgeEmbeddingKey(this.embedding))
            warnings.push('向量模型已变更，本次仅使用文本检索')
          else if (validKnowledgeVector(vector, this.stores.getDimension())) {
            this.stores
              .getSharedStore('knowledge')
              .search(vector, recall, 0, options.minVectorScore ?? 0.2)
              .filter((hit) => hit.payload?.hasVector)
              .forEach((hit, i) => add(hit.id, 'vector', i + 1))
          } else warnings.push('向量返回无效，本次使用文本检索')
        } catch (cause) {
          signal?.throwIfAborted()
          warnings.push(`向量检索暂不可用：${(cause as Error).message}`)
        }
      }
    }
    if (regex && entries.size) {
      try {
        const matches = await this.regexMatches(regex, signal)
        let rank = 1
        for (const [id, position] of matches) add(id, 'regex', rank++, position)
      } catch (cause) {
        signal?.throwIfAborted()
        if (!keywords.length) throw cause
        warnings.push(`正则检索暂不可用：${(cause as Error).message}`)
      }
    }
    signal?.throwIfAborted()
    const ranked = [...candidates]
      .filter(([id]) => this.current(entries.get(id)!))
      .sort((a, b) => b[1].score - a[1].score || a[0] - b[0])
    const items: KnowledgeSearchHit[] = []
    // 预算包含 JSON 转义后的正文、元数据与响应封装。
    let remaining = 23_000
    for (const [id, candidate] of ranked.slice(0, limit)) {
      const { part, document } = entries.get(id)!
      const body = document.content.slice(part.startOffset, part.endOffset)
      const position =
        candidate.position ??
        Math.max(
          0,
          ...keywords
            .map((k) => body.toLocaleLowerCase().indexOf(k.toLocaleLowerCase()))
            .filter((i) => i >= 0)
            .slice(0, 1),
        )
      let start = Math.max(0, position - 240)
      if (start > 0 && /[\uDC00-\uDFFF]/.test(body[start]!)) start--
      let end = Math.min(body.length, start + 1100)
      if (end < body.length && /[\uD800-\uDBFF]/.test(body[end - 1]!)) end++
      const excerpt = `${start ? '…' : ''}${body.slice(start, end)}${end < body.length ? '…' : ''}`
      const hit: KnowledgeSearchHit = {
        ...this.repo.partInfo(part),
        documentTitle: document.title,
        source: document.source || document.title,
        revision: document.revision,
        score: candidate.score,
        matchedBy: [...candidate.methods],
        excerpt,
        truncated: false,
      }
      const overhead = tokenCounter.countTokens(JSON.stringify(hit)) + 32
      if (remaining < overhead + (input.expand ? 64 : 0)) break
      remaining -= overhead
      if (input.expand) {
        let offset = Math.min(body.length, Math.max(0, Math.floor(input.offset ?? 0)))
        if (offset > 0 && /[\uDC00-\uDFFF]/.test(body[offset]!)) offset--
        let content = fitKnowledgeText(
          body.slice(offset),
          Math.max(1, Math.floor(remaining / (Math.min(limit, ranked.length) - items.length)) - 64),
        )
        while (content && tokenCounter.countTokens(JSON.stringify(content)) + 64 > remaining) {
          content = fitKnowledgeText(
            content,
            Math.max(0, Math.floor(tokenCounter.countTokens(content) * 0.85)),
          )
        }
        hit.content = content
        hit.contentOffset = offset
        hit.truncated = offset + content.length < body.length
        if (hit.truncated) hit.nextOffset = offset + content.length
        remaining -= tokenCounter.countTokens(JSON.stringify(content)) + 32
      }
      items.push(hit)
    }
    if (items.length < Math.min(limit, ranked.length))
      warnings.push('结果达到单次预算，可用片段编号或缩小检索范围继续读取')
    return {
      version,
      items,
      total: ranked.length,
      limit,
      expanded: Boolean(input.expand),
      truncated: items.length < Math.min(limit, ranked.length) || items.some((h) => h.truncated),
      warnings: warnings.map((warning) => fitKnowledgeText(warning, 200)),
    }
  }

  private async regexMatches(pattern: string, signal?: AbortSignal): Promise<Map<number, number>> {
    const rg = await resolveRipgrepPath()
    if (!rg) throw new Error('ripgrep 不可用，暂时无法执行正则检索')
    return new Promise((resolve, reject) => {
      const matches = new Map<number, number>()
      const child = spawn(
        rg,
        [
          '--json',
          '--no-ignore',
          '--sort',
          'path',
          '--text',
          '--line-number',
          '--max-count',
          '1',
          '--',
          pattern,
          this.sourceRoot,
        ],
        { shell: false, windowsHide: true },
      )
      let pending = ''
      let stderr = ''
      let bytes = 0
      let failure: Error | undefined
      const stop = (error: Error) => {
        failure = error
        child.kill()
      }
      const timer = setTimeout(() => stop(new Error('正则检索超时，请缩小表达式或资料范围')), 5000)
      const abort = () => stop(new Error('检索已取消'))
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      child.stderr.on('data', (chunk) => {
        if (stderr.length < 4096) stderr += chunk.toString()
      })
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        bytes += Buffer.byteLength(chunk)
        if (bytes > 64 * 1024 * 1024) {
          stop(new Error('正则命中内容过多，请缩小检索范围'))
          return
        }
        pending += chunk
        let newline: number
        while ((newline = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, newline)
          pending = pending.slice(newline + 1)
          try {
            const event = JSON.parse(line)
            if (event.type !== 'match') continue
            const id = Number(path.basename(event.data.path.text, '.txt'))
            const entry = this.entries.get(id)
            if (!entry || matches.has(id)) continue
            const byteOffset = event.data.absolute_offset + (event.data.submatches?.[0]?.start ?? 0)
            const body = entry.document.content.slice(entry.part.startOffset, entry.part.endOffset)
            matches.set(
              id,
              Buffer.from(body, 'utf8').subarray(0, byteOffset).toString('utf8').length,
            )
          } catch {
            /* ripgrep 的非匹配记录不参与召回。 */
          }
        }
      })
      const cleanup = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
      }
      child.on('error', (error) => {
        cleanup()
        reject(new Error(`正则检索无法启动：${error.message}`))
      })
      child.on('close', (code) => {
        cleanup()
        if (failure) reject(failure)
        else if (code === 0 || code === 1) resolve(matches)
        else reject(new Error(`正则检索失败：${stderr.trim() || '表达式无效'}`))
      })
    })
  }
}
