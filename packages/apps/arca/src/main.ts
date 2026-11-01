/** Arca 独立与托管进程入口，统一处理启动失败和退出。 */
import path from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ApplicationProcessLifetime } from '@infos/node-host'
import { ArcaApplicationHost } from './applicationHost'
import { setLocale, resolveEnvironmentLocale } from '@infos/shared/i18n'
setLocale(resolveEnvironmentLocale(process.env, Intl.DateTimeFormat().resolvedOptions().locale))

function numberFlag(name: string): number | undefined {
  const prefix = `--${name}=`
  const value = process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length)
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error(`参数 --${name} 必须是 0-65535 的整数`)
  }
  return parsed
}

const standalone = process.argv.includes('--standalone') || !process.env.INFOS_ARCA_OWNER_PID
const dataPath =
  (standalone
    ? (process.env.ARCA_DATA_PATH ?? process.env.INFOS_ARCA_DATA_PATH)
    : process.env.INFOS_ARCA_DATA_PATH) ?? path.resolve(process.cwd(), '.arca')
const packagedUi = fileURLToPath(new URL('./ui/', import.meta.url))
let host: ArcaApplicationHost | undefined
const lifetime = new ApplicationProcessLifetime(
  'Arca',
  async () => {
    await host?.stop()
  },
  standalone ? undefined : Number(process.env.INFOS_ARCA_OWNER_PID),
)
process.once('SIGINT', () => void lifetime.shutdown())
process.once('SIGTERM', () => void lifetime.shutdown())
try {
  lifetime.assertRunning()
  host = new ArcaApplicationHost({
    dataPath,
    discoveryPath: standalone
      ? (process.env.ARCA_DISCOVERY_PATH ?? process.env.INFOS_ARCA_DISCOVERY_PATH)
      : process.env.INFOS_ARCA_DISCOVERY_PATH,
    standalone,
    httpPort: numberFlag('port') ?? (standalone ? 7365 : 0),
    uiRoot:
      process.env.ARCA_UI_ROOT ??
      (existsSync(path.join(packagedUi, 'index.html')) ? packagedUi : undefined),
    developmentUi: process.argv.includes('--dev-ui'),
    bindDesktop: standalone ? undefined : (value) => lifetime.bindDesktop(value),
    shutdown: () => lifetime.shutdown(),
  })
  if (!standalone && process.env.INFOS_ARCA_DESKTOP_GUARD)
    await lifetime.bindDesktop(JSON.parse(process.env.INFOS_ARCA_DESKTOP_GUARD))
  lifetime.assertRunning()
  const result = await host.start({ loopbackPort: numberFlag('loopback-port') ?? 0 })
  lifetime.assertRunning()
  process.stdout.write(`Arca 自治 Host 已监听 ws://127.0.0.1:${result.loopbackPort}\n`)
  if (host.browserUrl) process.stdout.write(`打开文稿：${host.browserUrl}\n`)
} catch (error) {
  process.stderr.write(`Arca 启动失败：${String(error)}\n`)
  await lifetime.shutdown(1)
}
