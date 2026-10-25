const fs = require('node:fs/promises')
const fsSync = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const http = require('node:http')
const { createHash, randomBytes } = require('node:crypto')
const { createRequire } = require('node:module')
const { electronProcessEnvironment } = require('./electron-environment.cjs')

async function removePath(targetPath) {
  await fs.rm(targetPath, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 })
}

/** 等待子进程完全退出，确保 Windows 已释放 SQLite WAL/SHM 文件句柄。 */
async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.kill()
  await Promise.race([
    exited,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Daemon 烟雾测试进程退出超时')), 10_000),
    ),
  ])
}

async function assertFile(targetPath, label) {
  try {
    await fs.access(targetPath)
  } catch {
    throw new Error(`发行产物缺少 ${label}: ${targetPath}`)
  }
}

async function findFile(directory, predicate) {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      const nested = await findFile(absolute, predicate)
      if (nested) return nested
    } else if (predicate(absolute)) return absolute
  }
  return null
}

async function validatePortableRuntime(resourcesDir) {
  const platformArch = `${process.platform}-${process.arch}`
  const rgPath = path.join(
    resourcesDir,
    'bin',
    platformArch,
    process.platform === 'win32' ? 'rg.exe' : 'rg',
  )
  await assertFile(rgPath, '内置 ripgrep')

  const ptyDir = path.join(resourcesDir, 'node_modules', 'node-pty')
  const native = await findFile(ptyDir, (file) => path.extname(file).toLowerCase() === '.node')
  if (!native) throw new Error(`发行产物 node-pty 缺少原生 .node: ${ptyDir}`)

  const sqliteDir = path.join(resourcesDir, 'node_modules', 'better-sqlite3')
  const sqliteNative = await findFile(
    sqliteDir,
    (file) => path.basename(file).toLowerCase() === 'better_sqlite3.node',
  )
  if (!sqliteNative) throw new Error(`发行产物 better-sqlite3 缺少原生模块: ${sqliteDir}`)

  if (process.platform === 'win32') {
    for (const name of ['conpty.dll', 'OpenConsole.exe']) {
      const found = await findFile(
        ptyDir,
        (file) => path.basename(file).toLowerCase() === name.toLowerCase(),
      )
      if (!found) throw new Error(`发行产物 node-pty 缺少 ${name}: ${ptyDir}`)
    }
  }
}

async function validateOfficialApplications(resourcesDir) {
  const arcaRoot = path.join(resourcesDir, 'applications', 'arca')
  const manifestPath = path.join(arcaRoot, 'manifest.json')
  await assertFile(manifestPath, 'Arca应用清单')
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  if (manifest.applicationId !== 'infos.arca' || manifest.trust !== 'official') {
    throw new Error('Arca发行清单身份或信任级别无效')
  }
  for (const [relative, expected] of Object.entries(manifest.files ?? {})) {
    const target = path.resolve(arcaRoot, relative)
    if (!target.startsWith(`${path.resolve(arcaRoot)}${path.sep}`)) {
      throw new Error(`Arca发行清单包含越界路径: ${relative}`)
    }
    await assertFile(target, `Arca资源 ${relative}`)
    const content = await fs.readFile(target)
    const digest = createHash('sha256').update(content).digest('hex')
    if (content.length !== expected.size || digest !== expected.sha256) {
      throw new Error(`Arca资源完整性校验失败: ${relative}`)
    }
  }
  for (const dependency of manifest.runtime?.externalDependencies ?? []) {
    await assertFile(
      path.join(resourcesDir, 'node_modules', ...dependency.split('/'), 'package.json'),
      `Arca运行依赖 ${dependency}`,
    )
  }
}

function probeHealth(port) {
  return new Promise((resolve) => {
    const request = http.get(
      { host: '127.0.0.1', port, path: '/api/health', timeout: 1000 },
      (response) => {
        let body = ''
        response.on('data', (chunk) => (body += chunk.toString()))
        response.on('end', () => resolve(response.statusCode === 200 && body.includes('"ok"')))
      },
    )
    request.once('timeout', () => {
      request.destroy()
      resolve(false)
    })
    request.once('error', () => resolve(false))
  })
}

async function waitForFile(target, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fsSync.existsSync(target)) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`等待发行烟测文件超时: ${target}`)
}

