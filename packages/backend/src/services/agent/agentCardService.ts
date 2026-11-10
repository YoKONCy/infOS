/** 角色卡协调层负责资源编解码、预览、身份改写与安装事务。 */
import { isMap, parseDocument } from 'yaml'
import type { AgentManager } from './agentManager'
import {
  AgentCardError,
  decodeCard,
  defaultCardImage,
  encodeCardZip,
  parseCardJson,
  validateCard,
  writePngCard,
  type AgentCard,
} from './agentCardCodec'

export class AgentCardService {
  constructor(
    private agents: AgentManager,
    private refresh: () => void = () => {},
  ) {}

  private collect(id: string): AgentCard {
    const pkg = this.agents.exportAgentPackage(id)
    const files = new Map(
      pkg.files
        .map((file) => [file.path, Buffer.from(file.contentBase64, 'base64')]),
    )
    return validateCard({
      manifest: {
        format: 'infos.agent-card',
        version: 1,
        agentId: pkg.agentId,
        name: pkg.name,
        worldbooks: [],
      },
      files,
    })
  }

  export(
    id: string,
    format: 'png' | 'zip',
    cover?: Buffer,
  ): { fileName: string; contentBase64: string } {
    const card = this.collect(id)
    const zip = encodeCardZip(card)
    let bytes = zip
    if (format === 'png') {
      const avatar = this.agents.getAvatarData(id)
      // 非 PNG 头像由浏览器画布转码，原头像仍逐字节保存在资源包中。
      if (avatar && avatar.mime !== 'image/png' && !cover) throw new AgentCardError()
      bytes = writePngCard(cover ?? avatar?.buffer ?? defaultCardImage(), zip)
    }
    return { fileName: `${id}.infos-agent.${format}`, contentBase64: bytes.toString('base64') }
  }

  preview(input: Buffer) {
    const { manifest, files } = decodeCard(input)
    const image = ['avatar.png', 'avatar.jpg', 'avatar.webp', 'icon.png'].find((name) =>
      files.has(name),
    )
    const mime = image?.endsWith('.jpg')
      ? 'image/jpeg'
      : image?.endsWith('.webp')
        ? 'image/webp'
        : 'image/png'
    return {
      agentId: manifest.agentId,
      name: manifest.name,
      exists: this.agents.hasAgentPackage(manifest.agentId),
      avatar: `data:${mime};base64,${(image ? files.get(image)! : defaultCardImage()).toString('base64')}`,
    }
  }

  import(input: Buffer, mode: 'overwrite' | 'new' | 'create') {
    const card = decodeCard(input)
    let id = card.manifest.agentId
    let name = card.manifest.name
    if (mode === 'create' && this.agents.hasAgentPackage(id)) throw new AgentCardError('CONFLICT')
    if (mode === 'new') {
      const names = new Set(this.agents.listAgents().map((a) => a.name.toLowerCase()))
      for (let index = 2; ; index++) {
        const suffix = ` (${index})`
        const candidate = `${name.slice(0, 100 - suffix.length)}${suffix}`
        const candidateId = `${id.slice(0, 48)}-${index}`
        if (!this.agents.hasAgentPackage(candidateId) && !names.has(candidate.toLowerCase())) {
          id = candidateId
          name = candidate
          break
        }
      }
    }
    // 两份旧/新清单都同步改写，避免旧字段残留身份；资源元数据其余字段保持原样。
    for (const file of ['agent.json', 'config.json'])
      if (card.files.has(file)) {
        const config = parseCardJson(card.files.get(file)!) as Record<string, unknown>
        config.name = name
        config.agent_id = id
        card.files.set(file, Buffer.from(JSON.stringify(config, null, 2)))
      }
    const yaml = card.files.get('capabilities.yaml')
    if (yaml) {
      const doc = parseDocument(yaml.toString('utf8'), { uniqueKeys: true })
      if (doc.errors.length || !isMap(doc.contents)) throw new AgentCardError()
      doc.toJS({ maxAliasCount: 100 })
      doc.set('agent', id)
      card.files.set('capabilities.yaml', Buffer.from(doc.toString()))
    }
    try {
      return this.agents.installCard(id, card.files, () => {
        this.refresh()
        return { id, name }
      })
    } catch (error) {
      // 能力索引可能已读到暂存后的档案，回滚磁盘后重新读取旧配置。
      try {
        this.refresh()
      } catch {
        /* 原始事务错误由 API 展示边界统一处理。 */
      }
      throw error
    }
  }
}
