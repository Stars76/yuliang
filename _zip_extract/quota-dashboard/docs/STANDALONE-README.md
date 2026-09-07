# EntropicEcho 额度聚合面板 — 单机离线版（包内上手说明）

本包是你用来在**自己的电脑**上搭建"单机、离线、无账户体系"版额度查询 App 的**源材料 + 实施计划**。
它**不连接你的服务器**，凭证只存在本机。正式实现前请先读 `PLAN-STANDALONE.md`。

---

## 一、包内有什么

| 目录/文件 | 说明 |
|---|---|
| `src/server/providers/**` | **可复用的额度引擎**：全部 provider 适配器 + `http.js` 里的 `executeAdapter`/`QuotaError`。只依赖 Node 全局 `fetch`/`URL`/`AbortSignal`，不含 HTTP 服务器/store/账户体系，可直接被 Electron/WebView 复用。 |
| `src/web/**` | 现在的 React+Vite 前端源码（仪表盘/凭证/额度卡/余额卡/主题/进度模式），单机版会复用绝大部分，仅精简 `api.js` 与 `App.jsx` 的登录/审计/用户分支。 |
| `test/providers/**` | provider 适配器的单测，用来在改动后验证解析逻辑不回归。 |
| `docs/` · `CONTRACT.md` · `CONTEXT.md` · `README.md` | 数据源/契约/术语说明，写单机版时作参考。 |
| `PLAN-STANDALONE.md` | **实施计划**（阶段 0→3：引擎抽取 → 环境抽象 → Windows/Electron → Android/Capacitor）。 |
| `STANDALONE-README.md` | 本文件。 |

**目录结构**：包的一个子目录即 `quota-dashboard/` 项目根；上面两个 `.md` 放在根级。

## 二、没打进包里的东西（刻意排除）

- **`data/`**（真实加密 store + 审计日志）——敏感，且单机版不需要，**千万别从服务器拷贝**。
- **`src/web/node_modules`**（46M）——你机器上 `npm install` 生成，不入包。
- **`src/web/dist`** — Vite 构建产物，你在本机 `npm run build` 重新生成。
- `deploy/`、`Dockerfile`、`docker-compose.yml`、`scripts/`、`.deploy-state` —— 服务器部署相关，单机版用不到。

## 三、在你电脑上跑起来（前置准备）

1. 装 **Node.js ≥ 22**（推荐 LTS）+ npm。可到 nodejs.org 下载，或 `winget install OpenJS.NodeJS.LTS`。
2. 解压本包到任意目录，进入 `quota-dashboard/src/web`：
   ```bash
   npm install
   npm run build     # 生成 dist/（Vite）
   ```
3. 验证 provider 引擎在纯 Node 下可独立取数（**无登录、无服务器**）：
   ```bash
   node --input-type=module -e "import('./src/server/providers/index.js').then(m=>m.listProviderMeta()).then(x=>console.log('providers:',x.map(p=>p.id).join(', ')))"
   ```
   若列出 codex/codex-direct/ollama/command-code/opencode-go/kimi/zai/bigmodel/deepseek/sub2api/newapi，说明引擎可用。
4. **运行服务端单测**（可选，验证解析逻辑）：
   ```bash
   node --test "test/**/*.test.js"   # 在项目根执行
   ```

## 四、下一步（真正做出单机 App）

按 `PLAN-STANDALONE.md` 实施。核心结论先给你：

- **引擎**：拿 `src/server/providers/**` 直接复用即可；把 `codex.js` 里的 `process.env.CPA_MGMT_URL` 改成**注入的对象**（默认仍是 `http://127.0.0.1:8317`，线上行为不变），这样同一份代码能在 Electron（Node）与 Capacitor（WebView）跑。
- **Windows**：Electron 主进程跑引擎 + 一个仅 `127.0.0.1` 随机端口的极简 `node:http`（只实现保留端点 + 静态托管 `src/web/dist`），加载 `http://127.0.0.1:<端口>/`；凭证用 `electron.safeStorage`（Windows 钥匙串）。
- **Android**：Capacitor 复用同一前端构建；取数走 `@capacitor-community/http`（原生 fetch 绕过 WebView CORS——这是安卓唯一硬门槛）；凭证用 SecureStorage。
- **砍掉**：登录/注册/恢复/会话/TOTP/多用户/管理员/审计/导出导入。
- **凭证来源双轨**：自动读本机 Codex `~/.codex` + OpenCode `auth.json`；DeepSeek/Ollama/kimi/z.ai/sub2api/newapi 等纯云端服务手动填。

## 五、常见问题

- **Node 版本低**：`node -v` 需 ≥22。旧版本不支持 `AbortSignal.timeout` 等用法。
- **`npm run build` 报错**：先 `npm install`，确认无 46M node_modules 缺失。
- **Windows 上跑 Electron**：需要对应平台包，`npm i -D electron` 后 `npx electron .` 启动。
- **凭证安全**：单机版不连服务器，凭证只在本机；Windows 用 OS 钥匙串加密，别用明文存云。
