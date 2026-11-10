/**
 * 可选外部模块的类型声明 (shim)
 *
 * winreg 和 adm-zip 是可选依赖，通过 dynamic import + .catch() 容错。
 * 这里只提供最小类型声明让编译通过。
 *
 * @platform ELECTRON
 */

// ── winreg (Windows 注册表读取, 可选) ──
declare module 'winreg' {
  interface RegistryItem {
    value: string
    name: string
    type: string
  }

  interface RegistryKey {
    get(name: string, callback: (err: Error | null, item: RegistryItem | null) => void): void
  }

  interface WinregConstructor {
    new (options: { hive: string; key: string }): RegistryKey
    HKLM: string
    HKCU: string
  }

  const winreg: WinregConstructor
  export default winreg
}

// ── adm-zip (ZIP 解压, 可选) ──
declare module 'adm-zip' {
  class AdmZip {
    constructor(data?: Buffer | string)
    addFile(entryName: string, content: Buffer): void
    writeZip(targetPath: string): void
    extractAllTo(targetPath: string, overwrite?: boolean): void
    getEntries(): Array<{
      entryName: string
      isDirectory: boolean
      attr: number
      header: { size: number }
      getData(): Buffer
    }>
  }
  export default AdmZip
}
