# 自定义主题

入口：「系统设定 → 外观设置 → 自定义主题」。可以选择、导入（ZIP）、删除和刷新主题；选择按设备保存，与深色 / 浅色切换一致。

主题只改变外观：内容是 CSS 与图片、字体，不运行脚本。

## 主题文件夹

主题存放在数据目录的 `themes/` 下，每个主题一个文件夹，文件夹名即主题 ID（小写字母、数字、`_`、`-`）：

```text
themes/
└── sakura/
    ├── theme.json     名称、作者、说明、适用模式（可选）
    ├── theme.css      必需
    ├── img/bg.webp    资源文件，按 theme.css 中的相对路径引用
    └── fonts/x.woff2
```

把文件夹放进 `themes/` 后在设置页点「刷新」即可；设置页会显示服务端实际的文件夹位置。

`theme.json`：

```json
{
  "name": "樱花",
  "description": "粉色强调色与暖白背景",
  "author": "作者",
  "version": "1.0.0",
  "mode": "light"
}
```

| 字段                                 | 说明                                                                               |
| ------------------------------------ | ---------------------------------------------------------------------------------- |
| `name`                               | 显示名称，最多 100 字；为空时显示文件夹名                                          |
| `description` / `author` / `version` | 可选，显示在选择框下方                                                             |
| `mode`                               | 可选，`light` 或 `dark`。选用主题时切换到该模式；不填表示跟随当前的深色 / 浅色设置 |

`theme.json` 缺失或格式错误时仍可使用，名称显示为文件夹名。

## theme.css 怎么写

infOS 的颜色、阴影、圆角都定义为 CSS 变量，主题覆盖这些变量即可。主题样式放在页面 `<head>` 的最后，同等优先级时覆盖应用自身的定义。

```css
/* 两种模式都生效 */
:root {
  --ui-accent-primary: #e0457b;
  --ui-accent-primary-soft: rgba(224, 69, 123, 0.12);
}

/* 只在浅色 / 深色模式生效 */
[data-theme='light'] {
  --ui-bg-canvas: #fff5f8;
}
[data-theme='dark'] {
  --ui-bg-canvas: #1a1220;
}

/* 资源用相对路径 */
@font-face {
  font-family: 'MyFont';
  src: url('fonts/x.woff2') format('woff2');
}
:root {
  --ui-font-sans: 'MyFont', sans-serif;
}
```

常用变量（完整定义见 `packages/frontend/src/assets/ui-tokens.css` 与 `tokens.css`）：

| 分组         | 变量                                                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 背景         | `--ui-bg-canvas`、`--ui-bg-sidebar`、`--ui-bg-surface`、`--ui-bg-surface-soft`、`--ui-bg-elevated`、`--ui-bg-hover`、`--ui-bg-active`             |
| 文字         | `--ui-text-primary`、`--ui-text-secondary`、`--ui-text-tertiary`、`--ui-text-disabled`、`--ui-text-inverse`                                       |
| 边框         | `--ui-border-subtle`、`--ui-border-default`、`--ui-border-strong`                                                                                 |
| 强调与语义   | `--ui-accent-primary`、`--ui-accent-sky`、`--ui-accent-purple`（各带 `-soft`）、`--ui-success`、`--ui-warning`、`--ui-danger`、`--ui-focus-color` |
| 设置面板     | `--dash-panel-bg`、`--dash-panel-soft`、`--dash-panel-border`、`--dash-input-bg`、`--dash-input-border` 等                                        |
| 阴影与遮罩   | `--ui-shadow-*`、`--ui-glow-*`、`--ui-overlay-backdrop`                                                                                           |
| 字体与圆角   | `--ui-font-sans`、`--ui-font-pixel`、`--ui-font-mono`、`--ui-radius-*`                                                                            |
| 像素组件色系 | `tokens.css` 中的 `--color-{sky,pink,amber,emerald,indigo…}-{outline,shadow,face,light,hover}`                                                    |

注意：

