# Quota Dashboard — 内部接口契约（所有实现必须遵守）

本项目为多用户 AI 订阅额度聚合面板。优先级：数据真实 > 凭证安全 > 不产生额度消耗 > 覆盖数量 > 界面丰富度。

## 多用户与隐私模型

- 每个注册用户拥有独立加密信封：密钥数据由**该用户自己的登录密码**经 scrypt 派生 KEK 包裹 DEK、AES-256-GCM 加密存储。没有用户密码，任何人（含管理员）无法解密其数据。
- 管理员仅有用户的「列表 / 禁用 / 启用 / 删除」权，**没有**查看、导出或重置他人密钥的入口；忘记密码的用户凭注册时一次性展示的恢复码自助重置。
- TOTP 两步验证为**可选项**（所有用户，含管理员）：在安全页自行开启/关闭；开启后 step-up 需 密码+TOTP，未开启只需密码。
- 用户数据严格隔离：凭证、额度缓存（key 含用户名前缀）、审计视图（普通用户只见自己的条目）均按用户隔离。

## 通用约束

- 后端：Node 22 ESM（`"type": "module"`），**运行时零第三方依赖**（只用 node: 内置模块）。所有 JS 文件用 `.js` + ESM import/export。
- 前端：React 18 + Vite（仅 react / react-dom / vite / @vitejs/plugin-react 四个依赖，不许加其他），手写 CSS，系统字体栈，不引用任何外部 CDN/字体/脚本。
- 任何输出到日志的内容不得包含凭证、token、Cookie、Authorization 头、恢复码、上游响应原文。
- 代码注释保持极简；提交信息不需要（无 git）。

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

## Provider adapter 模块约定（src/server/providers/<id>.js）

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

**密钥材料不外发**：adapter 不提供 mask/脱敏展示，API 任何响应都不携带密钥片段（连前4后4也没有）；密钥只能在「导出加密备份」中经 step-up 后离开服务器。

`QuotaError`（src/server/providers/http.js 导出）：`new QuotaError(kind, message)`，kind 取上表四种。

核心提供 `executeAdapter(adapter, cred)`（providers/http.js）：
1. 调 `buildRequest`，校验 url 的 protocol 必须 https（codex 例外允许 http://127.0.0.1:8317 或容器部署的 http://host.docker.internal:8317，由 `CPA_MGMT_URL` 环境变量固定）、host/path/method 命中 `allowed` 白名单，否则抛错；
2. fetch（10s 超时）；若 adapter 声明 `extraRequests`，逐一同样校验白名单后并发抓取，结果以 `extras` 第三参交给 `parseResponse`（附加请求网络失败记为 null 降级，白名单违规仍抛错）；
3. 网络错误映射为 `QuotaError('unavailable')`。

**kimi 套餐名**（providers/kimi.js）：`/coding/v1/usages` 只带 `user.membership.level` 内部枚举（LEVEL_*），真实档位名走附加请求 `GET /coding/v1/me` 的 `user_level_name`（Andante/Moderato/Allegretto/Allegro…）；/me 不可用时按枚举映射表兜底，未知枚举转可读形式。

**codex 特例**（providers/codex.js）：凭证即 CPA 配置 `{ managementKey: string }`（alias 固定 "CLIProxyAPI"）。管理口地址默认 `http://127.0.0.1:8317`，容器部署用 `CPA_MGMT_URL=http://host.docker.internal:8317`（compose 已配 extra_hosts）。额外导出：
- `listAccounts(cred)` → `[{ authIndex, maskedEmail, disabled, status }]`（走 `GET $CPA_MGMT_URL/v0/management/auth-files`）
- `fetchCodexQuota(cred, authIndex)` → QuotaResult 的 windows/plan 部分（走 `POST /v0/management/api-call`，body: `{auth_index, method:'GET', url:'https://chatgpt.com/backend-api/wham/usage', header:{Authorization:'Bearer $TOKEN$','User-Agent':'codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal','Chatgpt-Account-Id':'$ACCOUNT_ID$'}}`——若 CPA 不支持 `$ACCOUNT_ID$` 占位则省略该头；失败时回退 `GET /v0/management/plugins/cpa-account-config-manager/accounts` 取缓存快照并标 `source:'cache'`）
- 面板 store 中 codex 的"账号"= 用户从 listAccounts 勾选并设别名的 `{credId, authIndex, maskedEmail, alias}` 记录。
- **绝不调用** `/v0/management/usage-queue`（单消费者，CPAMP 在用）。

