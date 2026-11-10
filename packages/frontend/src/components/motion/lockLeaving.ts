/**
 * TransitionGroup 离开项的位置锁定
 *
 * 离开项在 leave-active 阶段改为绝对定位、脱离文档流，其余项才能用 move 动画平滑让位。
 * 脱离文档流前先把当前尺寸和位置写到行内样式，避免离开项自己跳动。
 * 父容器需要是离开项的 offsetParent（position: relative / fixed 等）。
 */
export function lockLeaving(node: Element): void {
  const el = node as HTMLElement
  const { offsetWidth, offsetHeight, offsetLeft, offsetTop } = el
  el.style.width = `${offsetWidth}px`
  el.style.height = `${offsetHeight}px`
  el.style.left = `${offsetLeft}px`
  el.style.top = `${offsetTop}px`
  el.style.margin = '0'
}
