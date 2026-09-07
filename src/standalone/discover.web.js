// WebView/Capacitor 侧 discover 占位：本机配置文件扫描依赖 node:fs，浏览器/WebView 无文件系统。
// 经 capacitor vite 配置把 ../standalone/discover.js 别名到本文件；额度取数与凭证存储不受影响。
export function discoverLocalCredentials() {
  return { candidates: [] };
}
