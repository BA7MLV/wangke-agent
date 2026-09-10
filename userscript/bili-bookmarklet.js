// 网课学习助手 - B站视频提取书签脚本（Bookmarklet）
// 用法：在 B 站视频页按一下书签栏的这个书签，自动解析视频流地址并复制到剪贴板
//
// 安装方法：
//   1. 浏览器书签栏右键 → 添加新书签
//   2. 名称填：B站导入网课助手
//   3. 网址填下面这行（全部复制，包括 javascript: 前缀）：
//
// javascript:(function(){/* 把下面整个文件内容压缩成一行粘贴到这里 */})()
//
// 注意：现代浏览器出于安全，粘贴到地址栏时会自动去掉 javascript: 前缀，
// 所以必须先在书签管理器里手动输入 javascript:，或者先随便保存一个书签再编辑。

(async function () {
  'use strict';

  const TAG = '[网课助手]';

  function getBvFromPage() {
    const m = location.pathname.match(/BV[0-9A-Za-z]{10}/);
    return m ? m[0] : null;
  }

  function getCurrentPage() {
    const m = location.search.match(/[?&]p=(\d+)/);
    return m ? parseInt(m[1], 10) : 1;
  }

  async function apiGet(url) {
    const resp = await fetch(url, {
      headers: { Referer: 'https://www.bilibili.com' },
      credentials: 'include',
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
  }

  const bvid = getBvFromPage();
  if (!bvid) {
    alert('当前页面未识别到 B 站视频（BV 号）');
    return;
  }

  const page = getCurrentPage();

  try {
    // 1. 视频信息
    const view = await apiGet(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`);
    if (view.code !== 0) throw new Error(view.message);
    const pages = view.data?.pages || [];
    const target = pages.find((p) => p.page === page) || pages[0];
    if (!target) throw new Error('未找到分 P');

    // 2. 播放地址
    const play = await apiGet(
      `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${target.cid}&fnval=16&qn=127&fourk=1`
    );
    if (play.code !== 0) throw new Error(play.message);
    const dash = play.data?.dash;
    if (!dash?.video?.length) throw new Error('无可用视频流');

    const video = dash.video.sort((a, b) => (b.height || 0) - (a.height || 0))[0];
    const audio = dash.audio?.[0];

    // 3. 组装数据包
    const payload = {
      _source: 'bilibili-bookmarklet',
      bvid,
      title: pages.length > 1 && target.part
        ? `${view.data.title} P${target.page} ${target.part}`
        : view.data.title,
      videoUrl: video.baseUrl || video.base_url,
      audioUrl: audio ? (audio.baseUrl || audio.base_url) : null,
      duration: dash.duration,
      cookie: document.cookie,
    };

    // 4. 复制到剪贴板
    await navigator.clipboard.writeText(JSON.stringify(payload));

    // 5. 提示
    const tip = document.createElement('div');
    tip.style.cssText = `
      position: fixed; top: 20px; left: 50%; transform: translateX(-50%);
      background: #00a1d6; color: #fff; padding: 16px 24px; border-radius: 12px;
      z-index: 999999; font-size: 14px; box-shadow: 0 4px 20px rgba(0,0,0,0.3);
      max-width: 400px; text-align: center;
    `;
    tip.innerHTML = `
      <div style="font-weight:bold;margin-bottom:8px">✅ 已复制视频信息</div>
      <div style="font-size:12px;opacity:0.9">
        打开网课学习助手 → 导入 B 站 → 粘贴即可<br>
        Cookie 仅本次有效，过期需重新点击书签
      </div>
    `;
    document.body.appendChild(tip);
    setTimeout(() => tip.remove(), 5000);

    console.log(TAG, payload);
  } catch (e) {
    alert(`解析失败：${e.message}`);
    console.error(TAG, e);
  }
})();
