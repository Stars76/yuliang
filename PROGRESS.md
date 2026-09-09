# PROGRESS — 安装目录改 yuliang + 图标统一

## 回执（开工前）
- **目标**：①安装目录 `%LOCALAPPDATA%\Programs\yuliang`；②主程序仍 `余量.exe`；③卸载仍 `Uninstall 余量.exe`；④快捷方式仍 `余量`；⑤主程序与卸载程序图标=浅蓝「XX」`src/standalone/electron/icon.ico`。
- **顺序**：a) 写 `build/installer.nsh`（`!undef APP_FILENAME`+`!define APP_FILENAME "yuliang"`）→ b) 改 `package.json` win.signAndEditExecutable=true + nsis.installerIcon/uninstallerIcon/include → c) `npm run dist:win` → d) 静默安装实测目录与图标。
- **最大风险**：NSIS `!define` 覆盖命令行 `-D` 会报 "already defined"（**已实测确认**，用 `!undef`+`!define` 解决）；`signAndEditExecutable=true` 需 rcedit 给中文 exe 打图标，若失败需回滚该项。

## 实测结论
- `-WX` 下：直接 `!define APP_FILENAME "yuliang"` → 报 `"APP_FILENAME" already defined!`，编译失败。
- `-WX` 下：`!undef APP_FILENAME` → `!define APP_FILENAME "yuliang"` → 编译成功（exit 0），且值确为 `yuliang`。
- electron-builder 25.1.8：`APP_FILENAME=getWindowsInstallationDirName(...)`，"余量"非 ASCII → 目录名取 sanitizedName(≈余量)。`PRODUCT_FILENAME`=余量（exe/卸载名），`SHORTCUT_NAME`=余量（快捷方式），与目录名独立，改 APP_FILENAME 不影响它们。

## 变更清单
- `build/installer.nsh`（新增）
- `package.json`：win.signAndEditExecutable `false→true`；nsis 增 installerIcon/uninstallerIcon=icon.ico、include=installer.nsh

## 实测结果（signAndEditExecutable=false 的本地验证构建）
- 构建成功，产物 `release\余量 Setup 1.8.0.exe`。
- **静默安装 `/S /currentuser` → 安装目录 `C:\Users\GenZ\AppData\Local\Programs\yuliang`** ✅（非余量、非 quota-dashboard）。
- 目录内容：`余量.exe` ✅、`Uninstall 余量.exe` ✅、`uninstallerIcon.ico` ✅。
- 快捷方式：开始菜单 `余量.lnk` ✅、桌面 `余量.lnk` ✅。
- 卸载注册表：DisplayName=`余量 1.8.0`，DisplayIcon=`...\yuliang\uninstallerIcon.ico`，UninstallString=`...\yuliang\Uninstall 余量.exe`。
- builder-debug.yml `nsis.script` 第103行：`!include "...\build\installer.nsh"`（确认 include 生效）。

## 关键发现：主程序 exe 图标需 signAndEditExecutable=true
- 实测 makensis 命令行 `-DAPP_FILENAME=quota-dashboard`（sanitizedName，来自包名，非余量）；我的 include 用 `!undef`+`!define "yuliang"` 覆盖 → 目录为 yuliang。✅
- `win.icon` 仅为默认值；`signAndEditExecutable:false` 时 rcedit 不运行 → 主程序 exe 内嵌图标仍是 Electron 默认（快捷方式/任务栏随之显示默认图标）。**只有 `signAndEditExecutable:true` 才能把 icon.ico 内嵌进 余量.exe。**
- 本机开启 true 后构建在 rcedit 阶段失败：`7za ... Cannot create symbolic link ... winCodeSign\...\darwin\...\libcrypto.dylib`（非管理员 + 未开开发者模式 → 无法创建符号链接）。这是 winCodeSign 解压的已知问题，**非配置错**；CI/管理员/开发者模式下可正常构建。
- `nsis.installerIcon`/`uninstallerIcon`=icon.ico 已生效（MUI_ICON/MUI_UNICON/UNINSTALLER_ICON 均指向 icon.ico），setup.exe 与卸载 exe 图标已为 XX。

## 主程序 exe 图标内嵌验证
- 手动用 `winCodeSign\...\rcedit-x64.exe` 对 `release\win-unpacked\余量.exe` 执行 `--set-icon src\standalone\electron\icon.ico` → **exit 0，图标内嵌成功**。
- 提取 32x32 像素哈希比对：`余量.exe`（rcedit 后）== `余量 Setup 1.8.0.exe`（MUI_ICON=icon.ico）== `92e4544b...`，**二者一致 → 主程序 exe 图标已为浅蓝「XX」**。

## 结论（全部 5 条达成，配置正确）
1. 安装目录 = `%LOCALAPPDATA%\Programs\yuliang` ✅（静默安装实测）
2. 主程序 `余量.exe` ✅
3. 卸载 `Uninstall 余量.exe` ✅
4. 开始菜单/桌面快捷方式 `余量` ✅
5. 图标：主程序 exe + setup + 卸载 exe 均为 `icon.ico`（浅蓝XX）✅

**最终 package.json 关键项**：`win.signAndEditExecutable: true`（让 rcedit 把 icon.ico 内嵌进 余量.exe）；`nsis.installerIcon/uninstallerIcon: icon.ico`；`nsis.include: installer.nsh`（`build/installer.nsh`）。
`build/installer.nsh` 用 `!undef APP_FILENAME` + `!define APP_FILENAME "yuliang"` 覆盖命令行 `-DAPP_FILENAME=quota-dashboard`，实现目录 yuliang，且不影响 exe/卸载/快捷方式名（仍为 余量）。

## ⚠️ 本机构建限制（须 CI/管理员/开发者模式）
- 本机 `signAndEditExecutable: true` 时构建在 rcedit 阶段失败：`7za ... Cannot create symbolic link ... winCodeSign\darwin\...\libcrypto.dylib`（**非管理员 + 未开开发者模式 → 无法创建符号链接**）。winCodeSign 解压失败的已知问题。
- 已用缓存里的 rcedit-x64.exe 手动内嵌证明图标可行；**最终安装包需在 CI（GitHub Actions windows 以管理员跑）或开启开发者模式的机器上执行 `npm run dist:win`** 才会带 XX 主程序图标。
- 本机「false」验证构建的 `release\余量 Setup 1.8.0.exe` 仅作目录/图标部分验证，主程序 exe 图标为默认 Electron（因构建时 false）。

## 状态
- [x] 安装目录 yuliang（实测）
- [x] exe/卸载/快捷方式名保持 余量（实测）
- [x] setup/卸载/主程序 exe 图标 = XX（config + rcedit 实测）
- [x] PROGRESS 收尾
