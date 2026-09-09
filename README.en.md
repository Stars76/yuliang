# Yuliang · Offline AI Quota Dashboard

[简体中文](README.md) | **English**

A **fully offline** AI coding subscription quota dashboard: it brings the remaining quota, usage windows, and reset times of 11 kinds of services onto a single panel — Codex (ChatGPT), Kimi, GLM (Z.AI / BigModel), DeepSeek, OpenCode, Ollama, Command Code, sub2api, newapi, and more. **No server, no account system, and credentials are stored only on your own device.**

> Supports **Windows (Electron)** and **Android (Capacitor)**, sharing the same engine and frontend across both platforms.
>
> Open-sourced at [Stars76/yuliang](https://github.com/Stars76/yuliang) (MIT License). Issues and PRs are welcome.

<p align="left">
  <a href="https://github.com/Stars76/yuliang/actions/workflows/verify.yml"><img src="https://github.com/Stars76/yuliang/actions/workflows/verify.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="License">
  <img src="https://img.shields.io/github/v/release/Stars76/yuliang" alt="Release">
</p>

## Installation

**Windows** (10/11 x64)
1. Download `余量 Setup <version>.exe` from [GitHub Releases](https://github.com/Stars76/yuliang/releases/latest)
2. Run the installer. If SmartScreen shows a blue warning on first launch: click **More info** → **Run anyway** (the app has no code-signing certificate; this is normal)
3. Go to **Credentials** and add your first account

**Android** (8.0+)
1. Download `yuliang-<version>.apk` from [GitHub Releases](https://github.com/Stars76/yuliang/releases/latest)
2. Allow "Install from this source" (Settings → Security → Install unknown apps)
3. After adding an account, you can place a quota card on the home screen from the **Widgets** page; the ↻ button at the top-right refreshes and opens the app

> The desktop widget is Android-only; the Windows app automatically discovers local Codex / OpenCode configs.
> The Android build is currently signed with a local test key, so updating before switching to the official signing key requires reinstalling.

## Key Features

- **Data never leaves your device**: credentials are stored in the OS keychain (Windows Credential Manager / Android Keystore); traffic only goes to the official read-only endpoints
- **Read-only and zero-cost queries**: all data retrieval uses read-only GET calls; it never touches the model endpoints or incurs any usage
- **Three visualization styles**: bars / rings / nested rings; light & dark themes that follow the system by default
- **Usage threshold alerts**: adjustable at 85 / 90 / 95%, with highlighted cards and a one-time toast when a threshold is crossed (no repeated nudges within the same period)
- **Local credential auto-discovery** (Windows): automatically reads `~/.codex` and OpenCode `auth.json`; other services are filled in manually
- **Android home-screen widget**: puts a quota snapshot on the home screen without opening the app

## Supported Services

| Provider | Type | Description |
|---|---|---|
| Codex (direct) | Quota | OAuth device-code login, checks the 5-hour / weekly window (experimental, depends on undocumented endpoints) |
| Codex (CPA) | Quota | Enumerates accounts through the local CLIProxyAPI management port |
| Kimi For Coding | Quota | Subscription quota + tier name |
| GLM (Z.AI / BigModel) | Quota | International / CN dual endpoints, 5h / weekly / MCP windows |
| OpenCode | Quota | One key auto-detects Go / Zen |
| Ollama Cloud | Quota | Session / weekly / monthly windows |
| Command Code | Quota | Credits + usage window |
| DeepSeek | Balance | Pay-as-you-go balance (official endpoint) |
| OpenRouter | Balance | Official credits endpoint (purchased − used) |
| sub2api / newapi | Quota/Balance | Self-hosted relay instances |

## Local Development

```bash
npm test                       # engine + provider + alert logic tests
npm run build:web              # build the Electron shell frontend
npm run build:android-web      # build the Android WebView app
npm run electron               # launch the Windows shell (dev)
npm run dist:win               # package the Windows installer → release/
npm run release:bump           # sync versions across 3 places + bump Android versionCode
```

> The version number is kept in sync by `npm run release:bump` (root `package.json`, `capacitor/package.json`, and `build.gradle`'s `versionName`), and it also increments `versionCode`; run it before building a release.

## Architecture Overview

```
src/
├── standalone/            # the single-machine app core
│   ├── providers/         # 11 provider adapters + whitelist execution core (pure Node ESM)
│   ├── engine.js          # unified engine: 60s cache + exponential backoff + Codex direct OAuth
│   ├── store.js           # credential store (inject codec → safeStorage/SecureStorage encryption)
│   ├── discover.js        # local credential auto-discovery (~/.codex, OpenCode)
│   ├── electron/          # Windows shell: loopback static server + safeStorage + IPC
│   └── capacitor/         # Android shell: native fetch shim + SecureStorage + widgets
├── web/                   # React 18 + Vite frontend (shared by both, only 4 dependencies)
└── ...
```

For the security model and data-source details, see `docs/CONTRACT.md`, `docs/CONTEXT.md`, and `docs/data-sources.md`. Open-sourced under the [MIT License](LICENSE).

## Changelog

See `CHANGELOG.md`.
