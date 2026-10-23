// BASE_URL=http://localhost:5173 TEST_FILE=/path/to/60-second-video.mp4 node scripts/e2e-player-enhance.mjs
// 在独立浏览器上下文播种测试资料，不修改用户数据；需 Vite dev server。
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

if (!process.env.TEST_FILE) throw new Error('需要 TEST_FILE（至少 60 秒）');
const base = process.env.BASE_URL || 'http://localhost:5173';
const file = (await readFile(process.env.TEST_FILE)).toString('base64');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const mainVideo = (p = page) => p.locator('[data-media-provider] video');
const player = page.locator('[data-media-player]');
let mobilePage;

async function seed(p) {
  await p.goto(`${base}/#/library`);
  await p.evaluate(async (file) => {
    const { db } = await import('/src/store/db.ts');
    const { saveVideoFile } = await import('/src/store/fileStore.ts');
    const { useSettings } = await import('/src/store/settings.ts');
    const blob = new Blob([Uint8Array.from(atob(file), (c) => c.charCodeAt(0))], { type: 'video/mp4' });
    await saveVideoFile('bili-player-test', blob);
    await db.videos.put({ id: 'bili-player-test', name: '播放器交互测试', mimeType: 'video/mp4', size: blob.size, createdAt: Date.now() });
    useSettings.getState().update({ customRates: [1.1, 2.5] });
  }, file);
  await p.goto(`${base}/#/player/bili-player-test`);
  // Vite 热更新可能为 settings 模块追加时间戳；刷新让应用从持久化配置重新装载。
  await p.reload();
  await p.waitForFunction(() => document.querySelector('[data-media-provider] video')?.readyState >= 2);
}

const state = () => mainVideo().evaluate((v) => ({ time: v.currentTime, rate: v.playbackRate, paused: v.paused, volume: v.volume, muted: v.muted }));
const waitRate = (rate) => page.waitForFunction((rate) => document.querySelector('[data-media-provider] video')?.playbackRate === rate, rate);
const seek = async (time) => {
  await mainVideo().evaluate((v, time) => { v.currentTime = time; }, time);
  await page.waitForFunction((time) => Math.abs(document.querySelector('[data-media-provider] video').currentTime - time) < .1, time);
};
const wake = async () => {
  const box = await player.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
};

