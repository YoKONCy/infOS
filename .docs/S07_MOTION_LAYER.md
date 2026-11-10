# S07 公共动效层

前端所有新加的过渡都走这一层：令牌、过渡类和几个小组件。目的是让各处动效节奏一致，作者组件只需「套一层」，不用各写一套。

- 样式：`packages/frontend/src/assets/motion.css`（由 `style.css` 全局引入）
- 组件：`packages/frontend/src/components/motion/`
- 与 [S06 §10](./S06_UI_UX_DESIGN_SPEC.md) 的关系：S06 的 `--ui-duration-*` 继续有效；新代码优先使用本层的 `--motion-*`。

## 1. 令牌

| 令牌                         | 值                                  | 用途                       |
| ---------------------------- | ----------------------------------- | -------------------------- |
| `--motion-duration-fast`     | 120ms                               | 悬停、按压、小气泡、退出   |
| `--motion-duration-medium`   | 200ms                               | 弹出菜单、提示条、卡片入场 |
| `--motion-duration-slow`     | 320ms                               | 抽屉、展开收起、列表让位   |
| `--motion-exit-ratio`        | 0.75                                | 退出时长 = 进入 × 该比例   |
| `--motion-ease-out`          | `cubic-bezier(0.2, 0, 0, 1)`        | 进入                       |
| `--motion-ease-in`           | `cubic-bezier(0.3, 0, 1, 1)`        | 退出                       |
| `--motion-ease-standard`     | `cubic-bezier(0.2, 0, 0.1, 1)`      | 位置移动、高度展开         |
| `--motion-ease-emphasized`   | `cubic-bezier(0.32, 0.72, 0, 1)`    | 抽屉、大面板               |
| `--motion-ease-spring`       | `cubic-bezier(0.34, 1.32, 0.64, 1)` | 小型弹出物的轻微回弹       |
| `--motion-distance-sm/md/lg` | 4px / 8px / 16px                    | 位移距离                   |
| `--motion-scale-in`          | 0.96                                | 弹出物的起始缩放           |
| `--motion-scale-press`       | 0.97                                | 按压缩放                   |
| `--motion-lift-hover`        | -1px                                | 卡片悬停抬起               |

### 减少动效

| 场景                                             | 行为                                             |
| ------------------------------------------------ | ------------------------------------------------ |
| 系统「减少动态效果」(`prefers-reduced-motion`)   | 位移、缩放归零，展开收起不做高度动画，只淡入淡出 |
| 系统设定 → 动效「减少」(`data-motion="reduced"`) | 同上，并缩短时长                                 |
| 系统设定 → 动效「关闭」(`data-motion="off"`)     | 所有时长归零                                     |

组件里直接用令牌即可，不需要自己再写 `@media (prefers-reduced-motion)`。

## 2. 过渡类

直接作为 `<Transition name>` 使用：

| 名称                                      | 效果             | 适用                              |
| ----------------------------------------- | ---------------- | --------------------------------- |
| `motion-fade`                             | 淡入淡出         | 遮罩、状态文字                    |
| `motion-rise`                             | 淡入 + 上浮 8px  | 提示条、新出现的区块、toast       |
| `motion-pop`                              | 从触发点缩放弹出 | 下拉菜单、气泡、浮层              |
| `motion-sheet`                            | 淡入 + 轻微放大  | 对话框                            |
| `motion-slide-end` / `motion-slide-start` | 从右 / 左滑入    | 抽屉、侧栏                        |
| `motion-swap`                             | 短促的上下替换   | 同位置内容切换（`mode="out-in"`） |

`motion-pop` 的原点用 `--motion-origin` 指定，默认 `top center`；向上弹出的菜单设 `--motion-origin: bottom center; --motion-pop-direction: 1`。

不需要 `Transition` 的一次性入场：给元素加 `motion-enter`（自身）、`motion-enter-children`（直接子元素，可用 `--motion-index` 错落）、`motion-enter-fade`。

## 3. 组件

| 组件                | 作用                                                                                                                                                        |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MotionList`        | 包一层 `TransitionGroup`，增删淡入淡出、其余项平滑让位。子元素需稳定 key（`v-if` 的空状态也要给 key）。只用于中短列表；单项加 `motion-list-static` 可不参与 |
| `MotionCollapse`    | `open` 控制展开收起（grid-template-rows 0fr→1fr），收起后内容 `inert`；`lazy` 首次展开才渲染                                                                |
| `MotionSkeleton`    | 骨架占位，`variant` 为 `list` / `text` / `card`，延迟 120ms 才淡入，短加载不闪                                                                              |
| `SurfaceTransition` | 页面与会话级切换（已有），带等待遮罩与骨架                                                                                                                  |

## 4. 可点元素

- 全局默认：所有 `button` 与 `[role="button"]` 按下时缩小到 `--motion-scale-press`。规则用 `:where()` 写成零优先级，组件只要自己声明了 `transform` 就以组件为准，不需要额外退出。
- `motion-press`：按压时缩小到 `--motion-scale-press`，并统一颜色、阴影的过渡时长。
- `motion-lift`：卡片类，悬停抬起 1px，按压缩小。
- 像素按钮（`PButton` 等）保留自己的下沉反馈，不叠加这两个类。

## 5. 约束

- 只对 `transform` 和 `opacity` 做动画；不要对 `width`、`height`、`top`、`left`、`margin` 做过渡。
- 长列表（消息流）不使用 `MotionList`；消息入场只给最后几条播放。
- 同一区域最多一个持续动画（见 S06 §10.3）。
