import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

export interface PackageDependencyPreparer {
  prepare(root: string): Promise<void>
}

/** 使用随发行版携带的 pnpm；不依赖用户的 Node、npm 或系统 PATH。 */
export class PackageDependencies implements PackageDependencyPreparer {
  constructor(
    private readonly storeDir: string,
    private readonly registry = 'https://registry.npmjs.org/',
  ) {}

  async prepare(root: string): Promise<void> {
    let text: string
    try {
      text = await readFile(path.join(root, 'package.json'), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const input = JSON.parse(text)
    const dependencies = { ...input.dependencies, ...input.optionalDependencies }
    for (const [name, version] of Object.entries(dependencies)) {
      if (
        !/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name) ||
        typeof version !== 'string' ||
        !/^[~^]?\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(version)
      )
        throw new Error('PACKAGE_DEPENDENCY_SPEC_UNSUPPORTED')
    }
    // 插件的生命周期脚本与 pnpm 配置不能控制依赖准备过程。
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify(
        {
          name: input.name,
          version: input.version,
          type: input.type ?? 'module',
          dependencies,
        },
        null,
        2,
      ),
    )
    if (!Object.keys(dependencies).length) return
    const require = createRequire(import.meta.url)
    const cli = path.join(path.dirname(require.resolve('pnpm')), 'bin/pnpm.cjs')
    await new Promise<void>((resolve, reject) => {
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !/^(npm_config_|pnpm_|node_options|node_path)/i.test(key),
        ),
      )
      const child = spawn(
        process.execPath,
        [
          cli,
          'install',
          '--prod',
          '--ignore-scripts',
          '--ignore-pnpmfile',
          '--ignore-workspace',
          '--config.manage-package-manager-versions=false',
          '--store-dir',
          this.storeDir,
          `--config.registry=${this.registry}`,
          '--config.userconfig=',
          '--config.globalconfig=',
          '--no-frozen-lockfile',
        ],
        {
          cwd: root,
          env: { ...env, CI: 'true', ELECTRON_RUN_AS_NODE: '1' },
          windowsHide: true,
          stdio: ['ignore', 'ignore', 'pipe'],
        },
      )
      let stderr = ''
      child.stderr?.on('data', (chunk) => {
        stderr = (stderr + chunk).slice(-4000)
      })
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error('PACKAGE_DEPENDENCY_TIMEOUT'))
      }, 120_000)
      child.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.once('exit', (code) => {
        clearTimeout(timer)
        if (code === 0) resolve()
        else reject(new Error(`PACKAGE_DEPENDENCY_FAILED: ${code} ${stderr}`))
      })
    })
  }
}
