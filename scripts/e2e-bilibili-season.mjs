// 真实合集元数据 + 隔离浏览器验证选集 UI，不下载视频、不使用账号 Cookie。
// 用法：node scripts/e2e-bilibili-season.mjs（先启动 npm run dev）
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const bvid = 'BV1Jft366E7W';
const response = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
  headers: { Referer: 'https://www.bilibili.com/', 'User-Agent': 'Mozilla/5.0' },
});
const metadata = await response.json();
assert.equal(metadata.code, 0);
const expected = metadata.data.ugc_season.sections.flatMap(s => s.episodes)
  .reduce((n, e) => n + (e.pages?.length || 1), 0);
assert.ok(expected > 1);

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  await page.addInitScript((data) => {
    window.__wangkeBiliBridge = {
      version: '2.1.1-test',
      async fetch(url) {
        if (url.includes('/x/player/playurl')) {
          const result = { code: 0, data: { dash: { duration: 120,
            video: [{ id: 32, height: 480, baseUrl: 'https://test.bilivideo.com/video.m4s' }],
            audio: [{ baseUrl: 'https://test.bilivideo.com/audio.m4s' }],
          } } };
          return { ok: true, status: 200, json: async () => result,
            text: async () => JSON.stringify(result), arrayBuffer: async () => new ArrayBuffer(0) };
        }
        if (url.includes('/audio.m4s')) return new Promise(() => {});
        if (url.includes('/video.m4s')) return { ok: true, status: 200,
          headers: { 'content-length': '1024' }, arrayBuffer: async () => new ArrayBuffer(1024) };
        if (!url.includes('/x/web-interface/view')) throw new Error('字幕请求未模拟');
        const text = JSON.stringify(data);
        return { ok: true, status: 200, json: async () => data, text: async () => text,
          arrayBuffer: async () => new TextEncoder().encode(text).buffer };
      },
    };
  }, metadata);
  await page.goto(`${process.env.BASE_URL || 'http://localhost:5173'}/#/library`);
  // 导入菜单入口与直接 B 站按钮均兼容。
  const direct = page.getByTestId('btn-bili-import');
  if (!(await direct.isVisible())) {
    await page.getByRole('button', { name: '导入资料', exact: true }).click();
  }
  await direct.click();
  await page.getByTestId('bili-url').fill(`https://www.bilibili.com/video/${bvid}/`);
  await page.getByTestId('bili-confirm').click();
  await page.getByTestId('bili-pages').waitFor();
  assert.match(await page.getByTestId('bili-subtitle-error').innerText(), /字幕读取失败/);
  await page.getByRole('button', { name: '重试读取字幕' }).click();
  await page.getByTestId('bili-subtitle-error').waitFor();
  assert.equal(await page.getByTestId('bili-page').count(), expected);
  assert.match(await page.getByTestId('bili-summary').innerText(), /已选 1/);
  await page.getByTestId('bili-pages-all').click();
  assert.match(await page.getByTestId('bili-summary').innerText(), new RegExp(`已选 ${expected}`));
  await page.getByTestId('bili-pages-none').click();
  assert.match(await page.getByTestId('bili-summary').innerText(), /已选 0/);
  await page.getByTestId('bili-page').nth(1).click();
  assert.match(await page.getByTestId('bili-summary').innerText(), /已选 1/);
  console.log(`通过：${bvid} 显示 ${expected} 个合集选项；默认选中当前集，全选、清空、单集选择正常。`);
  // 模拟视频流完成、音频流等待，不下载真实课程、不写入资料库。
  await page.getByTestId('bili-confirm').click();
  const progress = page.getByTestId('bili-progress');
  await page.waitForFunction(() => Number(document.querySelector('[data-testid="bili-progress"]')?.getAttribute('aria-valuenow')) > 0);
  const value = Number(await progress.getAttribute('aria-valuenow'));
  assert.ok(value > 0 && value < 100);
  assert.match(await page.getByTestId('bili-progress-value').innerText(), /\d+%/);
  const width = await page.getByTestId('bili-progress-fill').evaluate(el => el.getBoundingClientRect().width);
  assert.ok(width > 0, '进度条有可见的填充宽度');
  assert.match(await page.getByTestId('bili-label').innerText(), /第2集/);
  console.log(`通过：下载区域显示 ${value}% 和可见进度条，并保留当前集标题。`);
} finally {
  await browser.close();
}
