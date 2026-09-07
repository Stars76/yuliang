# 单机离线版：EntropicEcho 额度聚合面板（Windows App + Android App）

## 目标

做一个**独立运行、不连你服务器、无账户体系**的单机 App，复刻网页版大部分功能：
- 保留：仪表盘（额度卡/余额卡/进度模式/自动刷新/主题）、凭证管理、Codex 账号枚举、自动读取本机已有配置 + 手动填写双轨凭证来源。
- 砍掉：注册/登录/恢复、会话、TOTP、密码修改、多用户、管理员、审计、导出导入（它们依赖服务器账户体系）。
- 凭证来源双轨：**(a)** 自动读取本机已有工具的配置文件（Codex `~/.codex`、OpenCode `auth.json` 等）；**(b)** 手动填写（DeepSeek / Ollama / command-code / kimi / z.ai / sub2api / newapi 等纯云端服务没有本地文件）。

## 核心事实（决定架构）

- `src/server/providers/*` 与 `src/server/providers/http.js` 只依赖全局 `fetch`/`URL`/`AbortSignal.timeout`，**是纯 Node ESM，可被 Electron 主进程原样复用**；`providers/index.js` 用动态 `import` 惰性加载。
- `codex-direct.js` 只需 `accessToken`+`accountId`（来自 `~/.codex/auth.json`），**不依赖 CPA 服务**，单机可直接用。
- `codex.js` 读 `process.env.CPA_MGMT_URL`（默认 `127.0.0.1:8317`）——Windows 单机默认不通，需要环境抽象。
- 网页版前端 `src/web` 是 React+Vite，`api.js` 通过**同源 REST**（`/api/*`）与后端交互，含登录/审计/用户等调用。单机版会精简 `api.js`，前端其余视图（仪表盘/凭证）几乎原封不动复用。
- `.gitignore`/无 git；无任何 Electron/Tauri/Capacitor 工具链（`which electron` 无结果，只有 node/npm）。

## 推荐方案（架构复用最大化）

**共享的"单机引擎" + 两个壳**：

- 引擎：把现有 provider 层（`src/server/providers/**`、`executeAdapter`、`QuotaError`、quota 组装/cache/退避、Codex listAccounts/fetchCodexQuota）抽成一个**不依赖 HTTP 服务器/store 的纯 JS 模块**，暴露统一接口：`listProvidersMetrics()`、`getQuota()`、`refreshQuota(id?)`、`listCredentials()`/`saveCredential()`/`updateCredential()`/`deleteCredential()`、`listCodexAccounts(credId)`、`discoverLocalCredentials()`。
- 引擎保持环境无关：把 `CPA_MGMT_URL` 等通过**注入的 env 对象**传入（不再在模块顶层读 `process.env`），使同一份代码可跑在 Node（Electron 主进程）和 WebView（Capacitor）里。
- **Windows（Electron）**：main 进程跑引擎，内置一个**仅 loopback 的极简 `node:http` 静态+REST 服务**（只实现保留视图用到的端点 + 静态托管 `src/web` 构建产物），加载 `http://127.0.0.1:<随机端口>/`。前端 `api.js` 换成 loopback 同源版（去掉登录/审计/用户），凭证经 `electron.safeStorage`（OS 钥匙串）加密落盘；凭证多存一份明文索引 JSON 供 UI 展示（无密钥材料）。
- **Android（Capacitor）**：WebView 直接加载同一前端构建产物；引擎的 provider 取数改走 `@capacitor-community/http`（原生 fetch，绕过 WebView CORS）；凭证存 Capacitor SecureStorage；`env` 由原生插件注入。**CORS 是 Android 唯一的硬性门槛**，必须用原生 HTTP 插件。

## 实施步骤（分阶段，先 Windows 后 Android）

### 阶段 0 — 复用边界确认（不动现有线上）
- 新增独立目录 `src/standalone/`（与 `src/server` 分开），不改动线上服务端 `src/server`、前端业务视图。
- 引擎 `src/standalone/engine.js` re-export 现有 providers 与 `executeAdapter`，验证 `node -e` 可无服务器调用。

### 阶段 1 — 引擎与环境抽象
- `src/standalone/env.js`：`{ cpaMgmtUrl }` 注入对象；`codex.js` 改为从注入 env 取 base URL（默认 `http://127.0.0.1:8317`），**保持线上默认行为不变**。
- `src/standalone/engine.js`：实现上述接口，含 60s 缓存与失败指数退避（搬自 `server/http.js` 的 `fetchOne/collectQuota/cache`，去掉 username 作用域）。
- `src/standalone/discover.js`：扫描本机配置文件 → 产出候选凭证：
  - Codex：`~/.codex/auth.json`（`OPENAI_API_KEY`/tokens + account id）→ `codex-direct`。
  - OpenCode：`~/.local/share/opencode/auth.json` 或 `~/.config/opencode/`（`opencode`/`opencode-go` 的 api key）→ `opencode-go`。
  - 其余 provider 无本地文件 → 仅提示手动。
