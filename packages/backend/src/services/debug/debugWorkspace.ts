import { cp, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { packagePath, packageDigest } from '../../packages/packageFiles'

export class DebugWorkspace {
  constructor(readonly root: string) {}
  async write(relative: string, content: string): Promise<void> {
    if (typeof content !== 'string' || Buffer.byteLength(content) > 256 * 1024)
      throw new Error('DEBUG_FILE_LIMIT')
    const target = packagePath(this.root, relative)
    let parent = this.root
    await this.assertWithin(parent)
    for (const part of path
      .relative(this.root, path.dirname(target))
      .split(path.sep)
      .filter(Boolean)) {
      parent = path.join(parent, part)
      const info = await lstat(parent).catch(() => undefined)
      if (info?.isSymbolicLink() || (info && !info.isDirectory()))
        throw new Error('DEBUG_PATH_DENIED')
      await mkdir(parent, { recursive: true })
      await this.assertWithin(parent)
    }
    if ((await lstat(target).catch(() => undefined))?.isSymbolicLink())
      throw new Error('DEBUG_PATH_DENIED')
    await writeFile(target, content, { flag: 'w' })
  }
  async read(relative: string): Promise<string> {
    const file = packagePath(this.root, relative)
    await this.assertWithin(file)
    const stat = await lstat(file)
    if (!stat.isFile() || stat.size > 512 * 1024) throw new Error('DEBUG_FILE_LIMIT')
    return readFile(file, 'utf8')
  }
  async list(): Promise<string[]> {
    const result: string[] = []
    let entries = 0
    let bytes = 0
    const visit = async (directory: string, depth = 0): Promise<void> => {
      if (depth > 20) throw new Error('DEBUG_FILE_LIMIT')
      for (const name of (await readdir(directory)).sort()) {
        if (++entries > 500) throw new Error('DEBUG_FILE_LIMIT')
        const file = path.join(directory, name)
        const info = await lstat(file)
        bytes += info.size
        if (bytes > 8 * 1024 * 1024) throw new Error('DEBUG_FILE_LIMIT')
        if (info.isSymbolicLink()) throw new Error('DEBUG_PATH_DENIED')
        if (info.isDirectory()) await visit(file, depth + 1)
        else if (info.isFile() && info.size <= 512 * 1024)
          result.push(path.relative(this.root, file).replaceAll('\\', '/'))
        else throw new Error('DEBUG_FILE_LIMIT')
        if (result.length > 500) throw new Error('DEBUG_FILE_LIMIT')
      }
    }
    await mkdir(this.root, { recursive: true })
    await visit(this.root)
    return result
  }
  async check(): Promise<{ ok: boolean; digest: string; files: string[]; diagnostics: unknown[] }> {
    const { default: ts } = await import('typescript')
    const files = await this.list()
    const diagnostics: Array<{ file: string; code: number; message: string }> = []
    for (const file of files) {
      if (!/\.(?:[cm]?js|ts)$/.test(file)) continue
      const result = ts.transpileModule(await this.read(file), {
        fileName: file,
        reportDiagnostics: true,
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          isolatedModules: true,
        },
      })
      for (const diagnostic of result.diagnostics ?? []) {
        if (diagnostic.category === ts.DiagnosticCategory.Error)
          diagnostics.push({
            file,
            code: diagnostic.code,
            message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
          })
      }
    }
    return { ok: !diagnostics.length, digest: await packageDigest(this.root), files, diagnostics }
  }
  async stage(releases: string): Promise<{ directory: string; digest: string }> {
    const { default: ts } = await import('typescript')
    const check = await this.check()
    if (!check.ok) throw new Error(`DEBUG_CHECK_FAILED: ${JSON.stringify(check.diagnostics)}`)
    const directory = path.join(releases, randomUUID())
    await mkdir(directory, { recursive: true })
    await cp(this.root, directory, { recursive: true, dereference: false })
    const snapshot = new DebugWorkspace(directory)
    const stagedCheck = await snapshot.check()
    if (!stagedCheck.ok || stagedCheck.digest !== check.digest)
      throw new Error('DEBUG_WORKSPACE_CHANGED')
    for (const file of stagedCheck.files) {
      if (!file.endsWith('.ts')) continue
      if (stagedCheck.files.includes(file.slice(0, -3) + '.js'))
        throw new Error('DEBUG_OUTPUT_CONFLICT')
      const result = ts.transpileModule(await snapshot.read(file), {
        fileName: file,
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          rewriteRelativeImportExtensions: true,
        },
      })
      await writeFile(packagePath(directory, file.slice(0, -3) + '.js'), result.outputText)
    }
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ type: 'module' }))
    return { directory, digest: check.digest }
  }
  private async assertWithin(file: string) {
    const relative = path.relative(await realpath(this.root), await realpath(file))
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('DEBUG_PATH_DENIED')
  }
}
