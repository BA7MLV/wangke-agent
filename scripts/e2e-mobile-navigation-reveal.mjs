import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';

// Isolated storage and mocked network: never sends a model request or touches user conversations.
const base = process.env.BASE_URL || 'http://localhost:5194';
const out = process.env.SHOTS || 'test-results/mobile-navigation-reveal';
await mkdir(out, { recursive: true });
const browser = await (process.env.BROWSER === 'webkit' ? webkit : chromium).launch({
  ...(process.env.BROWSER === 'webkit' ? {} : { channel: 'chrome' }), headless: true,
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
const errors = [];
const startupWarnings = [];
let phase = 'boot';
page.on('pageerror', error => {
  // Existing WebKit warning also reproduces with the reveal CSS removed, before navigation opens.
  // Keep it visible, and still fail if the same warning occurs during any navigation interaction.
  if (process.env.BROWSER === 'webkit' && ['reload seeded chat', 'fill seeded chat'].includes(phase)
    && error.message === 'ResizeObserver loop completed with undelivered notifications.') {
    startupWarnings.push(error.message);
    console.warn('Existing WebKit chat-load warning:', error.message);
    return;
  }
  errors.push(error.message);
  console.error('pageerror', phase, page.viewportSize(), new URL(page.url()).hash, error.message);
});
await page.route('**/api/v1/**', route => route.fulfill({ json: { cloud: false } }));
await page.route('https://models.dev/**', route => route.fulfill({ json: {} }));
await page.addInitScript(() => {
  localStorage.setItem('wangke-settings', JSON.stringify({ version: 5, state: { theme: 'light', uiLanguage: 'zh-CN' } }));
  window.loadTestModule = path => {
    const entry = performance.getEntriesByType('resource').findLast(entry => new URL(entry.name).pathname === path);
    return import(entry?.name ?? path);
  };
});

const drawer = page.getByRole('dialog', { name: 'DeepStudent Go', exact: true });
const opener = page.getByTestId('nav-rail-open');
const input = page.getByRole('textbox', { name: '给 AI 助手发送消息' });
// macOS Playwright WebKit can omit all backdrop filters from snapshots, even in
// a standalone page with no app styles. Probe that renderer limitation separately
// so an app-specific failure still fails whenever the engine can capture blur.
let backdropSnapshots = true;
if (process.env.BROWSER === 'webkit') {
  const probe = await browser.newPage({ viewport: { width: 100, height: 100 } });
  try {
    await probe.setContent(`<style>
      body { margin: 0; background: repeating-linear-gradient(to bottom, #000 0 4px, #fff 4px 8px); }
      div { position: fixed; inset: 0 0 0 50%; -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); }
    </style><div></div>`);
    const data = (await probe.screenshot()).toString('base64');
    const probeContrast = await probe.evaluate(async data => {
      const image = new Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = 100;
      canvas.height = 100;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(image, 0, 0);
      const contrast = x => {
        const pixels = ctx.getImageData(x, 20, 1, 64).data;
        const values = Array.from({ length: 64 }, (_, i) => pixels[i * 4]);
        return Math.max(...values) - Math.min(...values);
      };
      return { clear: contrast(25), blurred: contrast(75) };
    }, data);
    assert.equal(probeContrast.clear, 255, 'WebKit optical probe has a visible striped backdrop');
    backdropSnapshots = probeContrast.blurred !== 255;
    if (backdropSnapshots) assert(probeContrast.blurred < 80, 'standalone WebKit backdrop blur removes detail');
    if (!backdropSnapshots) console.warn('WebKit standalone snapshot also omits backdrop-filter: pixel optics skipped; geometry, styles and interaction remain checked.');
  } finally {
    await probe.close();
  }
}
const waitMotion = () => page.waitForFunction(() => {
  const nodes = document.querySelectorAll('.app-navigation-workspace, .app-navigation-blur, .app-navigation-blur > span, .app-nav-content, .app-nav-drawer');
  return [...nodes].every(node => node.getAnimations().every(a => a.playState !== 'running' && a.playState !== 'pending'));
});
async function open() {
  await opener.click();
  await drawer.waitFor();
  await waitMotion();
  assert.equal(await opener.getAttribute('aria-expanded'), 'true');
  assert.equal(await drawer.getAttribute('id'), await opener.getAttribute('aria-controls'));
}
async function closed({ focus = false } = {}) {
  await page.locator('.app-nav-backdrop').waitFor({ state: 'detached' });
  await waitMotion();
  assert.equal(await page.locator('.app-navigation-shell').getAttribute('data-nav-open'), 'false');
  assert.equal(await page.locator('.app-navigation-workspace').evaluate(el => el.inert), false);
  assert.equal(await page.locator('.app-navigation-workspace').evaluate(el => getComputedStyle(el).transform), 'none');
  assert(await page.locator('.app-navigation-blur').evaluate(el => {
    const style = getComputedStyle(el);
    return style.display === 'none' || (style.visibility === 'hidden'
      && [...el.children].every(child => getComputedStyle(child).opacity === '0'));
  }), 'closed navigation leaves no visible blur overlay');
  if (focus) await page.waitForFunction(() => document.activeElement === document.querySelector('[data-testid="nav-rail-open"]'));
}
async function geometry(label) {
  const rects = await page.evaluate(() => {
    const workspace = document.querySelector('.app-navigation-workspace');
    const dialog = document.querySelector('.app-nav-drawer');
    const w = workspace.getBoundingClientRect();
    const d = dialog.getBoundingClientRect();
    return {
      viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth,
      left: w.x, top: w.y, width: workspace.offsetWidth, scale: w.width / workspace.offsetWidth,
      navWidth: d.width, navLeft: d.x, navBottom: d.bottom, height: innerHeight,
      inert: workspace.inert, radius: getComputedStyle(workspace).borderTopLeftRadius,
    };
  });
  assert(Math.abs(rects.left - rects.navWidth) < 1, `${label}: workspace starts at navigation's edge`);
  assert(rects.navLeft >= -1 && rects.navBottom <= rects.height + 1, `${label}: sidebar fits viewport`);
  assert(rects.viewport - rects.left >= 55, `${label}: at least 56px of the page remains tappable`);
  assert(Math.abs(rects.scale - 0.96) < 0.001, `${label}: page scales without reflow`);
  assert.equal(rects.width, rects.viewport, `${label}: workspace retains original layout width`);
  assert.equal(rects.scrollWidth, rects.viewport, `${label}: no document horizontal overflow`);
  assert.equal(rects.inert, true, `${label}: page is inert while navigation is open`);
  assert.notEqual(rects.radius, '0px', `${label}: page has rounded corners`);
  const close = await drawer.getByRole('button', { name: '关闭导航' }).boundingBox();
  assert(close.width >= 44 && close.height >= 44, `${label}: close target remains touch-sized`);
  const blur = await page.locator('.app-navigation-blur').boundingBox();
  assert(Math.abs(blur.x - rects.left) < 1 && Math.abs(blur.x + blur.width - rects.viewport) < 1,
    `${label}: blur covers only the exposed strip, not the whole page`);
  assert.equal(await page.locator('.app-navigation-workspace').evaluate(el => getComputedStyle(el).filter), 'none');
}

async function previewBlur(theme) {
  const styles = await page.locator('.app-navigation-blur > span').evaluateAll(nodes => nodes.map(el => {
    const style = getComputedStyle(el);
    return { filter: style.backdropFilter, mask: style.maskImage, opacity: style.opacity };
  }));
  assert.deepEqual(styles.map(style => style.filter), ['blur(1px)', 'blur(2px)', 'blur(4px)', 'blur(8px)']);
  assert(styles.every(style => style.mask.includes('to right') && style.opacity === '1'));
  if (!backdropSnapshots) return;
  // Sample real pixels without the tint. Horizontal masks over four fixed blur
  // radii must remove fine detail earlier than coarse detail, not merely fade it.
  const optics = await page.addStyleTag({ content: `
    .app-navigation-workspace { background: repeating-linear-gradient(to bottom, #000 0 8px, #fff 8px 16px) !important; }
    .app-navigation-workspace > :not(.app-navigation-blur) { visibility: hidden !important; }
    .app-navigation-blur::after { display: none !important; }
  ` });
  try {
    const geometry = await page.locator('.app-navigation-blur').evaluate(el => {
      const r = el.getBoundingClientRect();
      return { columns: [0.03, 0.35, 0.65, 0.93].map(t => Math.round(r.left + r.width * t)), y: 260 };
    });
    const sample = async suffix => {
      const png = await page.screenshot({ path: `${out}/${theme}-preview-${suffix}.png` });
      return page.evaluate(async ({ data, geometry }) => {
        const image = new Image();
        image.src = `data:image/png;base64,${data}`;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(image, 0, 0);
        return geometry.columns.map(x => {
          const pixels = ctx.getImageData(x, geometry.y, 1, 96).data;
          const values = Array.from({ length: 96 }, (_, i) => pixels[i * 4]);
          return Math.max(...values) - Math.min(...values);
        });
      }, { data: png.toString('base64'), geometry });
    };
    const coarse = await sample('coarse');
    const disable = await page.addStyleTag({ content: '.app-navigation-blur > span { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }' });
    const clear = await sample('clear');
    await disable.evaluate(el => el.remove());
    const finePattern = await page.addStyleTag({ content: '.app-navigation-workspace { background: repeating-linear-gradient(to bottom, #000 0 2px, #fff 2px 4px) !important; }' });
    const fine = await sample('fine');
    await finePattern.evaluate(el => el.remove());
    assert(clear.every(value => value === 255), 'striped backdrop is visible across the whole exposed strip');
    assert(coarse[0] > 240 && coarse[3] < 80, `sidebar edge stays clear; right screen edge is blurred: ${coarse}`);
    assert(coarse.every((value, i) => i === 0 || value < coarse[i - 1] - 5), `blur increases smoothly towards the right: ${coarse}`);
    assert(fine[1] < coarse[1] * 0.7, `fine detail blurs earlier, not just an opacity fade: coarse=${coarse}, fine=${fine}`);
  } finally {
    await optics.evaluate(el => el.remove());
  }
}

try {
  await page.goto(`${base}/#/`);
  await input.waitFor();
  await page.waitForFunction(() => !document.querySelector('textarea.course-chat__input').disabled);
  await page.evaluate(async () => {
    const { db } = await window.loadTestModule('/src/store/db.ts');
    const createdAt = Date.now();
    await db.chatSessions.add({ id: 91001, videoId: '__library_assistant__', title: '导航保活测试', createdAt });
    await db.chats.bulkAdd(Array.from({ length: 32 }, (_, i) => ({
      sessionId: 91001, videoId: '__library_assistant__', role: 'user',
      content: `第 ${i + 1} 条测试消息\n用于检查侧栏开合时阅读位置保持不变。`, createdAt: createdAt + i,
    })));
  });
  phase = 'reload seeded chat';
  await page.reload();
  await page.getByTestId('course-chat-messages').waitFor();
  await page.waitForFunction(() => !document.querySelector('textarea.course-chat__input').disabled);
  phase = 'fill seeded chat';
  await input.fill('不要发送：侧栏开合保留草稿');
  await page.getByTestId('course-chat-messages').evaluate(el => {
    el.scrollTop = 160;
    window.savedMessages = el;
    window.savedScroll = el.scrollTop;
    window.savedInput = document.querySelector('textarea.course-chat__input');
  });
  assert(await page.evaluate(() => window.savedScroll > 0), 'fixture has scrollable messages');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

  phase = 'open and keyboard';
  await open();
  await geometry('phone');
  await page.screenshot({ path: `${out}/light-open.png` });
  await previewBlur('light');
  await page.evaluate(() => document.querySelector('textarea.course-chat__input').focus());
  assert.equal(await input.evaluate(el => document.activeElement === el), false, 'background cannot steal focus');
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab');
    assert(await drawer.evaluate(el => el.contains(document.activeElement)), 'Tab stays in navigation');
  }
  await page.keyboard.press('Escape');
  await page.locator('.app-nav-content[data-exiting]').waitFor();
  assert.equal(await drawer.isVisible(), true, 'sidebar stays mounted for the return transition');
  await closed({ focus: true });
  assert.equal(await input.inputValue(), '不要发送：侧栏开合保留草稿');
  assert(await page.evaluate(() => window.savedInput === document.querySelector('textarea.course-chat__input')
    && window.savedMessages === document.querySelector('[data-testid="course-chat-messages"]')
    && window.savedMessages.scrollTop === window.savedScroll), 'same composer, messages DOM and scroll offset survive');
  await page.screenshot({ path: `${out}/light-closed.png` });

  await open();
  await page.touchscreen.tap(380, 400);
  await closed({ focus: true });
  await open();
  await drawer.getByRole('button', { name: '关闭导航' }).click();
  await closed({ focus: true });

  // Nested overlays must close independently, not dismiss the entire navigation.
  phase = 'nested overlays';
  await open();
  await page.getByTestId('nav-rail-account').click();
  await page.getByRole('menu').waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('menu').waitFor({ state: 'hidden' });
  assert.equal(await drawer.isVisible(), true);
  await page.getByTestId('nav-rail-account').click();
  await page.getByRole('menu').waitFor();
  const brand = await drawer.getByTestId('app-brand').boundingBox();
  // A modal popover makes its outside targets inert; tap the coordinates as a user would.
  await page.touchscreen.tap(brand.x + brand.width / 2, brand.y + brand.height / 2);
  await page.getByRole('menu').waitFor({ state: 'hidden' });
  assert.equal(await drawer.isVisible(), true, 'clicking outside a nested menu does not close navigation');
  await page.getByTestId('nav-rail-account').click();
  await page.getByTestId('account-menu-archived').click();
  await page.getByTestId('archived-sessions-dialog').waitFor();
  await page.getByRole('button', { name: '关闭已归档', exact: true }).click();
  await page.getByTestId('archived-sessions-dialog').waitFor({ state: 'hidden' });
  assert.equal(await drawer.isVisible(), true, 'closing nested archive returns to navigation');
  await page.getByTestId('nav-rail-settings').click();
  await page.getByTestId('settings-modal').waitFor();
  await closed();
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  await page.getByTestId('settings-modal').waitFor({ state: 'hidden' });
  await closed();
  assert.equal(await input.inputValue(), '不要发送：侧栏开合保留草稿');

  // Both destinations and Recent preserve existing navigation behavior.
  phase = 'destinations';
  await open();
  await page.getByTestId('nav-rail-home').click();
  await page.waitForURL('**/#/library');
  await closed();
  await open();
  await page.getByTestId('chat-recent-91001').click();
  await page.waitForURL('**/#/');
  await closed();
  assert.equal(await input.inputValue(), '不要发送：侧栏开合保留草稿');

  for (const [width, height] of [[320, 568], [768, 1024], [852, 393], [900, 700]]) {
    phase = `resize ${width}x${height}`;
    await page.setViewportSize({ width, height });
    await open();
    await geometry(`${width}x${height}`);
    await page.keyboard.press('Escape');
    await closed({ focus: true });
  }

  phase = 'dark phone';
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(async () => (await window.loadTestModule('/src/store/settings.ts')).useSettings.getState().update({ theme: 'dark' }));
  await page.waitForFunction(() => document.documentElement.classList.contains('dark'));
  await open();
  await geometry('dark phone');
  await page.screenshot({ path: `${out}/dark-open.png` });
  await previewBlur('dark');

  // Resizing while open cancels mobile navigation and does not reopen it on return.
  phase = 'desktop breakpoint';
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.getByTestId('nav-rail').waitFor();
  await closed();
  assert.equal(await page.locator('.app-navigation-blur').evaluate(el => getComputedStyle(el).display), 'none');
  assert(await page.locator('.app-navigation-blur > span').evaluateAll(nodes => nodes.every(el => getComputedStyle(el).backdropFilter === 'none')));
  await page.getByTestId('nav-rail-toggle').click();
  await page.getByTestId('nav-rail-compact').waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await opener.waitFor();
  await closed();

  // Interrupt an entry with a close, then reopen: no stale classes, overlays or transforms.
  phase = 'interrupted entry';
  await opener.click();
  await drawer.getByRole('button', { name: '关闭导航' }).click({ force: true });
  await closed({ focus: true });
  await open();
  await geometry('reopened');
  await page.keyboard.press('Escape');
  await closed();

  phase = 'small font';
  await page.evaluate(async () => (await window.loadTestModule('/src/store/settings.ts')).useSettings.getState().update({ fontScale: 'small' }));
  await page.setViewportSize({ width: 320, height: 568 });
  await open();
  await geometry('small font on narrow phone');
  await page.keyboard.press('Escape');
  await closed();
  await page.evaluate(async () => (await window.loadTestModule('/src/store/settings.ts')).useSettings.getState().update({ fontScale: 'standard' }));

  phase = 'reduced motion';
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open();
  await geometry('reduced motion');
  const transitions = await page.locator('.app-navigation-workspace, .app-navigation-blur, .app-navigation-blur > span, .app-nav-content, .app-nav-drawer').evaluateAll(nodes =>
    nodes.map(el => getComputedStyle(el).transitionDuration));
  assert(transitions.every(value => value.split(',').every(v => parseFloat(v) === 0)), 'reduced motion disables all navigation transitions');
  await page.keyboard.press('Escape');
  await closed({ focus: true });
  if (process.env.BROWSER !== 'webkit') {
    phase = 'reduced transparency';
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
    assert(await page.evaluate(() => matchMedia('(prefers-reduced-transparency: reduce)').matches));
    await open();
    assert(await page.locator('.app-navigation-blur > span').evaluateAll(nodes => nodes.every(el => getComputedStyle(el).display === 'none')));
    const fallback = await page.locator('.app-navigation-blur').evaluate(el => getComputedStyle(el, '::after').backgroundColor);
    assert(!fallback.includes('rgba') && !fallback.includes(' / '), 'reduced transparency uses an opaque preview');
    await page.keyboard.press('Escape');
    await closed({ focus: true });
  }
  assert.deepEqual(errors, []);
  console.log(`PASS: mobile push-reveal geometry, ${backdropSnapshots ? 'rendered horizontal progressive blur' : 'progressive blur styles (WebKit snapshot limitation)'}, draft/scroll/DOM retention, focus trap/restore, tap/Escape/button dismiss, nested overlays, settings, destinations/Recent, breakpoints, themes, interrupted entry and reduced motion${process.env.BROWSER === 'webkit' ? '' : '/transparency'}.`);
  if (startupWarnings.length) console.log(`WebKit pre-navigation chat-load warnings: ${startupWarnings.length}`);
} finally {
  await browser.close();
}
