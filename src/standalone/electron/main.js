// Electron 主进程：加载引擎（Node 侧），safeStorage 加密凭证，起仅 127.0.0.1 随机端口的 loopback 服务，
// BrowserWindow 同源加载 http://127.0.0.1:<port>/（nodeIntegration 关、contextIsolation 开）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, ipcMain, safeStorage, nativeImage, shell } from 'electron';
import { createEngine } from '../engine.js';
import { createFileStore } from '../store.js';
import { createApiServer } from './server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function makeCodec() {
  try {
    if (safeStorage && safeStorage.isEncryptionAvailable()) {
      return {
        available: true,
        encrypt: (s) => safeStorage.encryptString(s).toString('base64'),
        decrypt: (b) => safeStorage.decryptString(Buffer.from(b, 'base64')),
      };
    }
  } catch {}
  return null; // 无钥匙串 → 明文降级（仅本机、不联网）
}

function webDistDir() {
  const candidates = [
    path.join(__dirname, '..', '..', 'web', 'dist'),
    path.join(process.resourcesPath ?? '', 'web', 'dist'),
  ];
  return candidates.find((p) => fs.existsSync(path.join(p, 'index.html'))) ?? candidates[0];
}

async function main() {
  await app.whenReady();
  app.setAppUserModelId('com.yuliang.app'); // 让任务栏用本 App 的图标而非默认
  const store = createFileStore({ dataDir: app.getPath('userData'), codec: makeCodec() });
  const engine = createEngine({ store });

  const server = createApiServer({ engine, webDist: webDistDir() });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;

  ipcMain.handle('standalone:meta', () => ({
    origin,
    secure: store.secure,
    platform: process.platform,
  }));

  // 用系统默认浏览器打开外部链接（如 Codex 设备码验证页）；仅允许 http/https
  ipcMain.handle('standalone:openExternal', (_e, url) => {
    try {
      const u = new URL(String(url));
      if (u.protocol === 'http:' || u.protocol === 'https:') shell.openExternal(u.toString());
      return true;
    } catch {
      return false;
    }
  });

  const win = new BrowserWindow({
    width: 1080,
    height: 780,
    icon: path.join(__dirname, 'icon.ico'), // 窗口/任务栏图标（打包后从 asar 读取）
    show: !process.env.QD_SMOKE,
    backgroundColor: '#05070d',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true, // preload 只用 contextBridge/ipcRenderer（沙箱白名单模块），兼容
    },
  });
  win.setMenuBarVisibility(false);
  win.loadURL(origin);
  // 拒绝一切对外导航/新窗口，锁死在 loopback 源
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(origin)) e.preventDefault();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  if (process.env.QD_SMOKE) {
    const fail = (why) => {
      console.log(`[smoke] FAIL ${why}`);
      server.close();
      app.exit(1);
    };
    const guard = setTimeout(() => fail('timeout'), 20000);
    win.webContents.once('did-finish-load', async () => {
      try {
        const meta = await fetch(`${origin}/api/credentials/meta`).then((r) => r.json());
        const creds = await fetch(`${origin}/api/credentials`).then((r) => r.json());
        const html = await win.webContents.executeJavaScript('document.querySelector("#root").childElementCount');
        const ic = nativeImage.createFromPath(path.join(__dirname, 'icon.ico'));
        const sz = ic.isEmpty() ? 'EMPTY' : `${ic.getSize().width}x${ic.getSize().height}`;
        console.log(`[smoke] OK meta=${meta.length} creds=${creds.length} rootChildren=${html} secure=${store.secure} icon=${sz}`);
        clearTimeout(guard);
        server.close();
        app.exit(0);
      } catch (e) {
        clearTimeout(guard);
        fail(e?.message ?? String(e));
      }
    });
    win.webContents.once('did-fail-load', (_e, code, desc) => fail(`did-fail-load ${code} ${desc}`));
  }

  app.on('window-all-closed', () => {
    server.close();
    if (process.platform !== 'darwin') app.quit();
  });
}

main().catch((e) => {
  console.error('[main] startup failed:', e?.message ?? e);
  app.quit();
});
