/** 上传仅传二进制，不把本机路径或文件句柄交给后端。 */
export function fileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('HOME_FILE_READ_FAILED'))
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.readAsDataURL(file)
  })
}

export function shelfBlob(content: string): Blob {
  const raw = atob(content)
  const bytes = Uint8Array.from(raw, (character) => character.charCodeAt(0))
  // 只预览已知位图；HTML、SVG 等文件始终作为下载处理。
  const signature = [...bytes.slice(0, 12)]
  const mime =
    signature[0] === 137 && signature[1] === 80 && signature[2] === 78 && signature[3] === 71
      ? 'image/png'
      : signature[0] === 255 && signature[1] === 216 && signature[2] === 255
        ? 'image/jpeg'
        : raw.startsWith('GIF87a') || raw.startsWith('GIF89a')
          ? 'image/gif'
          : raw.startsWith('RIFF') && raw.slice(8, 12) === 'WEBP'
            ? 'image/webp'
            : 'application/octet-stream'
  return new Blob([bytes], { type: mime })
}