/** 使用发行版Electron Node运行时启动Arca Host并验证Discovery生命周期。 */
async function validateArcaBoot(appOutDir, resourcesDir, executableName) {
  if (process.platform !== 'win32') return
  const executable = path.join(
    appOutDir,
    executableName.endsWith('.exe') ? executableName : `${executableName}.exe`,
  )
  const host = path.join(resourcesDir, 'applications', 'arca', 'host.mjs')
  const smokeRoot = path.join(appOutDir, '.arca-smoke-data')
  const discoveryPath = path.join(smokeRoot, 'discovery.json')
  const logPath = path.join(appOutDir, '.arca-smoke.log')
  await assertFile(executable, '应用可执行文件')
  await assertFile(host, 'Arca Host')
  await fs.mkdir(smokeRoot, { recursive: true })
  const logFd = fsSync.openSync(logPath, 'a')
  let child
  try {
    child = spawn(executable, [host, '--loopback-port=0'], {
      cwd: appOutDir,
      env: electronProcessEnvironment(
        {
          ...process.env,
          INFOS_ARCA_DATA_PATH: smokeRoot,
          INFOS_ARCA_DISCOVERY_PATH: discoveryPath,
        },
        'node',
      ),
      windowsHide: true,
      stdio: ['ignore', logFd, logFd],
    })
  } finally {
    fsSync.closeSync(logFd)
  }
  try {
    await waitForFile(discoveryPath, 15_000)
    const discovery = JSON.parse(await fs.readFile(discoveryPath, 'utf8'))
    if (
      discovery.application?.appId !== 'infos.arca' ||
      discovery.application?.state !== 'ready' ||
      discovery.pid !== child.pid ||
      !/^ws:\/\/127\.0\.0\.1:\d+$/.test(discovery.endpoint)
    ) {
      throw new Error(`Arca Discovery烟测失败: ${JSON.stringify(discovery)}`)
    }
  } catch (error) {
    const output = await fs.readFile(logPath, 'utf8').catch(() => '')
    throw new Error(`${error}\n${output}`)
  } finally {
    await stopChild(child)
    await Promise.all([removePath(smokeRoot), removePath(logPath)])
  }
}

/** 在真实发行进程中模拟 OneBot 握手，避免主服务正常却丢失社交传输注册。 */
async function validateSocialTransport(port, bundle, token) {
  const { WebSocket } = createRequire(bundle)('ws')
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/social/ws`, {
    headers: { 'X-Self-ID': '10000001', Authorization: `Bearer ${token}` },
  })
  try {
    ws.on('message', (raw) => {
      const request = JSON.parse(String(raw))
      const data =
        request.action === 'get_login_info'
          ? { user_id: 10000001, nickname: '发行验证账号' }
          : request.action === 'get_version_info'
            ? { app_name: '发行验证', app_version: '1' }
            : []
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ status: 'ok', retcode: 0, echo: request.echo, data }))
    })
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('社交 WebSocket 握手超时')), 5000)
      ws.once('open', () => {
        clearTimeout(timer)
        resolve()
      })
      ws.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
    })
    const status = await new Promise((resolve, reject) => {
      const request = http.get(
        `http://127.0.0.1:${port}/api/social/status`,
        { headers: { Authorization: `Bearer ${token}` } },
        (response) => {
          let body = ''
          response.on('data', (chunk) => {
            body += chunk
          })
          response.on('end', () => {
            try {
              if (response.statusCode !== 200)
                throw new Error(`社交状态接口返回 ${response.statusCode}`)
              resolve(JSON.parse(body))
            } catch (error) {
              reject(error)
            }
          })
        },
      )
      request.setTimeout(5000, () => request.destroy(new Error('社交状态接口超时')))
      request.on('error', reject)
    })
    if (
      ws.readyState !== WebSocket.OPEN ||
      !status.data?.adapters?.some(
        (adapter) => adapter.platform === 'qq' && adapter.connected && adapter.latencyMs >= 0,
      )
    ) {
      throw new Error('发行验证失败：QQ 反向 WebSocket 未注册到社交适配器')
    }
  } finally {
    ws.terminate()
  }
}

