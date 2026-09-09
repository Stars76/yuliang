# 余量 · 单机离线额度面板

**中文** | [English](README.en.md)

一个**单机离线**的 AI 编码订阅额度面板：把 Codex(ChatGPT)、Kimi、GLM(Z.AI/BigModel)、DeepSeek、OpenCode、Ollama、Command Code、sub2api、newapi 等 11 类服务的剩余额度、限额窗口与重置时间，统一到一张面板上。**没有服务器、没有账户体系、凭证只存你自己的设备。**

> 支持 **Windows（Electron）** 与 **Android（Capacitor）**，两端共用同一份引擎与前端。
>
> 开源仓库：[Stars76/yuliang](https://github.com/Stars76/yuliang)（MIT 许可证），欢迎提 Issue / PR。

<p align="left">
  <a href="https://github.com/Stars76/yuliang/actions/workflows/verify.yml"><img src="https://github.com/Stars76/yuliang/actions/workflows/verify.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="License">
  <img src="https://img.shields.io/github/v/release/Stars76/yuliang" alt="Release">
</p>

## 下载安装

**Windows**（10/11 x64）
1. 到 [GitHub Releases](https://github.com/Stars76/yuliang/releases/latest) 下载 `余量 Setup <版本>.exe`
2. 双击安装。首次运行若出现 SmartScreen 蓝色警告：点「更多信息」→「仍要运行」（应用未购买代码签名证书，属正常提示）
3. 到「凭证管理」添加第一个账号即可

**Android**（8.0+）
1. 到 [GitHub Releases](https://github.com/Stars76/yuliang/releases/latest) 下载 `yuliang-<版本>.apk`
2. 安装时允许「来自此来源的应用」（设置 → 安全 → 安装未知应用）
3. 添加账号后可在「小组件」页把额度卡片加到桌面；小组件右上角 ↻ 可刷新并打开 App

> 桌面小组件为 Android 专属；Windows 端支持自动发现本机 Codex / OpenCode 配置。
> Android 包当前使用本地测试密钥签名，后续版本升级需卸载重装（换正式签名前）。

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
| OpenRouter | 余额 | 官方 credits 端点（购入-已用） |
| sub2api / newapi | 额度/余额 | 自建中转实例 |

## 本地开发

```bash
npm test                       # 引擎 + provider + 提醒逻辑测试
npm run build:web              # Electron 壳前端构建
npm run build:android-web      # Android WebView 构建
npm run electron               # 启动 Windows 壳（开发）
npm run dist:win               # 打包 Windows 安装包 → release/
npm run release:bump           # 同步三处版本号 + 递增 Android versionCode
```

> 版本号由 `npm run release:bump` 同步（根 `package.json`、`capacitor/package.json`、`build.gradle` 的 `versionName`），并自动 +1 `versionCode`；出包前先跑它。

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

安全模型与数据来源细节见 `docs/CONTRACT.md`、`docs/CONTEXT.md`、`docs/data-sources.md`。基于 [MIT License](LICENSE) 开源。

## 更新日志

见 `CHANGELOG.md`。
