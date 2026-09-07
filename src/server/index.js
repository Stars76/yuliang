// 入口：加载 store（缺失则提示先 init）、监听端口、启动时为锁定态，首次登录成功即解锁
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Store } from './store/index.js';
import { createServer } from './http.js';

const DATA_DIR = process.env.DATA_DIR ?? './data';
const PORT = Number(process.env.PORT ?? 18318);
const HOST = process.env.HOST ?? '127.0.0.1';

const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web/dist');

const store = new Store(DATA_DIR);
if (await store.exists()) {
  await store.load();
  console.log(`[quota-dashboard] store 已加载（${DATA_DIR}/store.enc），当前为锁定态，首次 HTTP 登录成功即解锁`);
} else {
  console.warn('[quota-dashboard] store 不存在，请先运行: node src/server/cli/index.js init');
}

const server = createServer({ store, dataDir: DATA_DIR, webDist });
server.listen(PORT, HOST, () => {
  console.log(`[quota-dashboard] listening on http://${HOST}:${PORT}`);
});
