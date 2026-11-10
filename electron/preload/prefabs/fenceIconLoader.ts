/**
 * @file 收纳框页面的图标加载：系统图标先显示，图片的缩略图好了再替换。
 *       缩略图按显示顺序分批要（同时最多 limit 个）：视图变了就丢掉排队中的旧请求，
 *       窗口关了也不再要，主进程那边不会积压。不依赖 DOM，由 fenceView 接到界面上。
 * @see .docs/P11_DESKTOP_PREFABS.md
 */

import type { FenceViewItem } from '../../../packages/shared/src/desktopFence'

export type FenceIconRequest = (itemId: string, thumbnail: boolean) => Promise<string | null>
export type FenceIconShow = (itemId: string, url: string) => void

type LoaderItem = Pick<FenceViewItem, 'id' | 'missing' | 'iconVersion' | 'thumbnail'>

const THUMBNAILS_IN_FLIGHT = 4

export class FenceIconLoader {
  private readonly icons = new Map<string, Promise<string | null>>()
  /** 拿到结果的缩略图（版本 → data URL，没拿到时为 null）。 */
  private readonly thumbnails = new Map<string, string | null>()
  /** 每个项目当前该显示的缩略图版本。 */
  private wanted = new Map<string, string>()
  private queue: { id: string; key: string }[] = []
  private readonly inFlight = new Set<string>()

  constructor(
    private readonly request: FenceIconRequest,
    private readonly show: FenceIconShow,
    private readonly limit: number = THUMBNAILS_IN_FLIGHT,
  ) {}

  /** 视图刷新后调用（界面已重建）：补上已有的图标，排队还没有的缩略图。 */
  update(items: readonly LoaderItem[], tier: string): void {
    const iconKeys = new Set<string>()
    const wanted = new Map<string, string>()
    const queue: { id: string; key: string }[] = []
    for (const item of items) {
      if (item.missing) continue
      const iconKey = `${item.id}|${item.iconVersion}`
      iconKeys.add(iconKey)
      if (item.thumbnail) {
        const key = `${iconKey}|${tier}`
        wanted.set(item.id, key)
        if (!this.thumbnails.has(key) && !this.inFlight.has(key)) queue.push({ id: item.id, key })
      }
    }
    this.wanted = wanted
    this.queue = queue
    // 只留当前视图用得到的，换档位或文件变化后旧的不再占内存。
    for (const key of this.icons.keys()) if (!iconKeys.has(key)) this.icons.delete(key)
    const keep = new Set(wanted.values())
    for (const key of this.thumbnails.keys()) if (!keep.has(key)) this.thumbnails.delete(key)

    for (const item of items) if (!item.missing) this.showIcon(item)
    this.pump()
  }

  private thumbnailOf(id: string): string | null | undefined {
    const key = this.wanted.get(id)
    return key === undefined ? undefined : this.thumbnails.get(key)
  }

  private showIcon(item: LoaderItem): void {
    const ready = this.thumbnailOf(item.id)
    if (ready) {
      this.show(item.id, ready)
      return
    }
    const key = `${item.id}|${item.iconVersion}`
    let loading = this.icons.get(key)
    if (!loading) {
      loading = this.request(item.id, false).catch(() => null)
      this.icons.set(key, loading)
    }
    void loading.then((url) => {
      // 缩略图先到了就不再用系统图标盖回去。
      if (url && !this.thumbnailOf(item.id)) this.show(item.id, url)
    })
  }

  private pump(): void {
    while (this.inFlight.size < this.limit) {
      const next = this.queue.shift()
      if (!next) return
      this.inFlight.add(next.key)
      void this.request(next.id, true)
        .catch(() => null)
        .then((url) => {
          this.inFlight.delete(next.key)
          // 等待期间视图变了（换了档位、文件变了）：这张已经过期，不用。
          if (this.wanted.get(next.id) === next.key) {
            this.thumbnails.set(next.key, url)
            if (url) this.show(next.id, url)
          }
          this.pump()
        })
    }
  }
}
