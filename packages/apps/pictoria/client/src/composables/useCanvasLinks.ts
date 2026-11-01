import { t as __t } from '../i18n'
import { applyReferenceUses, videoStartField } from '../../../src/creativeInputs'
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import Ajv from 'ajv'
import type {
  AssetReference,
  CanvasEdge,
  CanvasItem,
  FieldSchema,
  InputConnection,
  InputPort,
  OutputPort,
  Step,
} from '../types'
import type { CanvasStore } from './useCanvas'

export const isAssetField = (field: FieldSchema) =>
  field.type === 'object' && Boolean(field.properties?.assetId)
export const isAssetsField = (field: FieldSchema) =>
  field.type === 'array' && Boolean(field.items && isAssetField(field.items))
export function inputFields(item: CanvasItem) {
  return Object.entries(item.content.step?.inputSchema.properties || {})
}
export const canConnect = (field: FieldSchema) =>
  isAssetField(field) || isAssetsField(field) || (field.type === 'string' && !field.enum)
export function cardFields(item: CanvasItem) {
  return inputFields(item).filter(([, field]) => item.content.showAdvanced || canConnect(field))
}
export const fieldHeight = (field: FieldSchema) =>
  isAssetField(field) || isAssetsField(field) ? 132 : 76
export const draftHeight = (item: CanvasItem) =>
  120 + cardFields(item).reduce((height, [, field]) => height + fieldHeight(field), 0)
export function topPortX(item: CanvasItem, field: string) {
  const fields = inputFields(item).filter(([, schema]) => canConnect(schema))
  return (
    (item.content.width *
      (Math.max(
        0,
        fields.findIndex(([name]) => name === field),
      ) +
        1)) /
    (fields.length + 1)
  )
}
export function inputAnchor(item: CanvasItem, field: string, port: InputPort = 'left') {
  if (port === 'top')
    return {
      x: item.x + (item.content.kind === 'draft' ? topPortX(item, field) : item.content.width / 2),
      y: item.y,
    }
  if (item.content.kind !== 'draft') return { x: item.x, y: item.y + 36 }
  const fields = cardFields(item),
    index = Math.max(
      0,
      fields.findIndex(([name]) => name === field),
    )
  return {
    x: item.x,
    y:
      item.y +
      56 +
      fields.slice(0, index).reduce((height, [, schema]) => height + fieldHeight(schema), 0) +
      fieldHeight(fields[index]?.[1] || {}) / 2,
  }
}
export function outputAnchor(item: CanvasItem, port: OutputPort = 'right') {
  return port === 'bottom'
    ? { x: item.x + item.content.width / 2, y: item.y + item.content.height }
    : { x: item.x + item.content.width, y: item.y + 36 }
}
export function curve(
  from: { x: number; y: number },
  to: { x: number; y: number },
  sourcePort: OutputPort = 'right',
  targetPort: InputPort = 'left',
) {
  const bend = Math.max(48, Math.min(400, Math.hypot(to.x - from.x, to.y - from.y) * 0.4))
  const start =
    sourcePort === 'bottom' ? { x: from.x, y: from.y + bend } : { x: from.x + bend, y: from.y }
  const end = targetPort === 'top' ? { x: to.x, y: to.y - bend } : { x: to.x - bend, y: to.y }
  return `M${from.x},${from.y}C${start.x},${start.y} ${end.x},${end.y} ${to.x},${to.y}`
}
export function acceptsAsset(name: string, item: CanvasItem) {
  return (
    item.content.kind === 'asset' &&
    Boolean(item.content.assetId) &&
    (/video/i.test(name)
      ? Boolean(item.content.mimeType?.startsWith('video/'))
      : /audio/i.test(name)
        ? Boolean(item.content.mimeType?.startsWith('audio/'))
        : /image|mask/i.test(name)
          ? Boolean(item.content.mimeType?.startsWith('image/'))
          : true)
  )
}
function referenceId(value: unknown) {
  const id =
    value && typeof value === 'object' ? (value as { assetId?: unknown }).assetId : undefined
  return typeof id === 'string' ? id : undefined
}
export function assetReferences(
  item: CanvasItem,
  field: string,
  items: CanvasItem[],
  edges: CanvasEdge[],
): AssetReference[] {
  const value = item.content.inputs?.[field],
    fixed = Array.isArray(value) ? value : value ? [value] : []
  const refs = new Map<string, AssetReference>()
  for (const value of fixed) {
    const id = referenceId(value)
    if (typeof id !== 'string' || refs.has(id)) continue
    const source = items.find((candidate) => candidate.content.assetId === id)
    refs.set(id, {
      assetId: id,
      name: source?.content.name || '素材引用',
      mimeType: source?.content.mimeType,
    })
  }
  for (const edge of edges.filter(
    (edge) => edge.target === item.id && edge.field === field && !edge.historical,
  )) {
    const source = items.find((candidate) => candidate.id === edge.source),
      id = source?.content.assetId
    if (source && id)
      refs.set(id, {
        assetId: id,
        name: source.content.name || '素材引用',
        mimeType: source.content.mimeType,
        source: source.id,
      })
  }
  const order = item.content.inputOrder?.[field] || []
  const rank = (id: string) => {
    const index = order.indexOf(id)
    return index < 0 ? order.length : index
  }
  return [...refs.values()].sort((a, b) => rank(a.assetId) - rank(b.assetId))
}

