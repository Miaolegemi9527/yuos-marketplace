#!/usr/bin/env node
/**
 * scripts/build-marketplace-index.mjs — 市场仓库索引构建（yuos-marketplace 独立脚本）
 *
 * 扫描 yuos-marketplace/apps/<type>/<name>/*.zby.zip：
 *   1. zip 完整性（可解包 + manifest.json 存在）
 *   2. manifest schema 校验（format=zby-creation / type / id / version）
 *   3. 官方签名验签（ECDSA P-256 + SHA-256，公钥内嵌，与客户端 official-key.ts 同源）
 *   4. 收集 icon.png / preview-*.png / README.md → 生成 index.json
 *
 * 官方仓库本体位于项目外（~/Documents/Mine/Github/Web/yuos-marketplace/，独立 git 仓库），
 * 本脚本与其内 scripts/build-marketplace-index.mjs 同源，修改须双向同步。
 *
 * 用法（在官方仓库目录内执行）：
 *   node scripts/build-marketplace-index.mjs --root . --out index.json \
 *     --base "https://cdn.jsdelivr.net/gh/<owner>/yuos-marketplace@main" \
 *     --fallback-base "https://raw.githubusercontent.com/<owner>/yuos-marketplace/main"
 *
 * manifest.json 是唯一真相源，索引只是快照（Actions push 时重建，禁止手改）。
 *
 * @see prd/ZBY-APP-STORE-ROADMAP.md §3.3.1
 */

import { createHash, webcrypto } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import JSZip from 'jszip';

/* ── CLI 参数 ─────────────────────────── */
function parseArgs(argv) {
  const args = { root: '.', out: 'index.json', base: '', fallbackBase: '', sourceName: '小语官方坊市', owner: 'yuos-marketplace-owner', repo: 'yuos-marketplace' };
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    const val = argv[i + 1] ?? '';
    if (key in args) args[key] = val;
  }
  return args;
}

/* ── 官方公钥（与 src/domains/creation/services/official-key.ts 同源） ── */
const OFFICIAL_PUBLIC_KEY_JWK = {
  kty: 'EC',
  crv: 'P-256',
  x: 'tMRIMczOcWqja_3FEmqLQYmg2P0Lhmk5nCIuFCaTl8s',
  y: 'ule2U_Uf0KHCtiuP3c_LvNp9Cly-bDhv1GrUFYTgHNY',
};

/* ── 工具函数 ─────────────────────────── */
function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** 从 base64url 解码为 Uint8Array */
function b64urlToBytes(b64url) {
  const pad = b64url.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(Buffer.from(pad + '='.repeat((4 - (pad.length % 4)) % 4), 'base64'));
}

/** 对象键递归排序（数组保持顺序；值原样保留，与 package-signature.sortKeys 同构） */
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) sorted[key] = sortKeys(value[key]);
    return sorted;
  }
  return value;
}

/** 稳定 JSON 序列化（键排序 + 无多余空白，与 package-signature.canonicalJson 同构） */
function canonicalJson(value) {
  return JSON.stringify(sortKeys(value));
}

/** 验签：签名原文 = canonicalJson({ manifest: clean, files })（与 buildSignaturePayload 同构；WebCrypto 同源，raw r||s 签名） */
async function verifyOfficialSignature(manifest, filesList) {
  const sig = manifest.signature;
  if (sig === null || typeof sig !== 'object') return { ok: false, reason: '缺少 signature' };
  if (String(sig.algorithm ?? '') !== 'ECDSA-P256-SHA256') return { ok: false, reason: '算法不支持：' + String(sig.algorithm ?? '') };
  if (String(sig.signer ?? '') !== 'zby-official') return { ok: false, reason: '签名者非官方：' + String(sig.signer ?? '') };
  /* 剥离签名自身与系统内部键（signature/id/contract/_zby.*），与打包侧一致 */
  const clean = {};
  for (const [key, val] of Object.entries(manifest)) {
    if (key === 'signature' || key === 'id' || key === 'contract' || key.startsWith('_zby.')) continue;
    clean[key] = val;
  }
  const payload = canonicalJson({ manifest: clean, files: filesList });
  const sigBytes = b64urlToBytes(String(sig.value ?? ''));
  try {
    const key = await webcrypto.subtle.importKey(
      'jwk',
      OFFICIAL_PUBLIC_KEY_JWK,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    const ok = await webcrypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      sigBytes,
      new TextEncoder().encode(payload),
    );
    return ok ? { ok: true, reason: '' } : { ok: false, reason: '验签失败' };
  } catch (e) {
    return { ok: false, reason: '验签异常：' + String(e) };
  }
}

