; ---------------------------------------------------------------
; 自定义 NSIS include（经 nsis.include 引用，注入到 installer.nsi 头部）
; 目标：把本机安装目录从默认的「\余量」改成「\yuliang」。
;
; 原理：electron-builder 通过命令行 `-D APP_FILENAME=...` 传目录名；
; 在 NSIS 预处理器里，命令行已定义的符号用 `!define` 直接覆盖会报错
; （实测报 `"APP_FILENAME" already defined!`）。所以必须先 `!undef`
; 再 `!define` 才能让它生效（实测在 -WX 下编译通过）。
;
; 注意：只改「安装目录名」；可执行文件名 / 卸载程序名 / 快捷方式名均来自
; PRODUCT_FILENAME 与 SHORTCUT_NAME，不受这里影响，仍是「余量」。
; ---------------------------------------------------------------
!undef APP_FILENAME
!define APP_FILENAME "yuliang"
