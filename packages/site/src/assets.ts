/** public/art 下的素材地址，跟随 Vite 的 base，部署到子目录也能用 */
export function art(name: string): string {
  return `${import.meta.env.BASE_URL}art/${name}`
}

/** 预加载一组图片，切换角色时不闪白 */
export function preload(names: string[]): void {
  for (const n of names) {
    const img = new Image()
    img.decoding = 'async'
    img.src = art(n)
  }
}

export const LINKS = {
  steam: 'https://store.steampowered.com/app/4457100',
  docs: 'https://wiki.perofamily.top',
  github: 'https://github.com/YoKONCy/infOS',
  mobile: 'https://github.com/YoKONCy/Peroperochat',
}
