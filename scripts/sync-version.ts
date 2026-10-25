import { t as __t } from './i18n.mjs'
/**
 * 版本号同步脚本 (TypeScript)
 *
 * 唯一事实来源: 根 package.json 的 version 字段。
 * 本脚本将该版本号同步到所有子包 package.json，
 * 以及前后端源码中的硬编码版本号。
 *
 * 用法: pnpm version:sync [--version 0.9.5 | --check]
 * 执行: tsx scripts/sync-version.ts
 *
 * @module scripts/sync-version
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ─── 项目根目录 ──────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT = path.resolve(__dirname, '..')

// ─── 唯一的版本事实来源: 根 package.json ──────────────────
const rootPkgPath = path.join(ROOT, 'package.json')
if (!fs.existsSync(rootPkgPath)) {
  console.error(
    __t('scripts.sync-version', '[版本同步] ❌ 根 package.json 不存在！预期路径:'),
    rootPkgPath,
  )
  process.exit(1)
}

interface PackageJson {
  version: string
  [key: string]: unknown
}

const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
const versionIndex = args.indexOf('--version')
if (
  args.some(
    (arg, index) =>
      arg !== '--check' &&
      arg !== '--version' &&
      !(versionIndex >= 0 && index === versionIndex + 1),
  )
)
  throw new Error('[版本同步] 存在未知参数')
if (checkOnly && versionIndex >= 0) throw new Error('[版本同步] --check 不能与 --version 同用')
const rootPkg: PackageJson = JSON.parse(fs.readFileSync(rootPkgPath, 'utf8'))
if (versionIndex >= 0) {
  const requestedVersion = args[versionIndex + 1]
  if (!requestedVersion) throw new Error('[版本同步] --version 缺少目标版本')
  rootPkg.version = requestedVersion
}
const VERSION = rootPkg.version
const BROWSER_VERSION = toBrowserVersion(VERSION)
// 先核对所有目标，再统一写入，避免悬空路径使版本只同步了一半。
const pending = new Map<string, string>()
if (versionIndex >= 0) pending.set(rootPkgPath, JSON.stringify(rootPkg, null, 2) + '\n')

console.log(
  __t('scripts.sync-version', '\n[版本同步] 🎯 唯一事实来源 → package.json: {0}', [VERSION]),
)
console.log('═'.repeat(55))

let updatedCount = 0
let checkedCount = 0

// ─── 工具函数 ──────────────────────────────────────────

/** Chrome 扩展 version 仅允许 1-4 段数字；预发布序号映射到第四段。 */
function toBrowserVersion(version: string): string {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-[A-Za-z]+(\d+))?$/)
  if (!match) throw new Error(`[版本同步] 无法转换为浏览器扩展版本: ${version}`)
  const [, major, minor, patch, prerelease] = match
  return prerelease ? `${major}.${minor}.${patch}.${prerelease}` : `${major}.${minor}.${patch}`
}

/** 同步浏览器扩展清单：version 为 Chrome 数字格式，version_name 保留完整 SemVer。 */
function syncBrowserManifest(relPath: string, required = true): void {
  const fullPath = path.join(ROOT, relPath)
  if (!fs.existsSync(fullPath)) {
    if (required) throw new Error(`[版本同步] 必需文件不存在: ${relPath}`)
    console.log(__t('scripts.sync-version', '[版本同步] ⏭️  {0} 不存在，跳过可选同步', [relPath]))
    return
  }
  checkedCount++
  const manifest = JSON.parse(fs.readFileSync(fullPath, 'utf8')) as Record<string, unknown>
  if (typeof manifest.version !== 'string' || typeof manifest.version_name !== 'string') {
    throw new Error(`[版本同步] ${relPath} 缺少 version 或 version_name`)
  }
  if (manifest.version !== BROWSER_VERSION || manifest.version_name !== VERSION) {
    manifest.version = BROWSER_VERSION
    manifest.version_name = VERSION
    pending.set(fullPath, JSON.stringify(manifest, null, 2) + '\n')
    console.log(
      __t('scripts.sync-version', '[版本同步] ✅ {0}: {1} / {2}', [
        relPath,
        BROWSER_VERSION,
        VERSION,
      ]),
    )
    updatedCount++
  }
}

