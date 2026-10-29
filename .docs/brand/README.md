# 应用品牌资产

2026-10-17 定稿：

- `infos-approved.svg`：I-C 图形 + I-B 路径字标，应用内使用。实现位于 `packages/frontend/src/components/brands/InfosLogo.vue`，字标跟随深浅色主题，图形保持定稿配色。

历史备用品牌稿、角色美术归档与 Steam 商店设计仅在本地归档目录保存，不随源码或应用包分发。当前角色头像与立绘以 `packages/backend/src/assets/agents/<角色 ID>/` 为准；旧头像迁移用例所需样本单独保存在 `packages/backend/tests/fixtures/agents/`。

系统图标继续使用原角色资产：`public/Logo.png`、`public/icon.png`、`public/icon.ico`。Windows 任务栏、Electron 托盘与 exe 图标仍由这些资产提供；应用内品牌 SVG 不替代系统图标。
