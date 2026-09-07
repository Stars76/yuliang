# 余量（Yuliang）· Android（Capacitor）壳

复用与 Windows 版**同一份 React 前端**与**同一份引擎**（`src/standalone/engine.js`），
差异只在宿主注入的两件事：网络与存储。前端 `src/web/src/api.js` 会检测 `globalThis.__QUOTA_ENGINE__`，
存在时直接调用引擎（WebView 无 Node、无 loopback 服务），否则走 Electron 的同源 REST。

## 关键设计

- **网络**：`fetchShim.js` 用 `@capacitor-community/http` 覆盖全局 `fetch`，走原生 OkHttp，绕过 WebView 对上游（chatgpt.com / api.deepseek.com 等）的 CORS 拦截——这是 Android 的硬门槛。
- **存储**：`capacitorStore.js` 提供与 `store.js` 相同的同步接口，变更异步落盘到 `@capacitor/preferences`（应用私有沙箱）。
  要接入真正的 SecureStorage/Keystore，只需在 `loadCapacitorStore({ kv, codec })` 注入 `kv` 与 `codec`，无需改引擎。
- **discover**：本机文件扫描依赖 `node:fs`，WebView 不可用；`vite.config.js` 把 `discover.js` 别名到 `../discover.web.js` 空实现，界面上的「自动发现本机配置」在 Android 返回空候选（其余 provider 手动填写）。
- **Provider 注册**：WebView 里不能用 `providers/index.js` 的运行时动态 import（打包后解析不到哈希 chunk 名 → 注册表为空 → 「添加凭证」白屏）；改由 `src/standalone/providers.web.js` 静态 import 全部 adapter，经 vite 别名替换（仅 WebView；Electron 仍走真 Node 动态 import）。
- **状态栏**：`@capacitor/status-bar` 按主题设置背景色与图标明暗，消除顶部灰条；`ErrorBoundary` 让渲染异常显示错误信息而非整屏白屏。
- **CPA 管理口（codex）**：安卓也可用，凭证改为**手填「CPA 管理地址 + Management Key」**（`baseUrl` 字段，见 `engine.js` 的 `CODEX_URL_FIELD`）；留空则回退本机 `127.0.0.1:8317`。`codex.js` 已支持每凭证 `cred.baseUrl`（服务器不传则行为不变）。可指向局域网/远程自建 CPA 实例。
- **密钥粘贴**：凭证表单的密钥框用 `type=text` + CSS 遮罩（`-webkit-text-security`）+ 显示/隐藏切换，安卓长按可正常粘贴。
- **桌面小组件**：6 个尺寸族，样式/账号/主题**按实例配置**（v1.3 大一统），见下一节。App 每次取数后把**不含密钥**的额度快照写入 `SharedPreferences`（文件 `CapacitorStorage`、键 `widget_snapshot`），原生读取渲染并按实例配置重绘；`QuotaWidgetPlugin` 负责即时刷新 + 一键「添加到桌面」+ 主题跟随。

## 桌面小组件（放到桌面、不打开 App 也能瞄额度）

**推荐做法（v1.3）**：在 App 内点「小组件」页 —— 勾选账号 → 每个 quota 账号选样式（圆环/嵌套圆环/进度条/纯数字）→ 自动给「最小~最大」尺寸范围 → 一键「添加到桌面」（Android 弹系统放置框确认）。

- **尺寸族**：1×1 / 2×1（单账号大图）、2×2 / 3×2（固定多行）、4×2 / 4×4（内部滚动）。
- **样式规则**：balance 账号 → 一律数字余额；quota 账号 → 你选的样式；嵌套圆环为 Canvas 位图（外层=每周、内层=5h，中心数字）。
- **主题**：默认浅色（`#F3F6FF` 底 + 靛蓝 accent，对齐 App 浅色主题）；App 内切深色时经 `QuotaWidgetPlugin.setTheme` 跟随。
- **抗闪退**：每实例配置存 SharedPreferences（`widget_cfg_<id>`）；无配置的新实例用最近一次「添加到桌面」的配置；渲染全 try/catch，单行失败降级纯文本，任何数据/组合都不崩。
- 数据链路：`widget.js`（写快照+通知）→ `QuotaWidgetPlugin` → `BaseQuotaWidget`(6 子类)/`QuotaWidgetService`（滚动）。
- 刷新时机：① App 前台取数后即时重绘；② 系统按 `updatePeriodMillis`（≥30 分钟）周期刷新。不打开 App 显示最近快照。
- 快照只含展示字段（别名/百分比/金额/时间），**绝不含密钥材料**。
- 代码：`WidgetData.java`（配置/快照/画环/渲染）+ `BaseQuotaWidget.java` + `W1x1`…`W4x4` + `QuotaWidgetService`（滚动）+ `QuotaWidgetPlugin`（pin/refresh/theme）+ `PendingWidgetConfig` + `res/{layout,xml,drawable}` + 清单 6 个 receiver。

