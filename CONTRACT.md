# Quota Dashboard — 内部接口契约（所有实现必须遵守）

本项目为单机离线的 AI 订阅额度聚合面板（Windows / Android 双端，共用同一引擎与前端）。优先级：数据真实 > 凭证安全 > 不产生额度消耗 > 覆盖数量 > 界面丰富度。

## 通用约束

- 后端：Node 22 ESM（`"type": "module"`），**运行时零第三方依赖**（只用 node: 内置模块）。所有 JS 文件用 `.js` + ESM import/export。
- 前端：React 18 + Vite（仅 react / react-dom / vite / @vitejs/plugin-react 四个依赖，不许加其他），手写 CSS，系统字体栈，不引用任何外部 CDN/字体/脚本。
- 任何输出到日志的内容不得包含凭证、token、Cookie、Authorization 头、恢复码、上游响应原文。
- 代码注释保持极简。

## 统一数据模型（adapter 输出 & 前端消费）

```js
// QuotaResult —— 每个账号卡片的数据
{
  accountId: string,        // 面板内部 id
  provider: string,         // 'codex' | 'codex-direct' | 'ollama' | 'command-code' | 'opencode-go' | 'kimi' | 'zai' | 'bigmodel' | 'deepseek' | 'sub2api' | 'newapi'
  kind: 'quota' | 'balance',
  alias: string,
  plan: string | null,      // 套餐名，如 'plus'
  windows: [                // quota 类：多个限额窗口
    { name: string,         // '5小时' | '每周' | '每月' | 'MCP(月)' 等
      usedPercent: number | null,   // 0-100
      used: number | null, total: number | null, unit: string | null, // 原始单位（可选）
      resetAt: number | null }      // epoch 毫秒
  ],
  balance: null | { currency: string, total: number, granted: number | null, paid: number | null, used?: number | null },
            // balance 类；granted/paid 为 null 表示上游不提供赠送/充值拆分，前端改显 used（已用）
  fetchedAt: number,        // epoch 毫秒
  source: 'live' | 'cache',
  error: null | { kind: 'unavailable' | 'auth_expired' | 'rate_limited' | 'upstream_changed', message: string }
}
```

## Provider adapter 模块约定（src/standalone/providers/<id>.js）

每个 adapter 默认导出一个对象：

```js
export default {
  id: 'kimi',
  displayName: 'Kimi For Coding',
  kind: 'quota',
  // 凭证字段定义（驱动前端表单与后端校验）
  credentialFields: [
    { key: 'apiKey', label: 'API Key', secret: true, required: true, placeholder: 'sk-...' }
  ],
  // 白名单声明（代码固定，核心的 fetch 封装只放行这里声明的 host+path 前缀+方法）
  allowed: [ { method: 'GET', host: 'api.kimi.com', pathPrefix: '/coding/v1/usages' } ],
  buildRequest(cred) => { method, url, headers },  // 纯函数；url 必须匹配 allowed
  // 可选：附加请求（辅助信息，如套餐名）；每个都过同一白名单
  extraRequests(cred) => [ { id, method, url, headers } ],
  parseResponse(status, bodyText, extras?) => Partial<QuotaResult>  // 失败抛 QuotaError
  // extras: [{ id, status, bodyText }]，附加请求网络失败时 status/bodyText 为 null（只降级，不拖垮主请求）
}
```

**密钥材料不外发**：adapter 不提供 mask/脱敏展示，引擎任何接口都不返回密钥材料；凭证只在设备端（safeStorage / SecureStorage）加密落盘，不出本机。

`QuotaError`（src/standalone/providers/http.js 导出）：`new QuotaError(kind, message)`，kind 取上表四种。

核心提供 `executeAdapter(adapter, cred)`（providers/http.js）：
1. 调 `buildRequest`，校验 url 的 protocol 必须 https（codex 例外允许 http://127.0.0.1:8317 或注入 env.cpaMgmtUrl 指定的本机/局域网 CPA 管理口）、host/path/method 命中 `allowed` 白名单，否则抛错；
2. fetch（10s 超时）；若 adapter 声明 `extraRequests`，逐一同样校验白名单后并发抓取，结果以 `extras` 第三参交给 `parseResponse`（附加请求网络失败记为 null 降级，白名单违规仍抛错）；
3. 网络错误映射为 `QuotaError('unavailable')`。

