# 给新 agent 的任务提示词（单机离线版 Quota Dashboard）

你是一名全栈工程师。请根据已解压的源码目录 `quota-dashboard/`，实现一个**单机、离线、无账户体系**的 AI 额度查询 App，可做成 **Windows 桌面 App（Electron）** 和 **Android App（Capacitor）** 两个平台。目标是复刻现有网页版的大部分功能，但**完全独立运行、不连接任何服务器、不需要用户注册/登录**。

这是一个真实的源码项目，所有 provider 逻辑已存在，你要做的是**最大化复用 + 搭建本地壳**，而不是重写。

---

## 一、背景与资源

目录 `quota-dashboard/` 是一个现成的"多用户服务器版"额度聚合面板，结构如下（已按单机需求整理，无 `data/`、`node_modules`、`dist`）：

- `src/server/providers/**` —— **额度引擎**。每个 provider 一个 `.js`（codex / codex-direct / ollama / command-code / opencode-go / kimi / zhipu(含 zai+bignmodel) / deepseek / sub2api / newapi）。`http.js` 提供 `executeAdapter(adapter, cred)` 和 `QuotaError(kind, msg)`。这些文件**只依赖全局 `fetch`/`URL`/`AbortSignal.timeout`**，是纯 Node ESM，不依赖 HTTP 服务器、store 或账户体系——**可直接复用**。
- `src/server/providers/index.js` —— provider 注册表，`getAdapter(id)` / `listProviderMeta()`，用动态 `import` 惰性加载。
- `src/web/**` —— React 18 + Vite 前端。`views/Dashboard.jsx`（仪表盘，含额度卡/余额卡/进度模式/主题/自动刷新）、`views/Credentials.jsx`（凭证管理）、`views/Login.jsx`、`views/Security.jsx`、`views/Audit.jsx`、`views/Users.jsx`、`views/Recover.jsx`、`api.js`（同源 REST 封装）。
- `test/providers/**` —— provider 单测（node:test），改动后可跑它们验证解析逻辑不回归。
- `docs/data-sources.md`、`CONTRACT.md`、`CONTEXT.md` —— 数据源与接口契约说明。
- `PLAN-STANDALONE.md` —— 已写好的 **分阶段实施计划**（阶段 0→3），请以它为骨架，但本提示词是权威任务定义。
- `STANDALONE-README.md`（在 `docs/` 下）——上手说明。

**你的机器约定**：Node ≥22。Windows 上开发；如做 Android 需装 Android Studio/Java SDK。本任务**不得读取或修改 `data/`（真实加密 store，勿拷贝勿用作样例），不得触碰任何线上服务器**。

---

## 二、要砍掉的（无账户体系）

以下依赖服务器账户体系，**全部不要**：
注册/登录/登出/恢复、会话（session/TTL/cookie）、TOTP、密码修改、多用户、管理员、用户管理（Users）、审计（Audit）、导出/导入备份、CSRF/step-up 机制、服务端 `/api/auth/*`、`/api/users`、`/api/audit`。

**保留**：仪表盘（额度卡/余额卡/进度切换/自动刷新/主题切换）、凭证管理（增删改）、Codex 账号枚举与选择、provider 元信息（表单驱动）。

---

## 三、核心架构（复用最大化）

**一个共享引擎 + 两个壳**。

### 3.1 引擎（纯 JS，环境无关）

新建 `src/standalone/engine.js`，直接复用 `src/server/providers/**`，暴露统一接口（均无需登录/无服务器）：

```js
{
  listProvidersMeta(),                   // 来自 providers/index.js
  getQuota(),                            // 返回所有账号的 QuotaResult[]
  refreshQuota(accountId?),              // 强制刷新单个或全部
  listCredentials(),                     // 元信息（不含密钥材料）
  saveCredential({provider, alias, fields}),
  updateCredential(id, {alias?, fields?}),
  deleteCredential(id),
  listCodexAccounts(credId),
  saveCodexAccounts(credId, [{authIndex, alias}]),
  discoverLocalCredentials(),            // 扫描本机配置 → 候选凭证
}
```

