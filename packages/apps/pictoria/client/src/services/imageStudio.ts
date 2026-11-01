export interface CropRect {
  x: number
  y: number
  width: number
  height: number
}
export async function decodeImage(url: string): Promise<HTMLImageElement> {
  const image = new Image()
  image.src = url
  await image.decode()
  return image
}
export function imageBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('IMAGE_ENCODING_FAILED'))),
      'image/png',
    ),
  )
}
function canvas(width: number, height: number) {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < 1 ||
    height < 1 ||
    width * height > 64 * 1024 * 1024
  )
    throw new Error('IMAGE_DIMENSIONS_INVALID')
  const value = document.createElement('canvas')
  value.width = Math.round(width)
  value.height = Math.round(height)
  return value
}
/** 裁剪坐标使用原图像素，预览缩放不改变输出范围。 */
export async function cropImage(image: HTMLImageElement, rect: CropRect): Promise<Blob> {
  const { x, y, width, height } = rect
  if (
    ![x, y, width, height].every(Number.isFinite) ||
    x < 0 ||
    y < 0 ||
    width < 1 ||
    height < 1 ||
    x + width > image.naturalWidth ||
    y + height > image.naturalHeight
  )
    throw new Error('IMAGE_CROP_INVALID')
  const output = canvas(width, height)
  output.getContext('2d')!.drawImage(image, x, y, width, height, 0, 0, output.width, output.height)
  return imageBlob(output)
}
export async function splitImage(
  image: HTMLImageElement,
  columns: number,
  rows: number,
): Promise<Blob[]> {
  if (
    ![columns, rows].every(Number.isInteger) ||
    columns < 1 ||
    rows < 1 ||
    columns * rows > 20 ||
    columns > image.naturalWidth ||
    rows > image.naturalHeight
  )
    throw new Error('IMAGE_SPLIT_INVALID')
  const parts: Blob[] = []
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < columns; x++) {
      const left = Math.floor((x * image.naturalWidth) / columns),
        top = Math.floor((y * image.naturalHeight) / rows)
      parts.push(
        await cropImage(image, {
          x: left,
          y: top,
          width: Math.floor(((x + 1) * image.naturalWidth) / columns) - left,
          height: Math.floor(((y + 1) * image.naturalHeight) / rows) - top,
        }),
      )
    }
  return parts
}
export async function resizeImage(
  image: HTMLImageElement,
  width: number,
  height: number,
  pixelated: boolean,
): Promise<Blob> {
  const output = canvas(width, height),
    context = output.getContext('2d')!
  context.imageSmoothingEnabled = !pixelated
  context.imageSmoothingQuality = 'high'
  context.drawImage(image, 0, 0, output.width, output.height)
  return imageBlob(output)
}
