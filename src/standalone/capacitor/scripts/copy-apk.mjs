// 构建后处理：把 Gradle 产物复制为发布命名的 APK 到仓库根 release-android/
//  • yuliang-<版本>.apk   带版本号（分发存档用）
//  • yuliang.apk          固定名（覆盖安装/测试用）
// 版本号取 capacitor/package.json 的 version，与 gradle versionName 保持同步。
// 构建类型默认 release（assembleRelease，debug 密钥签名折中）；APK_DEBUG=1 时取 debug 产物。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const capRoot = path.resolve(here, '..'); // capacitor/ 目录
const version = JSON.parse(fs.readFileSync(path.join(capRoot, 'package.json'), 'utf8')).version;
const isDebug = process.env.APK_DEBUG === '1';
const buildType = isDebug ? 'debug' : 'release';
const tag = isDebug ? 'debug-' : '';
const src = path.join(capRoot, 'android', 'app', 'build', 'outputs', 'apk', buildType, `app-${buildType}.apk`);
const outDir = path.resolve(capRoot, '..', '..', '..', 'release-android'); // 仓库根 release-android/

if (!fs.existsSync(src)) {
  console.error(`[apk] 未找到 Gradle 产物：${src}\n[apk] 先执行 cd android && gradlew.bat assembleRelease`);
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });
for (const name of [`yuliang-${tag}${version}.apk`, `yuliang${tag ? '-' + tag : ''}.apk`]) {
  const out = path.join(outDir, name);
  fs.copyFileSync(src, out);
  console.log(`[apk] ${out}`);
}
