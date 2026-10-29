import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app'
import { setLocale } from '../../src/lib/i18n'
import { DistributedSyncService } from '../../src/services/distributed/distributedSyncService'
import {
  decryptSnapshot,
  diskState,
  distributedApp,
  listen,
  transferKey,
  type DistributedApp,
} from './fixtures/distributedApp'

type RouteCase = { method: string; route: string; status: number; protected: boolean }
const routes: RouteCase[] = [
  { method: 'GET', route: '/identity', status: 200, protected: false },
  { method: 'GET', route: '/servers', status: 200, protected: true },
  { method: 'POST', route: '/servers/probe', status: 200, protected: true },
  { method: 'POST', route: '/servers', status: 201, protected: true },
  { method: 'DELETE', route: '/servers/source', status: 200, protected: true },
  { method: 'POST', route: '/snapshot', status: 200, protected: true },
  { method: 'POST', route: '/snapshot/import', status: 202, protected: true },
  { method: 'POST', route: '/sync/source', status: 202, protected: true },
  { method: 'GET', route: '/pending', status: 200, protected: true },
  { method: 'POST', route: '/rollback', status: 202, protected: true },
  { method: 'POST', route: '/capability-invites', status: 201, protected: false },
  { method: 'GET', route: '/capability-nodes', status: 200, protected: false },
]
const actors = ['匿名', '普通设备', '管理员', '合法同步节点'] as const
let source: DistributedApp
let target: DistributedApp
let remote: Awaited<ReturnType<typeof listen>>
const resources: Array<{ close(): Promise<void> }> = []

beforeEach(async () => {
  vi.stubEnv('INFOS_API_TOKEN', '')
  vi.stubEnv('INFOS_DOCKER', '')
  vi.stubEnv('PERO_CAPABILITY_PORT', '9399')
  vi.stubEnv('OTEL_SDK_DISABLED', 'true')
  source = await distributedApp('source')
  resources.push(source)
  target = await distributedApp('target')
  resources.push(target)
  remote = await listen(source.app)
  resources.push(remote)
})

afterEach(async () => {
  vi.restoreAllMocks()
  const failures: unknown[] = []
  for (const resource of resources.splice(0).reverse()) {
    try {
      await resource.close()
    } catch (error) {
      failures.push(error)
    }
  }
  vi.unstubAllEnvs()
  setLocale('zh-CN')
  if (failures.length) throw new AggregateError(failures, '分布式测试资源清理失败')
})

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` })
const url = (route: string) => `http://localhost:9300/api/distributed${route}`
const serverInput = () => ({ endpoint: remote.endpoint, token: source.localToken })

async function prepare(route: string): Promise<RequestInit> {
  const init: RequestInit = { headers: { 'X-Sync-Transfer-Key': transferKey } }
  if (['/servers', '/servers/probe'].includes(route)) {
    init.headers = { ...init.headers, 'Content-Type': 'application/json' }
    init.body = JSON.stringify(serverInput())
  }
  if (['/servers/source', '/sync/source'].includes(route))
    await target.service.saveServer(serverInput())
  if (route === '/snapshot/import') {
    init.body = new Uint8Array(await source.service.createEncryptedSnapshot(transferKey))
  }
  if (route === '/rollback') {
    const backupPath = path.join(target.dataDir, '.backup-state/sync/backup-fixture')
    await mkdir(backupPath, { recursive: true })
    await mkdir(path.join(target.dataDir, 'distributed'), { recursive: true })
    await writeFile(
      path.join(target.dataDir, 'distributed/last-sync.json'),
      JSON.stringify({ backupPath }),
    )
  }
  return init
}

