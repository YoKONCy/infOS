/**
 * @file 收纳框外观：半透明深色、细边框、小号大写标题。窗口全透明，背景由这里绘制，透明度用
 *       `--fence-bg-alpha` 控制，只影响框的背景和标题栏，图标和文字不变；文字靠阴影保持清晰。
 *       动效一律使用公共动效层（motion.css）的令牌，系统「减少动态效果」时自动归零。
 * @see .docs/P11_DESKTOP_PREFABS.md
 * @see .docs/S07_MOTION_LAYER.md
 */

export const FENCE_STYLE = `
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; overflow: hidden; background: transparent;
  font: 12px/1.35 "Segoe UI", system-ui, sans-serif; color: #f4f6fb; user-select: none; }
.fence { --fence-edge: 10px; --fence-corner: 16px; --fence-bg-alpha: 0.42;
  position: relative; height: 100%; display: flex; flex-direction: column;
  background: rgba(14, 16, 22, var(--fence-bg-alpha)); border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 6px;
  transition: background-color var(--motion-duration-fast) var(--motion-ease-out),
    border-color var(--motion-duration-fast) var(--motion-ease-out); }
.fence:hover { background: rgba(14, 16, 22, min(1, calc(var(--fence-bg-alpha) + 0.1)));
  border-color: rgba(255, 255, 255, 0.24); }
.fence[data-drop='true'] { border-color: rgba(150, 190, 255, 0.85);
  background: rgba(40, 70, 120, 0.42); }

.fence__bar { flex: 0 0 30px; height: 30px; display: flex; align-items: center; gap: 4px;
  padding: 0 6px; background: rgba(0, 0, 0, calc(var(--fence-bg-alpha) * 0.667)); cursor: grab;
  touch-action: none;
  border-radius: 5px 5px 0 0; }
.fence[data-collapsed='true'] .fence__bar { border-radius: 5px; }
/* 移动由页面内的指针手势实现（见 fenceView），不用 app-region：系统拖动区会吞掉指针事件。 */
.fence[data-gesture='move'] .fence__bar { cursor: grabbing; }
.fence[data-layer='true'] .fence__bar { cursor: default; }
.fence__title { flex: 1; min-width: 0; text-align: center; font-size: 11px; font-weight: 600;
  letter-spacing: 0.12em; text-transform: uppercase; white-space: nowrap; overflow: hidden;
  text-overflow: ellipsis; text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6);
  cursor: inherit; padding: 2px 4px; border-radius: 3px; }
.fence__rename { flex: 1; min-width: 0; height: 22px; padding: 0 6px; font: inherit;
  font-size: 11px; color: #fff; text-align: center; background: rgba(0, 0, 0, 0.45);
  border: 1px solid rgba(150, 190, 255, 0.8); border-radius: 3px; outline: none; user-select: text;
  position: relative; z-index: 3; }
.fence__count { min-width: 18px; padding: 0 5px; font-size: 10px; line-height: 16px;
  text-align: center; color: rgba(255, 255, 255, 0.72); background: rgba(255, 255, 255, 0.1);
  border-radius: 8px; }
.fence__button { all: unset; position: relative; z-index: 3; width: 22px; height: 22px;
  display: grid; place-items: center; border-radius: 4px; color: rgba(255, 255, 255, 0.85);
  cursor: pointer; }
.fence__button:hover { background: rgba(255, 255, 255, 0.14); color: #fff; }
.fence__button:focus-visible { outline: 1px solid rgba(150, 190, 255, 0.9); }
.fence__button svg { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 1.6;
  stroke-linecap: round; stroke-linejoin: round; }
.fence__chevron { transition: transform var(--motion-duration-medium) var(--motion-ease-standard); }
.fence[data-collapsed='true'] .fence__chevron { transform: rotate(-90deg); }
.fence__lock { opacity: 0.7; font-size: 10px; }
/* 折叠后窗口只剩标题栏，放不下选项菜单：先展开再改选项。 */
.fence[data-collapsed='true'] .fence__more { display: none; }
/*
 * 关闭按钮：平时隐藏，鼠标移到框上才出现；占位不变，标题不会跳动。
 * 框的背景透明度可调到 0，按钮自带深色底，浅色壁纸上也看得清。
 */
.fence__close { opacity: 0; color: #fff; background: rgba(14, 16, 22, 0.62);
  transition: opacity var(--motion-duration-fast) var(--motion-ease-out),
    background-color var(--motion-duration-fast) var(--motion-ease-out); }
.fence:hover .fence__close, .fence__close:focus-visible { opacity: 1; }
.fence__close:hover { background: rgba(196, 43, 28, 0.95); }

/* 左右下各留出缩放手柄的宽度：图标和滚动条都在手柄内侧，不会被挡住。 */
.fence__body { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden;
  margin: 0 var(--fence-edge) var(--fence-edge); padding-top: 6px; }
.fence[data-collapsed='true'] .fence__body { display: none; }
.fence__body::-webkit-scrollbar { width: 6px; }
.fence__body::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.22); border-radius: 3px; }
.fence__grid { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px;
  grid-template-columns: repeat(auto-fill, minmax(var(--fence-cell), 1fr)); }
.fence[data-icon-size='small'] { --fence-cell: 64px; --fence-icon: 24px; }
.fence[data-icon-size='medium'] { --fence-cell: 76px; --fence-icon: 36px; }
.fence[data-icon-size='large'] { --fence-cell: 92px; --fence-icon: 48px; }
/* content-visibility：滚动到视口外的项目不做布局和绘制，映射几百张图片时也不卡；高度先按图标档位估算。 */
.fence__item { display: flex; flex-direction: column; align-items: center; gap: 4px;
  padding: 6px 2px 5px; border: 1px solid transparent; border-radius: 4px; cursor: default;
  outline: none; content-visibility: auto;
  contain-intrinsic-size: auto calc(var(--fence-icon) + 44px); }
.fence__item:hover { background: rgba(255, 255, 255, 0.1); }
.fence__item:focus-visible, .fence__item[aria-selected='true'] {
  background: rgba(120, 160, 255, 0.22); border-color: rgba(150, 190, 255, 0.55); }
.fence__item[data-missing='true'] { opacity: 0.45; }
.fence__item[data-dragging='true'] { opacity: 0.35; }
.fence__item[data-drop-before='true'] { box-shadow: inset 2px 0 0 rgba(150, 190, 255, 0.95); }
.fence__icon { width: var(--fence-icon); height: var(--fence-icon); object-fit: contain;
  pointer-events: none; filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.45)); }
.fence__icon--blank { border-radius: 6px; background: rgba(255, 255, 255, 0.16); }
.fence__label { width: 100%; text-align: center; font-size: 11px; line-height: 1.3;
  word-break: break-word; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  overflow: hidden; text-shadow: 0 1px 2px rgba(0, 0, 0, 0.85); }
.fence__empty { margin: 0; padding: 18px 8px; text-align: center; color: rgba(255, 255, 255, 0.6);
  border: 1px dashed rgba(255, 255, 255, 0.22); border-radius: 4px; }
.fence__folder { margin: 0 0 4px; font-size: 10px; color: rgba(255, 255, 255, 0.55);
  text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/*
 * 缩放手柄：边 10px、四角 16px。上边只有 8px，并让位给标题栏的按钮（按钮的层级更高），
 * 否则会占掉标题文字的上半截，拖标题时变成缩放。窗口是透明的，手柄也要有一点点不透明度才收得到指针。
 * 贴在桌面上时坐标系不同，不能缩放；折叠后只剩标题栏，只保留左右两边改宽度。
 */
.fence__handle { position: absolute; z-index: 2; background: rgba(0, 0, 0, 0.008);
  touch-action: none; }
.fence__handle--n { top: -1px; left: var(--fence-corner); right: var(--fence-corner); height: 8px;
  cursor: ns-resize; }
.fence__handle--s { bottom: -1px; left: var(--fence-corner); right: var(--fence-corner);
  height: var(--fence-edge); cursor: ns-resize; }
.fence__handle--e { right: -1px; top: var(--fence-corner); bottom: var(--fence-corner);
  width: var(--fence-edge); cursor: ew-resize; }
.fence__handle--w { left: -1px; top: var(--fence-corner); bottom: var(--fence-corner);
  width: var(--fence-edge); cursor: ew-resize; }
.fence__handle--ne, .fence__handle--nw, .fence__handle--se, .fence__handle--sw {
  width: var(--fence-corner); height: var(--fence-corner); }
.fence__handle--ne { top: -1px; right: -1px; cursor: nesw-resize; }
.fence__handle--sw { bottom: -1px; left: -1px; cursor: nesw-resize; }
.fence__handle--nw { top: -1px; left: -1px; cursor: nwse-resize; }
.fence__handle--se { bottom: -1px; right: -1px; cursor: nwse-resize; }
.fence[data-layer='true'] .fence__handle { display: none; }
.fence[data-collapsed='true'] .fence__handle:not(.fence__handle--e, .fence__handle--w) {
  display: none; }
.fence[data-collapsed='true'] .fence__handle--e, .fence[data-collapsed='true'] .fence__handle--w {
  top: -1px; bottom: -1px; }

.fence__menu { position: absolute; top: 30px; right: 4px; z-index: 10; min-width: 160px;
  padding: 4px; background: rgba(24, 27, 36, 0.96); border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 6px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45); transform-origin: top right;
  max-height: calc(100vh - 34px); overflow-y: auto;
  animation: fence-pop var(--motion-duration-medium) var(--motion-ease-spring) backwards; }
.fence__menu[hidden] { display: none; }
.fence__menu-row { display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 4px 6px; color: rgba(255, 255, 255, 0.75); font-size: 11px; }
.fence__menu-slider { display: block; padding: 4px 6px 2px; color: rgba(255, 255, 255, 0.75);
  font-size: 11px; }
.fence__menu-slider-head { display: flex; justify-content: space-between; gap: 8px; }
.fence__opacity { display: block; width: 100%; height: 16px; margin: 2px 0 0; cursor: pointer;
  accent-color: rgb(120, 160, 255); }
.fence__menu-item { all: unset; display: flex; align-items: center; gap: 6px; width: 100%;
  box-sizing: border-box; padding: 5px 6px; border-radius: 4px; cursor: pointer; font-size: 12px; }
.fence__menu-item:hover, .fence__menu-item:focus-visible { background: rgba(255, 255, 255, 0.12); }
.fence__menu-item[aria-checked='true']::before { content: '✓'; width: 10px; }
.fence__menu-item[aria-checked='false']::before { content: ''; width: 10px; }
.fence__segment { display: flex; gap: 2px; }
.fence__segment button { all: unset; padding: 1px 6px; border-radius: 3px; cursor: pointer;
  color: rgba(255, 255, 255, 0.8); }
.fence__segment button[aria-pressed='true'] { background: rgba(120, 160, 255, 0.35); color: #fff; }
.fence__toast { position: absolute; left: 6px; right: 6px; bottom: 6px; z-index: 11;
  padding: 5px 8px; font-size: 11px; background: rgba(150, 40, 40, 0.92); border-radius: 4px;
  animation: motion-rise-in var(--motion-duration-medium) var(--motion-ease-out) backwards; }
.fence__toast[hidden] { display: none; }

@keyframes fence-pop {
  from { opacity: 0; transform: scale(var(--motion-scale-in)); }
}
`
