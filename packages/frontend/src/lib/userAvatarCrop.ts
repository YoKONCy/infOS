export interface AvatarCrop {
  width: number
  height: number
  zoom: number
  x: number
  y: number
}

/** 位移以裁切框边长为单位，任意长宽比与缩放都不允许露出空白。 */
export function clampAvatarCrop(crop: AvatarCrop): AvatarCrop {
  const zoom = Math.max(1, Math.min(3, Number.isFinite(crop.zoom) ? crop.zoom : 1))
  const edge = Math.min(crop.width, crop.height)
  const boundX = ((crop.width / edge) * zoom - 1) / 2
  const boundY = ((crop.height / edge) * zoom - 1) / 2
  return {
    ...crop,
    zoom,
    x: Math.max(-boundX, Math.min(boundX, crop.x)),
    y: Math.max(-boundY, Math.min(boundY, crop.y)),
  }
}

export function avatarCropStyle(value: AvatarCrop) {
  const crop = clampAvatarCrop(value)
  const edge = Math.min(crop.width, crop.height)
  return {
    width: `${(crop.width / edge) * crop.zoom * 100}%`,
    height: `${(crop.height / edge) * crop.zoom * 100}%`,
    left: `${50 + crop.x * 100}%`,
    top: `${50 + crop.y * 100}%`,
  }
}

/** 将预览里的同一裁切区域换算回原图坐标，避免保存结果与小头像预览偏移。 */
export function avatarCropRect(value: AvatarCrop) {
  const crop = clampAvatarCrop(value)
  const size = Math.min(crop.width, crop.height) / crop.zoom
  return {
    x: (crop.width - size) / 2 - crop.x * size,
    y: (crop.height - size) / 2 - crop.y * size,
    size,
  }
}
