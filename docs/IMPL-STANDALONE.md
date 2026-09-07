# 单机离线版实现说明

把「多用户服务器版」额度聚合面板复刻成**独立运行、不连任何服务器、无注册/登录**的桌面/移动 App。
最大化复用现有 provider 引擎，只搭本地壳。

## 一、复用了什么（不改）

- `src/server/providers/**`：全部 provider 适配器 + `executeAdapter` / `QuotaError`（`providers/http.js`）。纯 Node ESM，Electron 主进程与 Capacitor WebView 均可复用。
- `src/server/providers/index.js`：注册表 `getAdapter` / `listProviderMeta`。
- 前端视图：`Dashboard.jsx`（额度卡/余额卡/进度模式/主题/自动刷新）、`Credentials.jsx`（表单驱动）、`Toast.jsx`、`util.js`、`styles.css` —— 逻辑原样保留。
- 数据模型与错误映射沿用 `CONTRACT.md`（plan/windows/balance/error/source/fetchedAt）。无分母时不伪造百分比。

## 二、环境无关改造（唯一动到 providers 的地方）

`src/server/providers/codex.js` 原第 6 行直接读 `process.env.CPA_MGMT_URL`（WebView 无 `process`）。
改为从 `src/standalone/env.js` 注入：

```js
import { env } from '../../standalone/env.js';
const MGMT = (env.cpaMgmtUrl || 'http://127.0.0.1:8317').replace(/\/+$/, '');
```

`env.js` 默认值仍是 `http://127.0.0.1:8317`，**线上服务端行为零变化**，`node --test` 104 项全过（含 codex 白名单断言 `127.0.0.1:8317`）。
`buildRequest` 的 `allowed` 白名单随 `env.cpaMgmtUrl` 的 host 联动。

## 三、新增文件

| 文件 | 作用 |
|---|---|
| `src/standalone/env.js` | 注入式环境（cpaMgmtUrl），Node/WebView 双活 |
| `src/standalone/engine.js` | 统一引擎接口：`listProvidersMeta/getQuota/refreshQuota/listCredentials/saveCredential/updateCredential/deleteCredential/listCodexAccounts/saveCodexAccounts/discoverLocalCredentials`；60s 缓存 + 失败指数退避（搬自 `server/http.js`，去掉 username 作用域）。无硬 Node 依赖（uuid 用 `globalThis.crypto`，discover 动态 import）以便 WebView 打包 |
| `src/standalone/store.js` | 单用户本地凭证存储（无密码/无信封）。注入 `codec`（safeStorage）加密 `fields`；无 codec → 本机明文 JSON 降级；索引不含密钥材料 |
| `src/standalone/discover.js` | 扫描本机 `~/.codex/auth.json`→codex-direct、OpenCode `auth.json`→opencode-go；脱敏预览，用户确认后入库 |
| `src/standalone/discover.web.js` | WebView 空实现（无文件系统），vite 别名替换 |
| `src/standalone/electron/main.js` | 主进程：safeStorage codec、起 `127.0.0.1:随机端口` loopback 服务、`BrowserWindow` 同源加载、锁死外部导航；`nodeIntegration:false / contextIsolation:true`；`QD_SMOKE=1` 冒烟模式 |
| `src/standalone/electron/server.js` | 极简 REST + 静态托管 `src/web/dist`（含 SPA 回退、路径穿越拦截）：`/api/quota`、`/api/quota/refresh`、`/api/credentials` CRUD、`/api/credentials/meta`、`/api/discover`、`/api/codex/accounts` |
| `src/standalone/electron/preload.cjs` | contextBridge 最小安全桥 |
| `src/standalone/capacitor/*` | Android 壳：`fetchShim.js`（`@capacitor-community/http` 覆盖全局 fetch 绕 CORS）、`capacitorStore.js`（`@capacitor/preferences` 私有沙箱，可换 SecureStorage）、`bridge.js`、`capacitor-entry.jsx`、`index.html`、`vite.config.js`（stub discover + publicDir）、`capacitor.config.ts`、`package.json`、`README.md`；桌面小组件：`widget.js`（写快照+通知）+ 原生 `android/.../com/yuliang/app/{QuotaWidgetProvider,QuotaWidgetPlugin}.java`、`MainActivity.java`（注册插件）、`res/{layout,xml,drawable}` 与清单 receiver |

