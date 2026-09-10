# B 站导入 · 油猴桥

Cloudflare Worker 的出口 IP 常被 B 站拒绝。这支脚本挂在**网课学习助手页面**上，用 `GM_xmlhttpRequest` 从**本机 IP**直连 B 站 API / CDN，并带上 `Referer: https://www.bilibili.com`。

## 安装

1. 浏览器装 [Tampermonkey](https://www.tampermonkey.net/)（Chrome / Edge / Firefox / Safari 桌面端）
2. 打开网课助手 → **设置 → 哔哩哔哩导入**，点「安装油猴脚本」；或把 `wangke-bili-bridge.user.js` 拖进 Tampermonkey
3. 刷新网课助手。设置页应显示「油猴桥已连接」
4. 库页粘贴 BV / 链接即可导入。可选：在设置里贴自己的 `SESSDATA` 解锁更高清晰度

## 限制

- **iPad / 手机 Safari PWA 用不了油猴**，请改用本机文件导入，或在电脑浏览器里导
- Tampermonkey 无法真正流式下载，整段 m4s 会先进内存再封装，超大视频可能顶内存
- 脚本用 `@match *://*/*`，但只有页面带 `data-wangke="1"` 才会注入（助手的 `index.html` 已加）
