/** @platform ELECTRON 系统回收站接入的运行时实例：shell.trashItem + 主进程凭据。 */
import fs from 'node:fs/promises'
import { shell } from 'electron'
import { homeApi } from './homeApi'
import { NativeTrash } from './homeNativeTrash'

export const homeNativeTrash = new NativeTrash({
  api: homeApi,
  now: Date.now,
  lstat: (file) => fs.lstat(file),
  realpath: (file) => fs.realpath(file),
  readFile: (file) => fs.readFile(file),
  trash: (file) => shell.trashItem(file),
  exists: (file) =>
    fs.lstat(file).then(
      () => true,
      () => false,
    ),
})
