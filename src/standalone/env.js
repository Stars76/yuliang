// 环境抽象：provider 层需要的运行时配置。默认值保持与线上服务端一致（http://127.0.0.1:8317）。
// 用防御式读取 process，使同一份代码可跑在 Node（Electron 主进程）与 WebView（Capacitor）。
export const env = {
  cpaMgmtUrl:
    (typeof process !== 'undefined' && process.env && process.env.CPA_MGMT_URL) ||
    'http://127.0.0.1:8317',
};

export function setCpaMgmtUrl(url) {
  if (typeof url === 'string' && url.trim()) env.cpaMgmtUrl = url.trim();
  return env.cpaMgmtUrl;
}
