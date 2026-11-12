import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { MemoryStoreRegistry } from '../../../src/repositories/storeRegistry'
import { captureLiveSnapshot } from '../../../src/services/backup/liveSnapshot'
import { installBackupTree } from '../../../src/services/backup/backupStorage'

const roots: string[] = []
function temporaryRoot(): string {
  const temporary = fileURLToPath(new URL('../../../../../TEMP/', import.meta.url))
  mkdirSync(temporary, { recursive: true })
  const root = mkdtempSync(path.join(temporary, 'live-snapshot-'))
  roots.push(root)
  return root
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = temporaryRoot()
  const data = path.join(root, 'data')
  mkdirSync(path.join(data, 'applications'), { recursive: true })
  const main = new Database(path.join(data, 'infos.db'))
  const child = new Database(path.join(data, 'applications', 'app.sqlite'))
  for (const db of [main, child]) {
    db.pragma('journal_mode = WAL')
    db.exec("CREATE TABLE notes(value TEXT); INSERT INTO notes VALUES('边界前')")
  }
  const stores = new MemoryStoreRegistry({
    resolve: (alias: string) => alias === '@data' ? data : path.join(data, alias.slice(6)),
  } as never, 4)
  const memory = stores.getAgentStore('pero', 'main')
  memory.insertWithId(1, [1, 0, 0, 0], { content: '边界前的记忆' })
  const configuration = path.join(data, 'account.json')
  writeFileSync(configuration, '固定配置')
  return { root, data, main, child, stores, memory, configuration }
}