## 四、前端改动（仅 src/web）

- `api.js`：删除 login/register/logout/recover/audit/users/changePassword/totp/import/export 等账户方法；保留 quota/credentials/codex/discover。**双传输**：Electron 走同源相对 REST；检测到 `globalThis.__QUOTA_ENGINE__`（Capacitor 桥注入）时直连引擎。
- `App.jsx`：去掉 boot/login/recover 分支，直接进仪表盘；移除 Security/Audit/Users/Login/Recover 引入与导航，保留主题切换。
- `Dashboard.jsx`：去掉退出登录按钮（`onLogout`）。
- `Credentials.jsx`：新增「自动发现本机配置」入口（`DiscoverModal`），手动表单保留。

`Login/Security/Audit/Users/Recover/StepUpModal` 视图文件保留在树中但不再被引用，Vite 构建 tree-shake 掉（Electron 前端构建 36 模块）。

## 五、跑起来

### Windows（Electron）
```powershell
npm install                                   # 根：electron + electron-builder（首次需下载 Electron 二进制）
node node_modules/electron/install.js         # 若 postinstall 被安全策略跳过，手动补下二进制
cd src/web; npm install; npm run build; cd ../..
npm run electron                              # 直接运行，无登录页，进仪表盘
npm run dist:win                              # electron-builder → release/（nsis 安装包 + portable exe）
```
或 `npm run build:web` 一步构建前端。

### Android（Capacitor）
见 `src/standalone/capacitor/README.md`（需 Android Studio + JDK + Android SDK）。

## 六、已实测验证

- `node --test "test/**/*.test.js"` → 104/104 通过（provider 解析不回归）。
- 引擎无服务器取数：纯 Node 下 saveCredential→refreshQuota 正常发起上游请求并如实返回错误卡（`auth_expired`），不伪造。
- 本地存储加密：注入 codec 后磁盘 `credentials.json` **不含明文密钥**，读回自动解密。
- `src/web` `npm run build` 成功（精简产物）。
- Electron 冒烟（`QD_SMOKE=1`）：窗口从 loopback 同源加载、React 挂载、`/api/credentials/meta` 返回 11 provider、`secure=true`（safeStorage 生效）。
- loopback REST 端到端：CRUD/刷新/发现/静态/SPA 回退/路径穿越 404/未知 404 全部符合预期。
- `electron-builder --win portable` → 产出 `release/余量 1.0.0.exe`（约 71MB，未签名）。
- Capacitor WebView 包 `vite build` 成功：providers+原生 HTTP+引擎全部打包，discover 编译为 0.07kB 空实现（无 `node:fs` 泄漏），fonts/icons 随 publicDir 拷贝。

### Codex 直连 OAuth 登录（v1.4 移植）
- `src/standalone/codexDirectAuth.js`：device-code 全流程（申请设备码/轮询/PKCE 换 token/id_token 解 accountId/refreshToken 续期），纯环境无关函数。
- `engine.js`：`codexDirectStart()/codexDirectPoll(loginToken)`（内存态、15 分钟 TTL、单用户）；取数路径对 `codex-direct` 先判断 `needsRefresh`（剩余<5 分钟）→ 续期并 `store.patch` 写回，再取数；同 accountId 凭证幂等覆盖。
- 路由（仅 Electron loopback）：`POST /api/codex-direct/login`、`GET /api/codex-direct/login/status`（过期 410）；安卓直接调引擎方法。
- 前端：`Credentials.jsx` 对 codex-direct 显示「登录 Codex」（不再手填字段）+ `CodexLoginModal` 轮询 + 已有凭证「重新登录」；验证页经 `openExternal`（Electron=shell / 安卓=Intent）打开系统浏览器。
- 网络边界不变：仅 auth.openai.com（登录/续期）+ chatgpt.com wham/usage（只读额度）。

