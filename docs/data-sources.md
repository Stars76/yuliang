# Provider 数据来源说明

本文档说明面板中每个 provider 的额度数据来源、凭证类型、端点、刷新行为与用量影响。
所有端点均为代码内固定白名单（`src/server/providers/*.js` 的 `allowed` 声明），面板不提供任何自定义请求代理。
所有查询均为只读 GET（Codex 经 CPA 代发也是只读 GET），**不产生任何模型用量**。

## Codex / ChatGPT（经本机 CLIProxyAPI）

- **凭证**：CLIProxyAPI 的 management key（`remote-management.secret-key` 明文），面板信封加密保存，仅用于访问 CPA 管理口（默认 `http://127.0.0.1:8317`；容器部署经 `CPA_MGMT_URL=http://host.docker.internal:8317` 走 docker 网关，均不出宿主机）。
- **账号枚举**：`GET /v0/management/auth-files`（只读），按 `auth_index` 引用账号，邮箱默认脱敏。
- **额度取数三级回退**（`fetchCodexQuota`）：
  1. **实时**：`POST /v0/management/api-call` 以 `auth_index` + `Bearer $TOKEN$` 占位代发 `GET https://chatgpt.com/backend-api/wham/usage`（UA 伪装 `codex_cli_rs/...`）。⚠️ 2026-09-03 实测该上游端点对全部账号返回 404（疑似上游变更），链路保留以便上游恢复后自动生效。
  2. **插件快照**：`GET /v0/management/plugins/cpa-account-config-manager/accounts`，取 `usage.codex.{five_hour, seven_day}`（`used_percent`、`reset_at`、`window_minutes`）。由插件的被动信号驱动，近期有真实流量的账号数据为当天新鲜。卡片标注 `cache`。
  3. **auth-files 被动信号**：`quota.signals` 中的 `X-Codex-Primary/Secondary-Used-Percent/-Window-Minutes/-Reset-At` 响应头信号（来自真实模型响应头，权威但仅当账号近期有流量）。卡片标注 `cache`。
  4. 三者皆失败 → 显示"不可用"，绝不伪造额度。
- **面板绝不调用** `/v0/management/usage-queue`（单消费者队列，CPA-Manager-Plus 在消费）。

## OpenCode（自动识别 Go / Zen）

- **凭证**：API key（`sk-...`）。同一个 `opencode-go` provider 会根据响应自动识别 Go 或 Zen，不需要用户选择另一个 provider。
- **统一探测端点**：只发送 `GET https://opencode.ai/zen/go/v1/usage`（必须 `Authorization: Bearer`；注意与推理侧的 `x-api-key` 不通用）。
- **Go**：HTTP 200 表示 Go usage 响应；`usage.{rolling, weekly, monthly}.{status, percent, resetsAt}` → 5 小时 / 每周 / 每月窗口，兼容旧扁平字段。响应提供 `plan_type`、`plan`、`planName` 等套餐名时优先保留，没有可读套餐名时标记为 `Go`。
- **Zen**：HTTP 403 只有响应 JSON 或文本明确包含 `EntitlementError`、`entitlement`、`no Go subscription` 等权益缺失信号时才识别为 Zen，显示 Zen 套餐并提示“已识别为 OpenCode Zen；当前没有公开的 API Key 余额查询接口”。普通 403 与 401 都按凭证错误处理，429 按限流处理。
- **余额限制**：Zen 确实有余额体系——按请求计费、余额低于 $5 自动补 $20、工作区/成员可设月度花销上限（官方文档确认）——但**没有用 API Key 可查的公开余额/额度接口**。官方 Zen 文档只列出推理端点（`/zen/v1/responses`、`/zen/v1/messages`、`/zen/v1/chat/completions`、`/zen/v1/models`），不含任何 balance/usage/credits 查询；余额只在网页版 billing 后台（GitHub/Google 登录 + 浏览器会话）可见，面板禁止 Cookie 抓取/OAuth/本地配置读取。官方仓库对此的 feature request（`anomalyco/opencode#10448`）至今仍是开放需求。实测（无凭据请求）：`/zen/v1/balance`、`/zen/v1/usage`、`/zen/v1/credits`、`/zen/v1/me` 均返回 404；`/zen/v1/models` 返回 200 但只含模型列表，不含余额。不能通过 `/chat/completions`、`/messages`、`/responses` 或任何模型调用探测，否则会产生用量；面板只发送上述固定 GET。
- **风险**：第一方但未文档化，2026-08 改过一次响应形态（旧扁平形态仍兼容解析）；再次变更时卡片显示“上游变更”。

## Kimi For Coding

- **凭证**：订阅 API key。
- **端点**：`GET https://api.kimi.com/coding/v1/usages`（Bearer）。
- **字段**（2026-09-03 实测）：`limits[].detail.{limit, used, remaining, resetTime}` + `window.duration=300 TIME_UNIT_MINUTE` → 5 小时窗口；顶层 `usage.{...}` → 每周窗口；`user.membership.level` → 套餐。数值为字符串格式，解析已兼容。

## GLM Coding Plan（Z.AI 国际版 / BigModel 国内版）

- **凭证**：平台 API key。
- **端点**（鉴权均为**裸 `Authorization: <key>`**，无 Bearer 前缀）：
  - 国际版：`GET https://api.z.ai/api/monitor/usage/quota/limit`
  - 国内版：`GET https://open.bigmodel.cn/api/monitor/usage/quota/limit`