**kimi 套餐名**（providers/kimi.js）：`/coding/v1/usages` 只带 `user.membership.level` 内部枚举（LEVEL_*），真实档位名走附加请求 `GET /coding/v1/me` 的 `user_level_name`（Andante/Moderato/Allegretto/Allegro…）；/me 不可用时按枚举映射表兜底，未知枚举转可读形式。

**codex 特例**（providers/codex.js）：凭证即 CPA 配置 `{ managementKey: string }`（alias 固定 "CLIProxyAPI"）。管理口地址默认 `http://127.0.0.1:8317`，可通过注入 `env.cpaMgmtUrl` 指向本机/局域网其他地址（单机版凭证表单可手填）。额外导出：
- `listAccounts(cred)` → `[{ authIndex, maskedEmail, disabled, status }]`（走 `GET $CPA_MGMT_URL/v0/management/auth-files`）
- `fetchCodexQuota(cred, authIndex)` → QuotaResult 的 windows/plan 部分（走 `POST /v0/management/api-call`，body: `{auth_index, method:'GET', url:'https://chatgpt.com/backend-api/wham/usage', header:{Authorization:'Bearer $TOKEN$','User-Agent':'codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal','Chatgpt-Account-Id':'$ACCOUNT_ID$'}}`——若 CPA 不支持 `$ACCOUNT_ID$` 占位则省略该头；失败时回退 `GET /v0/management/plugins/cpa-account-config-manager/accounts` 取缓存快照并标 `source:'cache'`）
- 面板 store 中 codex 的"账号"= 用户从 listAccounts 勾选并设别名的 `{credId, authIndex, maskedEmail, alias}` 记录。
- **绝不调用** `/v0/management/usage-queue`（单消费者，CPAMP 在用）。

**codex-direct provider**（providers/codex-direct.js）：普通 quota provider，凭证为 `{ accessToken, accountId }`，直连 ChatGPT 的只读用量端点；不参与 `codex` 的 CPA 账号枚举、选择或回退流程。

**ollama provider**（providers/ollama.js）：普通 quota provider，使用 Ollama Cloud API key 查询只读用量窗口；仅请求固定 usage 端点，不激活聊天或生成接口。

**command-code provider**（providers/command-code.js）：普通 quota provider，主 credits 请求独立决定是否成功；固定的 usage、subscriptions、whoami 附加请求只用于补充窗口和套餐，附加请求失败不得覆盖主额度数据；所有请求均为只读 GET。

**opencode-go provider**（统一 OpenCode 来源）：保留 provider id `opencode-go`，由同一 API key 自动识别 Go 或 Zen，不要求用户选择新的 provider。仅发送固定的 `GET https://opencode.ai/zen/go/v1/usage`，使用 Bearer 鉴权；HTTP 200 按兼容的新旧字段解析 Go 的 5 小时、每周、每月窗口，并保留响应提供的套餐名，没有套餐名时标记为 `Go`。HTTP 403 只有明确的 entitlement 缺失信号才识别为 Zen，返回套餐 `Zen`、空窗口和“已识别为 OpenCode Zen；当前没有公开的 API Key 余额查询接口”提示；401 或普通 403 仍按凭证过期处理，429 按限流处理。Zen 确有余额体系（按请求计费、余额低于 $5 自动补 $20、月度上限），但官方没有用 API Key 可查的公开余额端点——文档只列推理端点（`/zen/v1/responses`、`/zen/v1/messages`、`/zen/v1/chat/completions`、`/zen/v1/models`），余额仅在网页 billing 后台可见，官方仓库 issue `#10448` 仍是开放需求；实测 `/zen/v1/balance`、`/zen/v1/usage` 返回 404。因此 Zen 分支只识别套餐、不伪造余额。不得通过模型请求探测套餐或余额。

