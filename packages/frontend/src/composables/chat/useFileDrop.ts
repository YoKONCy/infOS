import { onActivated, onDeactivated, ref } from 'vue'

/** 只接管真实文件拖入；子级处理后的 drop 冒泡时仅清除提示，不重复上传。 */
export function useFileDrop(options: {
  enabled: () => boolean
  files: (files: File[]) => void | Promise<void>
  unavailable?: () => void
  directory?: () => void
}) {
  const dragging = ref(false)
  let depth = 0,
    active = true
  const hasFiles = (event: DragEvent) =>
    Array.from(event.dataTransfer?.types ?? []).includes('Files') ||
    Array.from(event.dataTransfer?.items ?? []).some((item) => item.kind === 'file') ||
    !!event.dataTransfer?.files.length
  function reset() {
    depth = 0
    dragging.value = false
  }
  function enter(event: DragEvent) {
    if (!active || !hasFiles(event)) return
    event.preventDefault()
    depth++
    dragging.value = options.enabled()
  }
  function over(event: DragEvent) {
    if (!active || !hasFiles(event)) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = options.enabled() ? 'copy' : 'none'
    dragging.value = options.enabled()
  }
  function leave(event: DragEvent) {
    if (!hasFiles(event) && !dragging.value) return
    depth = Math.max(0, depth - 1)
    if (!depth) dragging.value = false
  }
  async function drop(event: DragEvent) {
    reset()
    if (!active || !hasFiles(event)) return
    const handled = event.defaultPrevented
    event.preventDefault()
    if (handled) return
    if (!options.enabled()) {
      options.unavailable?.()
      return
    }
    const entries = Array.from(event.dataTransfer?.items ?? [])
    const directories = entries.filter((item) => item.webkitGetAsEntry?.()?.isDirectory)
    if (directories.length) options.directory?.()
    const files = entries.some((item) => item.kind === 'file')
      ? entries
          .filter((item) => item.kind === 'file' && !directories.includes(item))
          .map((item) => item.getAsFile())
          .filter((file): file is File => !!file)
      : Array.from(event.dataTransfer?.files ?? [])
    if (files.length) await options.files(files)
  }
  onDeactivated(() => {
    active = false
    reset()
  })
  onActivated(() => {
    active = true
  })
  return { dragging, enter, over, leave, drop, reset }
}
