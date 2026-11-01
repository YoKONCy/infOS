import { t as __t } from './i18n.mjs'
/**
 * 官方应用发行资源构建脚本
 *
 * 按官方应用定义打包独立 Host，并收集已提供的 Client 与迁移资源，
 * 并生成带SHA-256的应用清单。Electron Builder只消费该目录，不读取源码树。
 */
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outputRoot = path.join(root, 'dist-applications')
const rootManifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

function resolveEsbuildEntry() {
  const pnpmDir = path.join(root, 'node_modules', '.pnpm')
  const candidates = fs
    .readdirSync(pnpmDir)
    .filter((name) => /^esbuild@/.test(name))
    .sort()
  const latest = candidates[candidates.length - 1]
  if (!latest) throw new Error('未找到esbuild，请先执行pnpm install')
  return path.join(pnpmDir, latest, 'node_modules', 'esbuild', 'lib', 'main.js')
}

function copyDirectory(source, target) {
  if (!fs.existsSync(source)) throw new Error(`发行资源不存在: ${source}`)
  fs.mkdirSync(target, { recursive: true })
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name)
    const targetPath = path.join(target, entry.name)
    if (entry.isDirectory()) copyDirectory(sourcePath, targetPath)
    else fs.copyFileSync(sourcePath, targetPath)
  }
}

function listFiles(directory, base = directory) {
  const files = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...listFiles(absolute, base))
    else files.push(path.relative(base, absolute).replaceAll(path.sep, '/'))
  }
  return files.sort()
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

const applications = [
  {
    directory: 'arca',
    id: 'infos.arca',
    name: 'Arca',
    config: 'tsconfig.host.json',
    client: true,
    external: ['better-sqlite3', 'tiktoken', 'ws'],
  },
  {
    directory: 'pictoria',
    id: 'infos.pictoria',
    name: 'Pictoria',
    config: 'tsconfig.json',
    client: true,
    migrations: true,
    external: ['better-sqlite3', 'ajv', 'zod', 'ws', '@noble/hashes'],
  },
]
const selected = process.argv.find((argument) => argument.startsWith('--app='))?.slice(6)
if (selected && !applications.some((entry) => entry.directory === selected))
  throw new Error('指定的官方应用不存在')
fs.mkdirSync(outputRoot, { recursive: true })
const esbuild = require(resolveEsbuildEntry())
for (const application of applications.filter(
  (entry) => !selected || entry.directory === selected,
)) {
  const appRoot = path.join(root, 'packages', 'apps', application.directory)
  const output = path.join(outputRoot, application.directory)
  if (path.dirname(path.resolve(output)) !== path.resolve(outputRoot))
    throw new Error('应用发行路径越界')
  if (fs.existsSync(output)) fs.rmSync(output, { recursive: true, force: true })
  fs.mkdirSync(output, { recursive: true })
  const hostBuild = await esbuild.build({
    entryPoints: [path.join(appRoot, 'src', 'main.ts')],
    outfile: path.join(output, 'host.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    sourcemap: false,
    tsconfig: path.join(appRoot, application.config),
    packages: 'external',
    absWorkingDir: root,
    logLevel: 'info',
    metafile: true,
    external: application.external,
  })
  const externalDependencies = [
    ...new Set(
      Object.values(hostBuild.metafile.outputs)
        .flatMap((entry) => entry.imports)
        .filter((entry) => entry.external && !entry.path.startsWith('node:'))
        .map((entry) =>
          entry.path.startsWith('@')
            ? entry.path.split('/').slice(0, 2).join('/')
            : entry.path.split('/')[0],
        ),
    ),
  ].sort()
  const unsupported = externalDependencies.filter(
    (dependency) => !application.external.includes(dependency),
  )
  if (unsupported.length)
    throw new Error(application.name + ' 后台包含未声明的发行依赖：' + unsupported.join(', '))
  if (application.client) {
    execFileSync('pnpm', ['--filter', '@infos/' + application.directory, 'build:client'], {
      cwd: root,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
    copyDirectory(path.join(appRoot, 'client', 'dist'), path.join(output, 'ui'))
    if (!fs.existsSync(path.join(output, 'ui', 'index.html'))) throw new Error('应用客户端资源缺失')
  }
  if (application.migrations)
    copyDirectory(
      path.join(appRoot, 'src', 'database', 'migrations'),
      path.join(output, 'database', 'migrations'),
    )
  const files = listFiles(output)
  const manifest = {
    schemaVersion: 1,
    applicationId: application.id,
    displayName: application.name,
    version: rootManifest.version,
    trust: 'official',
    runtime: {
      host: 'host.mjs',
      ...(application.client ? { ui: 'ui/index.html' } : {}),
      externalDependencies,
    },
    files: Object.fromEntries(
      files.map((file) => [
        file,
        {
          size: fs.statSync(path.join(output, file)).size,
          sha256: sha256(path.join(output, file)),
        },
      ]),
    ),
  }
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  if (!fs.existsSync(path.join(output, 'host.mjs'))) throw new Error('应用后台资源缺失')
  console.log(
    __t('scripts.build-official-apps', '官方应用发行资源已生成：') +
      application.name +
      __t('scripts.build-official-apps', '，文件数量：') +
      (files.length + 1),
  )
}
