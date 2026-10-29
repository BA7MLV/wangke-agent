import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, webkit } from 'playwright';

const base = process.env.BASE_URL || 'http://localhost:5173';
const safari = process.env.BROWSER === 'webkit';
const out = process.env.SHOTS_DIR || join(tmpdir(), 'opencode', 'code-toolbar', safari ? 'webkit' : 'chrome');
await mkdir(out, { recursive: true });
const browser = await (safari ? webkit : chromium).launch({ ...(safari ? {} : { channel: 'chrome' }), headless: true });
try {
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    if (!safari) await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const page = await context.newPage();
    const errors = [];
    const resizeNotices = [];
    page.on('pageerror', error => {
      // WebKit also reports this one-frame scheduling notice with a standalone
      // HeroUI dropdown (without sticky/virtualization). Never hide app errors.
      if (error.message === 'ResizeObserver loop completed with undelivered notifications.') resizeNotices.push(error.message);
      else errors.push(error.message);
    });
    await page.route('**/api/v1/cloud/status', route => route.fulfill({ json: { cloud: false } }));
    await page.route('https://models.dev/**', route => route.fulfill({ json: {} }));
    await page.goto(`${base}/#/chat`);
    await page.getByTestId('course-chat-page').waitFor();
    const source = await page.evaluate(async () => {
      const load = path => import(performance.getEntriesByType('resource').findLast(entry => new URL(entry.name).pathname === path)?.name || path);
      const { db } = await load('/src/store/db.ts');
      const { useCourseChat } = await load('/src/store/courseChat.ts');
      const { createToolExecutor } = await load('/src/harness/tools.ts');
      const { widgetReference } = await load('/src/harness/widgetLayout.ts');
      const source = '<section><h2>HTML 预览示例</h2><button id="counter">0</button></section>\n'
        + Array.from({ length: 65 }, (_, i) => `<!-- 代码第 ${i + 1} 行：滚动时 HTML 和操作栏保持清晰。 -->`).join('\n')
        + '\n<script>document.querySelector("button").onclick=e=>e.target.textContent=Number(e.target.textContent)+1</script>';
      let payload;
      const execute = createToolExecutor('code-toolbar', { onWidget: value => { payload = value; } });
      await execute('show_widget', { format: 'html', code: source });
      if (!payload) throw new Error('show_widget did not deliver a payload');
      const videoId = '__library_assistant__';
      const sessionId = await db.chatSessions.add({ videoId, title: 'HTML 代码与吸顶验证', createdAt: Date.now() });
      await db.chats.add({ sessionId, videoId, role: 'assistant', createdAt: Date.now(),
        reasoning: Array.from({ length: 75 }, (_, i) => `第 ${i + 1} 步：检查展示内容，代码只作为源码，点击预览后才运行。`).join('\n\n'),
        reasoningMs: 2300,
        content: `下面是 HTML 代码：\n\n${widgetReference(payload.ref)}\n\n后续说明。\n\n\`\`\`js\n${'const example = 1;\n'.repeat(45)}\`\`\``,
        widget: payload, widgets: [payload],
      });
      await useCourseChat.getState().loadSession(sessionId);
      return source;
    });
    await page.locator('[data-chat-positioned="true"]').waitFor();
    const messages = page.getByTestId('course-chat-messages');
    const html = page.getByTestId('code-block').filter({ has: page.locator('.code-block__language', { hasText: /^html$/ }) });
    await html.waitFor();
    await messages.evaluate(el => {
      el.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
      el.scrollTop = 0;
    });
    assert.equal(await html.locator('pre code').textContent(), source);
    assert.equal(await page.getByTestId('widget-frame').count(), 0, 'code-first delivery does not initialize a runtime');

    // Native bounds plus the promoted header: assert real hit testing over the
    // blur ramp, not merely the presence of a high z-index declaration.
    const stick = async selector => {
      await page.evaluate(async selector => {
        const scroll = document.querySelector('.course-chat__messages');
        const block = document.querySelector(selector);
        scroll.scrollTop += block.getBoundingClientRect().top - scroll.getBoundingClientRect().top + 180;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }, selector);
      const overlay = page.locator(selector === '.reasoning-chain' ? '.reasoning-chain__heading.chat-sticky-overlay' : '.code-block__header.chat-sticky-overlay');
      await overlay.waitFor();
      const first = await overlay.boundingBox();
      await messages.evaluate(el => { el.scrollTop += 80; });
      await page.waitForFunction(selector => {
        const header = document.querySelector(selector === '.reasoning-chain' ? '.reasoning-chain__heading.chat-sticky-overlay' : '.code-block__header.chat-sticky-overlay');
        if (!header) return false;
        const r = header.getBoundingClientRect();
        const button = header.querySelector('button');
        const b = button.getBoundingClientRect();
        return r.height > 0 && document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)?.closest('.chat-sticky-overlay') === header;
      }, selector);
      const second = await overlay.boundingBox();
      assert.ok(Math.abs(first.y - second.y) < 2, 'toolbar stays pinned during actual scrolling');
      const state = await overlay.evaluate(header => {
        const blur = document.querySelector('.page-app-bar__blur').getBoundingClientRect();
        const r = header.getBoundingClientRect();
        return { top: r.top, blurBottom: blur.bottom, z: Number(getComputedStyle(header).zIndex) };
      });
      assert.ok(state.z > 5, 'sticky toolbar is above the app bar blur context');
      if (width < 900) assert.ok(state.top < state.blurBottom, 'test exercises overlap with the progressive blur');
    };
    await stick('[data-testid="code-block"]');
    await page.screenshot({ path: `${out}/${width}-code-sticky.png` });
    const promoted = page.locator('.chat-sticky-overlay');
    await promoted.getByRole('button', { name: '更多 HTML 操作' }).click();
    const menu = page.getByRole('menu');
    await menu.getByRole('menuitem', { name: '复制代码', exact: true }).waitFor();
    await menu.getByRole('menuitem', { name: '预览', exact: true }).waitFor();
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.dropdown__popover')).opacity === '1');
    await page.screenshot({ path: `${out}/${width}-code-menu.png` });
    if (!safari) {
      await menu.getByRole('menuitem', { name: '复制代码', exact: true }).click();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), source, 'copy includes exact source');
      await promoted.getByRole('button', { name: '更多 HTML 操作' }).click();
    }
    await menu.getByRole('menuitem', { name: '预览', exact: true }).click();
    await html.scrollIntoViewIfNeeded();
    const frame = page.getByTestId('widget-frame');
    await frame.contentFrame().getByRole('heading', { name: 'HTML 预览示例' }).waitFor();
    assert.equal(await frame.getAttribute('sandbox'), 'allow-scripts');
    await frame.contentFrame().getByRole('button', { name: '0', exact: true }).click();
    await html.getByTestId('code-block-more').click();
    await menu.getByRole('menuitem', { name: '查看代码', exact: true }).click();
    await html.getByTestId('code-block-more').click();
    await menu.getByRole('menuitem', { name: '预览', exact: true }).click();
    assert.equal(await frame.contentFrame().getByRole('button', { name: '1', exact: true }).count(), 1, 'switching code/preview retains the local runtime');

    await messages.evaluate(el => { el.scrollTop = 0; });
    await page.getByTestId('response-process-toggle').click();
    await page.waitForFunction(() => document.querySelector('.reasoning-chain')?.dataset.mode === 'expanded');
    await stick('.reasoning-chain');
    const reasoningHeading = page.locator('.reasoning-chain__heading.chat-sticky-overlay');
    assert.match(await reasoningHeading.innerText(), /已思考用时/);
    assert.equal(await page.locator('.code-block__header.chat-sticky-overlay').count(), 0, 'preceding layout changes clear stale code overlays');
    await page.screenshot({ path: `${out}/${width}-reasoning-sticky.png` });
    await reasoningHeading.getByRole('button', { name: '收起思考过程' }).click();
    await reasoningHeading.waitFor({ state: 'detached' });
    await messages.evaluate(el => { el.scrollTop = 0; });
    assert.equal(await page.getByTestId('response-process-toggle').getAttribute('aria-expanded'), 'false', 'promoted heading still controls the original Disclosure');
    assert.ok(await messages.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'no horizontal page overflow');
    assert.deepEqual(errors, []);
    assert.ok(resizeNotices.length < 10, 'no sustained ResizeObserver loop');
    console.log(`PASS ${safari ? 'WebKit' : 'Chrome'} ${width}px: actual show_widget code-first delivery, header menu/copy/preview, retained sandbox state, code/reasoning sticky above blur and operable collapse.`);
    if (resizeNotices.length) console.log(`  WebKit/HeroUI transient ResizeObserver notices: ${resizeNotices.length}`);
    await context.close();
  }
} catch (error) {
  const page = browser.contexts()[0]?.pages()[0];
  if (page) {
    await page.screenshot({ path: `${out}/failure.png` });
    console.error(await page.locator('.chat-sticky-header').evaluateAll(nodes => nodes.map(node => ({
      text: node.textContent, top: node.getBoundingClientRect().top, height: node.getBoundingClientRect().height, classes: node.className,
    }))));
  }
  throw error;
} finally { await browser.close(); }