**codex-direct provider**（providers/codex-direct.js）：普通 quota provider，凭证为 `{ accessToken, accountId }`，直连 ChatGPT 的只读用量端点；不参与 `codex` 的 CPA 账号枚举、选择或回退流程。

**ollama provider**（providers/ollama.js）：普通 quota provider，使用 Ollama Cloud API key 查询只读用量窗口；仅请求固定 usage 端点，不激活聊天或生成接口。

**command-code provider**（providers/command-code.js）：普通 quota provider，主 credits 请求独立决定是否成功；固定的 usage、subscriptions、whoami 附加请求只用于补充窗口和套餐，附加请求失败不得覆盖主额度数据；所有请求均为只读 GET。

**opencode-go provider**（统一 OpenCode 来源）：保留 provider id `opencode-go`，由同一 API key 自动识别 Go 或 Zen，不要求用户选择新的 provider。仅发送固定的 `GET https://opencode.ai/zen/go/v1/usage`，使用 Bearer 鉴权；HTTP 200 按兼容的新旧字段解析 Go 的 5 小时、每周、每月窗口，并保留响应提供的套餐名，没有套餐名时标记为 `Go`。HTTP 403 只有明确的 entitlement 缺失信号才识别为 Zen，返回套餐 `Zen`、空窗口和“已识别为 OpenCode Zen；当前没有公开的 API Key 余额查询接口”提示；401 或普通 403 仍按凭证过期处理，429 按限流处理。Zen 确有余额体系（按请求计费、余额低于 $5 自动补 $20、月度上限），但官方没有用 API Key 可查的公开余额端点——文档只列推理端点（`/zen/v1/responses`、`/zen/v1/messages`、`/zen/v1/chat/completions`、`/zen/v1/models`），余额仅在网页 billing 后台可见，官方仓库 issue `#10448` 仍是开放需求；实测 `/zen/v1/balance`、`/zen/v1/usage` 返回 404。因此 Zen 分支只识别套餐、不伪造余额。不得通过模型请求探测套餐或余额。

## REST API（全部 JSON；写操作需 `X-Requested-With: quota-dashboard` 头做 CSRF 校验）

公开：
- `POST /api/auth/register` `{username, password}` → 注册普通用户（需已初始化；用户名 3-20 位 `[A-Za-z0-9._-]` 大小写不敏感查重，密码 ≥8；限流 10 次/小时）→ 一次性返回 `{ok, recoveryCode}`（不生成 TOTP）
- `POST /api/auth/login` `{username, password}` → Set-Cookie session（HttpOnly; Secure; SameSite=Strict; cookie Max-Age 30 天仅是浏览器侧上限，服务端 session 才是真实闸门：12h **滑动** TTL——任意已认证请求（含前端每 5 分钟的 `/api/auth/status` keepalive）在剩余不足一半时自动续满并落盘，节流为每 session 每 TTL/2 最多写一次；标签页关闭不再产生请求，12h 后过期）。按用户错误密码指数退避+锁定；被禁用账号 403 `{error:'account_disabled'}`。响应 `{ok:true, expiresAt}`
- `POST /api/auth/logout`
- `GET /api/auth/status` → `{authenticated, expiresAt, initialized, user: null | {username, role, totpEnabled}}`（服务重启后 session 表仍在但用户数据未解锁时 authenticated=false，重新登录即解锁）

已认证：
- `GET /api/quota` → `{accounts: QuotaResult[]}`（触发超过 60s 缓存的账号后台刷新，先返回缓存；codex 凭证本身不产生卡片，只展示已勾选的 codexAccounts）
- `POST /api/quota/refresh` `{accountId?}` → 强制刷新（全局限流：每分钟最多 5 次）
- `GET /api/credentials` → `[{id, provider, kind, alias, createdAt}]`（**不含任何密钥材料**，连脱敏片段也不返回）
- `POST /api/credentials` `{provider, alias, fields:{...}}`（仅需登录态）
- `PUT /api/credentials/:id` `{alias?, fields?}`（仅需登录态）
- `DELETE /api/credentials/:id`（仅需登录态）
- （已移除 reveal 端点：密钥明文无任何 API 可取，唯一出口是 `POST /api/export` 加密备份）
- `GET /api/credentials/meta` → 各 provider 的 credentialFields/displayName/kind（驱动表单）
- `GET /api/codex/accounts?credId=` → listAccounts 结果（已认证即可）；勾选保存走 POST /api/codex/accounts `{credId, accounts:[{authIndex, alias}]}`（仅需登录态）
- `GET /api/audit?limit=` → 审计条目（admin 见全部；普通用户只见 `details.username` 为自己的条目，无 username 的历史条目归属 admin）
- `POST /api/auth/change-password` `{password, totp?, newPassword}`（newPassword ≥8）
- `POST /api/auth/revoke-others` `{password, totp?}`（只吊销该用户自己的其他会话）
- `POST /api/auth/totp/begin` `{password}` → `{totpSecret, totpUri}`（暂存 10 分钟）
- `POST /api/auth/totp/confirm` `{code}` → 用首个验证码激活 TOTP
- `POST /api/auth/totp/disable` `{password}` → 关闭 TOTP
- `POST /api/export` `{password, totp?, exportPassword}` → 加密备份文件下载（application/octet-stream；只含该用户自己的数据）
- `POST /api/import` `{password, totp?, exportPassword, backup}` → 导入恢复：`backup` 为备份文件的 JSON 文本或其 base64；用 exportPassword 解密后**覆盖** credentials/codexAccounts（settings 如备份含则一并恢复；sessions 绝不导入，totp/lockout 保留现状）。解密失败/格式错误统一 400 `{error:'invalid_backup'}`；审计 `credential_import` 只记条目数与用户名。响应 `{ok:true, imported:{credentials, codexAccounts}}`

