import { t as __t } from './i18n.mjs'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'

const origin = new URL(process.argv[2] ?? 'http://localhost:3000')
const token = process.env.INFOS_API_TOKEN ?? ''
const started = []

/** 对真实镜像验证入口模块的压缩、缓存和升级响应。 */
async function checkStaticCache() {
  const entry = await fetch(origin, { signal: AbortSignal.timeout(15_000) })
  assert.equal(entry.status, 200, 'WEB_ENTRY_UNAVAILABLE')
  assert.match(entry.headers.get('cache-control') ?? '', /no-cache/, 'WEB_ENTRY_CACHE_INVALID')
  const html = await entry.text()
  const script = html.match(/<script\b[^>]*\bsrc=["']([^"']+)["']/i)?.[1]
  assert.ok(script, 'WEB_ENTRY_ASSETS_MISSING')
  const address = new URL(script, origin)
  assert.equal(address.origin, origin.origin, 'WEB_ASSET_ORIGIN_CHANGED')
  const compressed = await fetch(address, {
    headers: { 'accept-encoding': 'gzip' },
    signal: AbortSignal.timeout(30_000),
  })
  assert.equal(compressed.status, 200, 'WEB_ASSET_UNAVAILABLE')
  assert.equal(compressed.headers.get('content-encoding'), 'gzip', 'WEB_ASSET_COMPRESSION_MISSING')
  assert.match(compressed.headers.get('vary') ?? '', /accept-encoding/i, 'WEB_ASSET_VARY_MISSING')
  assert.match(
    compressed.headers.get('cache-control') ?? '',
    /immutable/,
    'WEB_ASSET_LONG_CACHE_MISSING',
  )
  const etag = compressed.headers.get('etag')
  assert.ok(etag, 'WEB_ASSET_ETAG_MISSING')
  const decoded = Buffer.from(await compressed.arrayBuffer())
  const plain = await fetch(address, {
    headers: { 'accept-encoding': 'identity' },
    signal: AbortSignal.timeout(30_000),
  })
  assert.equal(plain.status, 200, 'WEB_ASSET_IDENTITY_UNAVAILABLE')
  assert.deepEqual(
    decoded,
    Buffer.from(await plain.arrayBuffer()),
    'WEB_ASSET_COMPRESSION_CORRUPTED',
  )
  const cached = await fetch(address, {
    headers: { 'accept-encoding': 'gzip', 'if-none-match': etag },
    signal: AbortSignal.timeout(15_000),
  })
  assert.equal(cached.status, 304, 'WEB_ASSET_CONDITIONAL_CACHE_FAILED')
  assert.equal((await cached.arrayBuffer()).byteLength, 0, 'WEB_ASSET_304_HAS_BODY')
}

async function request(application, action, method = 'GET') {
  const response = await fetch(new URL(`/api/applications/${application}/${action}`, origin), {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(60_000),
  })
  const result = await response.json()
  assert.ok(
    response.ok && result.code === 'OK',
    `${application} ${action} 失败：${result.message ?? response.status}`,
  )
  return result.data
}

async function checkArcaSocket() {
  const address = new URL('/api/applications/arca/transport', origin)
  address.protocol = origin.protocol === 'https:' ? 'wss:' : 'ws:'
  if (token) address.searchParams.set('token', token)
  const socket = new WebSocket(address)
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close()
        reject(new Error('Arca 代理握手超时'))
      }, 10_000)
      const finish = (error) => {
        clearTimeout(timer)
        if (error) reject(error)
        else resolve()
      }
      socket.addEventListener(
        'message',
        (event) => {
          try {
            const hello = JSON.parse(String(event.data))
            assert.equal(hello.type, 'hello')
            assert.equal(hello.application.appId, 'infos.arca')
            finish()
          } catch (error) {
            finish(error)
          }
        },
        { once: true },
      )
      socket.addEventListener('error', () => finish(new Error('Arca 代理连接失败')), { once: true })
      socket.addEventListener('close', () => finish(new Error('Arca 在握手前关闭')), { once: true })
    })
  } finally {
    socket.close()
  }
}

const failures = []
try {
  await checkStaticCache()
  for (const application of ['arca', 'pictoria']) {
    const before = await request(application, 'status')
    assert.equal(before.ownership, 'offline', '冒烟测试需要未启动应用的独立测试容器')
    assert.equal(before.managedRuntimeAvailable, true, `${application} 发行资源不完整`)
    // 启动请求失败也尝试回收，避免留下半启动的子进程。
    started.push(application)
    const status = await request(application, 'start', 'POST')
    assert.equal(status.ownership, 'managed')
    assert.equal(status.federation.state, 'connected')
    if (application === 'arca') await checkArcaSocket()
    console.log(
      __t('scripts.docker-runtime-smoke', 'Docker 子应用启动与连接通过：{0}', [application]),
    )
  }
} catch (error) {
  failures.push(error)
}
for (const application of started.reverse()) {
  try {
    await request(application, 'stop', 'POST')
    let status
    for (let attempt = 0; attempt < 40; attempt++) {
      status = await request(application, 'status')
      if (status.ownership === 'offline') break
      await delay(500)
    }
    assert.equal(status.ownership, 'offline', `${application} 未完成生命周期回收`)
    console.log(__t('scripts.docker-runtime-smoke', 'Docker 子应用停止通过：{0}', [application]))
  } catch (error) {
    failures.push(error)
  }
}
if (failures.length) throw new AggregateError(failures, 'Docker 子应用冒烟失败')