describe('在线一致性快照', () => {
  it('SQLite、子库和 TDB 固定在同一边界，后续写入继续留在源库', async () => {
    const f = fixture()
    const destination = path.join(f.root, 'snapshot')
    const clone = new MemoryStoreRegistry({
      resolve: (alias: string) => alias === '@data' ? destination : path.join(destination, alias.slice(6)),
    } as never, 4)
    try {
      await captureLiveSnapshot(f.data, destination, f.main, {
        captureSnapshot: (target, pin) => {
          f.stores.captureSnapshot(target, pin)
          f.main.exec("INSERT INTO notes VALUES('边界后')")
          f.child.exec("INSERT INTO notes VALUES('边界后')")
          f.memory.insertWithId(2, [0, 1, 0, 0], { content: '边界后的记忆' })
        },
      })
      for (const relative of ['infos.db', 'applications/app.sqlite']) {
        const copy = new Database(path.join(destination, relative), { readonly: true })
        try {
          expect(copy.prepare('SELECT value FROM notes').pluck().all()).toEqual(['边界前'])
        } finally { copy.close() }
      }
      expect(f.main.prepare('SELECT value FROM notes').pluck().all()).toEqual(['边界前', '边界后'])
      expect(f.child.prepare('SELECT value FROM notes').pluck().all()).toEqual(['边界前', '边界后'])
      expect(clone.getAgentStore('pero').get(1)?.payload).toEqual({ content: '边界前的记忆' })
      expect(clone.getAgentStore('pero').get(2)).toBeNull()
      expect(readFileSync(path.join(destination, 'account.json'), 'utf8')).toBe('固定配置')
    } finally {
      clone.closeAll()
      f.stores.closeAll()
      f.main.close()
      f.child.close()
    }
  })

  it.each(['改写文件', '取消'])('%s 时拒绝快照并释放固定读事务', async (operation) => {
    const f = fixture()
    const controller = new AbortController()
    try {
      const capture = captureLiveSnapshot(f.data, path.join(f.root, 'snapshot'), f.main, {
        captureSnapshot: (target, pin) => {
          f.stores.captureSnapshot(target, pin)
          if (operation === '取消') controller.abort(new Error('主动取消'))
          else writeFileSync(f.configuration, '边界后改写的完整配置')
        },
      }, controller.signal)
      await expect(capture).rejects.toThrow(operation === '取消' ? '主动取消' : 'BACKUP_SOURCE_CHANGED')
      expect(f.main.pragma('wal_checkpoint(TRUNCATE)')).toMatchObject([{ busy: 0 }])
      expect(f.child.pragma('wal_checkpoint(TRUNCATE)')).toMatchObject([{ busy: 0 }])
    } finally {
      f.stores.closeAll()
      f.main.close()
      f.child.close()
    }
  })

  it.each(['改写', '删除'])('捕获期间%s本机客户端缓存仍可导出，工作区同名文件正常保留', async (operation) => {
    const f = fixture()
    const caches = ['client-language.txt', 'client-default-agent.txt']
    const destination = path.join(f.root, 'snapshot')
    const workspace = 'principals/pero/workspace'
    mkdirSync(path.join(f.data, workspace), { recursive: true })
    for (const name of caches) {
      writeFileSync(path.join(f.data, name), '原本机偏好')
      writeFileSync(path.join(f.data, workspace, name), '用户记录的偏好说明')
    }
    try {
      await captureLiveSnapshot(f.data, destination, f.main, {
        captureSnapshot: (target, pin) => {
          f.stores.captureSnapshot(target, pin)
          for (const name of caches) {
            const cache = path.join(f.data, name)
            if (operation === '删除') rmSync(cache)
            else writeFileSync(cache, '更新后的本机偏好')
          }
        },
      })
      for (const name of caches) {
        expect(existsSync(path.join(destination, name))).toBe(false)
        expect(readFileSync(path.join(destination, workspace, name), 'utf8')).toBe('用户记录的偏好说明')
      }
      expect(readFileSync(path.join(destination, 'account.json'), 'utf8')).toBe('固定配置')
    } finally {
      f.stores.closeAll()
      f.main.close()
      f.child.close()
    }
  })

  it('导出省略发行程序，保留账号、第三方插件和工作区内的同名文件', async () => {
    const f = fixture()
    const destination = path.join(f.root, 'snapshot')
    const excluded = {
      'tools/NapCat/node.exe': '可重装程序',
      'tools/NapCat/napcat/static/app.js': '发行资源',
      'tools/NapCat/napcat/plugins/builtin/index.mjs': '官方插件',
      'data/tools/NapCat/QQNT.dll': '旧发行文件',
      'data/logs/old.log': '旧日志',
      'agent_pero/rnn_desktop.bin': '旧隐状态',
      'shared/rnn_proj.bin': '旧投影权重',
      'shared/rnn_output.bin': '旧输出权重',
      'shared/rnn_mingru.bin': '旧循环权重',
    }
    const retained = {
      'tools/NapCat/napcat/config/webui.json': '账号配置',
      'tools/NapCat/napcat/plugins/custom/addon.node': '用户插件',
      'tools/NapCat/.infos-quick-login-account': '快速登录',
      'principals/pero/workspace/tools/NapCat/node.exe': '用户文件',
      'principals/pero/workspace/rnn_mingru.bin': '用户同名文件',
    }
    try {
      for (const [relative, content] of Object.entries({ ...excluded, ...retained })) {
        mkdirSync(path.dirname(path.join(f.data, relative)), { recursive: true })
        writeFileSync(path.join(f.data, relative), content)
      }
      await captureLiveSnapshot(f.data, destination, f.main, f.stores)
      for (const relative of Object.keys(excluded))
        expect(existsSync(path.join(destination, relative))).toBe(false)
      for (const [relative, content] of Object.entries(retained))
        expect(readFileSync(path.join(destination, relative), 'utf8')).toBe(content)
    } finally {
      f.stores.closeAll()
      f.main.close()
      f.child.close()
    }
  })

  it('安装旧快照时清理退役状态并按原路径恢复工作区文件', async () => {
    const root = temporaryRoot()
    const data = path.join(root, 'data')
    const prepared = path.join(root, 'prepared')
    await mkdir(data)
    const retired = ['agent_pero/rnn_desktop.bin', 'shared/rnn_mingru.bin']
    const userFile = 'principals/pero/workspace/rnn_mingru.bin'
    for (const relative of [...retired, userFile]) {
      await mkdir(path.dirname(path.join(prepared, relative)), { recursive: true })
      writeFileSync(path.join(prepared, relative), relative)
    }
    await installBackupTree(data, prepared)
    for (const relative of retired) expect(existsSync(path.join(data, relative))).toBe(false)
    expect(await readFile(path.join(data, userFile), 'utf8')).toBe(userFile)
  })

  it.each([
    { file: 'client-language.txt', localValue: 'zh-CN', sourceValue: 'en-US' },
    { file: 'client-language.txt', localValue: null, sourceValue: 'en-US' },
    { file: 'client-default-agent.txt', localValue: 'nana', sourceValue: 'pero' },
    { file: 'client-default-agent.txt', localValue: null, sourceValue: 'pero' },
  ])('旧快照中的 $file 沿用目标端状态 $localValue', async ({ file, localValue, sourceValue }) => {
    const root = temporaryRoot()
    const data = path.join(root, 'data')
    const prepared = path.join(root, 'prepared')
    await mkdir(data)
    await mkdir(prepared)
    writeFileSync(path.join(prepared, file), sourceValue)
    writeFileSync(path.join(prepared, 'account.json'), '恢复的业务配置')
    if (localValue !== null) writeFileSync(path.join(data, file), localValue)

    await installBackupTree(data, prepared)

    expect(existsSync(path.join(data, file))).toBe(localValue !== null)
    if (localValue !== null)
      expect(await readFile(path.join(data, file), 'utf8')).toBe(localValue)
    expect(await readFile(path.join(data, 'account.json'), 'utf8')).toBe('恢复的业务配置')
  })

  it('恢复配置型快照时保留目标端程序，账号和第三方插件采用来源版本', async () => {
    const root = temporaryRoot()
    const data = path.join(root, 'data')
    const prepared = path.join(root, 'prepared')
    for (const directory of [data, prepared]) {
      await mkdir(path.join(directory, 'tools/NapCat/napcat/config'), { recursive: true })
      await mkdir(path.join(directory, 'tools/NapCat/napcat/plugins/custom'), { recursive: true })
    }
    writeFileSync(path.join(data, 'tools/NapCat/node.exe'), '本机程序')
    writeFileSync(path.join(data, 'tools/NapCat/napcat/config/webui.json'), '原账号')
    writeFileSync(path.join(prepared, 'tools/NapCat/napcat/config/webui.json'), '恢复的账号')
    writeFileSync(path.join(data, 'tools/NapCat/napcat/plugins/custom/index.js'), '原插件')
    writeFileSync(path.join(prepared, 'tools/NapCat/napcat/plugins/custom/index.js'), '恢复的插件')
    await installBackupTree(data, prepared)
    expect(await readFile(path.join(data, 'tools/NapCat/node.exe'), 'utf8')).toBe('本机程序')
    expect(await readFile(path.join(data, 'tools/NapCat/napcat/config/webui.json'), 'utf8')).toBe('恢复的账号')
    expect(await readFile(path.join(data, 'tools/NapCat/napcat/plugins/custom/index.js'), 'utf8')).toBe('恢复的插件')
  })
})
