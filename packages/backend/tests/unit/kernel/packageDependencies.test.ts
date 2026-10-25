import { describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { PackageDependencies } from '@infos/backend/packages/packageDependencies'

/** 仅创建本地 npm 协议夹具，不运行第三方包或插件。 */
function tarball() {
  const contents = Buffer.from(
    JSON.stringify({
      name: 'infos-dependency-fixture',
      version: '1.0.0',
      scripts: { install: 'node -e "process.exit(99)"' },
    }),
  )
  const header = Buffer.alloc(512)
  header.write('package/package.json')
  header.write('0000644\0', 100)
  header.write('0000000\0', 108)
  header.write('0000000\0', 116)
  header.write(contents.length.toString(8).padStart(11, '0') + '\0', 124)
  header.write('00000000000\0', 136)
  header.fill(32, 148, 156)
  header.write('0', 156)
  header.write('ustar\0', 257)
  header.write('00', 263)
  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148)
  return gzipSync(
    Buffer.concat([header, contents, Buffer.alloc(512 - contents.length), Buffer.alloc(1024)]),
  )
}

describe('随发行版携带的独立依赖运行器', () => {
  it('用真实 pnpm 连接本地模拟 registry，安装到插件目录且跳过生命周期脚本', async () => {
    const base = path.resolve('TEMP/plugin-infrastructure')
    await mkdir(base, { recursive: true })
    const root = await mkdtemp(path.join(base, 'pnpm-'))
    if (!root.startsWith(base + path.sep)) throw new Error('测试清理路径越界')
    const bytes = tarball()
    let url = ''
    const server = createServer((request, response) => {
      if (request.url?.endsWith('.tgz')) {
        response.end(bytes)
        return
      }
      response.setHeader('Content-Type', 'application/json')
      response.end(
        JSON.stringify({
          name: 'infos-dependency-fixture',
          'dist-tags': { latest: '1.0.0' },
          versions: {
            '1.0.0': {
              name: 'infos-dependency-fixture',
              version: '1.0.0',
              dist: {
                tarball: `${url}fixture.tgz`,
                integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
              },
            },
          },
        }),
      )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`
    try {
      const plugin = path.join(root, 'plugin')
      await mkdir(plugin)
      await writeFile(
        path.join(plugin, 'package.json'),
        JSON.stringify({
          name: 'infos-local-fixture',
          version: '1.0.0',
          dependencies: { 'infos-dependency-fixture': '1.0.0' },
        }),
      )
      await new PackageDependencies(path.join(root, 'store'), url).prepare(plugin)
      const installed = JSON.parse(
        await readFile(
          path.join(plugin, 'node_modules/infos-dependency-fixture/package.json'),
          'utf8',
        ),
      )
      expect(installed.version).toBe('1.0.0')
      expect(await readFile(path.join(plugin, 'pnpm-lock.yaml'), 'utf8')).toContain(
        'infos-dependency-fixture',
      )
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
      await rm(root, { recursive: true, force: true })
    }
  }, 30000)
})