- `:root` 中的覆盖对两种模式都生效，包括深色模式；只想改一种模式时用 `[data-theme='light']` / `[data-theme='dark']`。写了 `mode` 的主题也建议把颜色放在对应的 `[data-theme]` 中：用户手动切到另一种模式时回到默认配色，不会出现浅底浅字。
- 部分界面仍直接使用 Tailwind 颜色类（如 `text-slate-500`），不随变量变化。可以在 theme.css 中写普通选择器补充，但这类规则依赖界面结构，infOS 更新后可能失效；优先只改变量。
- 相对 `url()` 会改写为主题文件地址；绝对地址（`https:`、`data:`、以 `/` 开头）保持不变，含 `..` 的路径无效。主题根文件夹不接受目录联接或符号链接，包括指向库内其他主题的别名，读取、覆盖和删除均拒绝这些入口；主题内部资源仍按真实路径校验，不能越出该主题文件夹。正文和清单在打开后核对文件身份与归属，再通过同一句柄读取，避免异步打开期间换掉路径后读取外部文件。`@import "x.css"` 形式的相对导入不会改写，样式请写在 theme.css 一个文件里。
- 可读取的资源类型：`.css .png .jpg .jpeg .webp .gif .avif .woff .woff2 .ttf .otf`；不开放 SVG。

## 导入 ZIP

- ZIP 内可以是 `theme.css` 等文件直接在根目录，也可以包在一个顶层文件夹里。主题 ID 取顶层文件夹名，没有时取 ZIP 文件名；得不到合法 ID（例如全是中文）时自动生成 `theme-xxxxxxxx`。
- 已存在同名主题时会询问是否覆盖；覆盖会整体替换原文件夹。同一主题 ID 的导入与删除串行执行，导入结果在同一次操作内确定；并发导入时不允许覆盖的那次返回 ALREADY_EXISTS。
- 先解压到临时文件夹；覆盖时原文件夹先改名为待恢复备份 `.backup.<ID>.<随机串>`。新主题就位后，将备份改名为 `.retired.<ID>.<随机串>` 才算提交成功，再尝试清理；提交状态改名失败会撤回新目录并恢复旧目录。改名遇到短暂占用（EPERM/EBUSY/EACCES）时有界重试。
- 列表、导入和删除均在同 ID 锁内处理遗留备份。只有目标不存在且待恢复备份唯一时自动恢复；多份历史备份或目标与待恢复备份并存时全部保留并记录警告，覆盖导入会报错要求先检查。`replace=false` 将待恢复备份也视为已存在；已提交的 retired 只做清理、不参与恢复。删除先清理该 ID 的备份再删除目标，清理失败不报告删除成功，避免列表复活已删除的旧版本。
- 不支持的文件类型在导入时跳过；macOS 的 `__MACOSX/` 忽略。
- 限制：ZIP 20MB，解压后 64MB，最多 500 个文件，theme.css 不超过 1MB。

## 已知限制

- 文件夹改名只做有界重试；杀毒软件或资源管理器长时间占用主题文件夹时，导入或删除会失败并保留原状态，需要解除占用后重试。
- 同一 ID 有多份待恢复备份，或目标与待恢复备份并存时，不会自动判断哪份是正确版本，需要手动检查主题文件夹后删除多余备份。

## API

| 操作         | API                                                                  |
| ------------ | -------------------------------------------------------------------- |
| 列表与文件夹 | `GET /api/themes`，返回 `{ folder, themes }`                         |
| 读取文件     | `GET /api/themes/:id/files/<相对路径>`                               |
| 导入         | `POST /api/themes/import`，multipart 字段 `theme`；`?replace=1` 覆盖 |
| 删除         | `DELETE /api/themes/:id`                                             |

## 实现位置

- 共享结构、清单归一化、`url()` 改写：`packages/shared/src/customTheme.ts`
- 服务端：`services/theme/themeService.ts`，路由 `routers/theme.router.ts`
- 前端：`composables/ui/useCustomTheme.ts`（载入与注入，主界面与启动页挂载时调用 `start()`）、`components/dashboard/CustomThemeSettings.vue`（设置页）
