# 余量 · 单机离线额度面板

一个**单机离线**的 AI 编码订阅额度面板：把 Codex(ChatGPT)、Kimi、GLM(Z.AI/BigModel)、DeepSeek、OpenCode、Ollama、Command Code、sub2api、newapi 等 11 类服务的剩余额度、限额窗口与重置时间，统一到一张面板上。**没有服务器、没有账户体系、凭证只存你自己的设备。**

> 支持 **Windows（Electron）** 与 **Android（Capacitor）**，两端共用同一份引擎与前端。

## 核心特性

- **数据不出本机**：凭证存 OS 钥匙串（Windows Credential Manager / Android Keystore），流量只去各官方只读端点
- **只读查询零消耗**：所有取数均为只读 GET，绝不调用模型接口、不产生任何用量
- **三种进度可视化**：条形 / 圆环 / 嵌套环；明暗双主题，默认跟随系统
- **用量阈值提醒**：85/90/95% 可调，跨阈值卡片高亮 + 一次性 Toast（同周期不重复打扰）
- **本机凭证自动发现**（Windows）：自动读取 `~/.codex`、OpenCode `auth.json`，其余服务手动填写
- **Android 桌面小组件**：额度快照上桌面，无需打开 App

## 支持的服务

| Provider | 类型 | 说明 |
|---|---|---|
| Codex（直连） | 额度 | OAuth 设备码登录，查 5 小时/每周窗口（实验性，依赖未公开接口） |
| Codex（CPA） | 额度 | 经本机 CLIProxyAPI 管理口枚举账号查询 |
| Kimi For Coding | 额度 | 订阅额度 + 档位名 |
| GLM（Z.AI / BigModel） | 额度 | 国际/国内双端点，5h/周/MCP 窗口 |
| OpenCode | 额度 | 一个 Key 自动识别 Go / Zen |
| Ollama Cloud | 额度 | 会话/周/月窗口 |
| Command Code | 额度 | credits + 用量窗口 |
| DeepSeek | 余额 | 按量余额（官方端点） |
| sub2api / newapi | 额度/余额 | 自建中转实例 |

## 本地开发

```bash
npm test                       # 引擎 + provider + 提醒逻辑测试
npm run build:web              # Electron 壳前端构建
npm run build:android-web      # Android WebView 构建
npm run electron               # 启动 Windows 壳（开发）
npm run dist:win               # 打包 Windows 安装包 → release/
```

## 架构速览

```
src/
├── standalone/            # 单机 App 核心
│   ├── providers/         # 11 个 provider 适配器 + 白名单执行核心（纯 Node ESM）
│   ├── engine.js          # 统一引擎：缓存 60s + 指数退避 + Codex 直连 OAuth
│   ├── store.js           # 凭证存储（注入 codec → safeStorage/SecureStorage 加密）
│   ├── discover.js        # 本机凭证自动发现（~/.codex、OpenCode）
│   ├── electron/          # Windows 壳：loopback 静态服务 + safeStorage + IPC
│   └── capacitor/         # Android 壳：原生 fetch shim + SecureStorage + 小组件
├── web/                   # React 18 + Vite 前端（两端共用，仅 4 个依赖）
└── ...
```

安全模型与数据来源细节见 `CONTRACT.md`、`docs/data-sources.md`。

## 更新日志

见 `CHANGELOG.md`。