/* ── 包检视 ───────────────────────────── */
async function inspectZip(zipPath) {
  const buf = readFileSync(zipPath);
  let zip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch {
    return { ok: false, reason: 'zip 无法解包' };
  }
  const entry = zip.file('manifest.json');
  if (entry === null) return { ok: false, reason: '缺少 manifest.json' };
  let manifest;
  try {
    manifest = JSON.parse(await entry.async('string'));
  } catch {
    return { ok: false, reason: 'manifest.json 不是有效 JSON' };
  }
  if (manifest.format !== 'zby-creation') return { ok: false, reason: 'format=' + String(manifest.format ?? '') };
  if (typeof manifest.id !== 'string' || manifest.id === '') return { ok: false, reason: '缺少 id' };
  if (typeof manifest.version !== 'string' || manifest.version === '') return { ok: false, reason: '缺少 version' };

  /* 验签：filesList = 包内产物文件哈希（排除 manifest/contract/README/versions/preview-*，与打包/导入侧一致） */
  const filesEntry = zip.file('files.json');
  let filesList;
  if (filesEntry === null) {
    /* 兼容旧包（无 files.json）：从包内实时计算 */
    filesList = [];
    for (const [path, f] of Object.entries(zip.files)) {
      if (f.dir) continue;
      if (path === 'manifest.json' || path === 'contract.json' || path === 'README.md' || path.startsWith('versions/')) continue;
      /* B3：icon.png / preview-* 二进制附件不计入签名集合（三端统一排除，附件仅作目录展示） */
      if (/^(icon\.png|preview-\d+\.(png|jpe?g|webp))$/i.test(path)) continue;
      filesList.push({ path, sha256: sha256(await f.async('uint8array')) });
    }
    filesList.sort((a, b) => a.path.localeCompare(b.path));
  } else {
    try {
      filesList = JSON.parse(await filesEntry.async('string'));
    } catch {
      return { ok: false, reason: 'files.json 不是有效 JSON' };
    }
  }
  const v = await verifyOfficialSignature(manifest, filesList);
  if (!v.ok) return v;

  return {
    ok: true,
    reason: '',
    manifest,
    sha256: sha256(buf),
    sizeBytes: buf.byteLength,
  };
}

/* ── 主流程 ───────────────────────────── */
const CREATION_TYPES = ['app', 'game', 'widget', 'skin', 'wallpaper', 'animation', 'automation'];

/** 从 zip 文件名解析语义版本（<id>-v<version>-b<build>.zby.zip）；解析失败返回 null */
function parseZipVersion(name) {
  const m = /-v(\d+\.\d+\.\d+)(?:-b(\d+))?\.zby\.zip$/.exec(name);
  if (m === null) return null;
  return {
    version: m[1].split('.').map((n) => Number(n)),
    build: m[2] !== undefined ? Number(m[2]) : 0,
  };
}

/** 版本比较：先比 version 再比 build（numeric）；无法解析的按文件名兜底（排在前面） */
function compareZipVersion(a, b) {
  const pa = parseZipVersion(a);
  const pb = parseZipVersion(b);
  if (pa === null && pb === null) return a < b ? -1 : a > b ? 1 : 0;
  if (pa === null) return -1;
  if (pb === null) return 1;
  for (let i = 0; i < 3; i++) {
    const d = pa.version[i] - pb.version[i];
    if (d !== 0) return d;
  }
  return pa.build - pb.build;
}

