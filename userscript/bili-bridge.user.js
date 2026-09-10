// ==UserScript==
// @name         网课学习助手 - B站导入桥
// @namespace    https://wangke.local
// @version      1.0.0
// @description  在 B 站页面注入「导入到网课助手」按钮，一键把当前视频发送到网课学习助手
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/bangumi/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const TAG = '[网课助手]';

  // 从当前页面 URL 提取 BV 号
  function getBvFromPage() {
    const m = location.pathname.match(/BV[0-9A-Za-z]{10}/);
    return m ? m[0] : null;
  }

  // 获取当前分 P
  function getCurrentPage() {
    const m = location.search.match(/[?&]p=(\d+)/);
    return m ? parseInt(m[1], 10) : 1;
  }

  // 用 GM_xmlhttpRequest 请求 B 站 API（绕过 CORS）
  function gmFetch(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        headers: {
          'Referer': 'https://www.bilibili.com',
          'User-Agent': navigator.userAgent,
        },
        onload(res) {
          try {
            resolve(JSON.parse(res.responseText));
          } catch {
            reject(new Error('解析 JSON 失败'));
          }
        },
        onerror(err) {
          reject(new Error(`请求失败: ${err.error || '未知'}`));
        },
      });
    });
  }

  // 获取视频流地址
  async function getPlayUrl(bvid, cid) {
    const url = `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&fnval=16&qn=127&fourk=1`;
    const json = await gmFetch(url);
    if (json.code !== 0) throw new Error(`playurl 错误: ${json.message}`);
    const dash = json.data?.dash;
    if (!dash?.video?.length) throw new Error('无 DASH 流');
    const video = dash.video.sort((a, b) => (b.height || 0) - (a.height || 0))[0];
    const audio = dash.audio?.[0];
    return {
      videoUrl: video.baseUrl || video.base_url,
      audioUrl: audio ? (audio.baseUrl || audio.base_url) : null,
      title: document.title.replace(/_哔哩哔哩.*$/, ''),
      duration: dash.duration,
    };
  }

  // 下载并封装
  async function downloadAndRemux(streams, onProgress) {
    // 通知用户：由于浏览器安全限制，大文件下载需要用户手动确认
    // 这里返回流地址，让网课助手自己去下载（但网课助手域名不同，仍有 CORS）
    // 所以油猴方案的核心是：把流地址+Cookie 复制到剪贴板，用户粘贴到网课助手
    const payload = {
      title: streams.title,
      videoUrl: streams.videoUrl,
      audioUrl: streams.audioUrl,
      duration: streams.duration,
      cookie: document.cookie,
    };
    return payload;
  }

  // 创建悬浮按钮
  function createButton() {
    const bvid = getBvFromPage();
    if (!bvid) return;

    // 已存在则跳过
    if (document.getElementById('wangke-import-btn')) return;

    const btn = document.createElement('div');
    btn.id = 'wangke-import-btn';
    btn.innerHTML = '📥 导入网课助手';
    btn.style.cssText = `
      position: fixed;
      right: 20px;
      top: 200px;
      z-index: 99999;
      background: #00a1d6;
      color: #fff;
      padding: 10px 16px;
      border-radius: 8px;
      cursor: pointer;
      font-size: 14px;
      font-weight: bold;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
      user-select: none;
    `;
    btn.onmouseenter = () => btn.style.background = '#008cc0';
    btn.onmouseleave = () => btn.style.background = '#00a1d6';
    btn.onclick = handleImport;
    document.body.appendChild(btn);
  }

  async function handleImport() {
    const bvid = getBvFromPage();
    if (!bvid) return alert('未识别到 BV 号');

    const page = getCurrentPage();
    const btn = document.getElementById('wangke-import-btn');
    btn.innerHTML = '⏳ 解析中...';
    btn.style.pointerEvents = 'none';

    try {
      // 1. 获取 cid
      const viewUrl = `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`;
      const viewJson = await gmFetch(viewUrl);
      if (viewJson.code !== 0) throw new Error(`view 错误: ${viewJson.message}`);
      const pages = viewJson.data?.pages || [];
      const target = pages.find(p => p.page === page) || pages[0];
      if (!target) throw new Error('未找到分 P');

      // 2. 获取流地址
      const streams = await getPlayUrl(bvid, target.cid);
      streams.title = pages.length > 1 && target.part
        ? `${viewJson.data.title} P${target.page} ${target.part}`
        : viewJson.data.title;

      // 3. 生成网课助手可识别的数据包
      const payload = await downloadAndRemux(streams);

      // 4. 复制到剪贴板，引导用户去网课助手粘贴
      const text = JSON.stringify(payload);
      await navigator.clipboard.writeText(text);

      btn.innerHTML = '✅ 已复制！';
      alert(
        '视频信息已复制到剪贴板！\n\n' +
        '请打开网课学习助手 → 点击「导入 B 站」→ 粘贴此内容。\n\n' +
        '注意：Cookie 仅本次有效，过期需重新复制。'
      );
    } catch (e) {
      btn.innerHTML = '❌ 失败';
      alert(`解析失败：${e.message}`);
      console.error(TAG, e);
    } finally {
      setTimeout(() => {
        btn.innerHTML = '📥 导入网课助手';
        btn.style.pointerEvents = 'auto';
      }, 2000);
    }
  }

  // 页面加载完成后注入按钮
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createButton);
  } else {
    createButton();
  }

  // SPA 路由变化时重新注入
  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(createButton, 1000);
    }
  }).observe(document, { subtree: true, childList: true });

  console.log(TAG, '脚本已加载');
})();
