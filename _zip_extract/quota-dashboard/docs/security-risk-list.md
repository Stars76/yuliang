# 现有公网入口风险清单

> 本清单按 Brief 要求只输出风险、不做任何修改。采集时间 2026-09-03，依据 `ss -tlnp` 与既有配置。
> 新面板（quota-dashboard）自身只绑 `127.0.0.1:18318`，不在下列暴露面内。

## 整改进展（2026-09-03）

- **第 1 条（8317 部分）已整改**：`cliproxy/docker-compose.yml` 改为 `127.0.0.1:8317:8317` + `172.17.0.1:8317:8317` 双绑（docker0 网关供 quota-dashboard / cpa-manager-plus 经 `host.docker.internal` 访问），公网直连已断（实测 `http://<公网IP>:8317` 连接拒绝，回环与容器链路 401/200 正常）。同端口 OpenResty 无任何站点反代，公网 API 流量本就走 new-api:3000。`8085/1455/11451/51121/54545`（OAuth 回调端口）维持原绑定，远程浏览器授权流程依赖其公网可达。
- **第 2 条已整改**：`cpa-manager-plus/docker-compose.yml` 改为 `127.0.0.1:18317:18317`，公网直连已断，cpa.entropicecho.com 反代正常。
- 第 9 条随之失效：8317 的明文 HTTP 现已不出宿主机。

## 高：管理/控制面直接暴露公网

1. **CLIProxyAPI 全部端口绑定 `0.0.0.0`**（**8317 已整改**，见上）：`8317`（**含 Management API**）、`8085`、`1455`、`11451`、`51121`、`54545` 均经 docker-proxy 直接暴露公网。
   - 管理口仅依赖 management key（bcrypt 存储、明文传输于 TLS 之外的直连 HTTP）+ 同 IP 5 次失败封禁约 30 分钟。持有 key 即可 `api-call` 代发任意上游请求、读写全部账号配置。
   - 建议：compose 端口映射改为 `127.0.0.1:8317:8317`（管理口至少如此），或前置防火墙。
2. **CPA-Manager-Plus `18317` 绑定 `0.0.0.0`**（**已整改**，见上）：管理 API 公网直连可达（另经 cpa.entropicecho.com 反代），仅靠 Admin Key 鉴权。建议绑回环。
3. **New API `3000` 绑定 `0.0.0.0`**：公网直连绕过反代层的一切 header/日志策略。建议绑回环。
4. **1Panel 面板 `20399` 公网监听**：服务器级控制面直暴露。建议改回环 + SSH 隧道，或严格 ACL。
5. **x-ui `2096` 公网监听**（所有接口 `*`）：代理面板直暴露。建议同上。

## 中：TLS 与反代层

6. **OpenResty 站点 `ssl_protocols` 含 TLSv1.0/1.1**（cpa 站配置即如此），建议收敛到 TLSv1.2+。新面板站点模板已按 TLSv1.2/1.3 编写。
7. **HAProxy 443 TCP 透传且未开 PROXY protocol**：OpenResty 看到的 HTTPS 来源恒为 `127.0.0.1`，一切按客户端 IP 的限流/WAF 在 OpenResty 层失效（`limit_conn perip`、`limit_req`、1pwaf 按 IP 规则均视为同一客户端）。按 IP 限流只能在 HAProxy 层或应用层做。
8. **HSTS 未含 `includeSubDomains; preload`**（cpa 站）；新面板站点模板已带 `includeSubDomains`。
9. **CPA 直连 8317 是明文 HTTP**：管理 key 虽需持有，但公网明文 HTTP 上 Bearer 头可被链路嗅探。配合第 1 条整改。

## 低：运维面

10. **relay-auto-update.timer 每日自动 `pull + up -d` `:latest` 镜像**（new-api→cliproxy→cpa-manager-plus）：无变更评审，上游镜像被投毒或发布破坏性更新会直接进入生产。`images.lock` 未在 timer 流程中强制。
11. **PostgreSQL/Redis 容器内端口未映射宿主机**（好现状），但 `postgres:15` / `redis:latest` 长期未随系统升级记录，建议纳入更新节奏。
12. **cli-proxy-api 的 config.yaml/auths/logs/plugins 以 rw bind mount 进容器**：容器内任何 RCE 都可改写凭证与配置；建议 auths 等只读化评估（插件需写 auths 目录，需逐项权衡）。

## 新面板已内置的对应防护（供对照）

- 应用只绑回环，经 OpenResty（8444，TLSv1.2+）反代；Cookie `HttpOnly; Secure; SameSite=Strict`；写操作 CSRF 校验；应用内全局令牌桶 + 登录/step-up 失败指数退避锁定（绕开第 7 条拿不到真实 IP 的限制）；严格 CSP `default-src 'self'`；审计日志全链路脱敏。
