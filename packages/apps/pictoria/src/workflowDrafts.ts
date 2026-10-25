import { t as __t } from './i18n'
import { z } from 'zod'
import {
  bindingSchema,
  identifier,
  schemaObject,
  workflowSchema,
  type Step,
  type Workflow,
} from './domain'
import type { Store } from './store'
import { workflowIssues, type WorkflowIssue } from './workflowValidation'

const emptySchema = () => ({
  type: 'object',
  properties: {},
  required: [],
  additionalProperties: false,
})
export const workflowDraftSchema = z
  .object({
    id: identifier,
    name: z.string().trim().max(100).default(''),
    usageDescription: z.string().max(16000).default(''),
    inputSchema: schemaObject.default(emptySchema),
    outputSchema: schemaObject.default(emptySchema),
    nodes: z
      .array(
        z
          .object({
            id: identifier.refine(
              (value) => !['__input', '__output'].includes(value),
              '节点 ID 已保留',
            ),
            stepId: identifier.optional(),
            stepRevision: z.number().int().positive().optional(),
            inputs: z.record(z.string(), bindingSchema).default({}),
            x: z.number().finite().default(0),
            y: z.number().finite().default(0),
            comment: z.string().max(2000).default(''),
            label: z.string().max(100).optional(),
            example: z
              .object({
                name: z.string().min(1).max(100),
                kind: z.enum(['llm', 'service']),
                usageDescription: z.string().max(16000),
                inputSchema: schemaObject,
                outputSchema: schemaObject,
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .max(64)
      .default([]),
    notes: z
      .array(
        z
          .object({
            id: identifier,
            title: z.string().max(100),
            text: z.string().max(4000),
            x: z.number().finite(),
            y: z.number().finite(),
            anchor: z.string().max(128).optional(),
          })
          .strict(),
      )
      .max(128)
      .default([]),
    outputs: z.record(z.string(), bindingSchema).default({}),
    testInputs: z
      .record(z.string(), z.unknown())
      .refine((value) => JSON.stringify(value).length <= 128_000, '试运行参数超过大小限制')
      .optional(),
    io: z
      .object({
        input: z.object({ x: z.number().finite(), y: z.number().finite() }).strict(),
        output: z.object({ x: z.number().finite(), y: z.number().finite() }).strict(),
      })
      .strict()
      .default(() => ({ input: { x: -380, y: 0 }, output: { x: 650, y: 0 } })),
    routes: z
      .record(
        z.string(),
        z
          .object({ sourcePort: z.enum(['right', 'bottom']), targetPort: z.enum(['left', 'top']) })
          .strict(),
      )
      .default({})
      .refine((value) => Object.keys(value).length <= 2048, '连线过多'),
    viewport: z
      .object({
        x: z.number().finite(),
        y: z.number().finite(),
        scale: z.number().min(0.12).max(3),
      })
      .strict()
      .optional(),
  })
  .strict()
export type WorkflowDraft = z.infer<typeof workflowDraftSchema> & {
  revision: number
  publishedRevision?: number
  publishedStepRevision?: number
  updatedAt?: string
}

export function compileDraft(
  draft: z.infer<typeof workflowDraftSchema>,
  store: Store,
  owner: string,
): {
  valid: boolean
  issues: WorkflowIssue[]
  definition?: z.infer<typeof workflowSchema>
} {
  const issues: WorkflowIssue[] = []
  if (!draft.nodes.length)
    issues.push({
      code: 'empty',
      message: __t('apps.pictoria.ui', '添加一个节点'),
      severity: 'error',
    })
  for (const node of draft.nodes)
    if (!node.stepId || !node.stepRevision)
      issues.push({
        code: 'step',
        message: node.example
          ? __t('apps.pictoria.ui', '示例步骤未配置，请选择或新建步骤')
          : __t('apps.pictoria.ui', '选择步骤'),
        nodeId: node.id,
        severity: 'error',
      })
  if (issues.length) return { valid: false, issues }
  const parsed = workflowSchema.safeParse({
    id: draft.id,
    name: draft.name,
    usageDescription: draft.usageDescription,
    inputSchema: draft.inputSchema,
    outputSchema: draft.outputSchema,
    outputs: draft.outputs,
    nodes: draft.nodes.map(({ id, stepId, stepRevision, inputs }) => ({
      id,
      stepId,
      stepRevision,
      inputs,
    })),
  })
  if (!parsed.success)
    return {
      valid: false,
      issues: parsed.error.issues.map((issue) => ({
        code: 'definition',
        message: issue.message,
        field: issue.path.join('.'),
        severity: 'error' as const,
      })),
    }
  const definition = { ...parsed.data, revision: 1 }
  issues.push(...workflowIssues(definition, store, owner))
  return {
    valid: !issues.some((issue) => issue.severity === 'error'),
    issues,
    definition: parsed.data,
  }
}

/** 发布快照与步骤版本在同一事务内保存，编辑草稿不改变旧任务。 */
export function publishWorkflow(store: Store, owner: string, workflow: Workflow): Step {
  return store.transaction(() => {
    const publishedId = `${workflow.id}:${workflow.revision}`
    if (!store.get(owner, 'published', publishedId))
      store.put(
        owner,
        'published',
        { id: publishedId, snapshot: { ...workflow, published: true } },
        0,
      )
    const old = store.get<Step>(owner, 'step', workflow.id)
    if (
      old &&
      (old.implementation.kind !== 'workflow' || old.implementation.workflowId !== workflow.id)
    )
      throw new Error('工作流 ID 与步骤冲突')
    if (
      old?.enabled &&
      old.implementation.kind === 'workflow' &&
      old.implementation.revision === workflow.revision
    )
      return old
    const saved = store.put(
      owner,
      'step',
      {
        id: workflow.id,
        name: workflow.name,
        usageDescription: workflow.usageDescription,
        enabled: true,
        inputSchema: workflow.inputSchema,
        outputSchema: workflow.outputSchema,
        implementation: {
          kind: 'workflow' as const,
          workflowId: workflow.id,
          revision: workflow.revision,
        },
      },
      old?.revision,
    )
    store.put(owner, 'step-version', { id: `${saved.id}:${saved.revision}`, snapshot: saved }, 0)
    return saved
  })
}

function fromWorkflow(workflow: Workflow): WorkflowDraft {
  return {
    ...workflowDraftSchema.parse({
      id: workflow.id,
      name: workflow.name,
      usageDescription: workflow.usageDescription,
      inputSchema: workflow.inputSchema,
      outputSchema: workflow.outputSchema,
      outputs: workflow.outputs,
      nodes: workflow.nodes.map((node, index) => ({ ...node, x: index * 360, y: 0 })),
    }),
    revision: 0,
  }
}
export function draftOperation(
  store: Store,
  owner: string,
  operation: string,
  value: Record<string, unknown>,
) {
  const expected = z
    .number()
    .int()
    .nonnegative()
    .parse(value.expectedRevision ?? 0)
  const get = () => {
    const id = identifier.parse(value.id)
    const saved = store.get<WorkflowDraft>(owner, 'workflow-draft', id)
    if (saved) return saved
    const legacy = store.get<Workflow>(owner, 'workflow', id)
    if (legacy) return fromWorkflow(legacy)
    throw new Error('工作流不存在')
  }
  switch (operation) {
    case 'workflow.draft.list': {
      const rows = store.list<WorkflowDraft>(owner, 'workflow-draft', 200)
      return [
        ...rows,
        ...store
          .list<Workflow>(owner, 'workflow', 200)
          .filter((flow) => !rows.some((row) => row.id === flow.id))
          .map(fromWorkflow),
      ]
    }
    case 'workflow.draft.get':
      return get()
    case 'workflow.draft.save': {
      const draft = workflowDraftSchema.parse(value.definition),
        old = store.get<WorkflowDraft>(owner, 'workflow-draft', draft.id)
      return store.put(
        owner,
        'workflow-draft',
        {
          ...draft,
          testInputs: draft.testInputs ?? old?.testInputs,
          publishedRevision: old?.publishedRevision,
          publishedStepRevision: old?.publishedStepRevision,
          updatedAt: new Date().toISOString(),
        },
        expected,
      )
    }
    case 'workflow.validate':
      return compileDraft(
        value.definition ? workflowDraftSchema.parse(value.definition) : get(),
        store,
        owner,
      )
    case 'workflow.draft.publish': {
      const draft = get()
      if (draft.revision !== expected) throw new Error('工作流已变化，请刷新')
      const checked = compileDraft(draft, store, owner)
      if (!checked.valid || !checked.definition)
        throw new Error(
          checked.issues
            .map((issue) => [issue.nodeId, issue.field, issue.message].filter(Boolean).join(' · '))
            .join('\n'),
        )
      return store.transaction(() => {
        const previous = store.get<Workflow>(owner, 'workflow', draft.id)
        const workflow = store.put(owner, 'workflow', checked.definition!, previous?.revision ?? 0)
        const step = publishWorkflow(store, owner, workflow)
        const saved = store.put(
          owner,
          'workflow-draft',
          { ...draft, publishedRevision: workflow.revision, publishedStepRevision: step.revision },
          expected,
        )
        store.put(
          owner,
          'workflow-release',
          {
            id: `${draft.id}:${workflow.revision}`,
            snapshot: saved,
            createdAt: new Date().toISOString(),
            stepRevision: step.revision,
          },
          0,
        )
        return { draft: saved, step }
      })
    }
    case 'workflow.history': {
      const id = identifier.parse(value.id)
      const rows = store.db
        .prepare(
          "SELECT value_json FROM entities WHERE owner=? AND kind='published' AND json_extract(value_json,'$.snapshot.id')=? ORDER BY json_extract(value_json,'$.snapshot.revision') DESC LIMIT 100",
        )
        .all(owner, id) as Array<{ value_json: string }>
      return rows.map((row) => {
        const flow = (JSON.parse(row.value_json) as { snapshot: Workflow }).snapshot
        const release = store.get<{
          snapshot: WorkflowDraft
          createdAt: string
          stepRevision: number
        }>(owner, 'workflow-release', `${id}:${flow.revision}`)
        return {
          revision: flow.revision,
          name: flow.name,
          createdAt: release?.createdAt,
          stepRevision: release?.stepRevision,
        }
      })
    }
    case 'workflow.draft.restore': {
      const current = get(),
        version = z.number().int().positive().parse(value.publishedRevision)
      const release = store.get<{ snapshot: WorkflowDraft }>(
        owner,
        'workflow-release',
        `${current.id}:${version}`,
      )
      const published = store.get<{ snapshot: Workflow }>(
        owner,
        'published',
        `${current.id}:${version}`,
      )
      if (!published) throw new Error('发布版本不存在')
      const draft = workflowDraftSchema.parse(
        release
          ? Object.fromEntries(
              Object.entries(release.snapshot).filter(
                ([key]) =>
                  !['revision', 'publishedRevision', 'publishedStepRevision', 'updatedAt'].includes(
                    key,
                  ),
              ),
            )
          : Object.fromEntries(
              Object.entries(fromWorkflow(published.snapshot)).filter(
                ([key]) => key !== 'revision',
              ),
            ),
      )
      return store.put(
        owner,
        'workflow-draft',
        {
          ...draft,
          publishedRevision: current.publishedRevision,
          publishedStepRevision: current.publishedStepRevision,
          updatedAt: new Date().toISOString(),
        },
        expected,
      )
    }
    case 'workflow.draft.delete':
      return store.transaction(() => {
        const draft = get()
        if (draft.revision !== expected) throw new Error('工作流已变化，请刷新')
        if (draft.revision) store.remove(owner, 'workflow-draft', draft.id, expected)
        const legacy = store.get<Workflow>(owner, 'workflow', draft.id),
          step = store.get<Step>(owner, 'step', draft.id)
        if (legacy) store.remove(owner, 'workflow', draft.id, legacy.revision)
        if (step?.implementation.kind === 'workflow')
          store.remove(owner, 'step', step.id, step.revision)
        return { deleted: true }
      })
    default:
      throw new Error('未知工作流操作')
  }
}