- 实现 60s 内存缓存 + 失败指数退避（参考 `src/server/http.js` 的 `fetchOne/collectQuota/quotaCache`，去掉 username 作用域）；单个账号的 quota 组装（plan/windows/balance/error/source/fetchedAt）参考现有逻辑。
- **错误映射**沿用：`QuotaError(kind)`，kind ∈ `unavailable | auth_expired | rate_limited | upstream_changed`。

### 3.2 环境抽象（关键改动）

`src/server/providers/codex.js` 目前在第 6 行直接读 `process.env.CPA_MGMT_URL`（默认 `http://127.0.0.1:8317`），这只在 Node（Electron 主进程）可用，WebView（Capacitor）没有 `process`。

请新增 `src/standalone/env.js`：

```js
export const env = { cpaMgmtUrl: process.env.CPA_MGMT_URL || 'http://127.0.0.1:8317' };
```

并把 `codex.js` 改为从注入 env 取 base URL（可通过导入 `env`，或让 engine 在构造时把 `{ cpaMgmtUrl }` 传入 codex 适配器的工厂/函数）。**默认值保持 `http://127.0.0.1:8317`，确保原服务器行为不变**。`buildRequest` 的 `allowed` 白名单依赖 `MGMT_HOST`，需与注入 env 联动。用 `node --test` 现有 codex 测试确认不回归。

### 3.3 凭证本地存储

新建 `src/standalone/store.js`（单用户，无密码、无加密信封）：
- **Windows**：用 `electron.safeStorage`（OS 钥匙串）加密密钥材料；加密的凭证明文仅本机可见，索引 JSON 供 UI 展示但**不含密钥材料**。
- **Android**：用 Capacitor `SecureStorage`（或等价）。
- 降级：无 keychain 环境退回本机明文 JSON（明确标注，仅供本机、不联网）。
- 凭证结构沿用服务器版：`{ id, provider, kind, alias, fields: {...}, createdAt }`。**绝不把密钥材料打进日志或发给任何远端**。

---

## 四、凭证来源：双轨

1. **自动发现本机配置**（`discoverLocalCredentials()`）：扫描本机已有工具配置文件，产出候选凭证让用户一键采用：
   - Codex：`~/.codex/auth.json`（解析 access token + account id）→ `codex-direct`。
   - OpenCode：`~/.local/share/opencode/auth.json` 或 `~/.config/opencode/`（`opencode`/`opencode-go` 的 api key）→ `opencode-go`。
   - 其余（DeepSeek/Ollama/command-code/kimi/z.ai/sub2api/newapi）无本地文件，仅走手动。
   - 发现结果需要**脱敏展示**、由用户确认后再入库；不要把整串密钥直接暴露在界面上。
2. **手动填写**：复用现有 `Credentials.jsx` 的表单（由 `listProvidersMeta()` 的 `credentialFields` 驱动）。

---

## 五、Windows（Electron）—— 请先做这个

- `src/standalone/electron/main.js` + `preload.js`：
  - 主进程加载引擎；用 `safeStorage` 管理凭证；`ipcMain.handle` 暴露引擎接口。
  - 内置一个**仅监听 `127.0.0.1:<随机端口>`** 的极简 `node:http` 服务（REST + 静态托管 `src/web/dist`），供渲染进程同源调用。
  - BrowserWindow 加载 `http://127.0.0.1:<端口>/`；`nodeIntegration` 关闭、`contextIsolation` 开启，通过 preload 暴露安全桥。
- `src/standalone/electron/server.js`：只实现保留端点：
  - `GET /api/quota`、`POST /api/quota/refresh`（`{accountId?}`）
  - `GET /api/credentials`、`POST /api/credentials`、`PUT/DELETE /api/credentials/:id`
  - `GET /api/credentials/meta`、`GET /api/discover`
  - `GET /api/codex/accounts?credId=`、`POST /api/codex/accounts`
  - 静态托管 `src/web/dist`（含 SPA 回退到 index.html，路径穿越要拦住）
