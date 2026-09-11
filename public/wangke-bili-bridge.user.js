// ==UserScript==
// @name         网课学习助手 · B 站导入桥
// @namespace    https://wangke.local
// @version      2.1.1
// @description  在网课学习助手页面注入 B 站请求桥：用本机 IP 直连 API/CDN，带 Referer，绕过 CORS。不经过 Cloudflare。
// @author       wangke
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_cookie
// @grant        unsafeWindow
// @connect      *
// @run-at       document-start
// ==/UserScript==
//
// ⚠️ 本文件必须以 UTF-8 提供：它会被「新标签页直接打开」来安装，响应头若不带 charset
//    （Vite 默认只发 text/javascript），Chromium 会把正文嗅探成 GBK，中文元数据全成乱码。
//    dev/preview 由 vite.config.ts 的 serve-userscript 中间件发 charset，生产由 public/_headers 顶。

(function () {
  'use strict';

  const TAG = '[网课助手·B站桥]';
  const VERSION = '2.1.1';

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

  /**
   * 统一出口：GET（API/CDN）与 POST（App 的 gRPC 字幕接口）都走这里。
   * - 不带显式 Cookie 时用正常模式，浏览器会带上自己那份 B 站 Cookie（等于已登录）；
   *   带了显式 Cookie 才切 anonymous，改用请求头里的 Cookie（避免两套 Cookie 打架）。
   * - POST 的二进制体交给 GM_xmlhttpRequest（Blob 兼容性最好）。
   */
  function gmFetch(url, init = {}) {
    return new Promise((resolve, reject) => {
      const cookie = init.cookie;
      const method = init.method || 'GET';
      const extra = init.headers || {};
      const headers = {
        Referer: 'https://www.bilibili.com',
        Origin: 'https://www.bilibili.com',
        'User-Agent': navigator.userAgent,
        Accept: '*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        ...extra,
      };
      if (cookie) headers.Cookie = cookie;

      let data;
      if (init.body) {
        data = new Blob([init.body], { type: extra['Content-Type'] || 'application/octet-stream' });
      }

      GM_xmlhttpRequest({
        method,
        url,
        headers,
        data,
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

  /**
   * GM_cookie.list 的一次调用。返回值语义：
   *   null        → 这次调用没成功（没有 GM_cookie API、报错、超时）
   *   [] / [...]  → 调用成功，里面是命中的 Cookie（可能为空）
   */
  function gmCookieList(details) {
    return new Promise((resolve) => {
      if (typeof GM_cookie === 'undefined' || typeof GM_cookie.list !== 'function') return resolve(null);
      let settled = false;
      const done = (list, err) => {
        if (settled) return;
        settled = true;
        resolve(!err && Array.isArray(list) ? list : null);
      };
      try {
        const ret = GM_cookie.list(details, done);
        // 有的实现返回 Promise
        if (ret && typeof ret.then === 'function') ret.then((list) => done(list), () => done(null, true));
      } catch {
        done(null, true);
      }
      // 老实现可能在无权限时既不回调也不报错，兜一个超时
      setTimeout(() => done(null, true), 2000);
    });
  }

  /**
   * 读本机 B 站 Cookie（设置页「读取本机 Cookie」用）。
   *
   * 返回：
   *   null → 这个浏览器/扩展给不了（没有 GM_cookie，例如 Safari 的 Userscripts；或调用全失败）
   *   ''   → 能读，但本机没有 B 站 Cookie（没登录 / 无痕 / 容器标签页）
   *   串   → 命中的 Cookie 拼好的 `k=v; k=v`
   *
   * 实现：先整体列举（部分实现要求 details 里必须有 url/domain，会报错，故失败再按域名逐个列举）；
   * SESSDATA 在 .bilibili.com，buvid 系列可能在 .hdslb.com，两个后缀都收。
   */
  async function getCookie() {
    // 坑：有的实现（含 Tampermonkey 的某些版本）对「无 url/domain」的列举会**成功返回空数组**，
    // 并不报错 —— 只看空数组会把「读不到」误判成「没登录」。所以只要能列举就再按域名逐个查一遍。
    let all = [];
    let anyOk = false;
    const broad = await gmCookieList({});
    if (broad !== null) {
      anyOk = true;
      all = all.concat(broad);
    }
    if (all.length === 0) {
      for (const domain of ['.bilibili.com', 'www.bilibili.com', '.hdslb.com']) {
        const list = await gmCookieList({ domain });
        if (list !== null) {
          anyOk = true;
          all = all.concat(list);
        }
      }
    }
    if (!anyOk) return null;
    const map = new Map();
    for (const c of all) {
      if (!c || !c.name) continue;
      const domain = String(c.domain || '');
      if (!/(^|\.)bilibili\.com$/.test(domain) && !/(^|\.)hdslb\.com$/.test(domain)) continue;
      map.set(c.name, c.value == null ? '' : String(c.value));
    }
    return [...map].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  function inject() {
    if (!isWangkePage()) return false;
    const api = { version: VERSION, fetch: gmFetch, getCookie };
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
