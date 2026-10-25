import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { configuredElectron } = require('./runtime-security.cjs')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cacheHome = path.join(root, '.pnpm-cache', 'electron-rebuild-home')
const npmCache = path.join(root, '.pnpm-cache', 'npm')
fs.mkdirSync(cacheHome, { recursive: true })
fs.mkdirSync(npmCache, { recursive: true })
const rebuildMain = require.resolve('@electron/rebuild')
const rebuildCli = path.join(path.dirname(rebuildMain), 'cli.js')

const result = spawnSync(
  process.execPath,
  [
    rebuildCli,
    '--version',
    configuredElectron(),
    '--module-dir',
    'dist-daemon',
    '--only',
    'better-sqlite3,node-pty',
    '--force',
  ],
  {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      HOME: cacheHome,
      USERPROFILE: cacheHome,
      npm_config_cache: npmCache,
    },
  },
)

if (result.error) throw result.error
process.exit(result.status ?? 1)
