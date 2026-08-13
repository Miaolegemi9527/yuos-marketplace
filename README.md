# yuos-marketplace — 小语官方应用市场仓库

「小语」应用坊市（App Bazaar）的官方市场仓库。仓库内的 zby 安装包（`.zby.zip`）
由 `build-zby-app` 转包并用官方密钥签名，`index.json` 由 GitHub Actions 自动重建。

## 目录规范

```
yuos-marketplace/
├── index.json                      ← 总索引（Actions 自动重建，禁止手改）
├── apps/
│   ├── app/<name>/                 ← 按创造物类型分目录
│   │   ├── icon.png                ← 128×128 图标（可选）
│   │   ├── preview-1.png … -5.png  ← 1280×800 预览图（可选）
│   │   ├── <name>-v<version>.zby.zip
│   │   └── README.md               ← 详情描述（可选）
│   ├── game/<name>/ …
│   ├── widget/<name>/ …
│   └── theme|skin|wallpaper|animation|plugin/<name>/ …
└── .github/workflows/build-index.yml
```

## 上架流程

1. 在本仓库发起 PR：把 `.zby.zip` 放到 `apps/<type>/<name>/` 目录，可选附带图标/预览图
2. Actions 校验（zip 完整性 + 官方签名验签 + manifest schema）+ 重建 `index.json`
3. 合并到 `main` 后即上架——坊市通过 jsDelivr CDN 分发：
   - 主源：`https://cdn.jsdelivr.net/gh/Miaolegemi9527/yuos-marketplace@main`
   - 降级：`https://raw.githubusercontent.com/Miaolegemi9527/yuos-marketplace/main`

## index.json 真相源

索引由脚本从包内 `manifest.json`（zby 包唯一真相源）+ 仓库目录扫描自动生成，
`manifest.json` 的官方身份字段（developer/copyright/languages/compatibility）
由 `build-zby-app` 打包时强制写入并签名，篡改即验签失败。

schema v1 字段见 [prd/ZBY-APP-STORE-ROADMAP.md](../prd/ZBY-APP-STORE-ROADMAP.md) §3.3.1。

## 本地重建索引

```bash
node ../scripts/build-marketplace-index.mjs --root . --out index.json
```

## 签名与安全

- 官方包签名者 `signer: "zby-official"`，公钥内置于客户端（`official-key.ts`）
- 用户自签包 `signer: "user:<指纹>"`，商店安装前弹确认卡展示签名状态
- 未签名包 `signer: "none"`：卡片顶部红边警示，安装确认卡红色强化警告
