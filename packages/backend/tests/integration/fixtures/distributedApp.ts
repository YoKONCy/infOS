import { randomBytes, createDecipheriv } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import Database from 'better-sqlite3'
import { serve } from '@hono/node-server'
import { createApp } from '../../../src/app'
import { ClientAccessRepository } from '../../../src/repositories/clientAccess.repo'
import { ClientAccessService } from '../../../src/services/system/clientAccessService'
import { DistributedSyncService } from '../../../src/services/distributed/distributedSyncService'
import { CapabilityBridge } from '../../../src/capabilities/capabilityBridge'
import { CapabilityDirectory } from '../../../src/kernel/capabilityDirectory'
import { CapabilityHandleRegistry } from '../../../src/kernel/capabilityHandleRegistry'
import { NodeRegistry } from '../../../src/kernel/nodeRegistry'

export const transferKey = randomBytes(32).toString('base64')
export const tempRoot = path.resolve('TEMP')

/** 使用真实应用、鉴权、SQLite 和快照服务，只提供未使用业务域的最小上下文。 */
export async function distributedApp(serverId: string) {
  await mkdir(tempRoot, { recursive: true })
  const directory = await mkdtemp(path.join(tempRoot, 'distributed-auth-'))
  const dataDir = path.join(directory, 'data')
  const repository = new ClientAccessRepository(dataDir)
  const access = new ClientAccessService(repository, 9300)
  const localToken = repository.load(false).localToken
  const device = access.pair(access.createPairing().code, '普通手机', true, 'device')
  const admin = access.pair(access.createPairing(true).code, '管理设备', true, 'admin')
  const db = new Database(path.join(dataDir, 'infos.db'))
  db.exec('CREATE TABLE private_records(kind TEXT, value TEXT)')
  const insert = db.prepare('INSERT INTO private_records VALUES (?, ?)')
  insert.run('request', `${serverId}:完整请求副本`)
  insert.run('memory', `${serverId}:记忆`)
  await writeFile(path.join(dataDir, 'config.json'), JSON.stringify({ apiKey: `${serverId}:密钥` }))
  const service = new DistributedSyncService(dataDir, { $client: db } as never, serverId)
  const nodes = new NodeRegistry()
  const handles = new CapabilityHandleRegistry()
  const bridge = new CapabilityBridge(new CapabilityDirectory(handles), handles, nodes)
  const context = {
    clientAccess: access,
    distributedSyncService: service,
    capabilityBridge: bridge,
    nodeRegistry: nodes,
    pathResolver: { getRoot: () => dataDir },
    ttsService: {},
    asrService: {},
    gatewayHub: { connectedCount: 0 },
    agentManager: { listAgents: () => [], activeAgentId: null },
  }
  const app = createApp(context as never)
  return {
    app,
    context,
    directory,
    dataDir,
    service,
    access,
    localToken,
    device,
    admin,
    db,
    async close() {
      if (db.open) db.close()
      await access.dispose()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

export type DistributedApp = Awaited<ReturnType<typeof distributedApp>>

/** 只在测试允许的端口段监听，碰到已占用端口时继续寻找，绝不关闭别的服务。 */
export async function listen(app: DistributedApp['app']) {
  for (let port = 9300; port < 9400; port++) {
    const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' })
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('listening', resolve)
        server.once('error', reject)
      })
      return {
        endpoint: `http://127.0.0.1:${port}`,
        async close() {
          await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()))
            if ('closeAllConnections' in server) server.closeAllConnections()
          })
        },
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
    }
  }
  throw new Error('TEST_PORTS_UNAVAILABLE')
}

export function decryptSnapshot(bytes: Buffer, keyBase64 = transferKey) {
  const decipher = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(keyBase64, 'base64'),
    bytes.subarray(0, 12),
  )
  decipher.setAuthTag(bytes.subarray(12, 28))
  return JSON.parse(
    Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString(),
  ) as {
    manifest: { sourceServerId: string; snapshotId: string }
    files: Record<string, string>
  }
}

/** 对比实际磁盘内容，验证拒绝请求没有写入服务器、快照或回滚状态。 */
export async function diskState(directory: string, prefix = ''): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) Object.assign(result, await diskState(file, relative))
    else result[relative] = (await readFile(file)).toString('base64')
  }
  return result
}
