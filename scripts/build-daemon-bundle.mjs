import { t as __t } from './i18n.mjs'
/**
 * Daemon 单文件 Bundle 构建脚本
 *
 * 便携模式（方案 A）需要把后端 Daemon 打进 exe 同级的 resources/daemon/，
 * 由 Electron 主进程用 exe 自带的 Node 运行时（ELECTRON_RUN_AS_NODE=1）拉起。
 *
 * 由于便携包内没有 node_modules，本脚本用 esbuild 把 daemon 入口及其
 * 全部纯 JS 依赖（hono/zod/nunjucks/ws/consola 等）内联成单个 ESM 文件；
 * 仅保留无法内联的「原生/二进制」模块为 external，这些模块随包提供
 * （见 collect-daemon-deps.mjs 与 electron-builder 配置）。
 *
 * @module scripts/build-daemon-bundle
 */

import { createRequire } from 'node:module'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

// 仓库根目录（脚本位于 <root>/scripts/）
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 输出目录（便携包将打包其中的 daemon.mjs） */
const OUT_DIR = path.join(root, 'dist-daemon')
const OUT_FILE = path.join(OUT_DIR, 'daemon.mjs')

/**
 * 解析 pnpm 虚拟存储中的 esbuild 入口
 *
 * pnpm 不会把 esbuild 链接到根 node_modules，这里在 node_modules/.pnpm 下
 * 按版本号排序取最新一份，避免硬编码带 hash 的路径。
 */
function resolveEsbuildEntry() {
  const pnpmDir = path.join(root, 'node_modules', '.pnpm')
  const candidates = fs.existsSync(pnpmDir)
    ? fs
        .readdirSync(pnpmDir)
        .filter((name) => /^esbuild@/.test(name))
        .sort()
    : []
  const latest = candidates[candidates.length - 1]
  if (!latest) {
    throw new Error('未找到 esbuild，请先执行 pnpm install')
  }
  return path.join(pnpmDir, latest, 'node_modules', 'esbuild', 'lib', 'main.js')
}

/** @infos/* 工作区包由 daemon 的 tsconfig paths 映射解析（esbuild 原生支持） */
const DAEMON_TSCONFIG = path.join(root, 'packages/daemon/tsconfig.json')

/** social 应用编译产物（便携包 resources/backend/apps/social/runtime/index.js） */
const SOCIAL_OUT_FILE = path.join(OUT_DIR, 'social-runtime.mjs')

/**
 * 打包策略：
 * - 所有第三方依赖（hono/ws/nunjucks/better-sqlite3 等）通过 packages: 'external'
 *   保持 external —— 它们多为 CJS，ESM 内联会触发动态 require 运行时报错，
 *   统一交给 Node 原生加载（ESM→CJS interop），稳定可靠。
 * - @infos/* 工作区源码由 tsconfig paths 解析后内联进单文件。
 * - 便携包运行时需要随包携带完整生产依赖 node_modules（见 collect-daemon-deps.mjs）。
 */

// ─────────────────────────────────────────────
// 打包
// ─────────────────────────────────────────────

const esbuild = require(resolveEsbuildEntry())

await esbuild.build({
  entryPoints: [path.join(root, 'packages/daemon/src/main.ts')],
  outfile: OUT_FILE,
  bundle: true,
  platform: 'node',
  // ESM 输出：保留 import.meta.url（createRequire 加载原生模块依赖它）
  format: 'esm',
  target: 'node20',
  sourcemap: false,
  // 通过 tsconfig paths 解析 @infos/* 工作区包（映射到各包 src 源码）
  tsconfig: DAEMON_TSCONFIG,
  // 第三方依赖全部 external（CJS 动态 require 交给 Node 原生 interop）
  packages: 'external',
  // 打包产物定位到仓库根，便于 Electron 主进程 require 定位
  absWorkingDir: root,
  logLevel: 'info',
})

// ── 内置社交应用 runtime（动态 import 单独加载，无法内联进 daemon bundle）──
// 独立恢复入口不装配数据库或插件，后端崩溃时仍可离线使用。
await esbuild.build({
  entryPoints: [path.join(root, 'packages/backend/src/recovery.ts')],
  outfile: path.join(OUT_DIR, 'recovery.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  tsconfig: DAEMON_TSCONFIG,
  packages: 'external',
  absWorkingDir: root,
})
await esbuild.build({
  entryPoints: [path.join(root, 'packages/apps/social/runtime/index.ts')],
  outfile: SOCIAL_OUT_FILE,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: false,
  // social runtime 通过相对路径 import backend 源码，用根 tsconfig paths 解析 @infos/*
  tsconfig: path.join(root, 'tsconfig.base.json'),
  packages: 'external',
  absWorkingDir: root,
  logLevel: 'info',
})

function assertNoWorkspaceImports(outputFile) {
  const content = fs.readFileSync(outputFile, 'utf8')
  const matches = [...content.matchAll(/(?:from\s+|import\s*\()(["'])(@infos\/[^"']+)\1/g)].map(
    (match) => match[2],
  )
  if (matches.length) {
    throw new Error(`Daemon 发行产物仍包含未内联的工作区依赖: ${[...new Set(matches)].join(', ')}`)
  }
}

assertNoWorkspaceImports(OUT_FILE)
assertNoWorkspaceImports(SOCIAL_OUT_FILE)
assertNoWorkspaceImports(path.join(OUT_DIR, 'recovery.mjs'))

// 产物体积提示
const sizeMB = (fs.statSync(OUT_FILE).size / 1024 / 1024).toFixed(2)
const socialSizeMB = (fs.statSync(SOCIAL_OUT_FILE).size / 1024 / 1024).toFixed(2)
console.log(
  __t('scripts.build-daemon-bundle', '\n✅ Daemon bundle 已生成: {0} ({1} MB)', [OUT_FILE, sizeMB]),
)
console.log(
  __t('scripts.build-daemon-bundle', '✅ Social runtime bundle 已生成: {0} ({1} MB)', [
    SOCIAL_OUT_FILE,
    socialSizeMB,
  ]),
)
