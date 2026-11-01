const fs = require('node:fs/promises')
const path = require('node:path')
const { createRequire } = require('node:module')
const { createHash } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { Arch } = require('electron-builder')
const { electronProcessEnvironment } = require('./electron-environment.cjs')

const projectRequire = createRequire(path.join(__dirname, '..', 'package.json'))

/** 按发行目标收集 Koffi 平台包，不依赖打包器遍历传递可选依赖。 */
async function prepareKoffiRuntime(context) {
  const { t } = await import('./i18n.mjs')
  const platform = context.electronPlatformName
  const arch = Arch[context.arch] ?? String(context.arch)
  if (platform !== 'win32' || arch !== 'x64') {
    throw new Error(
      t('scripts.electron-native-runtime', '不支持的桌面原生模块发行目标：{0}/{1}', [
        platform,
        arch,
      ]),
    )
  }

  let source
  let version
  let license
  try {
    const entry = projectRequire.resolve('koffi')
    const packageRoot = path.dirname(entry)
    const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'))
    const nativePackage = `@koromix/koffi-${platform}-${arch}`
    // 从 Koffi 自身的依赖作用域解析，兼容 pnpm 的隔离目录。
    const nativeManifestPath = createRequire(entry).resolve(`${nativePackage}/package.json`)
    const nativeManifest = JSON.parse(await fs.readFile(nativeManifestPath, 'utf8'))
    if (nativeManifest.name !== nativePackage || nativeManifest.version !== manifest.version) {
      throw new Error(
        t('scripts.electron-native-runtime', 'Koffi 主包与平台包版本不一致：{0} / {1}', [
          manifest.version,
          nativeManifest.version,
        ]),
      )
    }
    version = manifest.version
    source = path.join(path.dirname(nativeManifestPath), `${platform}_${arch}`, 'koffi.node')
    license = path.join(packageRoot, 'LICENSE.txt')
    await fs.access(source)
    await fs.access(license)
  } catch (error) {
    throw new Error(
      t('scripts.electron-native-runtime', 'Koffi 发行源不完整：{0}', [String(error)]),
    )
  }

  // resources/koffi 是上游加载器支持的查找位置，无需改写上游模块或 ASAR。
  const directory = path.join(context.appOutDir, 'resources', 'koffi')
  const relative = `${platform}_${arch}/koffi.node`
  const binaryPath = path.join(directory, ...relative.split('/'))
  await fs.mkdir(path.dirname(binaryPath), { recursive: true })
  await fs.copyFile(source, binaryPath)
  await fs.copyFile(license, path.join(directory, 'LICENSE.txt'))
  const sha256 = createHash('sha256')
    .update(await fs.readFile(binaryPath))
    .digest('hex')
  await fs.writeFile(
    path.join(directory, 'runtime-manifest.json'),
    JSON.stringify(
      { schemaVersion: 1, module: 'koffi', version, platform, arch, binary: relative, sha256 },
      null,
      2,
    ) + '\n',
  )
  return {
    binaryPath,
    resourcesPath: path.join(context.appOutDir, 'resources'),
    version,
    platform,
    arch,
    sha256,
  }
}

/** 从发行包的公共 Koffi 入口加载，验证真实查找路径与 PTT 所用的 Windows FFI 调用。 */
async function validateKoffiRuntime(runtime, executable) {
  const { t } = await import('./i18n.mjs')
  const probe = `
    if (!process.versions.electron) throw new Error('KOFFI_PROBE_REQUIRES_ELECTRON');
    const path = require('node:path');
    if (path.resolve(process.resourcesPath) !== path.resolve(process.argv[1])) throw new Error('KOFFI_RESOURCES_PATH_MISMATCH');
    const appRequire = require('node:module').createRequire(path.join(process.argv[1], 'app.asar', 'package.json'));
    const manifestPath = path.join(path.dirname(appRequire.resolve('koffi')), 'package.json');
    const manifest = JSON.parse(require('node:fs').readFileSync(manifestPath, 'utf8'));
    if (manifest.version !== process.argv[2]) throw new Error('KOFFI_PACKAGE_VERSION_MISMATCH');
    const koffi = appRequire('koffi');
    if (koffi.version !== process.argv[2]) throw new Error('KOFFI_NATIVE_VERSION_MISMATCH');
    const user32 = koffi.load('user32.dll');
    const keyState = user32.func('short __stdcall GetAsyncKeyState(int vKey)');
    if (typeof keyState(0) !== 'number') throw new Error('KOFFI_WIN32_INPUT_PROBE_FAILED');
    process.stdout.write(JSON.stringify({version:koffi.version,platform:process.platform,arch:process.arch,ptt:true}));
  `
  const environment = electronProcessEnvironment(process.env, 'node')
  for (const key of Object.keys(environment))
    if (key.toUpperCase() === 'ELECTRON_NO_ASAR') delete environment[key]
  const child = spawnSync(executable, ['-e', probe, runtime.resourcesPath, runtime.version], {
    cwd: path.dirname(executable),
    env: environment,
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  })
  try {
    if (child.error) throw child.error
    if (child.status !== 0) throw new Error(child.stderr || child.stdout || `EXIT_${child.status}`)
    const evidence = JSON.parse(child.stdout.trim())
    if (
      evidence.version !== runtime.version ||
      evidence.platform !== runtime.platform ||
      evidence.arch !== runtime.arch ||
      evidence.ptt !== true
    ) {
      throw new Error('KOFFI_RUNTIME_EVIDENCE_MISMATCH')
    }
  } catch (error) {
    throw new Error(
      t('scripts.electron-native-runtime', '发行产物 Koffi 原生模块加载验证失败：{0}', [
        String(error),
      ]),
    )
  }
}

module.exports = { prepareKoffiRuntime, validateKoffiRuntime }
