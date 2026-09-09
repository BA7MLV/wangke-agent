/* eslint-disable no-console */
// 讲义预览字体验证（无需 API key）：种子数据（fixture DOCX）→ 真实 HandoutPanel 渲染，
// 断言 @font-face 兜底生效（local 链 / woff2 分包下载两条路径）+ 截图人工确认。
// 用法：npm run dev &（5173）→ node scripts/e2e-preview-fonts.mjs
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

// 1. 生成 fixture DOCX（兼跑 XML 断言）
if (!existsSync('scripts/out/handout-fixture.docx')) {
  execSync(
    'node_modules/.bin/esbuild scripts/render-handout-fixture.mjs --bundle --platform=node --format=esm --packages=external --outfile=scripts/.cache/render-handout-fixture.mjs',
    { stdio: 'inherit' },
  );
}
execSync('node scripts/.cache/render-handout-fixture.mjs', { stdio: 'inherit' });

// 2. dev server 前置检查
try {
  await fetch('http://localhost:5173');
} catch {
  console.error('dev server 未启动，请先 npm run dev');
  process.exit(1);
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });

const woff2Requests = [];
page.on('request', (r) => { if (r.url().endsWith('.woff2')) woff2Requests.push(r.url()); });

let failed = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '  ok' : '  FAIL'} - ${name}${detail ? `（${detail}）` : ''}`);
  if (!cond) failed++;
};

// 3. 进 app 种子数据：一条 fileDeleted 视频 + 一条 fixture 讲义
await page.goto('http://localhost:5173', { waitUntil: 'domcontentloaded' });
await page.evaluate(async () => {
  const { db } = await import('/src/store/db.ts');
  const blob = await (await fetch('/scripts/out/handout-fixture.docx')).blob();
  await db.videos.put({
    id: 'e2e-font-demo', name: '字体预览验证课', size: 0, mimeType: 'video/mp4',
    duration: 0, createdAt: Date.now(), status: 'transcribed', fileDeleted: 1,
  });
  await db.handouts.put({
    videoId: 'e2e-font-demo', createdAt: Date.now(),
    title: 'Hook 执行时机学习讲义', blob, outlineJson: '{}',
  });
});
console.log('1. 种子数据写入 OK');

// 4. 打开播放页 → 讲义 Tab → 等预览渲染
await page.goto('http://localhost:5173/#/player/e2e-font-demo', { waitUntil: 'domcontentloaded' });
await page.click('.ant-tabs-tab:has-text("讲义")');
await page.waitForSelector('.docx-preview-container section.docx', { timeout: 20000 });
console.log('2. 讲义预览渲染 OK');

// 5. 字体断言
const fonts = await page.evaluate(async () => {
  const load = async (family, text) => {
    try {
      const faces = await document.fonts.load(`16px '${family}'`, text);
      return faces.length > 0 && document.fonts.check(`16px '${family}'`, text[0]);
    } catch {
      return false; // 所有 src 失败（local 全未命中且无网络兜底）load 会 reject
    }
  };
  const out = {
    fangsong: await load('仿宋_GB2312', '学习讲义执行时机'),
    kaiti: await load('楷体_GB2312', '注意'),
    heiti: await load('黑体', '标题'),
    songti: await load('宋体', '页眉'),
  };

  // woff2 下载路径验证：复制一份 CSS，改掉字体名并剥掉 local()，强制走网络分包
  // （注意内联 <style> 里相对 url 会按文档路径解析，需改绝对路径）
  const css = await (await fetch('/fonts/zhuque-fangsong/index.css')).text();
  const st = document.createElement('style');
  st.textContent = css
    .replaceAll("font-family: '仿宋_GB2312'", "font-family: '仿宋_GB2312-nolocal'")
    .replace(/local\('[^']*'\),\s*/g, '')
    .replaceAll("url('", "url('/fonts/zhuque-fangsong/");
  document.head.append(st);
  out.nolocal = await load('仿宋_GB2312-nolocal', '学习讲义');

  // 渲染内容里应存在 font-family 含仿宋_GB2312 的元素（docx-preview 把字体名设在 run 级 span 上）
  out.paraFont = [...document.querySelectorAll('.docx-preview-container section.docx *')]
    .map((el) => getComputedStyle(el).fontFamily)
    .find((f) => f.includes('仿宋')) ?? '';
  return out;
});

check('仿宋_GB2312 可用（local 或分包）', fonts.fangsong);
check('楷体_GB2312 可用（local 别名）', fonts.kaiti);
check('黑体 可用（local 别名）', fonts.heiti);
check('宋体 可用（local 别名）', fonts.songti);
check('woff2 分包下载路径可用', fonts.nolocal && woff2Requests.length > 0, `${woff2Requests.length} 个分包请求`);
check('正文段落 font-family 含仿宋_GB2312', fonts.paraFont.includes('仿宋_GB2312'), fonts.paraFont);

// 6. 截图人工确认（公文味：正文仿宋、标题黑体、小节楷体）
await page.screenshot({ path: 'e2e-shots/handout-preview-fonts.png', fullPage: false });
console.log('3. 截图 → e2e-shots/handout-preview-fonts.png');

if (errors.length) console.log(`[console errors]\n${errors.join('\n')}`);
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
