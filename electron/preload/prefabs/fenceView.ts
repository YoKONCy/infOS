/**
 * @file 收纳框界面：在预制件 preload 的隔离环境中绘制（页面本身不运行脚本）。
 *
 *       - 标题栏：折叠 / 展开、标题（双击改名）、项目数、选项菜单（置顶、贴在桌面、图标大小、排序、背景透明度）、
 *         关闭（鼠标移到框上才出现，与 Ctrl/Cmd+W 同一条通路）；
 *         按住标题栏（含标题文字，不含按钮）拖动来移动窗口，拖四边四角的隐形手柄来缩放，
 *         增量经受控通道交给主进程；
 *       - 项目：双击或回车启动（主进程按项目 ID 反查，只能启动框里登记过的项目），
 *         右键「从框中移出」只删登记，不删文件；
 *       - 拖动项目：发起系统文件拖拽（`dragstart` 里取消页面拖拽，主进程按项目 ID 调 startDrag），
 *         拖到框外和从资源管理器拖一样，放回本框是排序；映射项目没有排序，放回本框什么都不做；
 *       - 从桌面拖进来的文件只登记为引用（主进程再校验路径）。
 *       只响应真实的用户操作（`isTrusted`）。不依赖 Electron，可在浏览器里用替身接口渲染。
 *
 * @see .docs/P11_DESKTOP_PREFABS.md
 */

import type {
  FenceGesture,
  FenceIconSize,
  FencePageAction,
  FenceSort,
  FenceView,
  FenceViewItem,
} from '../../../packages/shared/src/desktopFence'
import {
  FencePress,
  fenceBackgroundAlpha,
  fenceDragMode,
  fenceDragOverEffect,
  fenceDropOutcome,
  frameThrottle,
  FENCE_DRAG_THRESHOLD_PX,
  FENCE_OWN_DRAG_GRACE_MS,
  type FenceOwnDrag,
} from './fencePointer'
import { FenceIconLoader } from './fenceIconLoader'

export interface FenceApi {
  state(): Promise<FenceView>
  /** 按项目 ID 读图标；`thumbnail` 读图片缩略图（页面只能传 ID，路径由主进程反查）。 */
  icon(itemId: string, variant?: 'thumbnail'): Promise<string | null>
  action(action: FencePageAction, payload?: unknown): Promise<unknown>
  /** 把项目作为系统文件拖出去（只传 ID）；Windows 上拖拽结束才返回。 */
  dragOut(itemId: string): Promise<unknown>
  /** 窗口手势：`begin`（种类）→ `update`（累计增量）→ `end`（最终增量）；只作用于本窗口。 */
  gesture(phase: 'begin' | 'update' | 'end', payload: unknown): Promise<unknown>

  /** 主进程推送新视图（或只通知变化，需要重新读取）。 */
  onChange(listener: (view?: FenceView) => void): void
  /** 拖入的文件 → 本机路径；拿不到时为空数组。 */
  droppedPaths(files: FileList): string[]
}

