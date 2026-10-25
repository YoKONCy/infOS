import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { Assets } from './assets'
import {
  identifier,
  object,
  serviceSchema,
  stepSchema,
  workflowSchema,
  type Invocation,
  type Run,
  type RunSnapshot,
  type ServiceProfile,
  type Step,
  type Workflow,
  type HostPort,
} from './domain'
import { Store } from './store'
import { dismissedCanvasRuns } from './canvasNotificationState'
import { compileSchema, validate } from './schema'
import { expandWorkflow, resolve, verifyWorkflow, publishedWorkflow } from './workflows'
import { stepTemplates } from './templates'
import { ServiceClient } from './serviceClient'
import { ExecutionEngine } from './execution'
import { libraryList, updateLibrary, searchPrompts } from './library'
import {
  deleteCollection,
  moveCanvas,
  renameCanvas,
  requireCollection,
  saveCollection,
} from './collections'
import { dependencies } from './bindings'
import { draftOperation, publishWorkflow } from './workflowDrafts'
import {
  effectiveService,
  providerAdapterOperation,
  providerDirectory,
  saveProvider,
  fetchProviderModels,
  assertCredentialScope,
  sameCredentialScope,
  serviceDescriptor,
} from './providers'

export class PictoriaApplication {
  readonly assets: Assets
  readonly execution: ExecutionEngine
  constructor(
    readonly store: Store,
    private readonly host?: HostPort,
  ) {
    this.assets = new Assets(store)
    this.execution = new ExecutionEngine(store, new ServiceClient(store, this.assets), host)
  }
  catalog(owner: string) {
    return this.store
      .list<Step>(owner, 'step', 200)
      .filter((s) => s.enabled)
      .map((step) => this.describeStep(step, owner))
  }
  private describeStep(step: Step, owner: string) {
    const available = this.available(step, owner)
    const service =
      step.implementation.kind === 'service'
        ? this.store.get<ServiceProfile>(owner, 'service', step.implementation.serviceId)
        : undefined
    const modelName = service?.adapter
      ? service.name.replace(/^(?:AtlasCloud|APIModels)\s*·\s*/, '')
      : typeof service?.submit.body.model === 'string'
        ? service.submit.body.model
        : undefined
    const providerName = service?.providerId
      ? this.store.get<{ name: string }>(owner, 'model-provider', service.providerId)?.name
      : service?.adapter === 'atlascloud'
        ? 'AtlasCloud'
        : service?.adapter === 'apimodels'
          ? 'APIModels'
          : service
            ? service.name
            : step.implementation.kind === 'llm'
              ? 'infOS'
              : undefined
    return {
      ...step,
      modelName,
      providerName,
      available,
      reason: available ? undefined : '未配置或凭据不匹配',
    }
  }
  async invoke(operation: string, raw: unknown, context: Invocation): Promise<unknown> {
    const value = object(raw)
    const owner = identifier.parse(context.owner)
    if (
      operation.startsWith('workflow.draft.') ||
      operation === 'workflow.validate' ||
      operation === 'workflow.history'
    )
      return draftOperation(this.store, owner, operation, value)
    const revision =
      value.expectedRevision === undefined
        ? undefined
        : z.number().int().nonnegative().parse(value.expectedRevision)
    switch (operation) {
      case 'provider.list':
        return providerDirectory(this.store, owner)
      case 'provider.models':
        return fetchProviderModels(this.store, owner, value.definition)
      case 'provider.save':
        return saveProvider(
          this.store,
          owner,
          value.definition,
          z
            .number()
            .int()
            .nonnegative()
            .parse(value.expectedRevision ?? 0),
        )
      case 'collection.list':
        return this.store.list(
          owner,
          'collection',
          z
            .number()
            .int()
            .min(1)
            .max(200)
            .parse(value.limit ?? 200),
          z
            .number()
            .int()
            .nonnegative()
            .parse(value.offset ?? 0),
        )
      case 'collection.save':
        return saveCollection(this.store, owner, value)
      case 'collection.delete':
        return deleteCollection(this.store, owner, value)
      case 'project.move':
        return moveCanvas(this.store, owner, value)
      case 'project.rename':
        return renameCanvas(this.store, owner, value)
      case 'prompt.search':
        return searchPrompts(this.store, owner, value)
      case 'provider.settings':
        return providerAdapterOperation(this.store, owner, 'settings', value)
      case 'provider.configure':
        return providerAdapterOperation(this.store, owner, 'configure', value)
      case 'library.list':
        return libraryList(this.store, owner, value)
      case 'library.update':
        return updateLibrary(this.store, owner, value)
      case 'project.delete':
      case 'prompt.delete':
      case 'workflow.delete': {
        const kind = operation.split('.')[0]!
        const id = identifier.parse(value.id)
        this.store.transaction(() => {
          this.store.remove(owner, kind, id, z.number().int().positive().parse(revision))
          if (kind === 'project') {
            const runIds = (
              this.store.db
                .prepare('SELECT id FROM runs WHERE owner=? AND project_id=?')
                .all(owner, id) as Array<{ id: string }>
            ).map((run) => run.id)
            const previous = this.store.get<{ id: string; revision: number }>(
              owner,
              'dismissed-canvas',
              id,
            )
            this.store.put(owner, 'dismissed-canvas', { id, runIds }, previous?.revision ?? 0)
          }
          if (kind === 'workflow') {
            const step = this.store.get<Step>(owner, 'step', id)
            if (step?.implementation.kind === 'workflow')
              this.store.remove(owner, 'step', id, step.revision)
          }
        })
        return { deleted: true }
      }
      case 'step.set_enabled': {
        const step = this.require<Step>(owner, 'step', value.id)
        return this.store.transaction(() => {
          const saved = this.store.put(
            owner,
            'step',
            { ...step, enabled: z.boolean().parse(value.enabled) },
            revision,
          )
          this.store.put(
            owner,
            'step-version',
            { id: `${saved.id}:${saved.revision}`, snapshot: saved },
            0,
          )
          return saved
        })
      }
      case 'templates.list':
        return stepTemplates()
      case 'catalog.get':
        return { steps: this.catalog(owner) }
      case 'step.list':
        return this.store
          .list<Step>(owner, 'step', 200)
          .map((step) => this.describeStep(step, owner))
      case 'step.get':
        return this.describeStep(this.require<Step>(owner, 'step', value.id), owner)
      case 'step.version': {
        const result = this.store.get<{ snapshot: Step }>(
          owner,
          'step-version',
          `${identifier.parse(value.id)}:${z.number().int().positive().parse(value.revision)}`,
        )
        if (!result) throw new Error('步骤版本不存在')
        return this.describeStep(result.snapshot, owner)
      }
      case 'service.list':
        return this.store
          .list<ServiceProfile>(owner, 'service', 200)
          .map((service) => serviceDescriptor(this.store, owner, service))
      case 'service.get': {
        return serviceDescriptor(
          this.store,
          owner,
          this.require<ServiceProfile>(owner, 'service', value.id),
        )
      }
      case 'service.save': {
        const parsed = serviceSchema.parse(value.definition)
        const { credential, clearCredential, ...profile } = parsed
        const url = new URL(profile.baseUrl)
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
          throw new Error('服务地址无效')
        return this.store.transaction(() => {
          const previous = this.store.get<ServiceProfile>(owner, 'service', profile.id)
          if (credential !== undefined || clearCredential) {
            profile.credentialId = profile.id
            delete profile.credentialSourceId
          } else if (
            previous &&
            !profile.providerId &&
            !sameCredentialScope(previous, profile) &&
            this.store.secret(owner, profile.credentialId || profile.id)
          )
            throw new Error('供应商或认证已变化，请重新填写 API Key')
          if (!profile.providerId && credential === undefined && !clearCredential)
            assertCredentialScope(this.store, owner, profile)
          if (credential !== undefined) this.store.secret(owner, profile.id, credential)
          else if (clearCredential) this.store.secret(owner, profile.id, null)
          if (credential !== undefined || clearCredential) {
            const scope = this.store.get<{ revision: number }>(
              owner,
              'credential-scope',
              profile.id,
            )
            this.store.put(
              owner,
              'credential-scope',
              {
                id: profile.id,
                baseUrl: profile.baseUrl,
                adapter: profile.adapter,
                authHeader: profile.authHeader,
                authPrefix: profile.authPrefix,
              },
              scope?.revision ?? 0,
            )
          }
          const saved = this.store.put(
            owner,
            'service',
            { ...profile, hasCredential: Boolean(this.store.secret(owner, profile.id)) },
            revision,
          )
          const effective = effectiveService(this.store, owner, saved)
          return {
            ...saved,
            hasCredential: Boolean(
              effective && this.store.secret(owner, effective.credentialId ?? effective.id),
            ),
          }
        })
      }
      case 'step.save': {
        const step = stepSchema.parse(value.definition)
        compileSchema(step.inputSchema)
        compileSchema(step.outputSchema)
        if (step.implementation.kind === 'workflow') throw new Error('工作流步骤由发布入口生成')
        return this.store.transaction(() => {
          const saved = this.store.put(owner, 'step', step, revision)
          this.store.put(
            owner,
            'step-version',
            { id: `${saved.id}:${saved.revision}`, snapshot: saved },
            0,
          )
          return saved
        })
      }
      case 'workflow.save': {
        const workflow = workflowSchema.parse(value.definition)
        compileSchema(workflow.inputSchema)
        compileSchema(workflow.outputSchema)
        return this.store.put(owner, 'workflow', workflow, revision)
      }
      case 'workflow.get':
        return this.require<Workflow>(owner, 'workflow', value.id)
      case 'workflow.list':
        return this.store.list<Workflow>(owner, 'workflow')
      case 'workflow.publish': {
        const workflow = this.require<Workflow>(owner, 'workflow', value.id)
        if (workflow.revision !== revision) throw new Error('工作流版本已变化')
        verifyWorkflow(workflow, this.store, owner)
        return publishWorkflow(this.store, owner, workflow)
      }
      case 'project.list':
        return this.store.list(
          owner,
          'project',
          z
            .number()
            .int()
            .min(1)
            .max(200)
            .parse(value.limit ?? 100),
          z
            .number()
            .int()
            .nonnegative()
            .parse(value.offset ?? 0),
        )
      case 'project.get':
        return this.require(owner, 'project', value.id)
      case 'project.save': {
        const project = z
          .object({
            id: identifier,
            title: z.string().min(1).max(120),
            collectionId: identifier.nullable().optional(),
            dismissedRunIds: z.array(identifier).optional(),
            creation: z
              .object({
                stepId: z.string().max(128),
                text: z.string().max(64000),
                inputsByStep: z.record(z.string(), z.record(z.string(), z.unknown())),
              })
              .strict()
              .refine((value) => JSON.stringify(value).length <= 256_000, '创作参数超过大小限制')
              .optional(),
            edges: z
              .array(
                z
                  .object({
                    id: identifier,
                    source: identifier,
                    target: identifier,
                    field: z.string().min(1).max(128),
                    sourcePort: z.enum(['right', 'bottom']).optional(),
                    targetPort: z.enum(['left', 'top']).optional(),
                    historical: z.boolean().optional(),
                  })
                  .strict(),
              )
              .max(8000)
              .optional(),
            items: z
              .array(
                z
                  .object({
                    id: identifier,
                    content: z.unknown(),
                    x: z.number().finite(),
                    y: z.number().finite(),
                  })
                  .strict(),
              )
              .max(2000)
              .default([]),
          })
          .strict()
          .parse(value.definition)
        const ids = new Set(project.items.map((item) => item.id))
        if (ids.size !== project.items.length) throw new Error('画布内容 ID 不能重复')
        if (
          project.edges?.some(
            (edge) => !ids.has(edge.source) || !ids.has(edge.target) || edge.source === edge.target,
          )
        )
          throw new Error('连线引用了无效的画布内容')
        const previous = this.store.get<typeof project>(owner, 'project', project.id)
        const edges =
          project.edges ??
          (previous?.edges || []).filter((edge) => ids.has(edge.source) && ids.has(edge.target))
        if (new Set(edges.map((edge) => edge.id)).size !== edges.length)
          throw new Error('连线 ID 不能重复')
        const collectionId =
          project.collectionId === undefined
            ? (previous?.collectionId ?? null)
            : project.collectionId
        // 未携带删除记录的旧客户端或工具更新也应保留已有记录。
        const dismissedRunIds = [
          ...new Set(project.dismissedRunIds ?? previous?.dismissedRunIds ?? []),
        ]
        return this.store.transaction(() => {
          requireCollection(this.store, owner, collectionId)
          return this.store.put(
            owner,
            'project',
            {
              ...project,
              creation: project.creation ?? previous?.creation,
              collectionId,
              edges,
              dismissedRunIds,
            },
            revision,
          )
        })
      }
      case 'prompt.list':
        return this.store.list(
          owner,
          'prompt',
          z
            .number()
            .int()
            .min(1)
            .max(200)
            .parse(value.limit ?? 60),
          z
            .number()
            .int()
            .nonnegative()
            .parse(value.offset ?? 0),
        )
      case 'prompt.save': {
        const prompt = z
          .object({
            id: identifier,
            title: z.string().min(1).max(120),
            text: z.string().max(64000),
            tags: z.array(z.string().max(50)).max(30).default([]),
            usage: z.string().max(1000).default(''),
          })
          .strict()
          .parse(value.definition)
        return this.store.put(owner, 'prompt', prompt, revision)
      }
      case 'asset.list':
        return this.assets.list(
          owner,
          z
            .number()
            .int()
            .min(1)
            .max(100)
            .parse(value.limit ?? 50),
          z
            .number()
            .int()
            .nonnegative()
            .parse(value.offset ?? 0),
        )
      case 'asset.import':
        return this.assets.import(
          owner,
          z.string().max(140000000).parse(value.source),
          z
            .string()
            .max(180)
            .parse(value.name ?? '素材'),
        )
      case 'asset.get': {
        const id = identifier.parse(value.id)
        return { ...this.store.asset(id, owner), meta: this.store.get(owner, 'asset-meta', id) }
      }
      case 'task.submit':
        return this.submit(value, context)
      case 'task.get':
        return this.snapshot(this.store.run(identifier.parse(value.id), owner))
      case 'task.list':
        return this.store.runs(owner).map((run) => this.snapshot(run))
      case 'task.dismissed':
        return dismissedCanvasRuns(this.store.db, owner)
      case 'task.cancel':
        return this.snapshot(await this.execution.cancel(identifier.parse(value.id), owner))
      case 'task.resume':
        return this.snapshot(
          this.execution.resume(
            identifier.parse(value.id),
            owner,
            value.nodeId === undefined ? undefined : z.string().max(1000).parse(value.nodeId),
            value.remoteId === undefined
              ? undefined
              : z.string().min(1).max(500).parse(value.remoteId),
            value.confirmRetry === true,
          ),
        )
      default:
        throw new Error(`不支持的操作：${operation}`)
    }
  }
  private require<T>(owner: string, kind: string, rawId: unknown): T {
    const value = this.store.get<T>(owner, kind, identifier.parse(rawId))
    if (!value) throw new Error('对象不存在')
    return value
  }
  private snapshot(run?: Run): RunSnapshot | null {
    if (!run) return null
    const { callId: _callId, nodes, ...snapshot } = run
    return {
      ...snapshot,
      nodes: nodes.map(
        ({ response: _response, service: _service, savedOutputs: _savedOutputs, ...node }) => node,
      ),
    }
  }
  private submit(value: Record<string, unknown>, context: Invocation) {
    const owner = context.owner
    if (!context.key) throw new Error('提交需要幂等键')
    const previous = this.store.request(owner, context.key, value)
    if (previous)
      return {
        accepted: true,
        taskId: previous.id,
        projectId: previous.projectId,
        acceptedAt: previous.createdAt,
      }
    const inputs = object(value.inputs ?? {})
    let workflow: Workflow
    if (value.definition) workflow = { ...workflowSchema.parse(value.definition), revision: 1 }
    else {
      const step = this.require<Step>(owner, 'step', value.stepId)
      if (!step.enabled || step.revision !== value.stepRevision)
        throw new Error('步骤不可用或版本已变化')
      validate(step.inputSchema, inputs)
      workflow = {
        id: randomUUID(),
        revision: 1,
        name: step.name,
        usageDescription: step.usageDescription,
        inputSchema: step.inputSchema,
        outputSchema: step.outputSchema,
        nodes: [
          {
            id: 'execute',
            stepId: step.id,
            stepRevision: step.revision,
            inputs: Object.fromEntries(Object.keys(inputs).map((key) => [key, { input: key }])),
          },
        ],
        outputs: Object.fromEntries(
          Object.keys((step.outputSchema.properties as object) ?? {}).map((key) => [
            key,
            { node: 'execute', output: key },
          ]),
        ),
      }
    }
    validate(workflow.inputSchema, inputs)
    const compiled = expandWorkflow(workflow, this.store, owner)
    for (const node of compiled.nodes)
      if (node.step.implementation.kind === 'llm' && (!this.host || !context.callId))
        throw new Error('此节点使用 infOS LLM；独立运行时请在节点上配置 LLM API')
    for (const node of compiled.nodes) {
      if (node.step.implementation.kind === 'service') {
        const service = effectiveService(
          this.store,
          owner,
          this.store.get<ServiceProfile>(owner, 'service', node.step.implementation.serviceId),
        )
        if (
          !service?.enabled ||
          (service.requiresCredential &&
            !this.store.secret(owner, service.credentialId ?? service.id))
        )
          throw new Error(`服务不可用或缺少凭据：${node.step.implementation.serviceId}`)
        node.service = structuredClone(service)
      }
      if (!dependencies(node.inputs).length)
        validate(
          node.step.inputSchema,
          Object.fromEntries(
            Object.entries(node.inputs).map(([key, binding]) => [
              key,
              resolve(binding, inputs, []),
            ]),
          ),
        )
    }
    const projectId = value.projectId ? identifier.parse(value.projectId) : randomUUID()
    const run: Run = {
      id: randomUUID(),
      owner,
      projectId,
      name: workflow.name,
      state: 'queued',
      revision: 0,
      inputs,
      ...compiled,
      outputSchema: workflow.outputSchema,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      callId: context.callId,
    }
    const accepted = this.store.transaction(() => {
      const result = this.store.accept(owner, context.key!, value, run)
      const project = this.store.get<{
        id: string
        revision: number
        title: string
        items: unknown[]
        dismissedRunIds?: string[]
      }>(owner, 'project', result.projectId)
      if (value.canvasItemId !== undefined) {
        const canvasItemId = identifier.parse(value.canvasItemId)
        if (
          !project?.items.some(
            (item) => item && typeof item === 'object' && 'id' in item && item.id === canvasItemId,
          )
        )
          throw new Error('创作草稿已变化，请保存画布后再提交')
      }
      if (!project)
        this.store.put(
          owner,
          'project',
          {
            id: result.projectId,
            title: workflow.name,
            items: [{ id: result.id, content: { runId: result.id }, x: 0, y: 0 }],
          },
          0,
        )
      else if (
        !value.canvasItemId &&
        !project.dismissedRunIds?.includes(result.id) &&
        !project.items.some(
          (item) => item && typeof item === 'object' && 'id' in item && item.id === result.id,
        )
      )
        this.store.put(
          owner,
          'project',
          {
            ...project,
            items: [
              ...project.items,
              { id: result.id, content: { runId: result.id }, x: project.items.length * 300, y: 0 },
            ],
          },
          project.revision,
        )
      return result
    })
    this.execution.pump()
    return {
      accepted: true,
      taskId: accepted.id,
      projectId: accepted.projectId,
      acceptedAt: accepted.createdAt,
    }
  }

  private available(step: Step, owner: string): boolean {
    if (step.implementation.kind === 'llm') return Boolean(this.host)
    if (step.implementation.kind === 'service') {
      try {
        const service = effectiveService(
          this.store,
          owner,
          this.store.get<ServiceProfile>(owner, 'service', step.implementation.serviceId),
        )
        return Boolean(
          service?.enabled &&
          (!service.requiresCredential ||
            this.store.secret(owner, service.credentialId ?? service.id)),
        )
      } catch {
        return false
      }
    }
    try {
      const flow = publishedWorkflow(
        this.store,
        owner,
        step.implementation.workflowId,
        step.implementation.revision,
      )
      return Boolean(
        flow &&
        expandWorkflow(flow, this.store, owner).nodes.every((node) =>
          this.available(node.step, owner),
        ),
      )
    } catch {
      return false
    }
  }
}
