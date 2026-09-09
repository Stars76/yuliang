# 更新日志（余量 / Yuliang）

> **版本约定（每次改动务必执行）**
> - 任何功能新增 / 缺陷修复 / 行为变更，都要递增版本号，不能只改代码不改版本。
> - 三处同步：根 `package.json` 的 `version`、`src/standalone/capacitor/package.json` 的 `version`、
>   `src/standalone/capacitor/android/app/build.gradle` 的 `versionName`。
> - 安卓 `versionCode`（build.gradle）**每次出可安装包都 +1**（否则系统拒绝覆盖安装）。
> - 语义：`MAJOR.MINOR.PATCH`。破坏性大改 → MAJOR；新增功能（如新平台/新组件）→ MINOR；修 bug/小改 → PATCH。
> - 改完重新出包：`npm run dist:win`（Windows）、安卓见 `src/standalone/capacitor/README.md`。

## 1.8.2 — 2026-09-09
- **Windows 图标圆角化 + XX 放大**：`icon.ico` 重制为 7 尺寸 PNG-in-ICO（16~256px）。白底圆角 tile（半径 22%），XX 取自安卓 432px 高清前景图**放大至 tile 的 70%**（覆盖率 6.1%→21.7%），保留原配色 RGB(105,193,255)。主程序 exe / 安装包 / 卸载程序 / 快捷方式 / 任务栏图标全部统一。
- **Windows 安装目录改 yuliang**：新增 `build/installer.nsh`（NSIS include），把 electron-builder 默认目录名覆盖为 `yuliang`；安装到 `%LOCALAPPDATA%\Programs\yuliang`，主程序仍为 `余量.exe`、卸载 `Uninstall 余量.exe`、快捷方式 `余量`。`signAndEditExecutable` 开启以将图标内嵌进主程序 exe（需管理员/CI 环境构建）。
- 版本 1.8.2（安卓 versionCode 19）。

## 1.8.0 — 2026-09-09
- **工程重构：统一 provider 解析辅助**：`providers/http.js` 新增 `httpStatusToError` / `parseJson`，把 12 个 provider 重复的「HTTP 状态 → QuotaError 映射」与「JSON 解析」收敛为共享函数（401/403/429/非200/坏 JSON 分支全部对齐），行为与错误类型保持不变。Codex 的 `checkHttp` 也改走同一映射。
- **手动刷新全局限流**：`refreshQuota` 每分钟最多 5 次，超出反馈「刷新太频繁」，与 `docs/data-sources.md` 的承诺一致；后台/静默刷新不受影响。附 1 个限流单测。
- **开源准备**：`package.json` 补 `repository`/`homepage`/`bugs` 元数据与 `license`；README 下载链接指向 GitHub Releases、新增仓库说明；新增 `npm run release:bump`（同步三处版本号 + 递增 versionCode）；CI 增加 Electron 冒烟（xvfb）与 Android `assembleRelease` 构建。
- **自动发布工作流**：新增 `.github/workflows/release.yml`——push `v*` 标签（或手动触发）时在 Windows 构建 NSIS 安装包、在 Linux 构建 APK，并自动创建 GitHub Release 附上产物（版本约定见本文件顶部）。
- **Android 正式签名配置**：`build.gradle` 改为从 gitignored `keystore.properties` 读取 release 签名，未配置时回退 debug 签名（本机/CI 仍可构建）；新增 `keytool` 生成指引与 `keystore.properties.example` 模板，并 gitignore `keystore.properties`。
- **仪表盘轻量筛选**：新增按别名/服务名的搜索框，分组与总览视图通用。
- **重置到点自动刷新节流**：改为 60s 节流，避免上游返回旧 `resetAt` 时同一账号反复触发刷新。
- **凭证未加密降级提示**：「关于」页在系统钥匙串不可用时给出警告（Electron 经 preload 读取）。
- **清理死文件**：移除 PWA 遗留的 `sw.js`、`manifest.webmanifest`、`icon-192/512/maskable` 图标及注册代码（单机离线版用不到）。
- 版本 1.8.0（安卓 versionCode 17）。

