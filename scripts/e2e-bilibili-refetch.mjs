// BASE_URL=http://127.0.0.1:5186 node scripts/e2e-bilibili-refetch.mjs
// 桩接口验证补拉交互，不依赖 B 站网络，也不下载视频或调用 ASR。
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { build } from 'esbuild';

const bundled = await build({ entryPoints: ['src/bilibili/wire.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { encodeMessage, fieldBytes, utf8 } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const message = encodeMessage([fieldBytes(3, encodeMessage(['ai-zh', 'ai-en'].map(lan => fieldBytes(3, encodeMessage([
  fieldBytes(3, utf8(lan)), fieldBytes(4, utf8(lan)), fieldBytes(5, utf8(`https://aisubtitle.hdslb.com/${lan}`)),
])))))]);
const frame = new Uint8Array(message.length + 5);
new DataView(frame.buffer).setUint32(1, message.length, false);
frame.set(message, 5);

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(process.env.BASE_URL || 'http://127.0.0.1:5186');
  await page.evaluate(async (frame) => {
    const { db } = await import('/src/store/db.ts');
    await db.videos.bulkPut([
      { id: 'bili-refetch', name: 'B站字幕补拉测试', status: 'new', size: 0, duration: 10, mimeType: 'video/mp4', createdAt: Date.now(), fileDeleted: 1, coverState: 'skipped',
        biliSource: { bvid: 'BV1GJ411x7h7', aid: 101, cid: 202, page: 2 } },
      { id: 'local-refetch', name: '本地视频', status: 'new', size: 0, duration: 10, mimeType: 'video/mp4', createdAt: Date.now(), fileDeleted: 1, coverState: 'skipped' },
    ]);
    window.__biliTestMode = 'success';
    window.__biliTestCalls = [];
    window.__wangkeBiliBridge = {
      version: '2.1.1',
      async fetch(url) {
        window.__biliTestCalls.push(url);
        await new Promise(resolve => setTimeout(resolve, 100));
        const list = url.includes('/DmView');
        const mode = window.__biliTestMode;
        const status = mode === 'error' ? 503 : 200;
        const bytes = url.includes('/x/web-interface/view')
          ? new TextEncoder().encode(JSON.stringify({ code: 0, data: { aid: 101, title: '视频', pages: [{ page: 1, cid: 201 }, { page: 2, cid: 202 }] } }))
          : list
          ? mode === 'empty' ? new Uint8Array(5) : new Uint8Array(frame)
          : new TextEncoder().encode(JSON.stringify({ body: [{ from: 1, to: 3, content: url.endsWith('ai-zh') ? 'B站原始字幕' : 'Original English subtitles' }] }));
        return { ok: status === 200, status, arrayBuffer: async () => bytes.buffer,
          text: async () => new TextDecoder().decode(bytes), json: async () => JSON.parse(new TextDecoder().decode(bytes)) };
      },
    };
    location.hash = '#/player/bili-refetch';
  }, [...frame]);
  await page.getByTestId('study-assistant-toggle').click();
  const fetchButton = page.getByTestId('subs-fetch-bili');
  await fetchButton.waitFor({ state: 'visible' });
  await fetchButton.click();
  assert.equal(await page.getByTestId('subs-generate').isDisabled(), true);
  await page.getByTestId('subs-row').filter({ hasText: 'B站原始字幕' }).waitFor();
  assert.equal(await page.evaluate(async () => {
    const { db } = await import('/src/store/db.ts');
    return db.subtitleTracks.where('videoId').equals('bili-refetch').count();
  }), 2);
  console.log('✓ 补拉自带字幕成功、对照轨落库、拉取期间禁止并发转写');

  const callCount = await page.evaluate(() => window.__biliTestCalls.length);
  await fetchButton.click();
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__biliTestCalls.length), callCount);
  console.log('✓ 已有字幕需要确认，取消不发送请求');

  for (const mode of ['empty', 'error']) {
    await page.evaluate(mode => { window.__biliTestMode = mode; }, mode);
    await fetchButton.click();
    await page.getByRole('button', { name: '拉取并替换', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="subs-fetch-bili"]').disabled);
    assert.equal(await page.getByTestId('subs-row').filter({ hasText: 'B站原始字幕' }).count(), 1);
    if (mode === 'error') await page.getByTestId('persistent-error').filter({ hasText: 'B 站字幕拉取失败' }).waitFor();
  }
  console.log('✓ 没有字幕或接口失败不会覆盖现有字幕，错误可见');

  await page.evaluate(() => { location.hash = '#/player/local-refetch'; });
  await page.getByTestId('study-assistant-toggle').click();
  await page.getByTestId('panel-subs').waitFor({ state: 'visible' });
  assert.match(await fetchButton.innerText(), /从 B 站链接拉取字幕/);
  await page.evaluate(() => { window.__biliTestMode = 'success'; });
  await fetchButton.click();
  await page.getByTestId('prompt-dialog-input').fill('https://www.bilibili.com/video/BV1GJ411x7h7?p=2');
  await page.getByTestId('prompt-dialog-confirm').click();
  await page.getByTestId('subs-row').filter({ hasText: 'B站原始字幕' }).waitFor();
  assert.equal(await page.evaluate(async () => {
    const { db } = await import('/src/store/db.ts');
    return (await db.videos.get('local-refetch')).biliSource.cid;
  }), 202);
  assert.match(await fetchButton.innerText(), /拉取 B 站字幕/);
  assert.deepEqual(errors, []);
  console.log('✓ 旧视频可补填链接，只拉指定分 P 的字幕并保存来源，无页面异常');
} finally {
  await browser.close();
}
