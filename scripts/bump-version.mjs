// scripts/bump-version.mjs
// 一键同步三处版本号 + 递增安卓 versionCode（对齐 CHANGELOG 的版本约定）。
// 用法：
//   node scripts/bump-version.mjs                  # 默认递增 PATCH（1.7.2 → 1.7.3）
//   node scripts/bump-version.mjs --minor          # 递增 MINOR
//   node scripts/bump-version.mjs --major          # 递增 MAJOR
//   node scripts/bump-version.mjs --version=2.0.0   # 指定目标版本
// 说明：versionCode 每次执行 +1（用于出可安装包）；三处版本保持一致后才同步。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootPkgPath = path.join(root, 'package.json');
const capPkgPath = path.join(root, 'src', 'standalone', 'capacitor', 'package.json');
const gradlePath = path.join(root, 'src', 'standalone', 'capacitor', 'android', 'app', 'build.gradle');

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
}
function nextVersion(cur, arg) {
  if (arg && arg.startsWith('--version=')) return arg.slice('--version='.length);
  const [maj, min, pat] = cur.split('.').map((x) => Number(x) || 0);
  if (arg === '--major') return `${maj + 1}.0.0`;
  if (arg === '--minor') return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}
function readVersionName(gradle) {
  const m = gradle.match(/versionName\s+"([^"]+)"/);
  return m ? m[1] : null;
}
function readVersionCode(gradle) {
  const m = gradle.match(/versionCode\s+(\d+)/);
  return m ? Number(m[1]) : null;
}

const arg = process.argv[2];
const rootPkg = readJson(rootPkgPath);
const capPkg = readJson(capPkgPath);
let gradle = fs.readFileSync(gradlePath, 'utf8');

const current = rootPkg.version;
if (capPkg.version !== current) {
  console.error(`[bump] 警告：capacitor/package.json 版本 ${capPkg.version} 与根 ${current} 不一致，先手动对齐`);
}
const versionName = readVersionName(gradle);
if (versionName && versionName !== current) {
  console.error(`[bump] 警告：build.gradle versionName ${versionName} 与根 ${current} 不一致，先手动对齐`);
}

const next = nextVersion(current, arg);
if (!/^\d+\.\d+\.\d+$/.test(next)) {
  console.error(`[bump] 无效版本：${next}`);
  process.exit(1);
}

const versionCode = (readVersionCode(gradle) ?? 0) + 1;
rootPkg.version = next;
capPkg.version = next;
writeJson(rootPkgPath, rootPkg);
writeJson(capPkgPath, capPkg);
gradle = gradle.replace(/versionCode\s+(\d+)/, `versionCode ${versionCode}`);
gradle = gradle.replace(/versionName\s+"[^"]+"/, `versionName "${next}"`);
fs.writeFileSync(gradlePath, gradle);

console.log(`[bump] 版本 ${current} → ${next}`);
console.log(`[bump] 安卓 versionCode → ${versionCode}`);
console.log('[bump] 已同步：package.json / capacitor/package.json / build.gradle');