describe('真实应用分布式接口权限矩阵', () => {
  for (const actor of actors) {
    it.each(routes)(`${actor}：$method $route 按权限执行`, async (item) => {
      const init = await prepare(item.route)
      const tokens = {
        匿名: '',
        普通设备: target.device.token,
        管理员: target.admin.token,
        // 当前协议中节点持有目标端授予的安装管理员凭据，没有独立的 HTTP 节点身份。
        合法同步节点: target.localToken,
      }
      const token = tokens[actor]
      const before = await diskState(target.dataDir)
      const methods = [
        'identity',
        'listServers',
        'probe',
        'saveServer',
        'removeServer',
        'createEncryptedSnapshot',
        'stageEncryptedSnapshot',
        'stageFromServer',
        'pending',
        'lastSync',
        'stageRollback',
      ] as const
      const reads = methods.map((method) => vi.spyOn(target.service, method))
      const snapshot = item.route === '/snapshot'
      const response = await target.app.request(url(item.route), {
        ...init,
        method: item.method,
        body: item.method === 'GET' ? undefined : init.body,
        headers: { ...init.headers, ...(token ? bearer(token) : {}) },
      })
      const denied = actor === '匿名' || (actor === '普通设备' && item.protected)
      const expected = actor === '匿名' ? 401 : denied ? 403 : item.status

      expect(response.status).toBe(expected)
      if (denied) {
        expect(await response.json()).toMatchObject({
          code: actor === '匿名' ? 'UNAUTHORIZED' : 'FORBIDDEN',
        })
        expect(await diskState(target.dataDir)).toEqual(before)
        for (const read of reads) expect(read).not.toHaveBeenCalled()
      } else if (snapshot) {
        const bundle = decryptSnapshot(Buffer.from(await response.arrayBuffer()))
        expect(bundle.manifest.sourceServerId).toBe('target')
        expect(Buffer.from(bundle.files['config.json']!, 'base64').toString()).toContain(
          'target:密钥',
        )
        expect(bundle.files['client-access.json']).toBeUndefined()
      } else {
        const body = await response.json()
        expect(body).toMatchObject({
          code: item.status === 201 ? 'CREATED' : item.status === 202 ? 'ACCEPTED' : 'OK',
        })
        if (item.route === '/identity') expect(body).toMatchObject({ data: { serverId: 'target' } })
        if (item.route === '/servers' && item.method === 'POST')
          expect(await target.service.listServers()).toMatchObject([
            { serverId: 'source', endpoint: remote.endpoint },
          ])
        if (item.method === 'DELETE') {
          expect(body).toMatchObject({ data: { removed: true } })
          expect(await target.service.listServers()).toEqual([])
        }
        if (['/snapshot/import', '/sync/source'].includes(item.route))
          expect(await target.service.pending()).toMatchObject({ sourceServerId: 'source' })
        if (item.route === '/rollback')
          expect(
            JSON.parse(
              await readFile(path.join(target.dataDir, '.backup-state/sync/rollback.json'), 'utf8'),
            ),
          ).toMatchObject({ backupPath: expect.stringContaining('backup-fixture') })
        if (item.route === '/capability-invites')
          expect(body).toMatchObject({
            data: { pairingCode: expect.stringMatching(/^[A-F0-9]{12}$/) },
          })
        if (item.route === '/capability-nodes')
          expect(body).toMatchObject({ data: { nodes: [], sessions: [], offers: [] } })
      }
    })
  }
})