- 打包：`electron-builder` 产出 Windows `nsis` 安装包或 `portable` exe。
- **前端精简**：
  - `src/web/src/api.js` 改写为调用上述 loopback 端点；删除 `login/register/logout/recover*/audit/listUsers/disableUser/enableUser/deleteUser/changePassword/revokeOthers/totp*/importBackup` 等账户相关方法。
  - `src/web/src/App.jsx` 去掉 `boot/login/recover` 分支，直接进入仪表盘；移除 `Security/Audit/Users/Login/Recover` 的引入与导航。
  - `views/Credentials.jsx` 增加"自动发现本机配置"入口（调 `/api/discover`，脱敏展示候选），手动表单保留。
  - 其余视图（Dashboard、进度切换、主题、Toast、错误映射）**原样复用**。
  - 若 `api.js` 的 `fetch(path)` 需要 base URL，改用绝对地址（loopback 或由 preload 注入）。

---

## 六、Android（Capacitor）—— 其次

- `npx cap init` 新建壳，`src/web` 作为 `webDir`（需先 `npm run build`）。
- 取数：provider 的 fetch 改走 `@capacitor-community/http`（原生网络层，**绕过 WebView CORS**——这是 Android 的硬门槛，必须用原生 HTTP 插件，否则额度请求会被浏览器同源策略拦截）。
- 凭证：Capacitor `SecureStorage`；`env`（如 `cpaMgmtUrl`）由 Capacitor 配置/原生注入。
- `npm run build` → `npx cap add android` → 构建 APK/AAB。
- 若本机无 Android SDK，完成代码与配置即可，不强制出包。

---

## 七、约定与约束

- 代码风格：与现有项目一致（无多余注释；ESM `.js`/`.jsx`；运行时零第三方依赖——**Electron/Capacitor 相关依赖除外**；前端仅依赖 react/react-dom/vite/@vitejs/plugin-react）。
- **不伪造额度数据**：provider 没有分母时（如余额）不要编一个百分比；沿用现有 `CONTRACT.md` 的数据模型（`plan/windows/balance/error/source/fetchedAt`）。
- **凭证安全**：密钥材料不进日志、不发送到任何远端、UI 只显示脱敏形式；存储用 OS 钥匙串/SecureStorage。
- **不要改动**线上服务端相关的 `src/server/http.js`、`src/server/store/**`、`src/server/cli/**`、`CONTRACT.md`、`Dockerfile`、`docker-compose.yml`；也不要读 `data/`。
- 引擎的 `codex.js` env 改动是**唯一动到 `src/server/providers/` 的地方**，且要保证默认行为不变、原测试通过。

---

## 八、分阶段交付顺序

1. **阶段 0/1**：引擎 `src/standalone/engine.js` + `env.js` + `store.js` + `discover.js`；`codex.js` env 注入。用 `node --test` 确保原 provider 测试全通过，并用一段 `node -e` 无服务器调用验证引擎可取数。
2. **阶段 2**：Electron 壳 + 极简 loopback server + 前端精简；产出 Windows 可运行版。
3. **阶段 3**：Capacitor 壳；产出 Android 工程与 AAB（本机无 SDK 则到代码/配置为止）。

## 九、验证清单（完成后逐项确认）

- [ ] `node --test "test/**/*.test.js"` 全部通过（原 provider 解析不回归）。
- [ ] `src/web` 下 `npm run build` 成功。
- [ ] Electron 启动后：无登录页，直接进仪表盘；可手动新增/删除凭证；可自动发现 Codex/OpenCode 凭证；能刷新额度并渲染额度卡/余额卡；进度切换/主题/自动刷新可用。
- [ ] 单机版**不发起任何对服务器的请求**；凭证未写入任何日志。
- [ ] （如做）Android 工程能构建，模拟器/真机上额度卡正常渲染且不被 CORS 拦截。

## 十、输出

交付所有源码改动 + 简短的实现说明（改了哪些文件、如何启动 Windows 版、如何构建 Android、哪些已知限制）。先完成 Windows，再视情况做 Android。