/** 同步 JSON 文件中的 version 字段。仅本地私有嵌套仓库允许缺失。 */
function syncJsonVersion(relPath: string, required = true): void {
  const fullPath = path.join(ROOT, relPath)
  if (!fs.existsSync(fullPath)) {
    if (required) throw new Error(`[版本同步] 必需文件不存在: ${relPath}`)
    console.log(
      __t('scripts.sync-version', '[版本同步] ⏭️  {0} 本地私有嵌套仓库未检出，跳过', [relPath]),
    )
    return
  }
  checkedCount++
  const pkg: PackageJson = JSON.parse(fs.readFileSync(fullPath, 'utf8'))
  if (typeof pkg.version !== 'string' || !pkg.version) {
    throw new Error(`[版本同步] ${relPath} 缺少有效 version 字段`)
  }
  if (pkg.version !== VERSION) {
    const oldVersion = pkg.version
    pkg.version = VERSION
    pending.set(fullPath, JSON.stringify(pkg, null, 2) + '\n')
    console.log(
      __t('scripts.sync-version', '[版本同步] ✅ {0}: {1} → {2}', [relPath, oldVersion, VERSION]),
    )
    updatedCount++
  }
}

/**
 * 同步 TypeScript 源码中的硬编码版本号
 * @param relPath - 相对于项目根的文件路径
 * @param pattern - 待替换的正则表达式
 * @param replacement - 替换内容（使用 VERSION 变量）
 * @param label - 日志标签
 */
function syncSourceVersion(
  relPath: string,
  pattern: RegExp,
  replacement: string,
  label: string,
  required = true,
): void {
  const fullPath = path.join(ROOT, relPath)
  if (!fs.existsSync(fullPath)) {
    if (required) throw new Error(`[版本同步] 必需文件不存在: ${relPath}`)
    console.log(__t('scripts.sync-version', '[版本同步] ⏭️  {0} 不存在，跳过可选同步', [relPath]))
    return
  }
  checkedCount++
  const content = pending.get(fullPath) ?? fs.readFileSync(fullPath, 'utf8')
  if (!pattern.test(content)) {
    if (required) throw new Error(`[版本同步] ${relPath} 未匹配到 ${label}`)
    console.log(
      __t('scripts.sync-version', '[版本同步] ⏭️  {0} 当前无 {1}，跳过可选同步', [relPath, label]),
    )
    return
  }
  pattern.lastIndex = 0
  const replaced = content.replace(pattern, replacement)
  if (content !== replaced) {
    pending.set(fullPath, replaced)
    console.log(
      __t('scripts.sync-version', '[版本同步] ✅ {0} {1} → {2}', [relPath, label, VERSION]),
    )
    updatedCount++
  }
}

// ═══════════════════════════════════════════════════════
// 1. 同步所有子包 package.json
// ═══════════════════════════════════════════════════════
console.log(__t('scripts.sync-version', '\n── 📦 子包 package.json ──'))

const subPackagePaths = [
  'packages/shared/package.json',
  'packages/backend/package.json',
  'packages/frontend/package.json',
  'packages/daemon/package.json',
  'packages/apps/social/package.json',
  'packages/apps/arca/package.json',
  'packages/apps/pictoria/package.json',
  'packages/avatar-assets/package.json',
  'packages/document-engine/package.json',
  'packages/node-sdk/package.json',
  'packages/node-host/package.json',
  'packages/wiki/package.json',
  'electron/package.json',
]

// 与 pnpm-workspace.yaml 中 packages/*、packages/apps/*、electron 的发现范围一致。
const discoveredPackages = ['packages', 'packages/apps'].flatMap((directory) =>
  fs
    .readdirSync(path.join(ROOT, directory), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${directory}/${entry.name}/package.json`)
    .filter((relPath) => fs.existsSync(path.join(ROOT, relPath))),
)
for (const relPath of [...new Set([...subPackagePaths, ...discoveredPackages])].sort()) {
  syncJsonVersion(relPath)
}

console.log(__t('scripts.sync-version', '\n── 🧩 应用与扩展清单 ──'))
syncJsonVersion('packages/apps/social/app.manifest.json')
syncBrowserManifest('packages/browser-extension/manifest.json', false)

// ═══════════════════════════════════════════════════════
// 3. 同步后端源码中的硬编码版本号
// ═══════════════════════════════════════════════════════
console.log(__t('scripts.sync-version', '\n── 🖥️  后端源码 ──'))

// 3a. system.router.ts — APP_VERSION 常量
syncSourceVersion(
  'packages/backend/src/routers/system.router.ts',
  /const APP_VERSION\s*=\s*'[^']*'/,
  `const APP_VERSION = '${VERSION}'`,
  'APP_VERSION',
)

// 3b. health.router.ts — 健康检查端点的 version 字段
syncSourceVersion(
  'packages/backend/src/routers/health.router.ts',
  /version:\s*'[^']*'/,
  `version: '${VERSION}'`,
  'health.version',
)

// 3c. mcpClientManager.ts — MCP 客户端版本标识
syncSourceVersion(
  'packages/backend/src/services/mcp/mcpClientManager.ts',
  /\{\s*name:\s*`infos-\$\{name\}`,\s*version:\s*'[^']*'\s*\}/,
  `{ name: \`infos-\${name}\`, version: '${VERSION}' }`,
  'MCP client version',
)

syncSourceVersion(
  'packages/backend/src/services/distributed/distributedSyncService.ts',
  /const APP_VERSION\s*=\s*'[^']*'/,
  `const APP_VERSION = '${VERSION}'`,
  'distributed APP_VERSION',
)

syncSourceVersion(
  'packages/backend/src/services/backup/backupService.ts',
  /const APP_VERSION\s*=\s*'[^']*'/,
  `const APP_VERSION = '${VERSION}'`,
  'backup APP_VERSION',
)

