// BASE_URL=http://localhost:5173 TEST_FILE=/path/to/video.mp4 node scripts/e2e-shortcuts.mjs
// 使用独立浏览器上下文，不修改用户数据。播放器部分需要不少于 8 秒的测试视频。
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const base = process.env.BASE_URL || 'http://localhost:5173';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const byId = (id) => page.getByTestId(id);
const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('wangke-settings')).state.shortcuts);
const record = async (id, key) => { await byId(`shortcut-${id}`).focus(); await page.keyboard.press(key); };

try {
  await page.goto(`${base}/#/settings/shortcuts`);
  await byId('card-shortcut-bindings').waitFor();
  await record('togglePaused', 'm');
  assert.match(await page.getByRole('alert').innerText(), /已用于/);
  await record('togglePaused', 'p');
  assert.equal((await stored()).bindings.togglePaused, 'p');
  await page.getByRole('button', { name: '清除静音 / 取消静音快捷键', exact: true }).click();
  assert.equal((await stored()).bindings.toggleMuted, '');
  await byId('shortcut-step-arrowSeek').fill('2');
  await byId('shortcut-step-keySeek').fill('3');
  await byId('shortcut-step-keySeek').blur();
  await page.reload();
  await byId('card-shortcut-bindings').waitFor();
  assert.equal(await byId('shortcut-togglePaused').inputValue(), 'p');
  assert.equal(await byId('shortcut-step-arrowSeek').inputValue(), '2');
  await record('togglePaused', 'Escape');
  assert.equal(await byId('settings-modal').isVisible(), true, 'Esc 取消录入而不关闭设置');
  await page.setViewportSize({ width: 390, height: 844 });
  await byId('card-shortcut-bindings').waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await byId('card-shortcut-bindings').waitFor();
  console.log('✓ 设置入口、按键录入、冲突、清除、步长、持久化、Esc 和移动端布局');

  if (process.env.TEST_FILE) {
    await page.getByRole('button', { name: '关闭设置', exact: true }).click();
    const file = (await readFile(process.env.TEST_FILE)).toString('base64');
    await page.evaluate(async (file) => {
      const { db } = await import('/src/store/db.ts');
      const { saveVideoFile } = await import('/src/store/fileStore.ts');
      const blob = new Blob([Uint8Array.from(atob(file), (c) => c.charCodeAt(0))], { type: 'video/mp4' });
      await saveVideoFile('shortcut-test', blob);
      await db.videos.put({ id: 'shortcut-test', name: '快捷键测试', mimeType: 'video/mp4', size: blob.size, createdAt: Date.now() });
    }, file);
    await page.goto(`${base}/#/player/shortcut-test`);
    await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2);
    const player = page.locator('[data-media-player]');
    await player.focus();
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => Math.abs(document.querySelector('video').currentTime - 2) < .1);
    await page.keyboard.press('l');
    await page.waitForFunction(() => Math.abs(document.querySelector('video').currentTime - 5) < .1);
    await page.keyboard.press('p');
    await page.waitForFunction(() => !document.querySelector('video').paused);
    await page.keyboard.press('p');
    await page.waitForFunction(() => document.querySelector('video').paused);
    await page.keyboard.press('k');
    assert.equal(await page.locator('[data-media-provider] video').evaluate((v) => v.paused), true, '旧绑定失效');
    await page.keyboard.press('.');
    await page.waitForFunction(() => document.querySelector('video').currentTime > 5.02);
    await byId('nav-rail-settings').click();
    await byId('settings-nav-shortcuts').click();
    await byId('shortcuts-enabled').click();
    await page.getByRole('button', { name: '关闭设置', exact: true }).click();
    await player.focus();
    await page.keyboard.press('p');
    assert.equal(await page.locator('[data-media-provider] video').evaluate((v) => v.paused), true, '总开关停用快捷键');
    await byId('nav-rail-settings').click();
    await byId('settings-nav-shortcuts').click();
    await byId('shortcuts-reset').click();
    assert.equal((await stored()).bindings.togglePaused, 'k Space');
    await page.getByRole('button', { name: '关闭设置', exact: true }).click();
    await player.focus();
    await page.keyboard.press('k');
    await page.waitForFunction(() => !document.querySelector('video').paused);
    console.log('✓ 实际播放器：动态绑定、旧键失效、两档跳转、逐帧、总开关、恢复默认');
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
