import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDrizzleConnection, createDrizzleConnection } from '../../../src/database'
import { HomeService } from '../../../src/services/home/homeService'
import { HomeError } from '../../../src/services/home/homeErrors'

let db: ReturnType<typeof createDrizzleConnection>
let root: string
let home: HomeService
const scope = { agentId: 'pero', sessionId: 'home-paths' }

beforeEach(() => {
  root = mkdtempSync(path.join(process.env.PERO_DATA_DIR!, 'home-paths-'))
  db = createDrizzleConnection(':memory:')
  home = new HomeService(db, root, () => path.join(root, 'workspace'))
})

afterEach(() => closeDrizzleConnection(db))

describe('家的默认系统目录授权', () => {
  it('按真实系统目录初始化后，新建文件仍要求逐次确认', () => {
    const systemRoot = process.platform === 'win32' ? process.env.SystemRoot ?? 'C:\\Windows' : '/usr'
    const file = path.join(realpathSync.native(systemRoot), 'infos-home-authorization-probe.txt')

    expect(() => home.authorization.enforce(scope, { action: 'write', paths: [file] }))
      .toThrowError(HomeError)
    expect(home.authorization.pending('pero')).toMatchObject([{
      intent: { action: 'write', paths: [process.platform === 'win32' ? file.toLowerCase() : file] },
      reasons: expect.arrayContaining(['system']),
      choices: ['once', 'deny'],
      status: 'pending',
    }])
  })

  it('用户提交的目录链接继续拒绝', () => {
    const target = path.join(root, 'target')
    const alias = path.join(root, 'alias')
    mkdirSync(target)
    symlinkSync(target, alias, 'junction')

    expect(() => home.authorization.enforce(scope, {
      action: 'write', paths: [path.join(alias, 'note.txt')],
    })).toThrowError(expect.objectContaining({ code: 'HOME_PATH_INVALID' }))
    expect(home.authorization.pending('pero')).toEqual([])
  })
})