## 1.7.2 — 2026-09-07
- **修复手机端凭证 Provider 下拉为空**（真机反馈）：引擎搬家后 Capacitor 打包 shim 的路径匹配静默失效，动态注册表被打进 WebView 导致 provider 加载全失败。修复后 12 个 adapter 静态内联，仪表盘/凭证/小组件一并恢复。
- 版本 1.7.2（安卓 versionCode 16）。装了 1.7.1 的用户可直接覆盖安装（同签名）。

## 1.7.1 — 2026-09-07
- **安卓发布构建切换**：`npm run apk` 改为出 release 构建（minify + shrinkResources，体积 4.2MB→1.8MB，-57%，且不带 debuggable 标志）；产物命名去掉 debug——`release-android/yuliang-<版本>.apk` + 固定名 `yuliang.apk`。无正式证书期间以 debug 密钥签 release 包（可安装、不可调试），升级仍需卸载重装；拿到 keystore 后删 gradle 里 signingConfig 一行即切正式签名。
- **安卓凭证真加密**：新增 SecureCodec 插件（Android Keystore AES-256-GCM，密钥不可导出、卸载即销毁），capacitorStore 接入后凭证落盘为密文；存量明文自动平滑迁移，解密失败如实降级。附 5 个加密链路单测。
- **加固**：`allowBackup="false"`（阻断系统备份/adb 提取凭证）；Electron loopback 服务加 Host 白名单校验（防 DNS rebinding）；小组件 ↻ 按钮补主题色（修复深色主题下不可见）。
- **清理**：Capacitor 构建剔除 Web 专属 sw.js/manifest 死文件；vite dev proxy 移除指向已删服务器的残留配置。
- 版本 1.7.1（versionCode 不变，待下次出包 +1）。

## 1.7.0 — 2026-09-07
- **新增 OpenRouter provider**：`GET /api/v1/credits`（官方端点）→ 余额 = 购入额度 − 已用；附完整解析单测与安全白名单用例。现支持 12 个 provider。
- **小组件 ↻ 刷新按钮（Android）**：全部 6 个尺寸的小组件新增刷新按钮，点击打开 App 并自动刷新一轮额度（PendingIntent 携带 widget_refresh 标记，前端桥读取后触发）。
- **无障碍打磨**：额度卡/分组/账号列表补全 role 与 aria-label（含折叠按钮、即将打满状态）；辅助文本色 `.muted` 提亮一档，正文对比度达标。
- **README 下载安装章节**：双端安装步骤与 SmartScreen / 未知来源提示（渠道链接待填）。
- 版本 1.7.0（安卓 versionCode 15）。