async function main() {
  const args = parseArgs(process.argv);
  const root = args.root.replace(/\/$/, '');
  const appsDir = join(root, 'apps');
  if (!existsSync(appsDir)) {
    console.error(`[build-marketplace-index] 未找到 ${appsDir}`);
    process.exit(1);
  }

  const apps = [];
  const errors = [];

  for (const type of CREATION_TYPES) {
    const typeDir = join(appsDir, type);
    if (!existsSync(typeDir)) continue;
    for (const name of readdirSync(typeDir)) {
      const appDir = join(typeDir, name);
      /* 跳过非目录条目（如 .DS_Store），避免 ENOTDIR 崩溃 */
      if (!statSync(appDir).isDirectory()) continue;
      const zips = readdirSync(appDir).filter((f) => f.endsWith('.zby.zip'));
      if (zips.length === 0) continue;
      /* 取最高版本 zip（语义排序：version + build numeric，防 -b15 < -b6 字符串序取错） */
      zips.sort(compareZipVersion);
      const zipName = zips[zips.length - 1];
      const zipPath = join(appDir, zipName);
      const rel = relative(root, zipPath).split('/').join('/');

      const inspected = await inspectZip(zipPath);
      if (!inspected.ok) {
        errors.push(`${rel}: ${inspected.reason}`);
        continue;
      }
      const m = inspected.manifest;

      /* 资源收集 */
      const previews = [];
      for (const f of readdirSync(appDir).sort()) {
        if (/^preview-\d+\.(png|jpg|jpeg|webp)$/i.test(f)) previews.push(relative(root, join(appDir, f)).split('/').join('/'));
      }
      /* icon：manifest.icon（内联 SVG）优先——客户端 safeSvg 只消费 <svg> 字符串；
         目录 icon.png 仅作兜底（无 manifest.icon 的社区包，客户端渲染首字母占位） */
      const iconFile = readdirSync(appDir).find((f) => f.toLowerCase() === 'icon.png');
      const icon =
        String(m.icon ?? '') !== ''
          ? String(m.icon)
          : iconFile !== undefined
            ? relative(root, join(appDir, iconFile)).split('/').join('/')
            : '';

      apps.push({
        id: String(m.id),
        type,
        name: String(m.name ?? name),
        displayName: String(m.displayName ?? m.name ?? name),
        description: String(m.description ?? ''),
        version: String(m.version),
        build: Number(m.build ?? 1),
        file: rel,
        sizeBytes: inspected.sizeBytes,
        sha256: inspected.sha256,
        signer: String(m.signature?.signer ?? 'none'),
        icon,
        previews,
        category: String(m.category ?? 'utility'),
        developer: String(m.developer ?? '小语团队'),
        developerUrl: String(m.developerUrl ?? ''),
        copyright: String(m.copyright ?? '© 2026 小语'),
        supportedLanguages: Array.isArray(m.supportedLanguages) ? m.supportedLanguages : ['zh-CN', 'zh-TW', 'en', 'ja', 'ko'],
        compatibility: Array.isArray(m.compatibility) ? m.compatibility : ['web', 'macos-intel', 'macos-arm64', 'windows', 'windows-10+', 'linux'],
        /* 更新内容/时间（与 build-app-store-local 同源）：优先包内声明，缺省回退索引构建时间 */
        updatedContent: String(m.changelog ?? m.updatedContent ?? ''),
        updatedAt: String(m.updatedAt ?? new Date().toISOString()),
        /* AI 改造版身份（与 build-app-store-local 同源透传） */
        ...(typeof m.remixOf === 'string' && m.remixOf !== '' ? { remixOf: m.remixOf } : {}),
        permissions: Array.isArray(m.permissions) ? m.permissions : [],
        tags: Array.isArray(m.aliases) ? m.aliases.slice(0, 8) : [],
      });
    }
  }

  if (errors.length > 0) {
    for (const e of errors) console.error('[build-marketplace-index] 校验失败：' + e);
    process.exit(1);
  }

  const index = {
    format: 'yuos-marketplace-index',
    schemaVersion: 1,
    source: {
      id: 'zby-official',
      name: args.sourceName,
      type: 'official',
      owner: args.owner,
      repo: args.repo,
      base: args.base,
      fallbackBase: args.fallbackBase,
      fingerprint: '',
      updatedAt: new Date().toISOString(),
    },
    apps,
  };

  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, JSON.stringify(index, null, 2) + '\n');
  console.log(`[build-marketplace-index] 校验通过 ${apps.length} 个包 → ${args.out}`);
}

main().catch((err) => {
  console.error('[build-marketplace-index] 失败：', err);
  process.exit(1);
});
