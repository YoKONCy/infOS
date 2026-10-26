import { describe, expect, it } from 'vitest'
import { systemFileOpenAction } from '../src/resources'

describe('系统文件打开策略', () => {
  it.each(['setup.exe', 'image.png.exe', 'run.PS1', 'run.py', 'shortcut.lnk',
    'download.url', 'page.html', 'vector.svg', 'unknown', 'script'])('%s 只定位，不执行', (name) => {
    expect(systemFileOpenAction(name)).toBe('reveal')
  })
  it.each(['报告.PDF', 'C:\\工作区\\图.png', '/workspace/data.csv', 'archive.zip'])
    ('%s 可由系统关联应用打开', (name) => {
      expect(systemFileOpenAction(name)).toBe('open')
    })
})