## 1.6.0 — 2026-09-07
- **移除全部服务器端代码，聚焦单机双端**：删除多用户 HTTP 服务/信封加密 store/审计/CLI 与 Docker 部署配置；引擎（providers/**）迁入 `src/standalone/providers`，登录/审计/用户管理等前端死视图一并移除。双端（Windows/Android）功能与测试完整保留。
- **用量阈值提醒**：仪表盘新增提醒阈值选择（85/90/95%）；窗口用量达阈值时卡片红框高亮 +「即将打满」横幅 + warn Toast 一次性提醒；同重置周期不重复打扰，回落阈值-5 以下自动重新武装。
- **清理与工程化**：删除 `_zip_extract/` 重复分发副本；git 初始化与基线入库；新增 `npm run verify`（测试+双端构建）与 GitHub Actions 工作流；CSP 纵深加固（object-src/base-uri/form-action/frame-ancestors）、Electron 渲染进程沙箱化、引擎（engine.js）单测 9 用例。
- **发布准备**：新增 MIT LICENSE；三处版本号对齐（根/capacitor/gradle）。
- 版本 1.6.0（安卓 versionCode 14）。

## 1.5.7 — 2026-09-06
- **移除圆环/嵌套环上残留的白色长条装饰**：彻底删除 `.ring-flow`（血管前锋白弧）与所有 `.ring-dot`/`.orbit-*`/`.ring-tip` 扫掠粒子等，只保留纯净的渐变彩弧 + 轨道。圆环不再出现“莫名其妙的白条”，也清除可能诱发安卓黑斑的全部叠加元素。
- 版本 1.5.7（安卓 versionCode 13）。

## 1.5.6 — 2026-09-06
- **圆环流动修正**：亮液前锋改为在「已填充的彩色弧段」内来回摆动（不再绕整圈空转）；去掉圆环填充弧的外发光/投影（`.ring-ok/warn/danger` 的 drop-shadow 已移除），特效只存在于环内，圆环外部不再有任何发光残留。
- 版本 1.5.6（安卓 versionCode 12）。

## 1.5.5 — 2026-09-06
- **圆环 / 嵌套环加“血管式”流动前锋**：在已填充弧上叠一条亮液段（`.ring-flow`），绕环循环转动 —— 与 1.5.4 进度条同一套纯 `transform: rotate` + 描边 dash 的做法，无 filter/无渐变叠加，安卓上丝滑且不产生黑斑；重置到点自动加速。
- 版本 1.5.5（安卓 versionCode 11）。

## 1.5.4 — 2026-09-06
- **进度条改为“血管式”丝滑流动**：去掉老的斜条纹 + 柔光团 + 白色粒子叠加。改用两层纯 `linear-gradient` 在管内循环平移 —— ① 一缕亮液高光流过（深浅制造纵深感）、② 细密“血细胞”鼓包沿管前进；只动 `background-position`，无 filter/无径向渐变叠加，安卓 WebView 合成开销最低、最丝滑且不会再出黑点黑斑。重置到点时流速自动加快。
- 版本 1.5.4（安卓 versionCode 10）。

## 1.5.3 — 2026-09-06
- **移除进度条/圆环的全部白色装饰粒子**（`.p-dot`/`.p-head`/`ring-dot`/`ring-tip`/`orbit-sat` 等）：仅保留干净的流动渐变弧/条，避免任何黑点黑斑并更清爽。圆环组件同步精简（RingLayers 不再画卫星/粒子/端点光珠）。
- 版本 1.5.3（安卓 versionCode 9）。

## 1.5.2 — 2026-09-06
- **修复进度条/圆环黑点黑斑**：安卓 WebView 中，白色粒子/光珠的 `drop-shadow` + 半透明径向渐变在叠加 CSS 渐变动画合成时会渲染成暗点。改为实心纯色小圆点（`.p-dot`/`.ring-dot`/`.ring-tip`/`.orbit-*` 去滤镜与渐变光晕），仍保留流动/脉冲动效但不再有暗晕。
- 版本 1.5.2（安卓 versionCode 8）。

## 1.5.1 — 2026-09-06
- **手机端动效放开**：移除 `.lite` 对圆环/进度条动画的屏蔽，安卓与桌面端一致（流动渐变、弧上粒子、端点光珠、条形纹理/彗星头全部可用）；仍保留毛玻璃/固定背景等性能相关项关闭。
- **桌面小组件添加兜底**：`requestAdd` 现在返回精确状态 —— `pin-ok`（系统已受理）/ `picker`（已打开系统小组件选择器）/ `manual`（引导长按桌面 → 小组件 → 余量 手动添加）；`requestPinAppWidget` 抛异常/被拒时不再静默，降级打开系统选择器或给出引导文案；被拒时先落 PendingWidgetConfig，手动添加也能用上你选的账号/样式/尺寸。
- 版本 1.5.1（安卓 versionCode 7）。

## 1.5.0 — 2026-09-05
- **额度显示语义改为「剩余」**：进度条/圆环/嵌套环统一显示剩余百分比（`100 − 已用`，从满额随用量递减）；纯余额卡加「可用余额」标注；带总额窗口改为「限额 $14 · 已用 $5.29/…」并保留总量。
- **长周期窗口显示具体重置日期**：每周/每月（≥1 天）窗口在倒计时旁补「M月D日 HH:MM」。
- **Command Code 引擎对齐**：解析 credits 顶层 `windowLimits` 的 5 小时/每周实时窗口（used+cap+resetAt）；套餐 id 映射短名（`individual-goat`→GOAT 等）；GOAT 套餐按官方限额 $14/$35/$70 硬编码总额并从剩余反推已用（不伪造无分母的百分比）；金额四舍五入到两位。
- **仪表盘「分组 / 总览」双视图**：可切换；总览为无分组紧凑网格；分组视图每个来源可折叠/展开。
- **拖拽排序**：分组模式下拖拽分组头调整来源先后；总览模式下拖拽卡片调整账号顺序，均 localStorage 记忆。
- **窗口有 total 也走进度可视化**：只给总量（无 used/usedPercent）的窗口不再当纯文本行，而按限额绘制。
- 版本 1.5.0（安卓 versionCode 6）。

## 1.4.0 — 2026-09-05
- **Codex（直连）支持 OAuth 设备码登录**：App 内点「登录 Codex」→ 申请设备码 → 浏览器打开验证页输码 → 自动换 token 并写入凭证；含 refreshToken 自动续期（临近过期 5 分钟预刷新并写回存储）。兼容旧手填 token（无 refreshToken 时不续期）。Electron 走 loopback 新路由 `/api/codex-direct/login[/status]`，安卓直接调引擎；验证页经系统浏览器打开（新增 `openExternal`：Electron shell / Android Intent）。
- **小组件 Command Code 显示**：带额度总量的窗口显示「月限额 10 USD · 剩 82%」，不再只有百分数。
- 版本 1.4.0（安卓 versionCode 5）。

## 1.3.0 — 2026-09-05
- **桌面小组件大一统重构**：12 个「尺寸×样式」写死预设 → 6 个尺寸族（1×1/2×1/2×2/3×2/4×2 滚动/4×4 滚动），样式/账号/主题改为**按每个小组件实例保存的配置**渲染。
- **消灭闪退**：全链路 try/catch；单行渲染失败自动降级为纯文本行；余额账号强制数字显示；quota 可选 圆环/嵌套圆环/进度条/纯数字（嵌套环画成位图）。任意账号组合任意尺寸都不再崩。
- **App 内「小组件」页**（安卓新增导航）：勾选账号 → 每个 quota 账号选样式 → 按账号数自动给「最小~最大」尺寸范围 → 一键「添加到桌面」（`requestPinAppWidget`，API≥26 弹系统放置框；22-25 打开选择器）。
- **浅色主题**：小组件默认浅色系（`#F3F6FF` 底 + 深字 + 靛蓝 accent，对齐 App 浅色主题），可跟随 App 深/浅主题（`QuotaWidgetPlugin.setTheme`）。
- 版本 1.3.0（安卓 versionCode 4）。

## 1.2.0 — 2026-09-05
- **修复安卓所有 provider 报 network error**：`@capacitor-community/http@1.4.1` 是 Capacitor 3 时代的插件，在 Cap6 下原生桥失效。移除之，改为自写原生插件 `NativeHttpPlugin`（`HttpURLConnection`，后台线程、主线程回调），`fetchShim.js` 改走该插件。已在 Windows 实测 opencode.ai/deepseek 可达（401 为未带 key 的正常表现）。
- **安卓流畅度**：新增 `.lite` 流畅模式（Capacitor 下自动启用）——去掉 `body{background-attachment:fixed}`（滚动逐帧重绘）、顶栏/弹层 `backdrop-filter` 毛玻璃、全部持续型装饰动画，并跳过圆环 SMIL 渐变旋转与轨道粒子（CSS 无法停 SMIL，组件内门控）。
- 版本 1.2.0（安卓 versionCode 3）。

## 1.1.0 — 2026-09-05
- 安卓 WebView provider 注册修复：新增 `providers.web.js` 静态导入，解决「添加凭证」白屏（运行时动态 import 在打包后解析不到哈希 chunk）。
- 安卓状态栏修复：`@capacitor/status-bar` 按主题设色，消除顶部灰条。
- 新增 `ErrorBoundary`：渲染异常显示错误信息而非整屏白屏。
- 安卓桌面小组件：12 个预设（1×1~4×4 × 进度条/圆环/纯数字 × 固定/滚动）。
- 密钥输入框可粘贴：`type=text` + CSS 遮罩 + 显示/隐藏切换。
- CPA(codex) 在安卓可用：凭证新增「管理地址 baseUrl」手填项；`codex.js` 支持每凭证 baseUrl（服务器行为不变）。
- 版本号升至 1.1.0（安卓 versionCode 2）。

## 1.0.0 — 初始单机离线版
- 共享引擎 + Electron(Windows) + Capacitor(Android) 双壳，复用现有 provider，无账户体系。
- 仪表盘 / 凭证管理 / 自动发现本机配置 / 主题 / 进度模式 / 60s 缓存+退避。
- 凭证 safeStorage(Windows)/Preferences(Android) 本地加密存储，不连任何服务器。
