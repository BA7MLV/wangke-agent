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
  assert.equal(await page.getByTestId('bili-page').count(), expected);
  assert.match(await page.getByTestId('bili-summary').innerText(), /已选 1/);
  await page.getByTestId('bili-pages-all').click();
  assert.match(await page.getByTestId('bili-summary').innerText(), new RegExp(`已选 ${expected}`));
  await page.getByTestId('bili-pages-none').click();
  assert.match(await page.getByTestId('bili-summary').innerText(), /已选 0/);
  await page.getByTestId('bili-page').nth(1).click();
  assert.match(await page.getByTestId('bili-summary').innerText(), /已选 1/);
  console.log(`通过：${bvid} 显示 ${expected} 个合集选项；默认选中当前集，全选、清空、单集选择正常。`);
} finally {
  await browser.close();
}
