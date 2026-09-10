// ==UserScript==
// @name         网课学习助手 - B站导入助手
// @namespace    https://wangke.local
// @version      1.0.0
// @description  在浏览器内直接转发 B 站 API/视频流请求，绕过 CORS 与防盗链，无需代理服务器
// @match        https://www.bilibili.com/*
// @match        https://api.bilibili.com/*
// @match        https://*.bilivideo.com/*
// @match        https://b23.tv/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const TAG = '[B站导入助手]';

  // 把 GM_xmlhttpRequest 包装成类似 fetch 的接口，暴露给页面
  function gmFetch(url, options = {}) {
    return new Promise((resolve, reject) => {
      const details = {
        method: options.method || 'GET',
        url,
        headers: options.headers || {},
        data: options.body,
        responseType: options.responseType || '',
        onload(response) {
          resolve({
            ok: response.status >= 200 && response.status < 300,
            status: response.status,
            statusText: response.statusText,
            headers: parseHeaders(response.responseHeaders),
            json: () => Promise.resolve(JSON.parse(response.responseText)),
            text: () => Promise.resolve(response.responseText),
            arrayBuffer: () => Promise.resolve(response.response),
            blob: () => Promise.resolve(new Blob([response.response])),
          });
        },
        onerror(error) {
          reject(new Error(`GM 请求失败: ${error.error || '未知错误'}`));
        },
        ontimeout() {
          reject(new Error('GM 请求超时'));
        },
      };
      // 流式下载用 responseType: 'arraybuffer'
      if (options.responseType === 'stream') {
        details.responseType = 'arraybuffer';
      }
      GM_xmlhttpRequest(details);
    });
  }

  function parseHeaders(raw) {
    const headers = {};
    if (!raw) return headers;
    for (const line of raw.split('\r\n')) {
      const idx = line.indexOf(':');
      if (idx > 0) {
        headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
      }
    }
    return headers;
  }

  // 暴露给页面的 API：网课学习助手通过 window.__biliFetch 调用
  const api = {
    fetch: gmFetch,
    version: '1.0.0',
  };

  // 同时挂在 unsafeWindow 和 window 上，确保页面能访问
  try {
    unsafeWindow.__biliFetch = api;
  } catch {
    window.__biliFetch = api;
  }

  // 页面还没加载完时，等 DOM ready 再挂一次
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      window.__biliFetch = api;
    });
  } else {
    window.__biliFetch = api;
  }

  console.log(TAG, '已注入，window.__biliFetch 可用');
})();
