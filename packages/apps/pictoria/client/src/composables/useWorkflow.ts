import { t as __t } from '../i18n'
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch, type Ref } from 'vue'
import type { CanvasItem, Run, Step } from '../types'
import type { Binding, WorkflowDraft, WorkflowIssue, WorkflowNode } from '../workflowTypes'
import { withoutSource } from '../workflowTypes'
import { pictoria } from '../services/transport'
import { createWorkflowExample } from '../services/workflowExample'
import {
  assertClipboardOwner,
  clipboardContext,
  type NodeClipboard,
} from '../services/nodeClipboard'

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const schema = () => ({ type: 'object', properties: {}, required: [], additionalProperties: false })
const executionStamp = (
  value: Pick<WorkflowDraft, 'inputSchema' | 'outputSchema' | 'outputs'> & {
    nodes: Array<Pick<WorkflowNode, 'id' | 'stepId' | 'stepRevision' | 'inputs'>>
  },
) =>
  JSON.stringify([
    value.inputSchema,
    value.outputSchema,
    value.nodes.map((node) => [node.id, node.stepId, node.stepRevision, node.inputs]),
    value.outputs,
  ])
async function testProject(id: string) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id))
  return `wf-test_${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}
const blank = (): WorkflowDraft => ({
  id: crypto.randomUUID(),
  name: '未命名工作流',
  revision: 0,
  usageDescription: '',
  inputSchema: schema(),
  outputSchema: schema(),
  nodes: [],
  notes: [],
  outputs: {},
  io: { input: { x: 20, y: -320 }, output: { x: 20, y: 700 } },
  routes: {},
})
export function useWorkflow(owner: Ref<string>) {
  const doc = reactive<WorkflowDraft>(blank()),
    list = ref<WorkflowDraft[]>([]),
    steps = ref<Step[]>([]),
    versions = reactive<Record<string, Step>>({})
  const selected = ref<string[]>([]),
    history = ref<string[]>([]),
    future = ref<string[]>([]),
    issues = ref<WorkflowIssue[]>([])
  const dirty = ref(false),
    saving = ref(false),
    busy = ref(false),
    blocked = ref(false),
    error = ref(''),
    notice = ref(''),
    loaded = ref(false)
  const run = ref<Run>(),
    releases = ref<Array<{ revision: number; name: string; createdAt?: string }>>([])
  const runDefinition = ref(''),
    runStale = computed(() => Boolean(run.value && runDefinition.value !== executionStamp(doc)))
  let context = 0,
    disposed = false,
    restoring = false,
    saved = '',
    polling = false,
    activeSave: Promise<boolean> | undefined
  let paused = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let draftTimer: ReturnType<typeof setTimeout> | undefined
  function autoSave() {
    if (!dirty.value || blocked.value || disposed || paused) return
    if (busy.value) {
      timer = setTimeout(autoSave, 500)
      return
    }
    void save()
  }
  const definition = () =>
    clone({
      id: doc.id,
      name: doc.name,
      usageDescription: doc.usageDescription,
      inputSchema: doc.inputSchema,
      outputSchema: doc.outputSchema,
      nodes: doc.nodes,
      notes: doc.notes,
      outputs: doc.outputs,
      viewport: doc.viewport,
      io: doc.io,
      routes: doc.routes,
      testInputs: doc.testInputs ?? {},
    })
  const stamp = () => JSON.stringify(definition())
  const localKey = (agent = owner.value) => `pictoria.workflow.${agent}.${doc.id}`
  function remember(agent = owner.value) {
    if (!agent || !loaded.value) return
    try {
      localStorage.setItem(
        localKey(agent),
        JSON.stringify({ definition: definition(), revision: doc.revision, dirty: dirty.value }),
      )
    } catch {
      error.value = '本地草稿保存失败，请保存或导出'
    }
  }
  function checkpoint() {
    history.value.push(stamp())
    if (history.value.length > 60) history.value.shift()
    future.value = []
  }
  function applyDefinition(value: Partial<WorkflowDraft>) {
    Object.assign(doc, value)
    selected.value = selected.value.filter(
      (id) =>
        doc.nodes.some((node) => node.id === id) ||
        doc.notes.some((note) => `__note:${note.id}` === id) ||
        ['__input', '__output'].includes(id),
    )
  }
  function undo() {
    const previous = history.value.pop()
    if (!previous) return
    future.value.push(stamp())
    applyDefinition(JSON.parse(previous))
  }
  function redo() {
    const next = future.value.pop()
    if (!next) return
    history.value.push(stamp())
    applyDefinition(JSON.parse(next))
  }
  const stepFor = (node?: WorkflowNode): Step | undefined =>
    !node
      ? undefined
      : node.stepId
        ? versions[`${node.stepId}:${node.stepRevision}`] ||
          steps.value.find((step) => step.id === node.stepId && step.revision === node.stepRevision)
        : node.example
          ? {
              ...node.example,
              id: `example:${node.id}`,
              revision: 0,
              available: false,
              reason: '示例步骤未配置',
              implementation: { kind: node.example.kind },
            }
          : undefined
  const examplePending = computed(() => doc.nodes.some((node) => !node.stepId && node.example))
  function noteAnchor(id?: string) {
    return id === '__input'
      ? doc.io.input
      : id === '__output'
        ? doc.io.output
        : doc.nodes.find((node) => node.id === id) || { x: 0, y: 0 }
  }
  const nodeHeight = (node: WorkflowNode) =>
    85 +
    Math.max(
      Object.keys(stepFor(node)?.inputSchema.properties || {}).length,
      Object.keys(stepFor(node)?.outputSchema?.properties || {}).length,
      1,
    ) *
      34
  const items = computed<CanvasItem[]>(() => [
    ...doc.nodes.map(
      (node): CanvasItem => ({
        id: node.id,
        get x() {
          return node.x
        },
        set x(value) {
          node.x = value
        },
        get y() {
          return node.y
        },
        set y(value) {
          node.y = value
        },
        content: {
          version: 1,
          kind: 'draft',
          width: 280,
          height: nodeHeight(node),
          name: node.label || stepFor(node)?.name,
          comment: node.comment,
        },
      }),
    ),
    ...(['input', 'output'] as const).map(
      (kind): CanvasItem => ({
        id: `__${kind}`,
        get x() {
          return doc.io[kind].x
        },
        set x(value) {
          doc.io[kind].x = value
        },
        get y() {
          return doc.io[kind].y
        },
        set y(value) {
          doc.io[kind].y = value
        },
        content: {
          version: 1,
          kind: 'draft',
          width: 240,
          height: 85 + Math.max(1, Object.keys(doc[`${kind}Schema`].properties || {}).length) * 34,
          name: kind === 'input' ? '输入' : '输出',
        },
      }),
    ),
    ...doc.notes.map(
      (note): CanvasItem => ({
        id: `__note:${note.id}`,
        get x() {
          return note.x + noteAnchor(note.anchor).x
        },
        set x(value) {
          note.x = value - noteAnchor(note.anchor).x
        },
        get y() {
          return note.y + noteAnchor(note.anchor).y
        },
        set y(value) {
          note.y = value - noteAnchor(note.anchor).y
        },
        content: {
          version: 1,
          kind: 'text',
          width: note.anchor ? 300 : 380,
          height: Math.max(
            130,
            Math.min(
              360,
              58 +
                note.text
                  .split('\n')
                  .reduce(
                    (lines, line) =>
                      lines + Math.max(1, Math.ceil(line.length / (note.anchor ? 20 : 26))),
                    0,
                  ) *
                  23,
            ),
          ),
          name: note.title,
          text: note.text,
        },
      }),
    ),
  ])
  const activeItems = computed(() => items.value.filter((item) => selected.value.includes(item.id)))
  async function hydrate() {
    const generation = context,
      agent = owner.value
    for (const node of doc.nodes) {
      const key = `${node.stepId}:${node.stepRevision}`
      if (!node.stepId || !node.stepRevision || versions[key]) continue
      try {
        const step = await pictoria.operation<Step>(agent, 'step.version', {
          id: node.stepId,
          revision: node.stepRevision,
        })
        if (!disposed && context === generation) versions[key] = step
      } catch {
        /* 已移除的步骤由校验面板定位，保留草稿。 */
      }
    }
  }
  async function refreshSteps() {
    const generation = context,
      agent = owner.value
    const result = await pictoria.operation<{ steps: Step[] }>(agent, 'catalog.get')
    if (disposed || generation !== context) return
    steps.value = result.steps
    for (const step of result.steps) versions[`${step.id}:${step.revision}`] = step
    await hydrate()
  }
  async function save(): Promise<boolean> {
    if (activeSave) {
      await activeSave
      return !dirty.value || save()
    }
    if (blocked.value || !owner.value) return false
    if (!dirty.value && doc.revision > 0) return true
    const generation = context,
      agent = owner.value,
      payload = definition(),
      original = JSON.stringify(payload),
      revision = doc.revision
    saving.value = true
    activeSave = (async () => {
      try {
        const result = await pictoria.operation<WorkflowDraft>(agent, 'workflow.draft.save', {
          definition: payload,
          expectedRevision: revision,
        })
        if (disposed || generation !== context || doc.id !== result.id) return false
        doc.revision = result.revision
        saved = original
        dirty.value = stamp() !== saved
        error.value = ''
        list.value = [clone(doc), ...list.value.filter((flow) => flow.id !== doc.id)]
        remember()
        return true
      } catch (failure) {
        if (!disposed && generation === context) {
          error.value = failure instanceof Error ? failure.message : '保存失败'
          blocked.value = true
          remember()
        }
        return false
      } finally {
        if (!disposed && generation === context) saving.value = false
      }
    })()
    try {
      return await activeSave
    } finally {
      activeSave = undefined
      if (!disposed && !paused && dirty.value && !blocked.value) {
        clearTimeout(timer)
        timer = setTimeout(autoSave, 1000)
      }
    }
  }
  function load(value: WorkflowDraft) {
    clearTimeout(draftTimer)
    clearTimeout(timer)
    runDefinition.value = ''
    restoring = true
    applyDefinition({
      ...blank(),
      testInputs: {},
      viewport: undefined,
      publishedRevision: undefined,
      publishedStepRevision: undefined,
      updatedAt: undefined,
      ...clone(value),
    })
    history.value = []
    future.value = []
    issues.value = []
    run.value = undefined
    releases.value = []
    blocked.value = false
    error.value = ''
    notice.value = ''
    saved = stamp()
    dirty.value = false
    try {
      const local = JSON.parse(localStorage.getItem(localKey()) || 'null') as {
        definition: WorkflowDraft
        revision: number
        dirty: boolean
      } | null
      if (local?.dirty && local.definition?.id === doc.id) {
        applyDefinition(local.definition)
        doc.revision = local.revision
        dirty.value = true
        if (local.revision !== value.revision) {
          blocked.value = true
          error.value = '另处已更新，请另存副本'
        }
      }
    } catch {
      /* 损坏的本地缓存不覆盖远端工作流。 */
    }
    loaded.value = true
    void nextTick(() => {
      restoring = false
    })
    void hydrate()
    void restoreRun()
    if (dirty.value && !blocked.value) {
      clearTimeout(timer)
      timer = setTimeout(autoSave, 1000)
    }
  }
  async function open(id: string) {
    if (busy.value || (dirty.value && !(await save()))) return false
    busy.value = true
    const generation = context,
      agent = owner.value
    try {
      const value = await pictoria.operation<WorkflowDraft>(agent, 'workflow.draft.get', { id })
      if (!disposed && generation === context) {
        context++
        load(value)
        return true
      }
    } catch (failure) {
      error.value = failure instanceof Error ? failure.message : '打开失败'
    } finally {
      busy.value = false
    }
    return false
  }
  async function create(copy = false) {
    if (busy.value || (!copy && dirty.value && !(await save()))) return false
    const value = copy
      ? {
          ...clone(doc),
          id: crypto.randomUUID(),
          name: `${doc.name} 副本`,
          revision: 0,
          publishedRevision: undefined,
          publishedStepRevision: undefined,
        }
      : blank()
    context++
    load(value)
    dirty.value = true
    await save()
    return true
  }
  async function createExample() {
    return importDraft(createWorkflowExample(), true)
  }
  async function connect() {
    if (!owner.value) return
    const generation = ++context,
      agent = owner.value
    loaded.value = false
    busy.value = true
    try {
      const [flows, catalog] = await Promise.all([
        pictoria.operation<WorkflowDraft[]>(agent, 'workflow.draft.list'),
        pictoria.operation<{ steps: Step[] }>(agent, 'catalog.get'),
      ])
      if (disposed || generation !== context) return
      list.value = flows
      steps.value = catalog.steps
      for (const step of catalog.steps) versions[`${step.id}:${step.revision}`] = step
      const last = localStorage.getItem(`pictoria.workflow.last.${agent}`)
      let local: { definition?: WorkflowDraft } | undefined
      try {
        local = last
          ? JSON.parse(localStorage.getItem(`pictoria.workflow.${agent}.${last}`) || 'null')
          : undefined
      } catch {
        /* 损坏草稿保留远端列表。 */
      }
      load(
        flows.find((flow) => flow.id === last) ||
          (local?.definition?.id === last && Array.isArray(local.definition.nodes)
            ? { ...blank(), ...local.definition, revision: 0 }
            : flows[0]) ||
          blank(),
      )
    } catch (failure) {
      if (!disposed && generation === context)
        error.value = failure instanceof Error ? failure.message : '连接失败'
    } finally {
      if (!disposed && generation === context) busy.value = false
    }
  }
  function add(
    step: Step,
    x = 0,
    y = Math.max(-120, ...doc.nodes.map((node) => node.y + nodeHeight(node))) + 120,
  ) {
    if (doc.nodes.length >= 64) {
      error.value = '最多 64 个节点'
      return
    }
    checkpoint()
    const inputs: Record<string, Binding> = {}
    for (const [name, field] of Object.entries(step.inputSchema.properties || {}))
      if (field.default !== undefined) inputs[name] = { literal: field.default }
    const node: WorkflowNode = {
      id: crypto.randomUUID(),
      stepId: step.id,
      stepRevision: step.revision,
      inputs,
      x,
      y,
      comment: '',
    }
    doc.nodes.push(node)
    selected.value = [node.id]
  }
  function removeSelection() {
    if (!selected.value.length) return
    checkpoint()
    const ids = [...selected.value]
    for (const note of doc.notes)
      if (
        note.anchor &&
        ids.includes(note.anchor) &&
        doc.nodes.some((node) => node.id === note.anchor)
      ) {
        const anchor = noteAnchor(note.anchor)
        note.x += anchor.x
        note.y += anchor.y
        delete note.anchor
      }
    doc.notes = doc.notes.filter((note) => !ids.includes(`__note:${note.id}`))
    doc.nodes = doc.nodes.filter((node) => !ids.includes(node.id))
    for (const id of ids)
      for (const bindings of [doc.outputs, ...doc.nodes.map((node) => node.inputs)])
        for (const [field, binding] of Object.entries(bindings)) {
          const next = withoutSource(binding, id)
          if (next) bindings[field] = next
          else delete bindings[field]
        }
    selected.value = []
    // 删除立即写入本地草稿，避免关闭页面时仍保留删除前的节点。
    dirty.value = true
    clearTimeout(draftTimer)
    remember()
  }
  function duplicate() {
    const value = copyNodes()
    if (!value || value.kind !== 'workflow') return
    const positions = [...value.nodes, ...value.notes.filter((note) => !note.anchor)]
    try {
      pasteNodes(value, {
        x: Math.min(...positions.map((item) => item.x)) + 36,
        y: Math.min(...positions.map((item) => item.y)) + 36,
      })
    } catch (failure) {
      error.value = failure instanceof Error ? failure.message : '无法创建副本'
    }
  }
  function copyNodes(): NodeClipboard | undefined {
    const nodes = doc.nodes.filter((node) => selected.value.includes(node.id)),
      ids = new Set(nodes.map((node) => node.id))
    const notes = doc.notes
      .filter(
        (note) =>
          (note.anchor && ids.has(note.anchor)) || selected.value.includes(`__note:${note.id}`),
      )
      .map((note) => {
        const copy = clone(note)
        if (copy.anchor && !ids.has(copy.anchor)) {
          const point = noteAnchor(copy.anchor)
          copy.x += point.x
          copy.y += point.y
          delete copy.anchor
        }
        return copy
      })
    if (!nodes.length && !notes.length) {
      if (selected.value.length) notice.value = '输入与输出接口保持唯一'
      return
    }
    const routes = Object.fromEntries(
      Object.entries(doc.routes).filter(([key]) => {
        try {
          return ids.has(JSON.parse(key)[0])
        } catch {
          return false
        }
      }),
    )
    return clone({
      ...clipboardContext(owner.value, doc.id),
      kind: 'workflow' as const,
      nodes,
      notes,
      routes,
    })
  }
  function pasteNodes(value: NodeClipboard, point: { x: number; y: number }) {
    assertClipboardOwner(value, owner.value)
    if (value.kind !== 'workflow') throw new Error('请在画布中粘贴这些节点')
    if (!value.nodes.length && !value.notes.length) return
    if (doc.nodes.length + value.nodes.length > 64 || doc.notes.length + value.notes.length > 128)
      throw new Error('工作流最多 64 个节点、128 张备注')
    const source = clone(value),
      ids = new Map(source.nodes.map((node) => [node.id, crypto.randomUUID()]))
    const positions = [...source.nodes, ...source.notes.filter((note) => !note.anchor)]
    if (!positions.length) throw new Error('节点位置无效')
    const dx = point.x - Math.min(...positions.map((item) => item.x)),
      dy = point.y - Math.min(...positions.map((item) => item.y))
    const routes: WorkflowDraft['routes'] = {},
      sameDocument = value.source === doc.id
    let removed = false
    function remap(
      binding: Binding,
      target: string,
      field: string,
      oldTrail: Array<string | number> = [],
      trail: Array<string | number> = [],
    ): Binding | undefined {
      if ('array' in binding) {
        const array: Binding[] = []
        binding.array.forEach((entry, index) => {
          const next = remap(
            entry,
            target,
            field,
            [...oldTrail, 'array', index],
            [...trail, 'array', array.length],
          )
          if (next) array.push(next)
        })
        return { ...binding, array }
      }
      if ('select' in binding) {
        const next = remap(
          binding.select,
          target,
          field,
          [...oldTrail, 'select'],
          [...trail, 'select'],
        )
        return next ? { ...binding, select: next } : undefined
      }
      if ('literal' in binding) return binding
      const oldSource = 'node' in binding ? binding.node : '__input',
        output = 'node' in binding ? binding.output : binding.input
      const newSource =
        ids.get(oldSource) ||
        (sameDocument &&
        (oldSource === '__input'
          ? Boolean(doc.inputSchema.properties?.[output])
          : doc.nodes.some((node) => node.id === oldSource))
          ? oldSource
          : undefined)
      if (!newSource) {
        removed = true
        return undefined
      }
      const route = source.routes[JSON.stringify([target, field, oldSource, output, oldTrail])]
      if (
        route &&
        ['right', 'bottom'].includes(route.sourcePort) &&
        ['left', 'top'].includes(route.targetPort)
      )
        routes[JSON.stringify([ids.get(target), field, newSource, output, trail])] = route
      return 'node' in binding ? { ...binding, node: newSource } : binding
    }
    const copies = source.nodes.map((node) => ({
      ...node,
      id: ids.get(node.id)!,
      x: node.x + dx,
      y: node.y + dy,
      inputs: Object.fromEntries(
        Object.entries(node.inputs).flatMap(([field, binding]) => {
          const next = remap(binding, node.id, field)
          return next ? [[field, next]] : []
        }),
      ),
    }))
    const notes = source.notes.map((note) => ({
      ...note,
      id: crypto.randomUUID(),
      anchor: note.anchor ? ids.get(note.anchor) : undefined,
      x: note.x + (note.anchor && ids.has(note.anchor) ? 0 : dx),
      y: note.y + (note.anchor && ids.has(note.anchor) ? 0 : dy),
    }))
    checkpoint()
    doc.nodes.push(...copies)
    doc.notes.push(...notes)
    Object.assign(doc.routes, routes)
    selected.value = [
      ...copies.map((node) => node.id),
      ...notes.filter((note) => !note.anchor).map((note) => `__note:${note.id}`),
    ]
    notice.value = removed ? '已粘贴，外部连线已断开' : '已粘贴'
    void hydrate()
  }
  async function check() {
    const generation = context,
      agent = owner.value,
      payload = definition(),
      original = stamp()
    const result = await pictoria.operation<{
      valid: boolean
      issues: WorkflowIssue[]
      definition?: Record<string, unknown>
    }>(agent, 'workflow.validate', { definition: payload })
    if (disposed || generation !== context || original !== stamp()) return undefined
    issues.value = result.issues
    notice.value = result.valid ? '校验通过' : ''
    return result
  }
  async function action(kind: 'check' | 'publish' | 'run', inputs: Record<string, unknown> = {}) {
    if (busy.value) return
    busy.value = true
    error.value = ''
    notice.value = ''
    const generation = context,
      agent = owner.value
    try {
      const original = stamp(),
        checked = await check()
      if (!checked?.valid || !checked.definition) return
      if (kind === 'check') return
      if (!(await save()) || dirty.value || disposed || generation !== context) return
      if (stamp() !== original) throw new Error('内容已变化，请重试')
      if (kind === 'publish') {
        const result = await pictoria.operation<{ draft: WorkflowDraft; step: Step }>(
          agent,
          'workflow.draft.publish',
          { id: doc.id, expectedRevision: doc.revision },
        )
        if (disposed || generation !== context) return
        doc.revision = result.draft.revision
        doc.publishedRevision = result.draft.publishedRevision
        doc.publishedStepRevision = result.step.revision
        notice.value = '已发布'
        await refreshSteps()
      } else {
        const input = {
            definition: checked.definition,
            inputs: clone(inputs),
            projectId: await testProject(doc.id),
          },
          fingerprint = JSON.stringify(input),
          keyName = `pictoria.workflow.request.${agent}.${doc.id}`
        if (disposed || generation !== context || stamp() !== original) return
        let request: { fingerprint: string; key: string; taskId?: string } | undefined
        try {
          request = JSON.parse(localStorage.getItem(keyName) || 'null')
        } catch {
          throw new Error('请求记录损坏，请先核验已有任务')
        }
        if (
          request?.fingerprint !== fingerprint ||
          (request?.taskId &&
            run.value?.id === request.taskId &&
            ['completed', 'partial', 'failed', 'cancelled'].includes(run.value.state))
        )
          request = { fingerprint, key: crypto.randomUUID() }
        if (!request || !/^[0-9a-f-]{36}$/i.test(request.key))
          throw new Error('请求记录无效，请先核验已有任务')
        localStorage.setItem(keyName, JSON.stringify(request))
        const accepted = await pictoria.run(agent, input, request!.key)
        if (disposed || generation !== context) return
        run.value = {
          id: accepted.taskId,
          projectId: accepted.projectId,
          state: 'queued',
          name: doc.name,
          nodes: [],
          inputs: input.inputs,
        }
        runDefinition.value = executionStamp(checked.definition as unknown as WorkflowDraft)
        try {
          localStorage.setItem(keyName, JSON.stringify({ ...request, taskId: accepted.taskId }))
        } catch {
          error.value = '任务已提交，本地回执保存失败'
        }
        notice.value = '已提交'
        try {
          const detail = await pictoria.task(agent, accepted.taskId)
          if (!disposed && generation === context && detail) run.value = detail
        } catch {
          /* 已接受的任务保留占位，详情由后续查询补齐。 */
        }
      }
    } catch (failure) {
      if (!disposed && generation === context)
        error.value = failure instanceof Error ? failure.message : '操作失败'
    } finally {
      if (!disposed && generation === context) busy.value = false
    }
  }
  async function restoreRun() {
    const generation = context,
      agent = owner.value,
      id = doc.id
    try {
      const projectId = await testProject(id),
        rows = await pictoria.operation<Run[]>(agent, 'task.list')
      if (!disposed && generation === context && !run.value) {
        run.value = rows.find((value) => value.projectId === projectId)
        try {
          const request = JSON.parse(
            localStorage.getItem(`pictoria.workflow.request.${agent}.${id}`) || 'null',
          )
          if (run.value && request?.taskId === run.value.id)
            runDefinition.value = executionStamp(JSON.parse(request.fingerprint).definition)
        } catch {
          /* 无对应快照的旧结果不标记当前节点已执行。 */
        }
      }
    } catch {
      /* 断线时保留任务，稍后继续查询。 */
    }
  }
  async function poll() {
    if (polling || paused || disposed || document.hidden || !run.value || !owner.value) return
    const generation = context,
      agent = owner.value,
      id = run.value.id
    polling = true
    try {
      const result = await pictoria.task(agent, id)
      if (!disposed && !paused && generation === context && result) run.value = result
    } catch {
      /* 查询失败不改变后台任务状态。 */
    } finally {
      polling = false
    }
  }
  async function historyList() {
    const generation = context,
      agent = owner.value
    const values = await pictoria.operation<
      Array<{ revision: number; name: string; createdAt?: string }>
    >(agent, 'workflow.history', { id: doc.id })
    if (!disposed && generation === context) releases.value = values
  }
  async function restore(revision: number) {
    if (busy.value || (dirty.value && !(await save()))) return
    busy.value = true
    const generation = context,
      agent = owner.value
    try {
      const value = await pictoria.operation<WorkflowDraft>(agent, 'workflow.draft.restore', {
        id: doc.id,
        expectedRevision: doc.revision,
        publishedRevision: revision,
      })
      if (disposed || generation !== context) return
      context++
      localStorage.removeItem(localKey())
      load(value)
      notice.value = '已恢复草稿'
    } catch (failure) {
      error.value = failure instanceof Error ? failure.message : '恢复失败'
    } finally {
      busy.value = false
    }
  }
  async function removeFlow() {
    if (busy.value) return
    if (activeSave) await activeSave
    busy.value = true
    const generation = context,
      agent = owner.value
    try {
      if (doc.revision)
        await pictoria.operation(agent, 'workflow.draft.delete', {
          id: doc.id,
          expectedRevision: doc.revision,
        })
      if (disposed || generation !== context) return
      localStorage.removeItem(localKey())
      list.value = list.value.filter((flow) => flow.id !== doc.id)
      context++
      load(blank())
    } catch (failure) {
      error.value = failure instanceof Error ? failure.message : '删除失败'
    } finally {
      busy.value = false
    }
  }
  function exportDraft() {
    const url = URL.createObjectURL(
        new Blob([JSON.stringify(definition(), null, 2)], { type: 'application/json' }),
      ),
      anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${doc.name}.json`
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  async function importDraft(raw: unknown, example = false) {
    if (busy.value || (dirty.value && !(await save()))) return false
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      error.value = '工作流格式无效'
      return false
    }
    busy.value = true
    const generation = context,
      agent = owner.value
    try {
      const {
        revision: _revision,
        published: _published,
        publishedRevision: _publishedRevision,
        publishedStepRevision: _stepRevision,
        updatedAt: _updatedAt,
        ...data
      } = raw as Record<string, unknown>
      const value = await pictoria.operation<WorkflowDraft>(agent, 'workflow.draft.save', {
        definition: { ...data, id: crypto.randomUUID() },
        expectedRevision: 0,
      })
      if (disposed || generation !== context) return false
      context++
      load(value)
      list.value = [value, ...list.value]
      notice.value = example ? '已创建示例' : '已导入'
      return true
    } catch (failure) {
      if (!disposed && generation === context)
        error.value = failure instanceof Error ? failure.message : '导入失败'
      return false
    } finally {
      if (!disposed) busy.value = false
    }
  }
  async function retrySave() {
    blocked.value = false
    return save()
  }
  function setPaused(value: boolean) {
    paused = value
    clearTimeout(timer)
    if (!value && !disposed) {
      if (dirty.value && !blocked.value) timer = setTimeout(autoSave, 1000)
      void poll()
    }
  }
  // 拖动按帧更新，草稿延迟落盘，避免连续同步写入阻塞画布。
  const contentWatcher = watch(
    () => [
      doc.name,
      doc.usageDescription,
      doc.inputSchema,
      doc.outputSchema,
      doc.nodes,
      doc.notes,
      doc.outputs,
      doc.io,
      doc.routes,
      doc.viewport,
      doc.testInputs,
    ],
    () => {
      if (restoring || disposed || !loaded.value) return
      dirty.value = true
      if (issues.value.length) issues.value = []
      clearTimeout(draftTimer)
      draftTimer = setTimeout(() => remember(), 300)
      clearTimeout(timer)
      if (!paused && !blocked.value) timer = setTimeout(autoSave, 1000)
    },
    { deep: true, flush: 'post' },
  )
  let interacting = false
  function beginInteraction(): void {
    if (interacting) return
    interacting = true
    contentWatcher.pause()
    dirty.value = true
    clearTimeout(timer)
  }
  function endInteraction(): void {
    if (!interacting) return
    interacting = false
    contentWatcher.resume()
  }
  watch(
    () => doc.id,
    (id) => {
      if (owner.value) localStorage.setItem(`pictoria.workflow.last.${owner.value}`, id)
    },
  )
  watch(
    owner,
    (_next, previous) => {
      if (previous) remember(previous)
      clearTimeout(timer)
      clearTimeout(draftTimer)
      selected.value = []
      for (const key of Object.keys(versions)) delete versions[key]
      void connect()
    },
    { immediate: true },
  )
  const interval = setInterval(() => void poll(), 2500)
  const refreshWhenVisible = () => {
    if (!document.hidden) void poll()
  }
  document.addEventListener('visibilitychange', refreshWhenVisible)
  onBeforeUnmount(() => {
    remember()
    disposed = true
    context++
    clearTimeout(timer)
    clearTimeout(draftTimer)
    clearInterval(interval)
    document.removeEventListener('visibilitychange', refreshWhenVisible)
  })
  function addNote(x: number, y: number) {
    if (doc.notes.length >= 128) {
      error.value = '最多 128 张备注'
      return
    }
    checkpoint()
    const id = crypto.randomUUID()
    doc.notes.push({
      id,
      title: __t('apps.pictoria.ui', '备注'),
      text: '',
      x,
      y,
    })
    selected.value = [`__note:${id}`]
  }
  const navigationStore = {
    beginInteraction,
    endInteraction,
    project: {
      get items() {
        return items.value
      },
    },
    activeItems,
    selected,
    checkpoint,
    undo,
    redo,
    duplicate,
    removeSelection,
    addText: addNote,
    retrySave,
    movingItems: () =>
      items.value.filter(
        (item) =>
          selected.value.includes(item.id) ||
          doc.notes.some(
            (note) =>
              `__note:${note.id}` === item.id &&
              note.anchor &&
              selected.value.includes(note.anchor),
          ),
      ),
  }
  return {
    owner,
    doc,
    list,
    steps,
    versions,
    selected,
    activeItems,
    items,
    history,
    future,
    issues,
    dirty,
    saving,
    busy,
    blocked,
    error,
    notice,
    loaded,
    run,
    runStale,
    releases,
    examplePending,
    definition,
    stepFor,
    nodeHeight,
    checkpoint,
    undo,
    redo,
    add,
    addNote,
    removeSelection,
    duplicate,
    copyNodes,
    pasteNodes,
    save,
    retrySave,
    open,
    create,
    createExample,
    connect,
    refreshSteps,
    action,
    historyList,
    restore,
    removeFlow,
    exportDraft,
    importDraft,
    persistDraft: remember,
    navigationStore,
    setPaused,
  }
}
export type WorkflowStore = ReturnType<typeof useWorkflow>
