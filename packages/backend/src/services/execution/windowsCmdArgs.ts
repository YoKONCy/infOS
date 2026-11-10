import path from 'node:path'

/**
 * Windows 上用参数数组启动 cmd.exe 时，Node 和 node-pty 会把参数里的双引号转义成 \"，
 * 但 cmd 不认这种转义：带引号的路径、管道、findstr 都会被拆坏，
 * 结果是报「文件名、目录名或卷标语法不正确」，或把存在的路径判成不存在。
 * 这里把 /c（或 /k）后面的内容原样交给 cmd，用 /s 约定「只去掉最外层一对引号」。
 */
export type WindowsCmdSpawn = {
  args: string[]
  /** 已经按 cmd 规则拼好的完整参数串，node-pty 用它避免再次转义。 */
  commandLine: string
}

const CMD_NAMES = new Set(['cmd', 'cmd.exe'])

function quoteExtraArg(arg: string): string {
  return /\s/.test(arg) && !arg.startsWith('"') ? `"${arg}"` : arg
}

export function resolveWindowsCmdSpawn(
  command: string,
  args: readonly string[] | undefined,
  platform: NodeJS.Platform = process.platform,
): WindowsCmdSpawn | null {
  if (platform !== 'win32' || !args?.length) return null
  if (!CMD_NAMES.has(path.win32.basename(command).toLowerCase())) return null
  const runIndex = args.findIndex((arg) => /^\/[ck]$/i.test(arg))
  // /c 之前只能是 cmd 自己的开关；否则不是我们认识的调用形式，不去改它。
  if (runIndex < 0 || args.slice(0, runIndex).some((arg) => !arg.startsWith('/'))) return null
  const rest = args.slice(runIndex + 1)
  if (!rest.length) return null
  // 只有一项时它就是模型写好的整行命令；多项时补上路径空格需要的引号再拼起来。
  const line = rest.length === 1 ? rest[0]! : rest.map(quoteExtraArg).join(' ')
  const switches = args.slice(0, runIndex).filter((arg) => arg.toLowerCase() !== '/s')
  const finalArgs = [...switches, '/s', args[runIndex]!, `"${line}"`]
  return { args: finalArgs, commandLine: finalArgs.join(' ') }
}
