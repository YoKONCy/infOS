import { t as __t } from './i18n'
/** 子应用兼容层组合自治内核、协议、页面与受控生命周期。 */
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { KernelNodeId } from '@infos/shared'
import { NodeHost, ApplicationDataLease } from '@infos/node-host'
import {
  type ArcaPortableProjectPackage,
  type ContentAddressedBlobStore,
  type SqliteDocumentEngine,
  type DocumentOutboxEvent,
} from '@infos/document-engine'
import { ArcaFederationState } from './federationState'
import { ArcaDocumentContextProvider } from './documentContextProvider'
import { SurfaceSessionManager } from './surfaceSession'
import { createDocumentCapabilityProvider } from './documentProvider'
import type { ArcaModelRepository } from './modelRepository'
import { createModelCapabilityProvider } from './modelProvider'
import { ArcaDiscoveryStore, type ArcaDiscoveryRecord } from './discovery'
import { arcaAdapterManifest } from './adapterManifest'
import type { ArcaOfficeTasks } from './officeTasks'
import { ArcaApplication } from './application'
import { ArcaCollaborationAuthority } from './collaborationAuthority'
import { createArcaTaskProvider } from './taskProvider'
import { arcaHostKey } from './hostCredentials'
import { ArcaHostControl } from './hostControl'
import { ArcaBrowserSurface } from './browserSurface'

export interface ArcaApplicationHostOptions {
  dataPath: string
  discoveryPath?: string
  displayName?: string
  onStopped?: () => void
  standalone?: boolean
  httpPort?: number
  uiRoot?: string
  developmentUi?: boolean
  bindDesktop?: (value: unknown) => Promise<void>
  shutdown?: () => Promise<void>
}

export class ArcaApplicationHost {
  readonly application: ArcaApplication
  readonly nodeHost: NodeHost
  readonly documents: SqliteDocumentEngine
  readonly blobs: ContentAddressedBlobStore
  readonly packages: ArcaPortableProjectPackage
  readonly discovery: ArcaDiscoveryStore
  readonly surfaceSessions = new SurfaceSessionManager()
  readonly models: ArcaModelRepository
  readonly officeTasks: ArcaOfficeTasks
  readonly documentContext: ArcaDocumentContextProvider
  readonly federation: ArcaFederationState
  readonly instanceId = randomUUID()
  private generation = 0
  private discoveryRecord?: ArcaDiscoveryRecord
  private started = false
  private stopRequested = false
  private readonly lease: ApplicationDataLease
  private readonly control: ArcaHostControl
  private readonly collaboration: ArcaCollaborationAuthority
  private starting?: Promise<{ loopbackPort?: number; httpPort?: number }>
  private stopping?: Promise<void>
  private closing = false
  browserUrl?: string

  constructor(readonly options: ArcaApplicationHostOptions) {
    mkdirSync(options.dataPath, { recursive: true })
    this.lease = new ApplicationDataLease(options.dataPath)
    let application: ArcaApplication | undefined
    try {
      this.application = application = new ArcaApplication(options.dataPath)
      this.nodeHost = new NodeHost({
        identityPath: path.join(options.dataPath, 'identity.json'),
        displayName: options.displayName ?? 'Arca',
        facets: ['application', 'capability', 'storage'],
        application: {
          protocolVersion: 1,
          appId: 'infos.arca',
          instanceId: this.instanceId,
          name: 'Arca',
          appVersion: '0.9.8',
          adapterVersion: '1.0.0',
          state: 'ready',
          endpoints: arcaAdapterManifest.endpoints,
        },
      })
      this.documents = this.application.documents
      this.blobs = this.application.blobs
      this.packages = this.application.packages
      this.models = this.application.models
      this.officeTasks = this.application.officeTasks
      const key = arcaHostKey(options.dataPath)
      const browser = options.standalone
        ? new ArcaBrowserSurface(
            options.uiRoot ?? fileURLToPath(new URL('../client/dist', import.meta.url)),
            options.developmentUi,
          )
        : undefined
      this.collaboration = new ArcaCollaborationAuthority(
        this.documents,
        path.join(options.dataPath, 'collaboration-grants.json'),
        this.instanceId,
      )
      this.control = new ArcaHostControl({
        key,
        browser,
        bindDesktop: options.bindDesktop,
        shutdown: () =>
          options.shutdown ? options.shutdown() : this.stop().then(() => options.onStopped?.()),
      })
      this.documentContext = new ArcaDocumentContextProvider(this.nodeId, this.documents)
      this.federation = new ArcaFederationState(this.documents)
      this.discovery = new ArcaDiscoveryStore(
        options.discoveryPath ?? path.join(options.dataPath, 'runtime', 'discovery.json'),
      )
      this.nodeHost.register(
        createDocumentCapabilityProvider({
          nodeId: this.nodeId,
          engine: this.documents,
          blobs: this.blobs,
          sessions: this.surfaceSessions,
          contextProvider: this.documentContext,
          federation: this.federation,
          packages: this.packages,
          officeTasks: this.officeTasks,
          office: this.application.office,
          collaboration: this.collaboration,
          hostKey: key,
          requestStop: () => this.requestStop(),
        }),
      )
      this.nodeHost.register(
        createModelCapabilityProvider({
          nodeId: this.nodeId,
          models: this.models,
          sessions: this.surfaceSessions,
        }),
      )
      this.nodeHost.register(
        createArcaTaskProvider({
          nodeId: this.nodeId,
          instanceId: this.instanceId,
          tasks: this.officeTasks,
          sessions: this.surfaceSessions,
          hostKey: key,
        }),
      )
    } catch (error) {
      // 构造中途失败时也释放已经创建的内核和独占锁。
      application?.documents.close()
      this.lease.release()
      throw error
    }
  }

