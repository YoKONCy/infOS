import path from 'node:path'
import { NodeHost } from './nodeHost'
import { OutboundCapabilityClient } from './outboundCapabilityClient'
import { setLocale, resolveEnvironmentLocale } from '@infos/shared/i18n'
setLocale(resolveEnvironmentLocale(process.env, Intl.DateTimeFormat().resolvedOptions().locale))

function readNumberFlag(name: string): number | undefined {
  const prefix = `--${name}=`
  const value = process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error(`参数 --${name} 必须是 0-65535 的整数`)
  }
  return parsed
}

const identityPath =
  process.env.INFOS_NODE_IDENTITY_PATH ??
  path.resolve(process.cwd(), '.infos-node', 'identity.json')
const port = readNumberFlag('loopback-port')
const homeServer = process.env.INFOS_HOME_SERVER?.trim()
const credentialPath = path.resolve(path.dirname(identityPath), 'home-server-credential.json')
const host = new NodeHost({ identityPath })
host.registerProbeProviders()
host.registerSystemShellProvider()
await host.start()
const outbound = homeServer
  ? new OutboundCapabilityClient(
      homeServer,
      credentialPath,
      () => host.hello(),
      host.runtime,
      process.env.INFOS_PAIRING_CODE ?? '',
    )
  : undefined
outbound?.start()

if (port === undefined) {
  process.stdout.write('Node Host 已启动；未配置 --loopback-port，因此未开启任何网络监听\n')
} else {
  const actualPort = await host.listenLoopback(port)
  process.stdout.write(`Node Host Loopback 探针已监听 ws://127.0.0.1:${actualPort}\n`)
}
process.stdout.write(`${JSON.stringify(host.diagnostics())}\n`)

const shutdown = async () => {
  await outbound?.stop()
  await host.stop()
  process.exit(0)
}
process.once('SIGINT', () => void shutdown())
process.once('SIGTERM', () => void shutdown())
