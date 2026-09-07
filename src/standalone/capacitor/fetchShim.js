// 原生 HTTP 取数：Capacitor WebView 里 provider 的全局 fetch 会被上游 CORS 拦截。
// 用自写原生插件 NativeHttp（HttpURLConnection，绕过 CORS）替代在 Capacitor6 下失效的 @capacitor-community/http。
// 仅实现 executeAdapter 用到的 status()/text()。
import { registerPlugin } from '@capacitor/core';

const NativeHttp = registerPlugin('NativeHttp');

export function installNativeFetch() {
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = String(init.method ?? (typeof input === 'object' && input?.method) ?? 'GET').toUpperCase();
    const headers = init.headers ?? {};
    const res = await NativeHttp.request({ url, method, headers, data: init.body ?? null });
    const status = res.status ?? 0;
    const bodyText = res.body ?? '';
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: () => null },
      text: async () => bodyText,
      json: async () => JSON.parse(bodyText),
    };
  };
}