syncSourceVersion(
  'packages/apps/arca/src/applicationHost.ts',
  /appVersion:\s*'[^']*'/,
  `appVersion: '${VERSION}'`,
  'Arca host appVersion',
)

syncSourceVersion(
  'packages/apps/arca/src/manifest.ts',
  /versions:\s*'[^']*'/,
  `versions: '>=${VERSION} <1.0.0'`,
  'Arca host version range',
)

syncSourceVersion(
  'packages/apps/pictoria/src/host.ts',
  /appVersion:\s*'[^']*'/,
  `appVersion: '${VERSION}'`,
  'Pictoria Host 版本',
)

syncSourceVersion(
  'packages/apps/pictoria/src/manifest.ts',
  /versions:\s*'[^']*'/,
  `versions: '>=${VERSION} <1.0.0'`,
  'Pictoria Host 版本范围',
)

syncSourceVersion(
  'packages/backend/tests/unit/capabilities/arcaApplicationController.test.ts',
  /appVersion:\s*'[^']*'/,
  `appVersion: '${VERSION}'`,
  'Arca controller fixture appVersion',
)

syncSourceVersion(
  'packages/backend/src/services/weather/weatherService.ts',
  /infOS\/\d+\.\d+\.\d+(?:-[\w.-]+)?(?= \()/,
  `infOS/${VERSION}`,
  '天气请求 User-Agent 版本',
)

console.log(__t('scripts.sync-version', '\n── 📖 当前文档与 Wiki 展示 ──'))
syncSourceVersion(
  'packages/wiki/.vitepress/components/MoePixelHome.vue',
  /v\d+\.\d+\.\d+(?:-[\w.-]+)?/g,
  `v${VERSION}`,
  'Wiki 首页版本',
)
syncSourceVersion(
  'packages/wiki/.vitepress/components/ArchitectureGraph.vue',
  /v\d+\.\d+\.\d+(?:-[\w.-]+)?(?=<)/,
  `v${VERSION}`,
  'Wiki 架构图版本',
)
for (const entry of fs.readdirSync(path.join(ROOT, '.docs'), { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.md')) continue
  const relPath = `.docs/${entry.name}`
  const pattern = /^(> \*\*版本\*\*：)\S+/m
  if (pattern.test(fs.readFileSync(path.join(ROOT, relPath), 'utf8')))
    syncSourceVersion(relPath, pattern, `> **版本**：${VERSION}`, '当前规范版本')
}

// ═══════════════════════════════════════════════════════
// 4. 同步 docker-compose.yml 镜像标签 (如果存在 image 字段)
// ═══════════════════════════════════════════════════════
console.log('\n── 🐳 Docker ──')

syncSourceVersion(
  'docker-compose.yml',
  /image:\s*infos-backend:[\w.-]+/g,
  `image: infos-backend:${VERSION}`,
  'image tag',
  false,
)

// ═══════════════════════════════════════════════════════
// 结果汇报
// ═══════════════════════════════════════════════════════
console.log('\n' + '═'.repeat(55))
if (checkOnly && pending.size) {
  console.error(
    __t(
      'scripts.sync-version',
      '[版本同步] ❌ 发现 {0} 个文件版本不一致，请运行 pnpm version:sync',
      [pending.size],
    ),
  )
  process.exit(1)
} else if (!checkOnly) {
  for (const [file, content] of pending) fs.writeFileSync(file, content)
}
if (updatedCount === 0) {
  console.log(
    __t('scripts.sync-version', '[版本同步] ✨ 全部 {0} 个检查点已是最新 ({1})，无需更新', [
      checkedCount,
      VERSION,
    ]),
  )
} else {
  console.log(
    __t('scripts.sync-version', '[版本同步] 🎉 检查 {0} 个点，已同步 {1} 个文件到 {2}', [
      checkedCount,
      updatedCount,
      VERSION,
    ]),
  )
}
console.log()
