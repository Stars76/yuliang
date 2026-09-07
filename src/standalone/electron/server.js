// 极简 loopback node:http：仅 127.0.0.1，只实现保留端点 + 静态托管 src/web/dist。
// 无账户/会话/CSRF/限流（本机单用户）。engine 由外部注入。
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

const HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    ...HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function errToStatus(code) {
  if (code === 'unknown_provider' || code === 'invalid_fields' || code === 'bad_request') return 400;
  if (code === 'credential_not_found' || code === 'account_not_found') return 404;
  if (code === 'expired') return 410;
  if (code === 'adapter_unavailable') return 503;
  if (code === 'upstream' || code === 'auth_expired' || code === 'rate_limited' || code === 'unavailable' || code === 'upstream_changed') return 502;
  return 500;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1024 * 1024) {
        req.destroy();
        reject(new Error('body_too_large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('bad_json'));
      }
    });
    req.on('error', () => reject(new Error('bad_request')));
  });
}

export function createApiServer({ engine, webDist }) {
  async function serveStatic(req, res, pathname) {
    for (const seg of (req.url ?? '').split(/[?#]/)[0].split('/')) {
      let dec;
      try {
        dec = decodeURIComponent(seg);
      } catch {
        return sendJson(res, 400, { error: 'bad_request' });
      }
      if (dec === '..' || dec.includes('\0')) return sendJson(res, 404, { error: 'not_found' });
    }
    let rel;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return sendJson(res, 400, { error: 'bad_request' });
    }
    const root = path.resolve(webDist);
    let filePath = path.resolve(root, `.${rel}`);
    if (filePath !== root && !filePath.startsWith(root + path.sep)) return sendJson(res, 404, { error: 'not_found' });
    let stat = await fs.stat(filePath).catch(() => null);
    if (stat?.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      stat = await fs.stat(filePath).catch(() => null);
    }
    if (!stat && !path.extname(rel)) {
      filePath = path.join(root, 'index.html');
      stat = await fs.stat(filePath).catch(() => null);
    }
    if (!stat) return sendJson(res, 404, { error: 'not_found' });
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      ...HEADERS,
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    if (req.method === 'HEAD') return res.end();
    res.end(await fs.readFile(filePath));
  }

  const routes = {
    'GET /api/quota': async (req, res) => sendJson(res, 200, { accounts: await engine.getQuota() }),
    'POST /api/quota/refresh': async (req, res) => {
      const b = await readJson(req);
      sendJson(res, 200, { accounts: await engine.refreshQuota(b.accountId) });
    },
    'GET /api/credentials': async (req, res) => sendJson(res, 200, engine.listCredentials()),
    'GET /api/credentials/meta': async (req, res) => sendJson(res, 200, await engine.listProvidersMeta()),
    'POST /api/credentials': async (req, res) => {
      const b = await readJson(req);
      sendJson(res, 200, await engine.saveCredential(b));
    },
    'PUT /api/credentials/:id': async (req, res, { id }) => {
      const b = await readJson(req);
      sendJson(res, 200, await engine.updateCredential(id, b));
    },
    'DELETE /api/credentials/:id': async (req, res, { id }) => sendJson(res, 200, engine.deleteCredential(id)),
    'GET /api/discover': async (req, res) => sendJson(res, 200, await engine.discoverLocalCredentials()),
    'POST /api/codex-direct/login': async (req, res) => {
      const b = await readJson(req);
      sendJson(res, 200, await engine.codexDirectStart(b));
    },
    'GET /api/codex-direct/login/status': async (req, res, p, url) => {
      const token = url.searchParams.get('loginToken');
      sendJson(res, 200, await engine.codexDirectPoll(token));
    },
    'GET /api/codex/accounts': async (req, res, p, url) => {
      const credId = url.searchParams.get('credId');
      sendJson(res, 200, await engine.listCodexAccounts(credId));
    },
    'POST /api/codex/accounts': async (req, res) => {
      const b = await readJson(req);
      sendJson(res, 200, await engine.saveCodexAccounts(b.credId, b.accounts));
    },
  };

  function matchRoute(method, pathname) {
    const direct = routes[`${method} ${pathname}`];
    if (direct) return { handler: direct, params: {} };
    for (const [key, handler] of Object.entries(routes)) {
      const [m, p] = key.split(' ');
      if (m !== method || !p.includes(':')) continue;
      const rp = p.split('/');
      const pp = pathname.split('/');
      if (rp.length !== pp.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < rp.length; i++) {
        if (rp[i].startsWith(':')) params[rp[i].slice(1)] = decodeURIComponent(pp[i]);
        else if (rp[i] !== pp[i]) {
          ok = false;
          break;
        }
      }
      if (ok) return { handler, params };
    }
    return null;
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const pathname = url.pathname;
      if (pathname.startsWith('/api/')) {
        const match = matchRoute(req.method, pathname);
        if (!match) return sendJson(res, 404, { error: 'not_found' });
        await match.handler(req, res, match.params, url);
        return;
      }
      if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, pathname);
      sendJson(res, 405, { error: 'method_not_allowed' });
    } catch (e) {
      const code = e.code ?? (e.name === 'QuotaError' ? e.kind : 'internal');
      sendJson(res, errToStatus(code), { error: code });
    }
  });

  return server;
}
