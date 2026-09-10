// ==UserScript==
// @name         网课学习助手 · B 站导入桥
// @namespace    https://wangke.local
// @version      2.0.0
// @description  在网课学习助手页面注入 B 站请求桥：用本机 IP 直连 API/CDN，带 Referer，绕过 CORS。不经过 Cloudflare。
// @author       wangke
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      *
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const TAG = '[网课助手·B站桥]';
  const VERSION = '2.0.0';

  function isWangkePage() {
    try {
      if (document.documentElement?.getAttribute('data-wangke') === '1') return true;
    } catch {
      /* documentElement 可能尚未就绪 */
    }
    return false;
  }

  function parseHeaders(raw) {
    const headers = {};
    if (!raw) return headers;
    for (const line of String(raw).split(/\r?\n/)) {
      const idx = line.indexOf(':');
      if (idx > 0) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    }
    return headers;
  }

  function gmFetch(url, init = {}) {
    return new Promise((resolve, reject) => {
      const cookie = init.cookie;
      const headers = {
        Referer: 'https://www.bilibili.com',
        Origin: 'https://www.bilibili.com',
        'User-Agent': navigator.userAgent,
        Accept: '*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      };
      if (cookie) headers.Cookie = cookie;

      GM_xmlhttpRequest({
        method: 'GET',
        url,
        headers,
        responseType: 'arraybuffer',
        anonymous: Boolean(cookie),
        timeout: 0,
        onload(res) {
          const ok = res.status >= 200 && res.status < 300;
          const buf = res.response instanceof ArrayBuffer ? res.response : new ArrayBuffer(0);
          const decoder = new TextDecoder('utf-8');
          let textCache;
          const text = () => {
            textCache ??= decoder.decode(buf);
            return Promise.resolve(textCache);
          };
          resolve({
            ok,
            status: res.status,
            headers: parseHeaders(res.responseHeaders),
            json: () => text().then((t) => JSON.parse(t)),
            text,
            arrayBuffer: () => Promise.resolve(buf),
          });
        },
        onerror(err) {
          reject(new Error(`油猴请求失败：${err?.error || err?.message || '未知错误'}`));
        },
        ontimeout() {
          reject(new Error('油猴请求超时'));
        },
      });
    });
  }

  function inject() {
    if (!isWangkePage()) return false;
    const api = { version: VERSION, fetch: gmFetch };
    try {
      unsafeWindow.__wangkeBiliBridge = api;
    } catch {
      window.__wangkeBiliBridge = api;
    }
    window.__wangkeBiliBridge = api;
    console.log(TAG, '已注入 window.__wangkeBiliBridge', VERSION);
    return true;
  }

  if (inject()) return;

  const obs = new MutationObserver(() => {
    if (inject()) obs.disconnect();
  });
  obs.observe(document.documentElement || document, { attributes: true, subtree: true, childList: true });
  document.addEventListener('DOMContentLoaded', () => {
    inject();
    obs.disconnect();
  });
})();