/** 只能框内排序的项目用的页面拖拽数据类型（与从外部拖入的文件区分）。 */
const ITEM_MIME = 'application/x-infos-fence-item'
const ICON_SIZES: FenceIconSize[] = ['small', 'medium', 'large']
const SORTS: FenceSort[] = ['manual', 'name', 'type']
const RESIZE_EDGES: FenceGesture[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']

const SVG = {
  chevron: '<svg viewBox="0 0 12 12" class="fence__chevron"><path d="M3 4.5l3 3 3-3"/></svg>',
  more: '<svg viewBox="0 0 12 12"><path d="M2.5 6h.01M6 6h.01M9.5 6h.01" stroke-width="2.4"/></svg>',
  close: '<svg viewBox="0 0 12 12"><path d="M3 3l6 6M9 3l-6 6"/></svg>',
}

function element<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

export function mountFence(doc: Document, api: FenceApi, css: string): void {
  const style = element(doc, 'style')
  style.textContent = css
  doc.head.append(style)

  const root = element(doc, 'div', 'fence')
  const bar = element(doc, 'header', 'fence__bar')
  const toggle = element(doc, 'button', 'fence__button')
  toggle.innerHTML = SVG.chevron
  const title = element(doc, 'span', 'fence__title')
  const rename = element(doc, 'input', 'fence__rename')
  rename.hidden = true
  rename.maxLength = 60
  const lock = element(doc, 'span', 'fence__lock', '⌖')
  const count = element(doc, 'span', 'fence__count')
  const more = element(doc, 'button', 'fence__button fence__more')
  more.innerHTML = SVG.more
  more.setAttribute('aria-haspopup', 'menu')
  const close = element(doc, 'button', 'fence__button fence__close')
  close.innerHTML = SVG.close
  bar.append(toggle, title, rename, lock, count, more, close)

  const menu = element(doc, 'div', 'fence__menu')
  menu.setAttribute('role', 'menu')
  menu.hidden = true
  const context = element(doc, 'div', 'fence__menu')
  context.setAttribute('role', 'menu')
  context.hidden = true
  const body = element(doc, 'main', 'fence__body')
  const toast = element(doc, 'div', 'fence__toast')
  toast.hidden = true
  root.append(bar, body, menu, context, toast)
  doc.body.append(root)

  let view: FenceView | null = null
  let selected: string | null = null
  /** 本框发起、还没结束的拖拽；放下事件靠它认出自己，不把文件再登记一遍。 */
  let dragging: FenceOwnDrag | null = null
  let toastTimer: number | undefined
  /** 只在首次显示时播放项目入场动效，之后的刷新不重复播放。 */
  let entered = false
  /** 当前界面上每个项目的图标元素。 */
  const iconImages = new Map<string, HTMLImageElement>()
  const iconLoader = new FenceIconLoader(
    (id, thumbnail) => api.icon(id, thumbnail ? 'thumbnail' : undefined),
    (id, url) => {
      const img = iconImages.get(id)
      if (!img) return
      img.src = url
      img.classList.remove('fence__icon--blank')
    },
  )
  const label = (key: string, value?: string) =>
    (view?.labels[key] ?? key).replace('{0}', value ?? '')

  const showError = (cause: unknown) => {
    const message = cause instanceof Error ? cause.message.replace(/^[A-Z_]+: /, '') : String(cause)
    toast.textContent = label('failed', message)
    toast.hidden = false
    window.clearTimeout(toastTimer)
    toastTimer = window.setTimeout(() => (toast.hidden = true), 4000)
  }
  const act = (action: FencePageAction, payload?: unknown) =>
    api.action(action, payload).catch(showError)
  const closeMenus = () => {
    menu.hidden = true
    context.hidden = true
  }

  // ─── 菜单 ──────────────────────────────────────────

  const checkItem = (text: string, checked: boolean, run: () => void) => {
    const item = element(doc, 'button', 'fence__menu-item', text)
    item.setAttribute('role', 'menuitemcheckbox')
    item.setAttribute('aria-checked', String(checked))
    item.addEventListener('click', (event) => {
      if (!event.isTrusted) return
      closeMenus()
      run()
    })
    return item
  }
  const segment = <T extends string>(
    caption: string,
    values: T[],
    current: T,
    run: (value: T) => void,
  ) => {
    const row = element(doc, 'div', 'fence__menu-row')
    const group = element(doc, 'div', 'fence__segment')
    for (const value of values) {
      const button = element(doc, 'button', undefined, label(value))
      button.setAttribute('aria-pressed', String(value === current))
      button.addEventListener('click', (event) => {
        if (!event.isTrusted) return
        closeMenus()
        run(value)
      })
      group.append(button)
    }
    row.append(element(doc, 'span', undefined, caption), group)
    return row
  }
  /** 背景和标题栏的透明度（CSS 变量），图标和文字不受影响。 */
  const applyOpacity = (percent: number) =>
    root.style.setProperty('--fence-bg-alpha', String(fenceBackgroundAlpha(percent)))
  /** 拖滑块时的预览值：松手才保存；保存完成前，主进程推来的视图不覆盖预览。 */
  let previewOpacity: number | null = null
  let opacityInput: HTMLInputElement | null = null
  const opacityRow = (current: number) => {
    const row = element(doc, 'label', 'fence__menu-slider')
    row.title = label('backgroundOpacityHint')
    const value = element(doc, 'span', undefined, `${current}%`)
    const head = element(doc, 'span', 'fence__menu-slider-head')
    head.append(element(doc, 'span', undefined, label('backgroundOpacity')), value)
    const input = element(doc, 'input', 'fence__opacity')
    input.type = 'range'
    input.min = '0'
    input.max = '100'
    input.step = '1'
    input.value = String(current)
    input.addEventListener('input', (event) => {
      if (!event.isTrusted) return
      previewOpacity = Number(input.value)
      value.textContent = `${previewOpacity}%`
      applyOpacity(previewOpacity)
    })
    input.addEventListener('change', (event) => {
      if (!event.isTrusted) return
      void act('backgroundOpacity', Number(input.value)).finally(() => {
        previewOpacity = null
        if (view) applyOpacity(view.backgroundOpacity)
      })
    })
    opacityInput = input
    row.append(head, input)
    return row
  }
  const renderMenu = () => {
    if (!view) return
    const current = view
    menu.replaceChildren(
      checkItem(label('pin'), current.alwaysOnTop, () => void act('pin', !current.alwaysOnTop)),
      checkItem(
        label('layer'),
        current.desktopLayer,
        () => void act('layer', !current.desktopLayer),
      ),
      segment(label('iconSize'), ICON_SIZES, current.iconSize, (v) => void act('iconSize', v)),
      segment(label('sort'), SORTS, current.sort, (v) => void act('sort', v)),
      opacityRow(current.backgroundOpacity),
    )
  }
  more.addEventListener('click', (event) => {
    if (!event.isTrusted) return
    const opening = menu.hidden
    closeMenus()
    if (opening) {
      renderMenu()
      menu.hidden = false
    }
  })
  doc.addEventListener('pointerdown', (event) => {
    const target = event.target as Node
    if (!menu.contains(target) && !more.contains(target) && !context.contains(target)) closeMenus()
  })
  doc.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMenus()
  })
  // 点到别的窗口（框是独立窗口）时收起菜单。
  doc.defaultView?.addEventListener('blur', closeMenus)

  // ─── 标题栏 ────────────────────────────────────────

  toggle.addEventListener('click', (event) => {
    if (event.isTrusted && view) void act('collapse', !view.collapsed)
  })
  close.addEventListener('click', (event) => {
    if (event.isTrusted) void act('close')
  })
  const startRename = () => {
    if (!view) return
    title.hidden = true
    rename.hidden = false
    rename.value = view.title
    rename.focus()
    rename.select()
  }
  /**
   * 指针手势：按下即捕获指针（窗口跟着移动时事件不丢），按屏幕坐标算累计增量，按动画帧节流后交给主进程。
   * 捕获后点击事件的目标会变，所以双击由 FencePress 自己判定，不用 dblclick。
   */
  const wireGesture = (
    target: HTMLElement,
    gesture: FenceGesture,
    threshold: number,
    onDoubleClick?: () => void,
  ) => {
    const press = new FencePress(threshold)
    let pointerId: number | null = null
    const updates = frameThrottle<{ dx: number; dy: number }>(
      (run) => doc.defaultView?.requestAnimationFrame(run),
      (delta) => void api.gesture('update', delta).catch(showError),
    )
    const stop = () => {
      pointerId = null
      delete root.dataset.gesture
    }
    target.addEventListener('pointerdown', (event) => {
      if (!event.isTrusted || event.button !== 0 || !view) return
      const from = event.target as Element
      if (from.closest('button, input')) return
      pointerId = event.pointerId
      target.setPointerCapture(pointerId)
      press.down(event.screenX, event.screenY, {
        draggable: !view.desktopLayer,
        onTitle: title.contains(from),
      })
    })
    const track = (event: PointerEvent) => {
      const step = press.move(event.screenX, event.screenY)
      if (step === 'begin') {
        root.dataset.gesture = gesture
        void api.gesture('begin', gesture).catch(showError)
      }
      return step
    }
    target.addEventListener('pointermove', (event) => {
      if (!event.isTrusted || event.pointerId !== pointerId) return
      if (track(event) !== 'none') updates.push(press.total)
    })
    target.addEventListener('pointerup', (event) => {
      if (!event.isTrusted || event.pointerId !== pointerId) return
      track(event)
      const total = press.total
      const end = press.up(event.screenX, event.screenY, event.timeStamp)
      updates.take()
      stop()
      if (end === 'dragged') void api.gesture('end', total).catch(showError)
      if (end === 'double-click') onDoubleClick?.()
    })
    const cancel = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return
      const total = press.total
      const wasDragging = press.cancel()
      updates.take()
      stop()
      if (wasDragging) void api.gesture('end', total).catch(showError)
    }
    target.addEventListener('pointercancel', cancel)
    target.addEventListener('lostpointercapture', cancel)
  }
  wireGesture(bar, 'move', FENCE_DRAG_THRESHOLD_PX, startRename)
  // 缩放手柄：隐形地铺在四边四角，一按住移动就开始（阈值为 0）。范围见 fenceStyle。
  for (const edge of RESIZE_EDGES) {
    const handle = element(doc, 'div', `fence__handle fence__handle--${edge}`)
    handle.setAttribute('aria-hidden', 'true')
    root.append(handle)
    wireGesture(handle, edge, 0)
  }
  const finishRename = (commit: boolean) => {
    if (rename.hidden) return
    const value = rename.value.trim()
    rename.hidden = true
    title.hidden = false
    if (commit && value && value !== view?.title) void act('rename', value)
  }
  rename.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') finishRename(true)
    if (event.key === 'Escape') finishRename(false)
  })
  rename.addEventListener('blur', () => finishRename(true))

  // ─── 项目 ──────────────────────────────────────────

  const renderItem = (item: FenceViewItem, index: number) => {
    const node = element(doc, 'li', 'fence__item')
    node.tabIndex = 0
    node.dataset.id = item.id
    node.dataset.missing = String(item.missing)
    node.style.setProperty('--motion-index', String(index))
    node.title = item.missing ? `${item.name}\n${label('missing')}` : item.name
    node.setAttribute('aria-selected', String(item.id === selected))
    const img = element(doc, 'img', 'fence__icon fence__icon--blank')
    img.alt = ''
    img.draggable = false
    // 图标都是 data URL，loading=lazy 对它不起作用；离屏项目由样式里的 content-visibility 跳过。
    img.decoding = 'async'
    iconImages.set(item.id, img)
    node.append(img, element(doc, 'span', 'fence__label', item.name))
    node.addEventListener('click', (event) => {
      if (!event.isTrusted) return
      selected = item.id
      for (const other of body.querySelectorAll('.fence__item'))
        other.setAttribute('aria-selected', String(other === node))
    })
    node.addEventListener('dblclick', (event) => {
      if (event.isTrusted) void act('launch', item.id)
    })
    node.addEventListener('keydown', (event) => {
      if (!event.isTrusted) return
      if (event.key === 'Enter') void act('launch', item.id)
      if (event.key === 'Delete' && !item.fromFolder) void act('remove', [item.id])
    })
    node.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      if (!event.isTrusted || item.fromFolder) return
      closeMenus()
      const remove = element(doc, 'button', 'fence__menu-item', label('remove'))
      remove.addEventListener('click', (click) => {
        if (!click.isTrusted) return
        closeMenus()
        void act('remove', [item.id])
      })
      context.replaceChildren(remove)
      context.style.top = `${Math.min(event.clientY, window.innerHeight - 40)}px`
      context.style.left = `${Math.max(4, Math.min(event.clientX, window.innerWidth - 170))}px`
      context.style.right = 'auto'
      context.hidden = false
    })
    const mode = fenceDragMode(item)
    node.draggable = mode !== 'none'
    node.addEventListener('dragstart', (event) => {
      if (!event.isTrusted || mode === 'none') {
        event.preventDefault()
        return
      }
      const own: FenceOwnDrag = { id: item.id, mode, fromFolder: item.fromFolder }
      dragging = own
      node.dataset.dragging = 'true'
      if (mode === 'sort') {
        event.dataTransfer?.setData(ITEM_MIME, item.id)
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
        return
      }
      // 取消页面自己的拖拽，改由主进程发起系统拖拽；这之后不会再有 dragend，靠返回值判断结束。
      event.preventDefault()
      void api
        .dragOut(item.id)
        .catch(showError)
        .finally(() => {
          window.setTimeout(() => {
            if (dragging === own) finishDrag()
          }, FENCE_OWN_DRAG_GRACE_MS)
        })
    })
    node.addEventListener('dragend', () => finishDrag())
    return node
  }

  const render = (next: FenceView) => {
    view = next
    root.dataset.collapsed = String(next.collapsed)
    root.dataset.iconSize = next.iconSize
    root.dataset.layer = String(next.desktopLayer)
    title.textContent = next.title
    // 标题自己有提示时不显示标题栏的提示，贴在桌面上时要把「不能移动」也写进去。
    title.title = next.desktopLayer
      ? `${label('layerHint')}\n${label('rename')}`
      : `${label('drag')}\n${label('rename')}`
    lock.title = label('layerHint')
    doc.title = next.title
    bar.title = next.desktopLayer ? label('layerHint') : label('drag')
    lock.hidden = !next.desktopLayer
    count.textContent = String(next.items.length)
    toggle.title = next.collapsed ? label('expand') : label('collapse')
    toggle.setAttribute('aria-expanded', String(!next.collapsed))
    more.title = label('menu')
    close.title = label('close')
    close.setAttribute('aria-label', label('close'))
    const children: HTMLElement[] = []
    iconImages.clear()
    if (next.folderName)
      children.push(element(doc, 'p', 'fence__folder', label('folder', next.folderName)))
    if (!next.items.length) children.push(element(doc, 'p', 'fence__empty', label('empty')))
    else {
      const grid = element(doc, 'ul', entered ? 'fence__grid' : 'fence__grid motion-enter-children')
      entered = true
      grid.append(...next.items.map(renderItem))
      children.push(grid)
    }
    body.replaceChildren(...children)
    iconLoader.update(next.items, next.iconSize)
    applyOpacity(previewOpacity ?? next.backgroundOpacity)
    // 正在调滑块（拖动中或键盘聚焦）时不重建菜单，否则滑块会丢焦点。
    if (!menu.hidden && previewOpacity === null && doc.activeElement !== opacityInput) renderMenu()
  }

  // ─── 拖入与排序 ─────────────────────────────────────

  const isFileDrag = (event: DragEvent) =>
    !dragging && !!event.dataTransfer?.types.includes('Files')
  const clearDropMarks = () => {
    delete root.dataset.drop
    for (const item of body.querySelectorAll<HTMLElement>('.fence__item'))
      delete item.dataset.dropBefore
  }
  function finishDrag() {
    dragging = null
    clearDropMarks()
    for (const item of body.querySelectorAll<HTMLElement>('.fence__item'))
      delete item.dataset.dragging
  }
  root.addEventListener('dragover', (event) => {
    if (!dragging && !isFileDrag(event)) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = fenceDragOverEffect(dragging)
    if (!dragging) root.dataset.drop = 'true'
    const over = (event.target as Element).closest?.('.fence__item') as HTMLElement | null
    const sorting = !!dragging && !dragging.fromFolder
    for (const item of body.querySelectorAll<HTMLElement>('.fence__item'))
      item.dataset.dropBefore = String(sorting && item === over && item.dataset.id !== dragging?.id)
  })
  // 拖到框外（包括去别的程序）时收起提示。
  root.addEventListener('dragleave', (event) => {
    if (!root.contains(event.relatedTarget as Node)) clearDropMarks()
  })
  root.addEventListener('drop', (event) => {
    event.preventDefault()
    clearDropMarks()
    if (!event.isTrusted || !view) return
    const over = (event.target as Element).closest?.('.fence__item') as HTMLElement | null
    const outcome = fenceDropOutcome(dragging, over?.dataset.id, view.items)
    if (outcome.kind === 'reorder') void act('reorder', outcome.order)
    if (outcome.kind !== 'register') return
    const paths = event.dataTransfer ? api.droppedPaths(event.dataTransfer.files) : []
    if (paths.length) void act('drop', paths)
  })

  // ─── 数据 ──────────────────────────────────────────

  const refresh = () => api.state().then(render, showError)
  api.onChange((next) => {
    if (next) render(next)
    else void refresh()
  })
  void refresh()
}
