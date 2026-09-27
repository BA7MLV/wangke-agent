/* eslint-disable no-console */
// 播放页交互语义回归：真实键盘导航、焦点可见、讨论 disclosure、触屏目标。
// 用法：BASE_URL=http://localhost:4173 TEST_FILE=/path/to/video.mp4 node scripts/probe-player-semantics.mjs
// 复用本地导入链路和自播种讨论，不调用模型 API。
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL ?? 'http://localhost:4173';
const TEST_FILE = process.env.TEST_FILE;
if (!TEST_FILE) throw new Error('需要 TEST_FILE=/path/to/video.mp4');

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.setInputFiles('input[type="file"]', TEST_FILE);
  await page.waitForSelector('[data-testid="video-item"]');
  await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('wangke');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const videos = await new Promise((resolve, reject) => {
      const request = db.transaction('videos').objectStore('videos').getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const videoId = videos[0].id;
    const tx = db.transaction(['segments', 'comments', 'cards'], 'readwrite');
    tx.objectStore('segments').add({ videoId, idx: 0, start: 0, end: 8, text: '回归检查字幕', status: 1 });
    tx.objectStore('comments').add({ videoId, time: 1, author: '学习者', role: 'ask', text: '这个概念如何理解？', createdAt: 1 });
    tx.objectStore('cards').add({ videoId, q: '已保留卡片的概念是什么？', a: '测试答案', time: 2, status: 1, createdAt: 1 });
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
  await page.locator('[data-testid="btn-play"]').first().click();
  await page.waitForSelector('[data-media-player]');

  const selectedTab = () => page.locator('mdui-tab[aria-selected="true"]');
  const expectPanel = async (key) => {
    await page.waitForFunction((value) => document.querySelector('mdui-tab-panel[active]')?.getAttribute('value') === value, key);
    assert.equal(await selectedTab().getAttribute('value'), key, '读屏选中状态应与可见面板一致');
    assert.equal(await page.locator('mdui-tab[tabindex="0"]').count(), 1, '面板切换只有一个 Tab 停靠点');
    const tabId = await selectedTab().getAttribute('id');
    const panelId = await selectedTab().getAttribute('aria-controls');
    assert.equal(await page.locator('mdui-tab-panel[active]').getAttribute('id'), panelId);
    assert.equal(await page.locator('mdui-tab-panel[active]').getAttribute('aria-labelledby'), tabId);
  };
  await expectPanel('subs');
  await selectedTab().focus();
  await page.keyboard.press('ArrowRight');
  await expectPanel('handout');
  await page.keyboard.press('End');
  await expectPanel('cards');
  const cardSeek = page.getByRole('button', { name: '跳到视频 0:02', exact: true });
  await cardSeek.waitFor();
  await page.waitForFunction(() => document.querySelector('video')?.readyState >= 1);
  await cardSeek.press('Enter');
  await page.waitForFunction(() => {
    const time = document.querySelector('video')?.currentTime;
    return time >= 2 && time < 3;
  });
  await selectedTab().focus();
  await page.keyboard.press('Home');
  await expectPanel('subs');
  console.log('✓ 面板方向键 / Home / End、选中状态与 ARIA 关联一致');

  const toggle = page.locator('[data-testid="comments-toggle"]');
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  await toggle.click();
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  const panelId = await toggle.getAttribute('aria-controls');
  assert.equal(await page.locator('.comments-panel').getAttribute('id'), panelId);
  assert.equal(await page.locator('.comments-panel').getAttribute('aria-labelledby'), await toggle.getAttribute('id'));
  await page.getByText('AI 生成的学习讨论，供复习参考。', { exact: true }).waitFor();
  assert.equal(await page.locator('[data-testid="comments-sort-hot"]').getAttribute('aria-pressed'), 'true');
  await page.locator('[data-testid="comments-sort-progress"]').click();
  assert.equal(await page.locator('[data-testid="comments-sort-progress"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('[data-testid="comments-sort-hot"]').getAttribute('aria-pressed'), 'false');
  assert.equal(await page.locator('.comments-sort').getByRole('button', { pressed: true }).count(), 1);
  assert.match(await page.locator('[data-testid="cmt-time"]').first().getAttribute('aria-label'), /^跳到视频 /);
  await toggle.click();
  console.log('✓ 讨论展开、排序状态、时间戳动作和 AI 来源明确');

  // Start with the controls shown, then model keyboard focus. This mirrors a
  // user moving into the player and pressing Tab; subsequent mouse movement
  // away verifies that focus keeps the controls available.
  const mediaBox = await page.locator('[data-media-player]').boundingBox();
  assert(mediaBox, '播放器应有可交互区域');
  await page.mouse.move(mediaBox.x + mediaBox.width / 2, mediaBox.y + mediaBox.height / 2);
  await page.waitForTimeout(300);
  await page.locator('[data-media-player]').evaluate((element) => {
    element.focus({ focusVisible: true });
  });
  await page.waitForFunction(() => {
    const style = getComputedStyle(document.querySelector('.vds-controls'));
    return style.visibility === 'visible' && Number(style.opacity) > 0.9;
  });
  let reachedControls = false;
  for (let step = 0; step < 12; step += 1) {
    await page.keyboard.press('Tab');
    reachedControls = await page.evaluate(() => Boolean(document.activeElement?.closest('.vds-controls')));
    if (reachedControls) break;
  }
  assert.equal(reachedControls, true, '键盘必须能从播放器进入实际控制栏');
  assert.equal(await page.locator('.vds-controls').evaluate((element) => getComputedStyle(element).visibility), 'visible');
  await page.mouse.move(8, 8);
  await page.waitForTimeout(350);
  assert.equal(await page.locator('.vds-controls').evaluate((element) => getComputedStyle(element).visibility), 'visible', '鼠标移出后焦点仍保持控制栏可见');
  assert.equal(await page.locator('[data-media-player]').evaluate((element) => getComputedStyle(element).borderTopLeftRadius), '0px');
  console.log('✓ 鼠标在外时键盘可进入播放器控件，播放器保持指定直角');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.panel-slot:not([hidden])').waitFor();
  assert.equal(await page.locator('.panel-slot:not([hidden])').getAttribute('aria-label'), '字幕');
  assert.ok((await toggle.boundingBox()).height >= 48, '讨论折叠条应达到 48px');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, '窄屏不能横向溢出');
  console.log('✓ 窄屏面板名称、48px 折叠目标与页面宽度通过');
} finally {
  await browser.close();
}
