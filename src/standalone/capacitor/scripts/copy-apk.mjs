// 构建后处理：把 Gradle 产物复制为发布命名的 APK 到 release-android/
//  • yuliang-debug-<版本>.apk  带版本号（分发存档用）
//  • yuliang-debug.apk         固定名（覆盖安装/测试用）
// 版本号取 capacitor/package.json 的 version，与 gradle versionName 保持同步。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const capRoot = path.resolve(here, '..'); // capacitor/ 目录
const version = JSON.parse(fs.readFileSync(path.join(capRoot, 'package.json'), 'utf8')).version;
const src = path.join(capRoot, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
const outDir = path.resolve(capRoot, '..', '..', '..', 'release-android'); // 仓库根 release-android/

if (!fs.existsSync(src)) {
  console.error(`[apk] 未找到 Gradle 产物：${src}\n[apk] 先执行 cd android && gradlew.bat assembleDebug`);
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });
for (const name of [`yuliang-debug-${version}.apk`, 'yuliang-debug.apk']) {
  const out = path.join(outDir, name);
  fs.copyFileSync(src, out);
  console.log(`[apk] ${out}`);
}
