# Quota Dashboard — AI 账号额度聚合面板

单用户 Web 面板，统一显示多个 AI 编码订阅账号的官方剩余额度、限额窗口与重置时间。
安全模型与数据来源详见 `docs/data-sources.md`、`docs/security-risk-list.md`、`CONTRACT.md`。

## 部署

```bash
cd /home/ckx/quota-dashboard
sudo docker compose build
sudo docker compose up -d
```

- 只监听 `127.0.0.1:18318`，由 OpenResty 反代 `quota.entropicecho.com`（配置模板在 `deploy/openresty/`，接入步骤见下文）。
- 容器内经 `host.docker.internal:8317`（docker 网关）访问宿主机 CPA 管理口；compose 已配 `extra_hosts` 与 `CPA_MGMT_URL`。裸机 `npm start` 时默认 `http://127.0.0.1:8317`。
- 数据目录 `./data`（bind mount 到容器 `/data`）。容器内以非 root 用户 `app` 运行，首次启动前确保目录可写：

```bash
mkdir -p data
APP_UID=$(sudo docker run --rm quota-dashboard-quota-dashboard id -u app | tr -d '\r')
sudo chown -R "$APP_UID:$APP_UID" data
```

## 首次初始化（只能在服务器终端完成）

```bash
sudo docker exec -it quota-dashboard node src/server/cli/index.js init
```

交互流程：设置主密码（≥16 位，二次确认）→ 显示 TOTP secret 与 otpauth:// URI（用 Authenticator 添加）→ 显示恢复码（**仅显示一次**，离线保存）。

服务启动后处于锁定态，首次网页登录成功即解锁（DEK 驻留内存，重启后需重新登录解锁）。

## 日常使用

- 打开 `https://quota.entropicecho.com` → 主密码登录。
- 添加/修改/删除凭证：登录态下直接操作（仅面板加密副本，不影响上游账号）。
- **导出/导入加密备份、修改密码、注销其他会话**：需再次输入主密码 + Authenticator TOTP（导入还需备份的导出密码）。
- 密钥完全不回显：网页与 API 都不返回密钥内容（连脱敏片段也没有）；密钥唯一出口是加密备份导出。
- 仪表盘：顶部总览统计（账号数/正常/异常/最紧窗口/余额合计），账号按来源分组展示；打开时拉取 + 手动刷新 + 5 分钟自动刷新；服务端缓存 ≥60 秒。
- 顶栏右侧圆形按钮切换浅色/深色主题，默认跟随系统，选择存 localStorage 记住。

## 备份与恢复

**导出加密备份**（网页：安全页 → 导出，需主密码 + TOTP + 独立导出密码；备份不含恢复码）：

也可在终端导出到指定路径：

```bash
sudo docker exec -it quota-dashboard node src/server/cli/index.js backup --out /data/backups/quota-backup-$(date +%Y%m%d).json
```

**从备份恢复**（覆盖当前数据，谨慎）：

网页：安全页 → 导入备份 → 选择备份文件 → 输入主密码 + TOTP + 导出密码。导入将**覆盖当前全部凭证与 Codex 账号选择**（settings 如备份含则一并恢复；登录会话不受影响，不会被备份覆盖）。完成后刷新页面。

也可在终端恢复（注意：CLI restore 会把主密码重置为导出密码）：

```bash
sudo docker exec -it quota-dashboard node src/server/cli/index.js restore --in /data/backups/quota-backup-YYYYMMDD.json
```

**恢复码重置**（忘记主密码或 TOTP 丢失）：网页登录页 → "恢复账户" → 输入恢复码 → 设置新主密码 → 重新绑定 TOTP → 获得新恢复码。完成后全部旧会话注销。

## OpenResty 接入（quota.entropicecho.com）

前置：DNS A 记录指向本机（443 由 HAProxy 按 SNI 透传到 OpenResty 8444，无需改 HAProxy）。

**推荐：运行交互式上线向导**（引导完成 DNS → 建站 → 证书 → 端口核对 → 验证 → 初始化）：

```bash
./scripts/go-live.sh
```

手工步骤如下：

1. 在 1Panel 面板创建"反向代理"网站：域名 `quota.entropicecho.com`，目标 `http://127.0.0.1:18318`；申请 Let's Encrypt 证书（HTTP-01，开自动续期）。
2. **立即检查生成的 conf**：若 `listen 443 ssl` 需改为 `listen 8444 ssl http2`（443 被 HAProxy 占用），修改前留 `.bak-$(date +%Y%m%d)` 备份。
3. 或用 `deploy/openresty/` 下的模板手工建站（与 1Panel 目录约定一致）：

```bash
OR=/opt/1panel/apps/openresty/openresty
sudo mkdir -p $OR/www/sites/quota.entropicecho.com/{proxy,log,ssl}
sudo cp deploy/openresty/quota.entropicecho.com.conf $OR/conf/conf.d/
sudo cp deploy/openresty/proxy-root.conf $OR/www/sites/quota.entropicecho.com/proxy/root.conf
# 证书：把 1Panel 签发的 fullchain.pem / privkey.pem 放入 ssl/（手工建站时需自行签发）
sudo docker exec 1Panel-openresty-mT7m nginx -t && sudo docker exec 1Panel-openresty-mT7m nginx -s reload
```

4. 验证：`curl -sI https://quota.entropicecho.com/` 应返回 200 且带安全响应头。

注意：此后如在 1Panel UI 重新保存该站点，可能把 listen 重置为 443 导致 OpenResty 起不来——保存后立即核对 conf。

## 审计

`/data/audit-YYYYMMDD.log`（JSONL，保留 30 天）：登录、失败、锁定、TOTP、凭证增删改、导出、改密、恢复。落盘前全量脱敏，绝不含凭证/Cookie/Authorization/恢复码/上游响应原文。

## 本地开发

```bash
npm test                          # 后端 + provider 解析测试（node:test）
cd src/web && npm ci && npm run dev    # 前端 dev（proxy 到 127.0.0.1:18318）
DATA_DIR=/tmp/qd-data node src/server/cli/index.js init   # 本地初始化
DATA_DIR=/tmp/qd-data npm start         # 本地起服务
```