### 安卓真机反馈修复
- **点「添加凭证」白屏**：根因是 `providers/index.js` 的运行时动态 import(`new URL(\`./${f}\`, import.meta.url)`) 在打包后的 WebView 里解析不到哈希 chunk 文件名 → provider 注册表为空 → 弹窗 `def.credentialFields` 崩。修复：新增 `src/standalone/providers.web.js` 静态 import 全部 adapter，经 capacitor vite 别名替换 `server/providers/index.js`（仅影响 WebView，Electron 仍走真 Node 动态 import）。构建产物已确认 provider id 静态进主 chunk。
- **顶部状态栏灰条**：加 `@capacitor/status-bar`，`capacitor-entry.jsx` 按主题设置状态栏背景色与图标明暗，并 MutationObserver 跟随主题切换。
- **兜底**：新增 `ErrorBoundary`（`src/web/src/components/ErrorBoundary.jsx`），渲染抛错时显示错误信息而非整屏白屏；`AddCredentialModal` 对 `def` 缺失加防护。

## 七、约束遵守

- 不连开发者服务器；单机版不发起任何到面板服务器的请求（上游 provider 取数是功能本身）。
- 凭证只在本机：Windows 经 safeStorage（OS DPAPI）加密，降级为明文仅限本机；密钥材料不进日志、不外发、UI 只显脱敏。
- 未改动：`src/server/http.js`、`src/server/store/**`、`src/server/cli/**`、`CONTRACT.md`、`Dockerfile`、`docker-compose.yml`；未读/未写 `data/`。

## 八、已知限制

1. **exe/快捷方式图标（打包资源）**：窗口/任务栏图标已修好——`main.js` 给 `BrowserWindow` 传了 `icon: icon.ico` 并设 `app.setAppUserModelId`，随 asar 打包，运行即生效、无需特权。但**exe 文件本身与安装快捷方式的图标**要 electron-builder 用 rcedit 写进 exe 资源，而这一步会解压 `winCodeSign` 工具缓存（内含 2 个 macOS `.dylib` 符号链接）；未开「开发者模式」且非管理员的 Windows 创建符号链接被拒（"客户端没有所需的特权"），故 `signAndEditExecutable` 暂设 `false` 让打包保持可用。要 exe/快捷方式也带图标：设置→系统→开发者选项→开启「开发人员模式」（或以管理员身份），再把 `package.json` 的 `win.signAndEditExecutable` 改回 `true` 重跑 `npm run dist:win`（`win.icon` 已指向 `src/standalone/electron/icon.ico`）。
2. **codex（CPA）跨平台可用**：`codex.js` 支持每凭证 `cred.baseUrl`（留空回退 env，服务器行为不变）；单机/安卓的凭证表单为 codex 追加「CPA 管理地址」字段（`engine.js` 的 `CODEX_URL_FIELD`，仅改 standalone 视图，不动服务器 credentialFields/测试），可手填局域网/远程 CPA 地址 + management key。`codex-direct` 亦跨平台可用。密钥框用 `type=text`+CSS 遮罩+显示切换，保证安卓可粘贴。
3. **Android 已装工具链并出包（含桌面小组件）**：本机已安装 Corretto JDK 17 + Android cmdline-tools/SDK（`C:\Android`），跑通 `cap add android` + `gradlew assembleDebug`，产出 debug APK（`release-android/yuliang-debug.apk`，包名 `com.yuliang.app`，应用名「余量」，minSdk22/target34），并含**原生桌面小组件** `QuotaWidgetProvider`（`aapt` 校验 receiver 已在清单内）。注意 AGP 在 Windows 拒绝非 ASCII 路径，构建须把 `capacitor/` 拷到纯 ASCII 目录（详见 `src/standalone/capacitor/README.md`）。小组件渲染与 App 取数尚未连接真机验证。
4. **WebView SecureStorage**：默认落到 `@capacitor/preferences`（应用私有沙箱，未额外加密）。接真正的 Keystore/SecureStorage 只需向 `loadCapacitorStore({ kv, codec })` 注入实现，无需改引擎。
5. OpenCode Go/Zen、command-code 等上游若非文档化接口变更，卡片如实显示「上游变更」，与服务器版一致。
