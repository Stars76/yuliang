// Service Worker：静态资源离线缓存。版本号变更即触发整批换缓存。
const VERSION = 'v18';
const CACHE_NAME = `qd-static-${VERSION}`;
const PRECACHE = ['/', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function isCacheFirst(pathname) {
  return (
    pathname.startsWith('/assets/') ||
    pathname.startsWith('/fonts/') ||
    pathname.startsWith('/icons/')
  );
}

// cache-first，命中后后台更新缓存（stale-while-revalidate）
async function cacheFirst(request) {
  const cached = await caches.match(request);
  const refresh = fetch(request)
    .then((resp) => {
      if (resp.ok) {
        const clone = resp.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
      }
      return resp;
    })
    .catch(() => null);
  return cached ?? (await refresh) ?? Response.error();
}

// network-first，失败回退缓存
async function networkFirst(request) {
  try {
    const resp = await fetch(request);
    if (resp.ok && request.method === 'GET') {
      const clone = resp.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
    }
    return resp;
  } catch {
    const cached = await caches.match(request);
    return cached ?? Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // 一律 network-only
  event.respondWith(isCacheFirst(url.pathname) ? cacheFirst(request) : networkFirst(request));
});