- **字段**（国内版 2026-09-03 实测）：`data.limits[]` 按 `unit` 分类——`unit:3, number:5` → 5 小时窗口；`unit:6` → 每周窗口；`type:TIME_LIMIT` → MCP 月用量。`percentage` 为已用百分比，`nextResetTime` 为毫秒时间戳，`data.level` 为套餐等级。z.ai 官方 Claude Code 插件使用同一端点。
- **实测状态**：国内版已用真实 key 验证；国际版同构（共用后端），本机无国际版 key，未实测。

## DeepSeek（按量余额，非订阅额度）

- **凭证**：平台 API key。
- **端点**：`GET https://api.deepseek.com/user/balance`（Bearer，官方文档化）。
- **字段**：`balance_infos[0].{currency, total_balance, granted_balance, topped_up_balance}`（字符串金额）。UI 明确标注"按量余额"。

## sub2api（自建/第三方中转实例）

- **凭证**：实例地址（用户填写，强制 https；仅 127.0.0.1/localhost 允许 http）+ 该实例用户 API key。
- **端点**：`GET {实例地址}/v1/usage`（`Authorization: Bearer <key>`）。方法与路径由代码固定；host 由凭证提供，这是白名单机制中唯一的通配项（`host:'*'`，仅限此 adapter、仅 GET、路径精确等于 `/v1/usage`）。
- **字段**（按上游 `gateway_handler.go` 的 `Usage()` 契约解析）：
  - `mode=quota_limited`：`quota.{limit,used,remaining}`（USD 总额度）→ "总额度" 窗口；`rate_limits[]`（window 5h/1d/7d + limit/used/reset_at）→ "5小时/每日/每周" 窗口。
  - `mode=unrestricted` + 订阅分组：`subscription.{daily,weekly,monthly}_{usage,limit}_usd` → "每日/每周/每月" 窗口，`planName` → 套餐。
  - `mode=unrestricted` + 钱包：`balance` → 余额卡片（标注"钱包余额"）。
- 该端点为官方预留的 CC Switch 集成接口，只读、不产生用量。

## Codex（直连 ChatGPT）

- **凭证**：ChatGPT access token + account ID；与 `codex` 的 CPA management key 和账号选择流程完全独立。
- **端点**：`GET https://chatgpt.com/backend-api/wham/usage`，Bearer 鉴权，带 ChatGPT account ID 和固定 Codex CLI User-Agent。
- **字段**：`plan_type`、`rate_limit.primary_window` / `secondary_window` 的百分比与重置时间 → 5 小时 / 每周窗口。
- **风险**：非稳定、未文档化的第一方接口；面板仅发送只读 GET，不刷新 token、不调用模型接口。字段或状态变化时显示“上游变更”。

## Ollama Cloud

- **凭证**：Ollama Cloud API key。
- **端点**：`GET https://ollama.com/api/usage`（Bearer）。仅使用固定 usage 端点，不调用 chat、generate 或 `/v1` 模型接口。
- **字段**：兼容常见的 `session` / `rolling`、`weekly` / `7d`、`monthly` / `included` 及 `usage` 嵌套形态；百分比、used/total 和 reset 时间用于 5 小时、每周、每月窗口。
- **风险**：接口形态依生态实现而变化，非稳定额度契约；面板仅发送只读 GET，无法识别的结构显示“上游变更”。

## Command Code

- **凭证**：Command Code API key。
- **端点**：主请求 `GET https://api.commandcode.ai/alpha/billing/credits`；附加只读请求为 `/alpha/usage/summary`、`/alpha/billing/subscriptions`、`/alpha/whoami`。请求带 Bearer 与 `x-api-key` 以兼容不同鉴权形态。
- **字段**：主 credits 解析月度 credits；usage summary 补充 5 小时 / 每周窗口；subscriptions 或 whoami 补充套餐和重置时间。仅在有 used/remaining/percentage 等证据时计算用量百分比。
- **风险**：`alpha` 接口为非稳定、未文档化形态；附加请求失败不覆盖主 credits 结果。面板仅发送只读 GET，绝不请求 `/provider/v1/chat/completions`、`/provider/v1/messages` 或 `/alpha/generate`。

## Zen 可识别但余额暂不可查询

| Provider | 原因 |
|---|---|
| OpenCode Zen | 可由统一 OpenCode usage 请求中的明确 403 entitlement 信号识别，但官方没有用 API Key 可查的公开余额端点（文档只列推理端点，`/zen/v1/balance`、`/zen/v1/usage` 实测 404；余额仅在网页 billing 后台可见，官方仓库 issue `#10448` 仍是开放需求） |

## 其他暂不支持的 provider

| Provider | 原因 |
|---|---|
| Moonshot 开放平台 | 用户明确只要订阅套餐额度，不要按量余额 |

## 刷新与缓存策略

- 页面打开时拉取 + 手动刷新 + 5 分钟自动刷新（前端可关）。
- 服务端每账号内存缓存 ≥60 秒；上游失败按指数退避，手动刷新全局限流（每分钟 5 次）。
- 上游失败时卡片如实显示"不可用 / 凭证过期 / 被限流 / 上游变更"及原因，不显示伪造的额度条。