## 构建（本机已装好命令行工具链，无需 Android Studio GUI）

已安装并验证：Corretto **JDK 17** → `C:\Android\jdk-17`；Android **cmdline-tools** → `C:\Android\cmdline-tools\latest`；
SDK（`platform-tools` / `platforms;android-34` / `build-tools;34.0.0`）→ `C:\Android`。
用户级环境变量 `JAVA_HOME` / `ANDROID_HOME` / `PATH` 已写入（新开终端生效）。

```bash
cd src/standalone/capacitor
npm install
npm run build:web        # vite 构建 → www/
npx cap add android      # 生成 android/（已生成）
npx cap sync
```

### ⚠️ Windows 非 ASCII 路径坑（重要）
Android Gradle Plugin 在 Windows 上**拒绝含中文/非 ASCII 的路径**（本工作区 `DSH工作区\余额查询APP` 会触发
`Your project path contains non-ASCII characters`）。`cap add android` 能跑，但 `gradlew` 编译会失败。
解决办法：把整个 `capacitor/` 目录（含 `node_modules`）拷到纯 ASCII 路径再构建，例如：

```powershell
robocopy "C:\...\src\standalone\capacitor" "C:\capbuild" /E
Set-Content C:\capbuild\android\local.properties "sdk.dir=C\:\\Android" -Encoding ascii
cd C:\capbuild\android
.\gradlew.bat assembleDebug --no-daemon
# 产物：C:\capbuild\android\app\build\outputs\apk\debug\app-debug.apk
```
（或直接长期把项目放在 ASCII 路径下，如 `C:\dev\quota`。）

## 已实测产物

上面流程在本机跑通，产出 **debug APK**（已拷回工作区 `release-android/yuliang-debug.apk`）：
- 包名 `com.yuliang.app`，versionName 1.0
- minSdk 22 / targetSdk 34 / compileSdk 34
- 应用名「余量」，启动 `MainActivity`，含 **6 个桌面小组件尺寸族 + 一键添加 + 主题跟随**（`aapt` 已校验 6 个 receiver + 集合服务在包内），约 4.2 MB

## 上架 / 正式签名

```bash
cd <ASCII路径>/android
gradlew bundleRelease          # AAB（Play 上架用）
gradlew assembleRelease        # APK
```
debug APK 用默认 debug keystore，可直接侧载到真机/模拟器安装测试；正式分发需配 release keystore 签名（Play 还需 AAB）。

## 已知限制

- `@capacitor-community/http@1.4.1` 官方尚未正式适配 Capacitor 6（`cap add` 会 warn 并尽力迁移），本次实测可正常编译通过。
- `codex`(CPA) 在安卓通过**手填管理地址 + key** 使用（不再隐藏）；需能访问到你填的 CPA 实例地址（局域网/远程均可，http/https 由你填）。`codex-direct` 直连也可用。
- 未在本机实机/模拟器安装运行验证（无连接的设备）；APK 已构建且 `aapt` 校验为合法可安装包，小组件 receiver 已在清单内，但**渲染效果需装到真机确认**。
- 桌面小组件依赖 App 至少前台刷新过一次才有数据；纯后台不会自动联网刷新（Android 限制 WebView 后台）。
- 启动器图标仍是 Capacitor 默认（`@mipmap/ic_launcher`）；要换成「余量」logo 需用 Android Studio 的 Image Asset 生成各密度图标（本机 headless 未做）。
