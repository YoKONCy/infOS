type DwmSetAttribute = (
  window: number | bigint,
  attribute: number,
  value: Buffer,
  size: number,
) => number
type LoadNative = () => Pick<typeof import('koffi'), 'load'>

const DWMWA_SYSTEMBACKDROP_TYPE = 38
const DWMSBT_NONE = 1

/** 只写 DWM 背景属性，不修改 Electron 的半透明状态或 DWM 客户区边距。 */
export function createSystemBackdropDisabler(loadNative: LoadNative = () => require('koffi')) {
  let setAttribute: DwmSetAttribute | null | undefined
  return (nativeHandle: Buffer): boolean => {
    // Electron 返回的是 HWND 的字节表示；不能把 Buffer 本身当作 HWND 指针传入。
    if (nativeHandle.length !== 4 && nativeHandle.length !== 8) return false
    const window =
      nativeHandle.length === 8 ? nativeHandle.readBigUInt64LE() : nativeHandle.readUInt32LE()
    if (!window) return false
    try {
      if (setAttribute === undefined) {
        // 仅在实际 Windows 窗口需要防护时加载，复用现有 koffi 依赖。
        const dwm = loadNative().load('dwmapi.dll')
        setAttribute = dwm.func(
          'int32_t __stdcall DwmSetWindowAttribute(uintptr_t window, uint32_t attribute, const void *value, uint32_t size)',
        )
      }
      if (!setAttribute) return false
      const value = Buffer.alloc(4)
      value.writeInt32LE(DWMSBT_NONE)
      // Windows 10 等不支持该属性时返回失败，不能回退到会破坏透明合成的材质接口。
      return setAttribute(window, DWMWA_SYSTEMBACKDROP_TYPE, value, value.length) >= 0
    } catch {
      if (setAttribute === undefined) setAttribute = null
      return false
    }
  }
}

export const disableWindowsSystemBackdrop = createSystemBackdropDisabler()
