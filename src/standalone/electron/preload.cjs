// preload（CJS，供沙箱化渲染进程）：只暴露最小安全桥；REST 走同源 loopback，不经此桥取敏感数据。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('standalone', {
  meta: () => ipcRenderer.invoke('standalone:meta'),
  openExternal: (url) => ipcRenderer.invoke('standalone:openExternal', url),
});
