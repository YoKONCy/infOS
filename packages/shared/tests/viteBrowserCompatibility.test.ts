import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  loadConfigFromFile,
  type ESBuildOptions,
  type ESBuildTransformResult,
  type UserConfig,
} from 'vite'
import { browserTargets } from '../../../scripts/vite-browser-compat'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const require = createRequire(import.meta.url)
// 必须使用 Vite 实际解析到的 esbuild，避免用测试框架的另一份版本掩盖兼容问题。
const viteRequire = createRequire(require.resolve('vite/package.json'))
const esbuild: {
  transform: (code: string, options: ESBuildOptions) => Promise<ESBuildTransformResult>
} = viteRequire('esbuild')
const vueRequire = createRequire(require.resolve('vue/package.json'))
const runtimeRequire = createRequire(vueRequire.resolve('@vue/runtime-dom/package.json'))
const reactivityFile = runtimeRequire.resolve('@vue/reactivity/dist/reactivity.esm-bundler.js')
const oldTargets = ['es2020', 'chrome87', 'edge88', 'firefox78', 'safari14']
afterEach(() => vi.unstubAllGlobals())

describe('Vite 与安全版 esbuild 的浏览器目标兼容', () => {
  it('实际 Vue 响应式源码在旧目标下复现故障，在新目标下可以转换', async () => {
    const code = await readFile(reactivityFile, 'utf8')
    await expect(
      esbuild.transform(code, { target: oldTargets, logLevel: 'silent' }),
    ).rejects.toThrow('Transforming destructuring')
    const result = await esbuild.transform(code, { target: browserTargets, format: 'esm' })
    expect(result.code).toContain('createInstrumentations')
    expect(result.warnings).toEqual([])
  })

  it.each([
    ['Arca', 'packages/apps/arca/client/vite.config.ts'],
    ['Pictoria', 'packages/apps/pictoria/client/vite.config.ts'],
    ['Web', 'packages/frontend/vite.config.ts'],
    ['Electron', 'electron.vite.config.ts'],
  ])('%s 的实际配置显式覆盖依赖预打包目标', async (name, file) => {
    // runner 在内存加载配置，不向 node_modules 写临时配置构建产物。
    // 默认 bundle 加载器会注入配置所在目录；runner 测试显式补齐同一值。
    vi.stubGlobal('__dirname', dirname(resolve(root, file)))
    const loaded = await loadConfigFromFile(
      { command: 'serve', mode: 'development' },
      resolve(root, file),
      root,
      'silent',
      undefined,
      'runner',
    )
    expect(loaded).toBeTruthy()
    const config =
      name === 'Electron'
        ? (loaded!.config as UserConfig & { renderer: UserConfig }).renderer
        : loaded!.config
    expect(config.optimizeDeps?.esbuildOptions?.target).toEqual(browserTargets)
    if (name === 'Web') expect(config.build?.target).toEqual(browserTargets)
    if (name === 'Arca' || name === 'Pictoria') expect(config.build?.target).toBe('es2022')
  })
})
