import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import {
  planReadOnlyTerminal,
  grantReadOnlyTerminal,
  executeReadOnlyTerminal,
} from '@infos/backend/services/execution/readOnlyTerminal'

const temporaryRoot = fileURLToPath(new URL('../../../../../../TEMP/', import.meta.url))
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function workspace() {
  await mkdir(temporaryRoot, { recursive: true })
  const root = await mkdtemp(path.join(temporaryRoot, 'terminal-readonly-'))
  roots.push(root)
  return root
}

describe('终端确定性只读查询', () => {
  it('识别整条只读管道及顺序组合，读取脚本内容而不执行', async () => {
    const root = await workspace()
    await writeFile(path.join(root, 'sample.py'), 'print("仅作为文本读取")\n第二行\n')
    const args = {
      command:
        'Get-Content -LiteralPath sample.py -TotalCount 1; Get-ChildItem -LiteralPath . -File |\n Select-Object Name,Length',
    }
    const plan = planReadOnlyTerminal(args, 'win32')
    expect(plan).not.toBeNull()
    const grant = await grantReadOnlyTerminal(plan!, root, '.', () => true)
    expect(grant).not.toBeNull()
    const output = await executeReadOnlyTerminal(grant!, args)
    expect(output.split('\n')[0]).toBe('print("仅作为文本读取")')
    expect(JSON.parse(output.split('\n')[1]!)).toEqual({
      Name: 'sample.py',
      Length: Buffer.byteLength('print("仅作为文本读取")\n第二行\n'),
    })
  })

  it.each([
    'Get-Location; python script.py',
    'Get-Content file.txt | Invoke-Expression',
    'Get-Content $(Get-Location)',
    'Get-Content "$(Get-Location)"',
    'Get-Content file.txt > copy.txt',
    'Get-ChildItem | Where-Object { $_.Length -gt 0 }',
    '& unknown.exe --help',
    'unknown.exe --version',
    'node -e "console.log(1)"',
    'npm test',
    'Get-Location && Get-Content file.txt',
  ])('不将动态语法或混合执行识别为只读：%s', (command) => {
    expect(planReadOnlyTerminal({ command }, 'win32')).toBeNull()
  })

  it('POSIX 参数数组保留常量，Shell 命令替换不能进入免审路径', () => {
    expect(
      planReadOnlyTerminal({ command: 'cat', argv: ['literal;name.py'] }, 'linux'),
    ).not.toBeNull()
    expect(planReadOnlyTerminal({ command: 'cat "$(pwd)"' }, 'linux')).toBeNull()
    expect(
      planReadOnlyTerminal({ command: 'cat file.txt | head -n 2; pwd' }, 'linux'),
    ).not.toBeNull()
    expect(planReadOnlyTerminal({ command: './cat', argv: ['file.txt'] }, 'linux')).toBeNull()
  })

  it('读取范围与最终参数仍受检查，不能将一次判定换成其他命令', async () => {
    const root = await workspace()
    await writeFile(path.join(root, 'allowed.txt'), '允许读取')
    const args = { command: 'cat', argv: ['allowed.txt'] }
    const plan = planReadOnlyTerminal(args, 'linux')!
    expect(await grantReadOnlyTerminal(plan, root, '.', () => false)).toBeNull()
    const grant = await grantReadOnlyTerminal(plan, root, '.', () => true)
    expect(grant).not.toBeNull()
    await expect(
      executeReadOnlyTerminal(grant!, { command: 'node', argv: ['allowed.txt'] }),
    ).rejects.toThrow('READ_ONLY_CONTEXT_CHANGED')
    const other = await workspace()
    const outside = path.join(other, 'outside.txt')
    await writeFile(outside, '存在但不属于当前工作区')
    expect(
      await grantReadOnlyTerminal(
        planReadOnlyTerminal({ command: 'cat', argv: [outside] }, 'linux')!,
        root,
        '.',
        () => true,
      ),
    ).toBeNull()
  })
})