- `src/standalone/store.js`：单用户本地凭证存储（无密码/无信封）；Windows 用 `electron.safeStorage`，其它用明文 JSON（仅本机、不联网）。索引 JSON 不含密钥材料。

### 阶段 2 — Windows（Electron）
- `src/standalone/electron/main.js` + `preload.js`：BrowserWindow 加载 loopback 静态服务；`safeStorage` 加解密凭证；`ipcMain` 暴露引擎接口。
- `src/standalone/electron/server.js`：极简 loopback `node:http`：`GET /api/quota`、`POST /api/quota/refresh`、`GET/POST/PUT/DELETE /api/credentials`、`GET /api/credentials/meta`、`GET/POST /api/codex/accounts`、`GET /api/discover` + 静态托管 `src/web/dist`。
- 前端：`api.js` 改为调用上述 loopback 端点（去掉登录/审计/users/recover/export）；`App.jsx` 去掉 boot/login/recover 分支直接进仪表盘；`Security/Audit/Users/Login/Recover` 视图不再引入；`Credentials.jsx` 加"自动发现本机配置"入口 + 手动表单。
- 打包：`electron-builder` 产出 Windows `nsis` 安装包 / `portable` exe。

### 阶段 3 — Android（Capacitor）
- `npx cap init`；`src/web` 作为 webDir；`@capacitor-community/http` 作 fetch 封装；`@capacitor/preferences`/secure storage 存凭证。
- 引擎在 WebView 内以 ES module 运行；`env` 与取数经原生插件。
- `npm run build` → `npx cap add android` → 产出 APK/AAB。

## 验证（每个阶段结束时）

```bash
cd /home/ckx/quota-dashboard/src/standalone && node -e "..."   # 阶段1引擎可独立取数（无登录）
npm test                                                      # 现有服务端测试仍全通过（不回归线上）
# 阶段2：electron . 启动，仪表盘/凭证/Codex 账号可用，无登录页
# 阶段3：adb 或模拟器跑 APK，确认额度卡渲染且不受 CORS 拦
```

## 明确不做（单机版的取舍）

- 不做账户/登录/TOTP/恢复/审计/多用户/管理员/导出导入（对应后端 store、session、audit、users 全程不引入）。
- 不连你服务器；凭证只存在于本机，不经过你服务器。
- 不新增数据库；凭证用 OS 钥匙串（Windows）/SecureStorage（Android）或本机明文 JSON。
- 不改变线上服务端现有行为与 `CONTRACT.md`（引擎是独立抽取，原 `server` 不动）。

## 改动文件清单（预计）

- 新增：`src/standalone/env.js`、`src/standalone/engine.js`、`src/standalone/discover.js`、`src/standalone/store.js`、`src/standalone/electron/{main,preload,server}.js`、`src/standalone/electron/package.json`、`electron-builder` 配置；Android 的 `capacitor.config.*`。
- 修改（仅前端，非线上后端）：`src/web/src/api.js`、`src/web/src/App.jsx`、`src/web/src/views/Credentials.jsx`、`src/web/src/views/Dashboard.jsx`（如需）。
- 复用不改：`src/server/providers/**`、`src/web/src/views/Dashboard.jsx`（除微小）、`styles.css`。
- 不触碰：`src/server/http.js`、`src/server/store/**`、`src/server/cli/**`、`CONTRACT.md`、`data/`。

## 已定取舍（默认采用推荐项）

1. **平台顺序**：Windows（Electron）先行，Android（Capacitor）随后。理由：复用最多、见效最快，安卓基于同一引擎加壳即可。
2. **凭证本地存储**：Windows 用 `electron.safeStorage`（OS 钥匙串），Android 用 Capacitor SecureStorage。理由：项目一贯重视凭证安全（服务端信封 + 钥匙串同思路）；明文 JSON 仅作为无 keychain 环境的降级兜底。
3. **"自动读取本机配置"范围**：先覆盖 **Codex（`~/.codex`）+ OpenCode（`auth.json`）** 这两类本机必有配置文件的 provider，其余（DeepSeek/Ollama/command-code/kimi/z.ai/sub2api/newapi）走手动填写。理由：最小可行、识别准确；后续如需再扩大覆盖。

## 需你后续确认（不阻塞首版 Windows）

- 若首版 Windows 落地后你想调整（如 Android 优先、明文 JSON、覆盖更多 provider），改动均集中在阶段 2/3 的壳与 `discover.js`，引擎与前端无需重构。

