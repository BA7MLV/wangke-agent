/* eslint-disable no-console */
// 油猴脚本的响应字符集回归。
//
// 背景：「安装脚本」是**用新标签页直接打开** /wangke-bili-bridge.user.js。Vite 的静态中间件
// 对 .js 只发 `Content-Type: text/javascript`（没有 charset），Chromium 于是按内容嗅探编码，
// 中文正文被判成 GBK —— 实测 `document.characterSet === 'GBK'`，元数据全成乱码
// （`网课学习助手` → `缃戣瀛︿範鍔╂墜`），油猴装出来的 name/description 也跟着乱。
//
// 修法：dev/preview 走 vite.config.ts 里的 `serve-userscript` 中间件显式发 charset，
// 生产构建由 public/_headers 顶。本脚本只断言「打开就是不乱码」，不关心实现方式。
//
// 用法：BASE_URL=http://localhost:4173 node scripts/e2e-userscript-charset.mjs
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:4173';
const URL = `${BASE}/wangke-bili-bridge.user.js`;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
const resp = await page.goto(URL, { waitUntil: 'domcontentloaded' });
const info = await page.evaluate(() => ({ charset: document.characterSet, text: document.body.innerText }));
await browser.close();

const checks = [
  ['HTTP 200', resp?.status() === 200],
  ['响应头带 charset=utf-8', /charset=utf-8/i.test(resp?.headers()['content-type'] ?? '')],
  ['浏览器解码为 UTF-8', info.charset === 'UTF-8'],
  ['@name 中文正常', info.text.includes('网课学习助手 · B 站导入桥')],
  ['没有 GBK 乱码痕迹', !info.text.includes('缃戣')],
  ['元数据里有版本号', /@version\s+2\.\d/.test(info.text)],
];

let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? '   ✓' : '   ❌'} ${label}`);
  if (!ok) failed++;
}
console.log(
  failed
    ? `\n❌ 油猴脚本字符集回归失败（characterSet=${info.charset}，content-type=${resp?.headers()['content-type']}）`
    : '\n✅ 油猴脚本字符集正常',
);
process.exit(failed > 0 ? 1 : 0);
