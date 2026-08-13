# apps — 包目录

按创造物类型分子目录，每个应用一个子目录：

- `app/<name>/` — 应用包目录
- `game/<name>/` — 游戏包目录
- 其余类型：widget / theme / skin / wallpaper / animation / plugin / skill / script / automation

每个包目录内：

- `<name>-v<version>.zby.zip` — 安装包（必填，命名必须符合规范）
- `icon.png` — 128×128 图标（可选）
- `preview-1.png` … `preview-5.png` — 1280×800 预览图（可选）
- `README.md` — 详情描述（可选）

索引构建脚本 scripts/build-marketplace-index.mjs 随仓库分发，
在仓库根目录执行 `node scripts/build-marketplace-index.mjs` 本地预览索引结果。