仅管理员（role='admin'，否则 403 `{error:'forbidden'}`；不能操作自己，不能删除 admin）：
- `GET /api/users` → `{users: [{username, role, status, createdAt, lastLoginAt}]}`（纯元信息）
- `POST /api/users/:username/disable` | `/enable`（禁用同时吊销其全部 session）
- `DELETE /api/users/:username`（删除其信封与全部 session，数据不可恢复）

公开（恢复流程，独立限流更严）：
- `POST /api/auth/recover` `{username, recoveryCode}` → 验证通过返回一次性 recovery session token
- `POST /api/auth/recover/complete` `{recoveryToken, newPassword}` → `{newRecoveryCode}`（仅展示一次；注销该用户全部旧 session；TOTP 被清除可在登录后重新开启）

所有 step-up 端点（password，+ totp 仅当该用户已开启 TOTP）：任一错误统一 401 `{error:'step_up_failed'}`，不区分密码/TOTP 错；失败计入该用户锁定。

## 加密存储格式（store）

- 数据文件：`/data/store.enc`（JSON，v2 多用户）：`{v:2, users:[{username, usernameLower, role:'admin'|'user', status:'active'|'disabled', createdAt, lastLoginAt, envelope}], sessions:[{hash, usernameLower, createdAt, expiresAt}]}`。
- 每个用户的 `envelope` 为独立信封：`{v:1, kdf:{algo:'scrypt',N,r,p,salt}, dek:{wrappedByMaster:{iv,ct,tag}, wrappedByRecovery:{salt2,iv,ct,tag}}, payload:{iv,ct,tag}}`。payload 明文 JSON = `{credentials:[], codexAccounts:[], settings:{}, totp:null|{secretEnc 用 DEK 加密}, lockout:{...}}`。
- 顶层 `sessions` 为全局会话表，只存 token 的 SHA-256 哈希与用户名，不含敏感数据；session 的创建/续期/吊销不落用户信封。
- v1 单用户信封在 load 时自动迁移：先复制 `store.enc.v1.bak`（0600），原信封成为 admin 用户，旧 payload 内 sessions 不迁移（所有人重新登录一次）。
- 原子写：写临时文件 + rename；落盘时把每个已解锁用户的 payload 重新加密回各自信封。
- 审计：`/data/audit-YYYYMMDD.log`，每日轮转，保留 30 天，JSONL；details 携带 `username` 归属。

## CLI（src/server/cli/index.js，`node src/server/cli/index.js <cmd>`）

- `init`：交互式（readline）设管理员用户名（默认 admin）与密码（≥8，二次确认）→ 显示恢复码（一次）→ 写 store；不再生成 TOTP（安全页可选开启）
- `unlock`：输入用户名+密码校验解锁（HTTP 登录成功即解锁）
- `backup --out <path>`：输入用户名+密码与导出密码，导出该用户自己的加密备份
- `restore --in <path>`：输入导出密码恢复（store 重置为单管理员 admin，密码=导出密码）

## HTTP 安全头（应用层）

`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`、`Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self' 'sha256-VC2U0hRkg0m8koNXtYJDXRFq+YKnXswGr2Bst72or4g='; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`（OpenResty 层再加 HSTS）。

## 端口与部署

- 应用监听 `127.0.0.1:18318`（容器内 0.0.0.0:18318，compose 映射 `127.0.0.1:18318:18318`）。
- 数据卷 `./data:/data`。
