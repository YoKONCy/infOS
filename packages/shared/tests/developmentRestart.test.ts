import { afterEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  DEVELOPMENT_RESTART_EXIT_CODE,
  runDevelopmentSessions,
} from '../../../electron/shared/developmentRestart.mjs'

let directory: string | undefined
afterEach(async () => {
  if (!directory) return
  if (path.dirname(directory) !== path.resolve('TEMP')) throw new Error('测试目录越界')
  await fs.rm(directory, { recursive: true, force: true })
  directory = undefined
})

describe('开发页面与 Electron 的父进程监督', () => {
  it('真实旧进程关闭后才创建新会话，普通退出结束整个监督循环', async () => {
    directory = await fs.mkdtemp(path.resolve('TEMP/development-restart-'))
    const entry = path.join(directory, 'session.cjs')
    await fs.writeFile(
      entry,
      'process.stdout.write(process.argv[2], () => process.exit(Number(process.argv[3])))',
    )
    const events: string[] = []
    let session = 0
    const result = await runDevelopmentSessions(
      async () => {
        const current = ++session
        events.push(`启动${current}`)
        return new Promise<number>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [entry, `页面${current}`, String(current === 1 ? DEVELOPMENT_RESTART_EXIT_CODE : 0)],
            {
              stdio: ['ignore', 'pipe', 'pipe'],
              windowsHide: true,
            },
          )
          let output = ''
          child.stdout.on('data', (data) => {
            output += data.toString()
          })
          child.once('error', reject)
          child.once('close', (code) => {
            events.push(output, `关闭${current}`)
            resolve(code ?? 1)
          })
        })
      },
      () => false,
    )
    expect(result).toBe(0)
    expect(events).toEqual(['启动1', '页面1', '关闭1', '启动2', '页面2', '关闭2'])
  })
  it('开发宿主正在停止时不消费重启请求，异常退出也不自动重开', async () => {
    let finished = false
    expect(
      await runDevelopmentSessions(
        async () => {
          if (finished) throw new Error('宿主停止后不应创建新会话')
          finished = true
          return DEVELOPMENT_RESTART_EXIT_CODE
        },
        () => true,
      ),
    ).toBe(DEVELOPMENT_RESTART_EXIT_CODE)
    expect(
      await runDevelopmentSessions(
        async () => 17,
        () => false,
      ),
    ).toBe(17)
  })
})