try {
  await mkdir('e2e-shots', { recursive: true });
  await seed(page);
  await wake();
  assert.ok((await state()).paused);
  assert.equal(await page.getByTestId('player-big-play').isVisible(), true);
  const box = await player.boundingBox();
  const speedBox = await page.locator('.player-speed-trigger').boundingBox();
  assert.ok(speedBox.y > box.y + box.height * .8, '倍速入口位于底栏');
  await page.locator('.player-speed-trigger').hover();
  await page.locator('.player-speed-options').waitFor({ state: 'visible' });
  await page.locator('.player-speed-option').filter({ hasText: '1.25x' }).click();
  await waitRate(1.25);
  await page.locator('.player-speed-options').waitFor({ state: 'hidden' });
  await page.locator('.player-speed-trigger').hover();
  await page.locator('.player-speed-options').waitFor({ state: 'visible' });
  await page.locator('.player-speed-option').filter({ hasText: '2.5x' }).click();
  await waitRate(2.5);
  await wake();
  await page.locator('.player-speed-trigger').focus();
  await page.keyboard.press('Enter');
  await page.locator('.player-speed-options').waitFor({ state: 'visible' });
  assert.match(await page.locator('.player-speed-option[data-checked]').innerText(), /2\.5x/);
  await page.keyboard.press('Escape');
  await page.locator('.player-speed-options').waitFor({ state: 'hidden' });
  console.log('✓ 底栏、右下角暂停标记、悬停倍速菜单、自定义档位');

  await player.getByRole('button', { name: '设置', exact: true }).click();
  await page.locator('.player-caption-size').click();
  assert.equal(await page.locator('.video-pane').evaluate((el) => el.style.getPropertyValue('--media-user-font-size')), '1.35');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('wangke-settings')).state.captionScale), 1.35);
  await page.keyboard.press('Escape');
  console.log('✓ 设置菜单中的字幕字号与持久化');

  await seek(10);
  await player.focus();
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => Math.abs(document.querySelector('[data-media-provider] video').currentTime - 15) < .1);
  await page.locator('.player-feedback[data-active]').waitFor({ state: 'visible' });
  assert.match(await page.locator('.player-feedback').innerText(), /快进 5/);
  await page.keyboard.press('ArrowLeft');
  await page.waitForFunction(() => Math.abs(document.querySelector('[data-media-provider] video').currentTime - 10) < .1);
  await page.keyboard.press('Space');
  await page.waitForFunction(() => !document.querySelector('[data-media-provider] video').paused);
  const beforeBoost = await state();
  await page.keyboard.down('ArrowRight');
  await waitRate(3);
  await page.locator('.player-feedback[data-boost]').waitFor({ state: 'visible' });
  await page.keyboard.up('ArrowRight');
  await waitRate(2.5);
  assert.ok((await state()).time - beforeBoost.time < 4, '长按不再叠加快进');
  await page.keyboard.down('ArrowRight');
  await waitRate(3);
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.querySelector('[data-media-provider] video').paused);
  await waitRate(2.5);
  await page.keyboard.up('ArrowRight');
  await page.keyboard.press('Space');
  await page.waitForFunction(() => !document.querySelector('[data-media-provider] video').paused);
  await page.keyboard.down('ArrowRight');
  await waitRate(3);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await waitRate(2.5);
  await page.keyboard.up('ArrowRight');
  await page.keyboard.press('Shift+Digit2');
  await waitRate(2);
  await page.keyboard.press('Shift+Digit1');
  await waitRate(1);
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.querySelector('[data-media-provider] video').paused);
  console.log('✓ 短按快进 / 快退、长按 3x、松开 / 窗口失焦恢复、Shift+1/2');

  await mainVideo().evaluate((v) => { v.volume = .5; });
  await page.keyboard.press('ArrowUp');
  await page.waitForFunction(() => document.querySelector('[data-media-provider] video').volume === .6);
  await page.keyboard.press('ArrowDown');
  await page.waitForFunction(() => document.querySelector('[data-media-provider] video').volume === .5);
  await page.keyboard.press('m');
  await page.waitForFunction(() => document.querySelector('[data-media-provider] video').muted);
  await page.keyboard.press('m');
  await page.waitForFunction(() => !document.querySelector('[data-media-provider] video').muted);
  await page.keyboard.press('d');
  await page.waitForFunction(() => document.querySelector('.player-dm-toggle')?.getAttribute('aria-pressed') === 'false');
  await page.keyboard.press('d');
  await page.waitForFunction(() => document.querySelector('.player-dm-toggle')?.getAttribute('aria-pressed') === 'true');
  await page.keyboard.press('t');
  await page.locator('.player-layout--theater').waitFor();
  await page.keyboard.press('t');
  await page.locator('.player-layout--theater').waitFor({ state: 'detached' });
  console.log('✓ 音量 10% 步长、静音、弹幕与宽屏快捷键');

  await page.keyboard.press('w');
  await page.locator('.player-web-fullscreen').waitFor();
  const fullBox = await player.boundingBox();
  assert.ok(fullBox.x <= 1 && fullBox.y <= 1 && fullBox.width >= 1438 && fullBox.height >= 998, JSON.stringify(fullBox));
  assert.equal(await page.evaluate(() => document.body.style.overflow), 'hidden');
  await player.locator('.vds-fullscreen-button').focus();
  await page.keyboard.press('Tab');
  assert.equal(await page.getByTestId('player-big-play').evaluate((el) => el === document.activeElement), true, '网页全屏 Tab 循环');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await player.locator('.vds-fullscreen-button').evaluate((el) => el === document.activeElement), true);
  await page.getByRole('button', { name: '播放器快捷键', exact: true }).click();
  await page.locator('.player-shortcuts-content').waitFor({ state: 'visible' });
  assert.match(await page.locator('.player-shortcuts-content').innerText(), /Shift \+ 1/);
  await page.keyboard.press('Escape');
  await page.locator('.player-shortcuts-content').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.player-web-fullscreen').count(), 1, 'Esc 优先关闭菜单');
  await page.keyboard.press('Escape');
  await page.locator('.player-web-fullscreen').waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => document.body.style.overflow), '');
  await player.focus();
  await page.keyboard.press('f');
  await page.waitForFunction(() => !!document.fullscreenElement);
  await page.keyboard.press('w');
  await page.waitForFunction(() => !document.fullscreenElement && !!document.querySelector('.player-web-fullscreen'));
  await page.keyboard.press('f');
  await page.waitForFunction(() => !!document.fullscreenElement && !document.querySelector('.player-web-fullscreen'));
  await page.evaluate(() => document.exitFullscreen());
  console.log('✓ 网页全屏尺寸、滚动锁定、快捷键说明、Esc 分层退出');

  await player.evaluate((el) => {
    const input = document.createElement('input');
    input.id = 'test-player-input';
    input.style.cssText = 'position:absolute;top:40%;left:20%;z-index:100';
    el.append(input);
  });
  await page.locator('#test-player-input').focus();
  const beforeTyping = await state();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('d');
  await page.keyboard.press('w');
  assert.equal((await state()).paused, beforeTyping.paused);
  assert.equal((await state()).time, beforeTyping.time);
  assert.equal(await page.locator('.player-web-fullscreen').count(), 0);
  await page.locator('#test-player-input').evaluate((el) => el.remove());
  await player.focus();
  await player.dispatchEvent('keydown', { key: ' ', code: 'Space', isComposing: true });
  assert.equal((await state()).paused, true, '输入法候选字不触发播放');
  console.log('✓ 输入框与输入法不误触播放器快捷键');

  await wake();
  const beforeDoubleClick = await state();
  const normalBox = await player.boundingBox();
  await page.mouse.dblclick(normalBox.x + normalBox.width * .1, normalBox.y + normalBox.height * .4);
  await page.waitForFunction(() => !!document.fullscreenElement);
  assert.ok(Math.abs((await state()).time - beforeDoubleClick.time) < .2, '桌面双击左侧也应全屏而不是快退');
  await page.evaluate(() => document.exitFullscreen());
  await wake();
  await page.screenshot({ path: 'e2e-shots/player-bilibili-desktop.png' });
  console.log('✓ 桌面双击任意区域切全屏、不误跳转');

  await player.focus();
  await page.keyboard.press('Space');
  await page.waitForFunction(() => !document.querySelector('[data-media-provider] video').paused);
  await page.locator('[data-testid="nav-back"]').hover();
  await page.waitForFunction(() => !document.querySelector('.vds-controls')?.hasAttribute('data-visible'));
  await wake();
  await page.waitForFunction(() => document.querySelector('.vds-controls')?.hasAttribute('data-visible'));
  await page.waitForFunction(() => !document.querySelector('.vds-controls')?.hasAttribute('data-visible'), undefined, { timeout: 6000 });
  console.log('✓ 鼠标唤醒控制栏、静止自动收起');

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  mobilePage = await mobile.newPage();
  mobilePage.on('pageerror', (error) => errors.push(error.message));
  await seed(mobilePage);
  await mobilePage.locator('[data-media-player] .vds-video-layout[data-sm]').waitFor({ state: 'attached' });
  assert.equal(await mobilePage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await mobilePage.getByTestId('player-big-play').isVisible(), false, '小屏不叠加第二个播放键');
  await mobilePage.locator('.player-speed-trigger').tap();
  await mobilePage.locator('.player-speed-option').filter({ hasText: '1.25x' }).tap();
  await mobilePage.waitForFunction(() => document.querySelector('[data-media-provider] video').playbackRate === 1.25);
  await mainVideo(mobilePage).evaluate((v) => { v.currentTime = 20; });
  await mobilePage.waitForFunction(() => Array.from(document.querySelectorAll('.vds-time')).some((el) => el.textContent === '0:20'));
  const mobileBox = await mobilePage.locator('[data-media-player]').boundingBox();
  const doubleTap = async (fraction) => {
    await mobilePage.touchscreen.tap(mobileBox.x + mobileBox.width * fraction, mobileBox.y + mobileBox.height * .4);
    await mobilePage.touchscreen.tap(mobileBox.x + mobileBox.width * fraction, mobileBox.y + mobileBox.height * .4);
  };
  await doubleTap(.9);
  await mobilePage.waitForFunction(() => Math.abs(document.querySelector('[data-media-provider] video').currentTime - 30) < .1);
  await mobilePage.locator('.seek-pulse-right').waitFor({ state: 'visible' });
  await mobilePage.waitForFunction(() => Array.from(document.querySelectorAll('.vds-time')).some((el) => el.textContent === '0:30'));
  await doubleTap(.1);
  await mobilePage.waitForFunction(() => Math.abs(document.querySelector('[data-media-provider] video').currentTime - 20) < .1);
  assert.equal(await mobilePage.evaluate(() => !!document.fullscreenElement), false, '触屏两侧双击跳转、不进入全屏');
  await mobilePage.waitForFunction(() => !document.querySelector('.seek-pulse'));
  await mobilePage.screenshot({ path: 'e2e-shots/player-bilibili-mobile.png' });
  await mobile.close();
  assert.deepEqual(errors, []);
  console.log('✓ 手机布局、触屏倍速菜单、无横向溢出、无运行错误');
} catch (error) {
  const failedPage = mobilePage && !mobilePage.isClosed() ? mobilePage : page;
  await failedPage.screenshot({ path: 'e2e-shots/player-bilibili-failure.png' }).catch(() => {});
  console.error('player errors:', errors);
  console.error('player debug:', await failedPage.evaluate(() => ({
    time: document.querySelector('[data-media-provider] video')?.currentTime,
    times: Array.from(document.querySelectorAll('.vds-time')).map((el) => el.textContent),
    active: document.activeElement?.outerHTML.slice(0, 500),
    controls: document.querySelector('.vds-controls')?.outerHTML.slice(0, 500),
    openMenus: Array.from(document.querySelectorAll('[data-open]')).map((el) => el.className),
    layout: document.querySelector('.vds-video-layout')?.outerHTML.slice(0, 400),
  })));
  throw error;
} finally {
  await browser.close();
}
