/* eslint-disable no-console */
// 探针：讨论区展开时的高度预算（视频栏 / 播放器 / 讨论区三者的几何关系）。
//
// 为什么单独一个脚本：这条链路的失效方式是**静默裁切** —— `.player-layout` 是
// `overflow:hidden`，展开后内容超了不会报错、也不会出滚动条，只是底部那块被切掉。
// 断言「没被裁」必须量到具体坐标，靠肉眼看截图在高分屏上很容易放过。
//
// 用法：
//   TEST_FILE=/path/to/video.mp4 node scripts/probe-comments-geometry.mjs
// 输出仅供人工参考（与其它 probe-* 一样，它退出码非 0 也会让整轮跑分变红，这是有意的）。
import { chromium } from 'playwright';

const TEST_FILE = process.env.TEST_FILE;
const BASE = process.env.BASE_URL ?? 'http://localhost:4173';
if (!TEST_FILE) {
  console.error('需要 TEST_FILE');
  process.exit(1);
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.setInputFiles('input[type="file"]', TEST_FILE);
await page.waitForSelector('[data-testid="video-item"]', { timeout: 30000 });
const id = await page.evaluate(async () => {
  const db = await new Promise((res, rej) => {
    const q = indexedDB.open('wangke');
    q.onsuccess = () => res(q.result);
    q.onerror = rej;
  });
  const all = await new Promise((res, rej) => {
    const q = db.transaction('videos', 'readonly').objectStore('videos').getAll();
    q.onsuccess = () => res(q.result);
    q.onerror = rej;
  });
  return all[all.length - 1].id;
});

// 播种 9 条发言（两串嵌套）：讨论区必须足够长，才能验到「左栏整体滚动」而不是内容刚好装下。
await page.evaluate(async (vid) => {
  const db = await new Promise((res, rej) => {
    const q = indexedDB.open('wangke');
    q.onsuccess = () => res(q.result);
    q.onerror = rej;
  });
  const tx = db.transaction(['segments', 'comments'], 'readwrite');
  const segs = tx.objectStore('segments');
  for (let i = 0; i < 4; i++) {
    segs.add({ videoId: vid, idx: i, start: i * 10, end: i * 10 + 8, text: `字幕 ${i}`, status: 1 });
  }
  const c = tx.objectStore('comments');
  for (let i = 1; i <= 9; i++) {
    c.add({
      id: i,
      videoId: vid,
      time: 10 * i,
      author: i % 2 ? '小林' : '阿哲',
      role: i % 2 ? 'ask' : 'answer',
      text: `第 ${i} 条发言，用来把讨论区撑长，好验高度预算是否真的生效。`,
      parentId: i > 5 ? i - 5 : undefined,
      createdAt: i,
    });
  }
  await new Promise((res, rej) => {
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
  db.close();
}, id);

await page.goto(`${BASE}/#/player/${id}`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="comments-toggle"]', { timeout: 15000 });
await page.waitForSelector('[data-media-player]', { timeout: 15000 });
await page.waitForTimeout(600);

let bad = 0;
const measure = async (label) => {
  const m = await page.evaluate(() => {
    const r = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height) };
    };
    const pane = document.querySelector('.video-pane');
    const body = document.querySelector('[data-testid="comments-list"]');
    return {
      vh: window.innerHeight,
      pane: r('.video-pane'),
      paneOverflow: pane ? pane.scrollHeight > pane.clientHeight + 1 : false,
      paneOverflowY: pane ? getComputedStyle(pane).overflowY : null,
      player: r('[data-media-player]'),
      block: r('[data-testid="comments"]'),
      body: r('[data-testid="comments-list"]'),
      bodyOverflowY: body ? getComputedStyle(body).overflowY : null,
      pageScroll: document.scrollingElement.scrollHeight > window.innerHeight + 2,
    };
  });
  console.log(`\n[${label}] ${JSON.stringify(m)}`);
  if (label.includes('展开')) {
    if (!m.paneOverflow || m.paneOverflowY !== 'auto') {
      console.error(`  ❌ ${label}：左栏没有形成整体滚动容器`);
      bad++;
    }
    if (m.bodyOverflowY !== 'visible') {
      console.error(`  ❌ ${label}：评论列表仍是独立滚动区`);
      bad++;
    }
  }
  if (m.pageScroll) {
    console.error(`  ❌ ${label}：整页被撑出了滚动条`);
    bad++;
  }
};

for (const [w, h] of [
  [1280, 800],
  [1280, 900],
  [1280, 560],
  [1600, 1000],
  [900, 700],
]) {
  await page.setViewportSize({ width: w, height: h });
  await page.waitForTimeout(250);
  await measure(`${w}x${h} 折叠`);
  if (!(await page.locator('[data-testid="comments-list"]').count())) {
    await page.click('[data-testid="comments-toggle"]');
  }
  await page.waitForSelector('[data-testid="comments-list"]', { timeout: 8000 });
  await page.waitForTimeout(250);
  await measure(`${w}x${h} 展开`);
  await page.click('[data-testid="comments-toggle"]');
  await page.waitForSelector('[data-testid="comments-list"]', { state: 'detached', timeout: 8000 });
}

await browser.close();
console.log(bad === 0 ? '\n几何全部符合预期' : `\n${bad} 处不符`);
process.exit(bad === 0 ? 0 : 1);