/** 使用打包后的 Electron Node 运行时执行 Daemon，验证真实发行环境可启动。 */
async function validateDaemonBoot(appOutDir, resourcesDir, executableName) {
  if (process.platform !== 'win32') return
  const executable = path.join(
    appOutDir,
    process.platform === 'win32' && !executableName.endsWith('.exe')
      ? `${executableName}.exe`
      : executableName,
  )
  const bundle = path.join(resourcesDir, 'daemon', 'daemon.mjs')
  await assertFile(executable, '应用可执行文件')
  await assertFile(bundle, '内置 Daemon bundle')

  const dataDir = path.join(appOutDir, '.daemon-smoke-data')
  const logPath = path.join(appOutDir, '.daemon-smoke.log')
  // 仅此烟测进程使用，管理接口仍通过正式鉴权，不读取或改写用户凭据。
  const token = randomBytes(32).toString('hex')
  await fs.mkdir(dataDir, { recursive: true })
  const logFd = fsSync.openSync(logPath, 'a')
  let child
  try {
    child = spawn(executable, [bundle], {
      cwd: appOutDir,
      env: electronProcessEnvironment(
        {
          ...process.env,
          PERO_PORT: '19120',
          INFOS_API_TOKEN: token,
          PERO_DATA_DIR: dataDir,
          PERO_APP_ROOT: path.join(resourcesDir, 'backend'),
          INFOS_RESOURCES_ROOT: resourcesDir,
          PERO_WORKSHOP_DIRS: '[]',
        },
        'node',
      ),
      windowsHide: true,
      // 与正式 PortableDaemon 完全一致：使用已经打开的同步文件描述符。
      stdio: ['ignore', logFd, logFd],
    })
  } finally {
    fsSync.closeSync(logFd)
  }

  try {
    const readOutput = async () => {
      try {
        return await fs.readFile(logPath, 'utf8')
      } catch {
        return ''
      }
    }
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      if (await probeHealth(19120)) {
        await validateSocialTransport(19120, bundle, token)
        return
      }
      if (child.exitCode !== null) {
        throw new Error(`Daemon 提前退出，exitCode=${child.exitCode}\n${await readOutput()}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    throw new Error(`Daemon 启动验证超时\n${await readOutput()}`)
  } finally {
    await stopChild(child)
    await Promise.all([
      removePath(dataDir),
      removePath(logPath),
      removePath(path.join(appOutDir, '.infos-runtime-locks')),
    ])
  }
}

// 可独立验证真实网络鉴权契约，无需执行 Electron 打包。
exports.validateSocialTransport = validateSocialTransport

exports.default = async function afterPack(context) {
  const appOutDir = context.appOutDir
  const resourcesDir = path.join(appOutDir, 'resources')

  // 壳层开屏独立于业务服务，发行包必须携带完整本地资源。
  for (const name of ['index.html', 'splash.css', 'splash.js', 'artwork.png']) {
    await assertFile(path.join(resourcesDir, 'splash', name), `splash/${name}`)
  }

  // 所有桌面发行版都携带内置 Daemon；仅便携版在 exe 同级生成便携标记。
  if (process.env.INFOS_EDITION === 'portable') {
    await fs.writeFile(path.join(appOutDir, '.portable'), '')
  } else {
    await removePath(path.join(appOutDir, '.portable'))
  }

  // 标准版、Steam 版和便携版都必须具备完整且可实际启动的自包含运行时。
  await validatePortableRuntime(resourcesDir)
  await validateOfficialApplications(resourcesDir)
  if (process.platform === 'win32') {
    const productFilename = context.packager.appInfo.productFilename
    const executable = path.join(
      appOutDir,
      productFilename.endsWith('.exe') ? productFilename : `${productFilename}.exe`,
    )
    // afterPack 后还会写入图标与版本资源，烟测只运行副本，避免 Windows 映像锁阻断 rcedit。
    const smokeExecutable = path.join(appOutDir, '.infos-runtime-smoke.exe')
    await fs.copyFile(executable, smokeExecutable)
    try {
      // 检查最终二进制的副本，避免探测产生的短暂映像锁影响后续签名与资源写入。
      await require('./electron-security-after-pack.cjs')(context, smokeExecutable)
      await validateArcaBoot(appOutDir, resourcesDir, path.basename(smokeExecutable))
      await validateDaemonBoot(appOutDir, resourcesDir, path.basename(smokeExecutable))
    } finally {
      await removePath(smokeExecutable)
    }
  }

  if (process.env.INFOS_EDITION === 'steam') return

  await Promise.all([
    removePath(path.join(appOutDir, 'steam_api64.dll')),
    removePath(path.join(appOutDir, 'steam_appid.txt')),
    removePath(path.join(resourcesDir, 'steam')),
    removePath(path.join(resourcesDir, 'app.asar.unpacked', 'node_modules', 'steamworks.js')),
  ])
}