export function useCanvasLinks(
  store: CanvasStore,
  world: (x: number, y: number) => { x: number; y: number },
  connectComposer?: (source: string, port: OutputPort) => void,
) {
  const connecting = ref(''),
    selectedEdge = ref(''),
    arranging = ref(false)
  const pointer = reactive({ x: 0, y: 0 })
  const connectingPort = ref<OutputPort>('right')
  const submitting = ref<string[]>([])
  let pointerId: number | undefined,
    arrangeFrame = 0
  let arrangement: Array<{ item: CanvasItem; x: number; y: number; toX: number; toY: number }> = []
  const validator = new Ajv({ allErrors: true, strict: false })
  const edges = computed(() => {
    const items = new Map(store.project.items.map((item) => [item.id, item]))
    return (store.project.edges || []).flatMap((edge) => {
      const source = items.get(edge.source),
        target = items.get(edge.target)
      if (!source || !target) return []
      const from = outputAnchor(source, edge.sourcePort),
        to = inputAnchor(target, edge.field, edge.targetPort)
      return [{ ...edge, path: curve(from, to, edge.sourcePort, edge.targetPort) }]
    })
  })
  const pendingPath = computed(() => {
    const item = store.project.items.find((item) => item.id === connecting.value)
    return item
      ? curve(
          outputAnchor(item, connectingPort.value),
          pointer,
          connectingPort.value,
          connectingPort.value === 'bottom' ? 'top' : 'left',
        )
      : ''
  })
  function fail(error: unknown) {
    store.error.value =
      error instanceof Error && error.message === 'REFERENCE_PURPOSE_PROMPT_REQUIRED'
        ? __t('apps.pictoria.references', '该步骤没有可接收用途说明的提示词字段。')
        : error instanceof Error
          ? error.message
          : '操作未完成'
  }
  function connect(
    sourceId: string,
    targetId: string,
    fieldName: string,
    checkpoint = true,
    sourcePort: OutputPort = 'bottom',
    targetPort: InputPort = 'top',
  ) {
    const source = store.project.items.find((item) => item.id === sourceId),
      target = store.project.items.find((item) => item.id === targetId)
    if (!source || !target || target.content.kind !== 'draft' || source.id === target.id)
      throw new Error('请连接素材或文字与待执行步骤的输入点')
    const field = target.content.step?.inputSchema.properties?.[fieldName]
    if (!field) throw new Error('这个输入字段不存在')
    const asset = isAssetField(field) || isAssetsField(field)
    if (asset && (source.content.kind !== 'asset' || !source.content.assetId))
      throw new Error('此输入需要素材')
    if (asset && !acceptsAsset(fieldName, source)) throw new Error('此素材的类型不符合输入要求')
    if (!asset && (field.type !== 'string' || field.enum || source.content.kind !== 'text'))
      throw new Error('文字便签可以连接提示词字段')
    const existing = (store.project.edges || []).filter(
      (edge) => edge.target === targetId && edge.field === fieldName && !edge.historical,
    )
    const refs = asset
      ? assetReferences(target, fieldName, store.project.items, store.project.edges || [])
      : []
    const bound = existing.find((edge) =>
      asset
        ? store.project.items.find((item) => item.id === edge.source)?.content.assetId ===
          source.content.assetId
        : edge.source === sourceId,
    )
    if (bound) {
      if (
        bound.source === sourceId &&
        bound.sourcePort === sourcePort &&
        bound.targetPort === targetPort
      )
        return
      if (checkpoint) store.checkpoint()
      Object.assign(bound, { source: sourceId, sourcePort, targetPort })
      return
    }
    if ((store.project.edges?.length ?? 0) >= 8000) throw new Error('连线已达到画布上限')
    if (
      isAssetsField(field) &&
      !refs.some((ref) => ref.assetId === source.content.assetId) &&
      refs.length >= (field.maxItems ?? 20)
    )
      throw new Error(`此输入最多引用 ${field.maxItems ?? 20} 份素材`)
    if (checkpoint) store.checkpoint()
    store.project.edges ||= []
    if (!isAssetsField(field))
      store.project.edges = store.project.edges.filter((edge) => !existing.includes(edge))
    target.content.inputs ||= {}
    if (!isAssetsField(field)) delete target.content.inputs[fieldName]
    else if (Array.isArray(target.content.inputs[fieldName]))
      target.content.inputs[fieldName] = (
        target.content.inputs[fieldName] as Array<{ assetId: string }>
      ).filter((ref) => ref.assetId !== source.content.assetId)
    if (asset) {
      if (!isAssetsField(field))
        target.content.referenceUses = target.content.referenceUses?.filter(
          (entry) => entry.field !== fieldName || entry.assetId === source.content.assetId,
        )
      target.content.inputOrder ||= {}
      target.content.inputOrder[fieldName] = isAssetsField(field)
        ? [...new Set([...refs.map((ref) => ref.assetId), source.content.assetId!])]
        : [source.content.assetId!]
    }
    store.project.edges.push({
      id: crypto.randomUUID(),
      source: sourceId,
      target: targetId,
      field: fieldName,
      sourcePort,
      targetPort,
    })
  }
  function disconnect(id: string) {
    const edge = store.project.edges?.find((item) => item.id === id)
    if (!edge) return
    if (edge.historical) {
      store.notice.value = '这条线记录实际执行来源；删除卡片可移除画布上的展示。'
      return
    }
    const target = store.project.items.find((item) => item.id === edge.target),
      source = store.project.items.find((item) => item.id === edge.source)
    if (target && source?.content.assetId) {
      removeReference(target, edge.field, source.content.assetId)
      return
    }
    store.checkpoint()
    store.project.edges = store.project.edges!.filter((item) => item.id !== id)
    selectedEdge.value = ''
  }
  function reorder(id: string, direction: number) {
    const all = store.project.edges || [],
      edge = all.find((item) => item.id === id)
    if (!edge || edge.historical) return
    const target = store.project.items.find((item) => item.id === edge.target),
      source = store.project.items.find((item) => item.id === edge.source)
    if (target && source?.content.assetId) {
      reorderReference(target, edge.field, source.content.assetId, direction)
      return
    }
    const indices = all.flatMap((item, index) =>
      item.target === edge.target && item.field === edge.field && !item.historical ? [index] : [],
    )
    const index = indices.indexOf(all.indexOf(edge)),
      other = indices[index + direction]
    if (other === undefined) return
    store.checkpoint()
    const current = indices[index]!
    ;[all[current], all[other]] = [all[other]!, all[current]!]
  }
  function removeReference(item: CanvasItem, field: string, assetId: string) {
    store.checkpoint()
    item.content.referenceUses = item.content.referenceUses?.filter(
      (entry) => entry.field !== field || entry.assetId !== assetId,
    )
    const inputs = item.content.inputs || {},
      value = inputs[field]
    if (Array.isArray(value)) inputs[field] = value.filter((ref) => ref?.assetId !== assetId)
    else if (
      value &&
      typeof value === 'object' &&
      (value as { assetId?: string }).assetId === assetId
    )
      delete inputs[field]
    store.project.edges = (store.project.edges || []).filter(
      (edge) =>
        edge.historical ||
        edge.target !== item.id ||
        edge.field !== field ||
        store.project.items.find((source) => source.id === edge.source)?.content.assetId !==
          assetId,
    )
    if (item.content.inputOrder?.[field])
      item.content.inputOrder[field] = item.content.inputOrder[field]!.filter(
        (id) => id !== assetId,
      )
    selectedEdge.value = ''
  }
  function reorderReference(item: CanvasItem, field: string, assetId: string, direction: number) {
    const order = assetReferences(item, field, store.project.items, store.project.edges || []).map(
        (ref) => ref.assetId,
      ),
      index = order.indexOf(assetId),
      other = index + direction
    if (index < 0 || other < 0 || other >= order.length) return
    store.checkpoint()
    ;[order[index], order[other]] = [order[other]!, order[index]!]
    item.content.inputOrder ||= {}
    item.content.inputOrder[field] = order
  }
  function begin(event: PointerEvent, id: string, port: OutputPort = 'right') {
    if (event.button !== 0) return
    event.preventDefault()
    connecting.value = id
    connectingPort.value = port
    pointerId = event.pointerId
    Object.assign(pointer, world(event.clientX, event.clientY))
  }
  function move(event: PointerEvent) {
    if (pointerId === event.pointerId && connecting.value)
      Object.assign(pointer, world(event.clientX, event.clientY))
  }
  function end(event: PointerEvent) {
    if (pointerId !== event.pointerId) return
    const source = connecting.value,
      port = connectingPort.value
    connecting.value = ''
    pointerId = undefined
    const element = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>('[data-link-target],[data-composer-link]')
    if (element && source) {
      try {
        if (element.hasAttribute('data-composer-link')) connectComposer?.(source, port)
        else
          connect(
            source,
            element.dataset.linkTarget!,
            element.dataset.linkField!,
            true,
            port,
            element.dataset.linkPort === 'top' ? 'top' : 'left',
          )
      } catch (error) {
        fail(error)
      }
    }
  }
  function cancel() {
    connecting.value = ''
    pointerId = undefined
  }
  function key(event: KeyboardEvent) {
    if (arranging.value && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z')
      finishArrangement()
    if (event.key === 'Escape') {
      cancel()
      selectedEdge.value = ''
    }
    if (
      !selectedEdge.value ||
      (event.target as HTMLElement)?.closest(
        'input,textarea,select,[contenteditable="true"],[role="dialog"],.canvas-panel,.creation-dock',
      )
    )
      return
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault()
      event.stopImmediatePropagation()
      disconnect(selectedEdge.value)
    }
  }
  function addDraft(
    step: Step,
    inputs: Record<string, unknown>,
    point: { x: number; y: number },
    connections: InputConnection[] = [],
  ) {
    if (store.project.items.length >= 2000) throw new Error('画布已满，请新建画布')
    store.checkpoint()
    const selected = [...store.activeItems.value]
    const defaults = Object.fromEntries(
      Object.entries(step.inputSchema.properties || {})
        .filter(([, schema]) => schema.default !== undefined)
        .map(([name, schema]) => [name, schema.default]),
    )
    const item: CanvasItem = {
      id: crypto.randomUUID(),
      ...point,
      content: {
        version: 1,
        kind: 'draft',
        width: 340,
        height: 120,
        name: step.name,
        step: JSON.parse(JSON.stringify(step)),
        inputs: JSON.parse(JSON.stringify({ ...defaults, ...inputs })),
      },
    }
    item.content.height = draftHeight(item)
    store.project.items.push(item)
    for (const [name, schema] of inputFields(item)) {
      const values = item.content.inputs?.[name]
      if (isAssetField(schema) || isAssetsField(schema)) {
        const refs = Array.isArray(values) ? values : values ? [values] : []
        const sources = refs.map((value) => {
          const id = referenceId(value)
          return (
            selected.find((source) => source.content.assetId === id && id) ||
            store.project.items.find((source) => source.content.assetId === id && id)
          )
        })
        item.content.inputOrder ||= {}
        const order = refs.flatMap((ref) => {
          const id = referenceId(ref)
          return id ? [id] : []
        })
        item.content.inputOrder[name] = order
        for (let index = 0; index < sources.length; index++) {
          const preferred = connections.find(
            (connection) =>
              connection.field === name &&
              store.project.items.find((source) => source.id === connection.source)?.content
                .assetId === order[index],
          )
          const source = preferred
            ? store.project.items.find((source) => source.id === preferred.source)
            : sources[index]
          if (source)
            connect(source.id, item.id, name, false, preferred?.sourcePort, preferred?.targetPort)
        }
        continue
      }
      const preferred = connections.find((connection) => connection.field === name)
      const textSources = preferred
        ? [store.project.items.find((source) => source.id === preferred.source)].filter(
            (source): source is CanvasItem => Boolean(source),
          )
        : selected
      for (const source of textSources) {
        if (
          source.content.kind === 'text' &&
          values === source.content.text &&
          schema.type === 'string' &&
          !schema.enum
        ) {
          connect(source.id, item.id, name, false, preferred?.sourcePort, preferred?.targetPort)
          break
        }
      }
    }
    store.selected.value = [item.id]
    return item
  }
  function resolveInputs(item: CanvasItem) {
    const inputs = JSON.parse(JSON.stringify(item.content.inputs || {})) as Record<string, unknown>
    for (const [field, schema] of inputFields(item)) {
      const refs = (store.project.edges || []).filter(
        (edge) => edge.target === item.id && edge.field === field && !edge.historical,
      )
      if (isAssetField(schema) || isAssetsField(schema)) {
        const fixed = inputs[field],
          entries = Array.isArray(fixed) ? fixed : fixed === undefined ? [] : [fixed]
        if (
          (isAssetsField(schema) && fixed !== undefined && !Array.isArray(fixed)) ||
          (isAssetField(schema) && Array.isArray(fixed)) ||
          entries.some(
            (entry) =>
              !entry ||
              typeof entry !== 'object' ||
              typeof (entry as { assetId?: string }).assetId !== 'string',
          )
        )
          throw new Error(`${schema.title || field}的素材引用格式不正确`)
        if (
          refs.some(
            (edge) =>
              !store.project.items.find((source) => source.id === edge.source)?.content.assetId,
          )
        )
          throw new Error('引用的画布素材已不存在')
        const values = assetReferences(
          item,
          field,
          store.project.items,
          store.project.edges || [],
        ).map((ref) => ({ assetId: ref.assetId }))
        if (values.length || inputs[field] !== undefined)
          inputs[field] = isAssetsField(schema) ? values : values[0]
        continue
      }
      if (!refs.length) continue
      const values = refs.map((edge) => {
        const source = store.project.items.find((candidate) => candidate.id === edge.source)
        if (!source) throw new Error('引用的画布内容已不存在')
        return source.content.text || ''
      })
      inputs[field] = values[0]
    }
    return inputs
  }
  async function submit(item: CanvasItem, preferredKey?: string): Promise<boolean> {
    if (!item.content.step || submitting.value.includes(item.id)) return false
    const current = store.steps.value.find(
      (step) => step.id === item.content.step!.id && step.available,
    )
    if (!current || current.revision !== item.content.step.revision) {
      store.error.value = '步骤配置已变化，请点卡片上的更新配置后再生成。'
      return false
    }
    try {
      const inputs = applyReferenceUses(
          current.inputSchema,
          resolveInputs(item),
          item.content.referenceUses,
        ),
        validate = validator.compile(current.inputSchema)
      if (item.content.continuation) {
        const start = videoStartField(current.inputSchema)
        const refs = start ? inputs[start] : undefined
        const frame = Array.isArray(refs) ? refs[0] : refs
        if (
          !frame ||
          typeof frame !== 'object' ||
          !('assetId' in frame) ||
          frame.assetId !== item.content.continuation.frame.assetId
        )
          throw new Error(__t('apps.pictoria.video', '接续起始帧已变化，请重新建立接续草稿'))
      }
      if (!validate(inputs)) {
        const problem = validate.errors?.[0]
        const name = String(
          problem?.params.missingProperty || problem?.instancePath.split('/')[1] || '',
        )
        const label =
          current.inputSchema.properties?.[name]?.title || name || __t('apps.pictoria.ui', '输入')
        const messages: Record<string, string> = {
          required: `请填写${label}`,
          minLength: `${label}不能为空`,
          minItems: `${label}至少需要 ${problem?.params.limit} 项`,
          maxItems: `${label}最多接受 ${problem?.params.limit} 项`,
          enum: `请重新选择${label}`,
          minimum: `${label}小于允许范围`,
          maximum: `${label}超出允许范围`,
        }
        throw new Error(messages[problem?.keyword || ''] || `${label}的格式不正确`)
      }
      const fingerprint = JSON.stringify([current.id, current.revision, inputs])
      if (item.content.request?.fingerprint !== fingerprint)
        item.content.request = {
          fingerprint,
          key: item.content.request ? crypto.randomUUID() : preferredKey || crypto.randomUUID(),
        }
      submitting.value.push(item.id)
      const accepted = await store.createRun(
        current,
        inputs,
        { x: item.x + item.content.width + 110, y: item.y },
        item.content.request.key,
        item.id,
      )
      if (!accepted) return false
      item.content.request = undefined
      return true
    } catch (error) {
      fail(error)
      return false
    } finally {
      submitting.value = submitting.value.filter((id) => id !== item.id)
    }
  }
  function refreshDraft(item: CanvasItem) {
    const step = store.steps.value.find((step) => step.id === item.content.step?.id)
    if (!step) return
    store.checkpoint()
    item.content.step = JSON.parse(JSON.stringify(step))
    item.content.height = draftHeight(item)
    item.content.inputs ||= {}
    for (const [field, schema] of Object.entries(step.inputSchema.properties || {}))
      if (item.content.inputs[field] === undefined && schema.default !== undefined)
        item.content.inputs[field] = schema.default
    for (const field of Object.keys(item.content.inputs || {}))
      if (!step.inputSchema.properties?.[field]) delete item.content.inputs![field]
    store.project.edges = (store.project.edges || []).filter(
      (edge) =>
        edge.target !== item.id ||
        edge.historical ||
        Boolean(step.inputSchema.properties?.[edge.field]),
    )
  }
  function organize() {
    finishArrangement()
    const items = store.activeItems.value.length ? store.activeItems.value : store.project.items
    if (!items.length) return
    store.checkpoint()
    arranging.value = true
    const start = new Map(items.map((item) => [item.id, { x: item.x, y: item.y }]))
    const ids = new Set(items.map((item) => item.id)),
      all = (store.project.edges || []).filter(
        (edge) => ids.has(edge.source) && ids.has(edge.target),
      )
    const adjacency = new Map(items.map((item) => [item.id, new Set<string>()]))
    for (const edge of all) {
      adjacency.get(edge.source)!.add(edge.target)
      adjacency.get(edge.target)!.add(edge.source)
    }
    const visited = new Set<string>(),
      isolated: CanvasItem[] = []
    let baseY = Math.min(...items.map((item) => item.y))
    const baseX = Math.min(...items.map((item) => item.x))
    for (const first of items) {
      if (visited.has(first.id)) continue
      if (!adjacency.get(first.id)?.size) {
        isolated.push(first)
        visited.add(first.id)
        continue
      }
      const component: string[] = [],
        pending = [first.id]
      while (pending.length) {
        const id = pending.pop()!
        if (visited.has(id)) continue
        visited.add(id)
        component.push(id)
        pending.push(...adjacency.get(id)!)
      }
      const levels = new Map(component.map((id) => [id, 0])),
        indegree = new Map(component.map((id) => [id, 0]))
      for (const edge of all)
        if (indegree.has(edge.target) && indegree.has(edge.source))
          indegree.set(edge.target, indegree.get(edge.target)! + 1)
      const queue = component.filter((id) => !indegree.get(id))
      for (let index = 0; index < queue.length; index++)
        for (const edge of all.filter(
          (edge) => edge.source === queue[index] && indegree.has(edge.target),
        )) {
          levels.set(edge.target, Math.max(levels.get(edge.target)!, levels.get(edge.source)! + 1))
          indegree.set(edge.target, indegree.get(edge.target)! - 1)
          if (!indegree.get(edge.target)) queue.push(edge.target)
        }
      let x = baseX,
        height = 0
      for (const level of [...new Set(levels.values())].sort((a, b) => a - b)) {
        const column = items
          .filter((item) => component.includes(item.id) && levels.get(item.id) === level)
          .sort((a, b) => a.y - b.y)
        let y = baseY
        for (const item of column) {
          item.x = x
          item.y = y
          y += item.content.height + 48
        }
        height = Math.max(height, y - baseY)
        x += Math.max(...column.map((item) => item.content.width)) + 110
      }
      baseY += height + 72
    }
    const sorted = isolated.sort((a, b) => a.content.kind.localeCompare(b.content.kind))
    let rowY = baseY
    for (let i = 0; i < sorted.length; i += 3) {
      const row = sorted.slice(i, i + 3)
      let x = baseX
      for (const item of row) {
        item.x = x
        item.y = rowY
        x += item.content.width + 48
      }
      rowY += Math.max(...row.map((item) => item.content.height)) + 48
    }
    arrangement = items.map((item) => ({ item, ...start.get(item.id)!, toX: item.x, toY: item.y }))
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      finishArrangement()
      return
    }
    for (const entry of arrangement) {
      entry.item.x = entry.x
      entry.item.y = entry.y
    }
    const started = performance.now()
    const animate = (now: number) => {
      const progress = Math.min(1, (now - started) / 420),
        eased = 1 - (1 - progress) ** 3
      for (const entry of arrangement) {
        entry.item.x = entry.x + (entry.toX - entry.x) * eased
        entry.item.y = entry.y + (entry.toY - entry.y) * eased
      }
      if (progress < 1) arrangeFrame = requestAnimationFrame(animate)
      else finishArrangement()
    }
    arrangeFrame = requestAnimationFrame(animate)
  }
  function finishArrangement() {
    cancelAnimationFrame(arrangeFrame)
    arrangeFrame = 0
    for (const entry of arrangement) {
      entry.item.x = entry.toX
      entry.item.y = entry.toY
    }
    arrangement = []
    arranging.value = false
  }
  watch(
    () => store.project.id,
    () => {
      cancel()
      finishArrangement()
      selectedEdge.value = ''
    },
  )
  watch(
    () => store.project.items,
    () => finishArrangement(),
  )
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', end)
  window.addEventListener('pointercancel', cancel)
  window.addEventListener('blur', cancel)
  window.addEventListener('keydown', key, true)
  onBeforeUnmount(() => {
    finishArrangement()
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', end)
    window.removeEventListener('pointercancel', cancel)
    window.removeEventListener('blur', cancel)
    window.removeEventListener('keydown', key, true)
  })
  return {
    connecting,
    selectedEdge,
    pendingPath,
    edges,
    arranging,
    submitting,
    begin,
    connect,
    disconnect,
    reorder,
    removeReference,
    reorderReference,
    addDraft,
    resolveInputs,
    submit,
    refreshDraft,
    organize,
    finishArrangement,
  }
}