  get nodeId(): KernelNodeId {
    return this.nodeHost.identity.descriptor.nodeId
  }

  start(
    input: { loopbackPort?: number } = {},
  ): Promise<{ loopbackPort?: number; httpPort?: number }> {
    if (this.closing) return Promise.reject(new Error('Arca 正在停止'))
    this.starting ??= this.open(input)
    return this.starting
  }
  private async open(input: {
    loopbackPort?: number
  }): Promise<{ loopbackPort?: number; httpPort?: number }> {
    try {
      await this.nodeHost.start()
      if (this.closing) throw new Error('Arca 启动已取消')
      if (input.loopbackPort === undefined) {
        this.application.start()
        this.started = true
        return {}
      }
      const loopbackPort = await this.nodeHost.listenLoopback(input.loopbackPort)
      const httpPort = await this.control.start(this.options.httpPort ?? 0)
      if (this.closing) throw new Error('Arca 启动已取消')
      this.generation += 1
      this.discoveryRecord = this.discovery.publish({
        application: this.nodeHost.hello().application!,
        nodeId: this.nodeId,
        pid: process.pid,
        generation: this.generation,
        carrier: 'websocket',
        endpoint: `ws://127.0.0.1:${loopbackPort}`,
        httpEndpoint: `http://127.0.0.1:${httpPort}`,
        startedAt: new Date().toISOString(),
      })
      if (this.options.standalone)
        this.browserUrl = new ArcaBrowserSurface(
          this.options.uiRoot ?? fileURLToPath(new URL('../client/dist', import.meta.url)),
          this.options.developmentUi,
        ).entry(`http://127.0.0.1:${httpPort}`, `ws://127.0.0.1:${loopbackPort}`)
      this.application.start()
      this.started = true
      return { loopbackPort, httpPort }
    } catch (error) {
      this.closing = true
      await this.close()
      throw error
    }
  }

  diagnostics() {
    return {
      applicationId: 'infos.arca',
      state: this.started ? 'ready' : 'stopped',
      dataPath: this.options.dataPath,
      pendingOutbox: this.documents.listPendingOutbox().length,
      officeTaskError: this.officeTasks.loadError || undefined,
      discovery: this.discoveryRecord,
      ...this.nodeHost.diagnostics(),
    }
  }

  async publishOutbox(
    publisher: (event: DocumentOutboxEvent) => Promise<void>,
    limit = 100,
  ): Promise<{ published: number; failedEventId?: string }> {
    let published = 0
    for (const event of this.documents.listPendingOutbox(limit)) {
      try {
        await publisher(event)
        this.documents.markOutboxPublished(event.eventId)
        published += 1
      } catch {
        return { published, failedEventId: event.eventId }
      }
    }
    return { published }
  }

  private requestStop(): void {
    if (this.stopRequested) return
    this.stopRequested = true
    // 先发送停止回执，再关闭传输与本地任务。
    setTimeout(() => {
      void (
        this.options.shutdown
          ? this.options.shutdown()
          : this.stop().then(() => this.options.onStopped?.())
      ).catch((error) => {
        this.stopRequested = false
        console.error(__t('apps.arca.logs', 'Arca 停止失败：'), error)
      })
    }, 150)
  }

  stop(): Promise<void> {
    this.closing = true
    this.stopping ??= Promise.resolve().then(async () => {
      await this.starting?.catch(() => undefined)
      await this.close()
    })
    return this.stopping
  }
  private async close(): Promise<void> {
    const failures: unknown[] = []
    const clean = async (action: () => unknown) => {
      try {
        await action()
      } catch (error) {
        failures.push(error)
      }
    }
    await clean(() => this.collaboration.close())
    await clean(() => this.officeTasks.stop())
    await clean(() => this.nodeHost.stop())
    await clean(() => this.control.stop())
    await clean(() => this.discovery.removeIfOwned(this.instanceId, this.generation))
    await clean(() => this.application.stop())
    await clean(() => this.lease.release())
    this.discoveryRecord = undefined
    this.started = false
    if (failures.length) throw new AggregateError(failures, 'Arca 退出清理失败')
  }
}