describe('授权先于读取、校验与网络访问', () => {
  it('普通设备的无效请求体不进入 JSON 校验或快照读取', async () => {
    for (const route of ['/servers', '/servers/probe', '/snapshot/import']) {
      const request = new Request(url(route), {
        method: 'POST',
        headers: { ...bearer(target.device.token), 'Content-Type': 'application/json' },
        body: '无效的 JSON 和快照',
      })
      const json = vi.spyOn(request, 'json')
      const arrayBuffer = vi.spyOn(request, 'arrayBuffer')
      const response = await target.app.fetch(request)
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ code: 'FORBIDDEN' })
      expect(json).not.toHaveBeenCalled()
      expect(arrayBuffer).not.toHaveBeenCalled()
    }
  })

  it('普通设备的 Cookie 与查询令牌同样不能取得管理权限', async () => {
    for (const headers of [
      { cookie: `infos_device=${target.device.token}`, Origin: 'http://localhost:9300' },
      bearer(target.device.token),
    ]) {
      const response = await target.app.request(url('/snapshot'), { method: 'POST', headers })
      expect(response.status).toBe(403)
    }
    expect(
      (await target.app.request(`${url('/servers')}?token=${target.device.token}`)).status,
    ).toBe(403)
    expect(
      (
        await target.app.request(url('/snapshot'), {
          method: 'POST',
          headers: { cookie: `infos_device=${target.admin.token}`, Origin: 'http://evil.invalid' },
        })
      ).status,
    ).toBe(401)
  })

  it('拒绝过期、撤销、伪造节点身份和只有传输密钥的请求', async () => {
    target.access.revoke(target.admin.deviceId)
    for (const headers of [
      bearer(target.admin.token),
      bearer('unregistered-node-token'),
      { 'X-Sync-Transfer-Key': transferKey, 'X-Node-Id': 'source' },
    ]) {
      expect((await target.app.request(url('/snapshot'), { method: 'POST', headers })).status).toBe(
        401,
      )
    }
    vi.spyOn(Date, 'now').mockReturnValue(target.device.expiresAt + 1)
    expect(
      (await target.app.request(url('/servers'), { headers: bearer(target.device.token) })).status,
    ).toBe(401)
  })

  it.each([
    ['zh-CN', '请使用管理员凭据管理分布式同步'],
    ['zh-TW', '請使用管理員憑據管理分佈式同步'],
    ['en-US', 'Use administrator credentials to manage distributed sync'],
  ])('权限错误使用 %s，业务码保持稳定', async (locale, message) => {
    setLocale(locale)
    const response = await target.app.request(url('/servers'), {
      headers: bearer(target.device.token),
    })
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: 'FORBIDDEN', message })
  })

  it('缺少认证服务时也不能从旧版认证分支进入管理接口', async () => {
    const app = createApp({ ...target.context, clientAccess: undefined } as never)
    for (const route of routes.filter((item) => item.protected)) {
      expect((await app.request(url(route.route), { method: route.method })).status).toBe(403)
    }
  })
})

describe('真实节点同步', () => {
  it.each(['安装管理员凭据', '管理员配对凭据', '环境管理凭据'])(
    '%s 支持探测、保存、下载、重启应用及回滚',
    async (mode) => {
      let token = mode === '管理员配对凭据' ? source.admin.token : source.localToken
      if (mode === '环境管理凭据') {
        token = 'isolated-node-administrator'
        vi.stubEnv('INFOS_API_TOKEN', token)
      }
      const headers = { ...bearer(target.admin.token), 'Content-Type': 'application/json' }
      const saved = await target.app.request(url('/servers'), {
        method: 'POST',
        headers,
        body: JSON.stringify({ endpoint: remote.endpoint, token }),
      })
      expect(saved.status).toBe(201)
      expect(await saved.json()).toMatchObject({ data: { serverId: 'source' } })
      expect(
        await readFile(path.join(target.dataDir, 'distributed/servers.json'), 'utf8'),
      ).not.toContain(token)
      const sync = await target.app.request(url('/sync/source'), { method: 'POST', headers })
      expect(sync.status).toBe(202)
      expect(await sync.json()).toMatchObject({
        data: { restartRequired: true, manifest: { sourceServerId: 'source' } },
      })
      expect(
        target.db.prepare('SELECT value FROM private_records WHERE kind=?').get('request'),
      ).toEqual({ value: 'target:完整请求副本' })
      const credentials = await readFile(path.join(target.dataDir, 'client-access.json'), 'utf8')
      target.db.close()

      expect(await DistributedSyncService.applyPending(target.dataDir)).toBe(true)
      const restored = new Database(path.join(target.dataDir, 'infos.db'), { readonly: true })
      try {
        expect(restored.prepare('SELECT * FROM private_records ORDER BY kind').all()).toEqual([
          { kind: 'memory', value: 'source:记忆' },
          { kind: 'request', value: 'source:完整请求副本' },
        ])
      } finally {
        restored.close()
      }
      expect(JSON.parse(await readFile(path.join(target.dataDir, 'config.json'), 'utf8'))).toEqual({
        apiKey: 'source:密钥',
      })
      expect(await readFile(path.join(target.dataDir, 'client-access.json'), 'utf8')).toBe(
        credentials,
      )
      expect(await target.service.pending()).toBeNull()
      const rollback = await target.app.request(url('/rollback'), { method: 'POST', headers })
      expect(rollback.status).toBe(202)
      expect(await DistributedSyncService.applyPending(target.dataDir)).toBe(true)
      expect(JSON.parse(await readFile(path.join(target.dataDir, 'config.json'), 'utf8'))).toEqual({
        apiKey: 'target:密钥',
      })
    },
  )
})
