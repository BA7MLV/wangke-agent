import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const base = process.env.BASE_URL || 'http://localhost:5173';
const out = process.env.SHOTS_DIR || '/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/chat-progressive-blur';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const width of [1280, 390]) {
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width, height: 844 }, reducedMotion: 'reduce' });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/api/v1/cloud/status', route => route.fulfill({ json: { cloud: false } }));
      await page.route('https://models.dev/**', route => route.fulfill({ json: {} }));
      await page.addInitScript(theme => {
        localStorage.setItem('wangke-settings', JSON.stringify({ version: 5, state: { theme, studyTrackingEnabled: false } }));
      }, theme);
      await page.goto(`${base}/#/chat`);
      await page.getByTestId('course-chat-page').waitFor();
      await page.evaluate(async () => {
        const load = path => import(performance.getEntriesByType('resource').findLast(entry => new URL(entry.name).pathname === path)?.name || path);
        const { db } = await load('/src/store/db.ts');
        const { useCourseChat } = await load('/src/store/courseChat.ts');
        const videoId = '__library_assistant__';
        const sessionId = await db.chatSessions.add({ videoId, title: '渐进模糊验证', createdAt: Date.now() });
        await db.chats.bulkAdd([
          { sessionId, videoId, role: 'user', content: '请解释什么是渐进模糊。', createdAt: 1 },
          { sessionId, videoId, role: 'assistant', content: Array.from({ length: 80 }, (_, i) => `第 ${i + 1} 段：正文向上进入顶栏时，应从清晰过渡到轻微虚化，再逐渐变糊；标题和按钮始终保持清晰。`).join('\n\n'), createdAt: 2 },
        ]);
        await useCourseChat.getState().loadSession(sessionId);
      });
      const messages = page.getByTestId('course-chat-messages');
      await page.locator('[data-chat-positioned="true"]').waitFor();
      await messages.evaluate(el => {
        el.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, bubbles: true }));
        el.scrollTop = 400;
      });
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: `${out}/${width}-${theme}-chat.png` });

      // Test actual rendered pixels, with the tint removed. A color gradient or a
      // computed backdrop-filter value alone must never make this test pass.
      const optics = await page.addStyleTag({ content: `
        .course-chat__messages { background: repeating-linear-gradient(to right, #000 0 16px, #fff 16px 32px) !important; }
        .course-chat__messages > * { visibility: hidden !important; }
        .page-app-bar__blur::after { display: none !important; }
      ` });
      for (const safeArea of [0, 47]) {
        const safe = safeArea ? await page.addStyleTag({ content: `
          .page-course-chat { --app-edge-solid-height: ${safeArea}px; }
          .page-course-chat [data-testid='top-app-bar'] { padding-top: ${safeArea}px; }
        ` }) : null;
        const geometry = await page.evaluate(() => {
          const blur = document.querySelector('.page-app-bar__blur');
          const span = blur.firstElementChild.getBoundingClientRect();
          const header = document.querySelector('[data-testid="top-app-bar"]').getBoundingClientRect();
          const main = document.querySelector('.course-chat__messages').getBoundingClientRect();
          const control = document.querySelector('[data-testid="top-app-bar"] button');
          const r = control?.getBoundingClientRect();
          return {
            x: Math.round(main.left + main.width / 2),
            rows: [0.15, 0.4, 0.65, 0.9].map(t => Math.round(span.top + span.height * t)),
            edge: Math.round(blur.getBoundingClientRect().bottom),
            headerBottom: header.bottom,
            sampleTop: span.top,
            headerTop: header.top,
            solid: parseFloat(getComputedStyle(document.querySelector('.page-shell__top-edge')).height),
            clickable: !r || document.elementsFromPoint(r.x + r.width / 2, r.y + r.height / 2).some(el => el === control || control.contains(el)),
          };
        });
        const sample = async suffix => {
          const png = await page.screenshot({ path: `${out}/${width}-${theme}-safe${safeArea}-${suffix}.png` });
          return page.evaluate(async ({ data, geometry }) => {
            const image = new Image();
            image.src = `data:image/png;base64,${data}`;
            await image.decode();
            const canvas = document.createElement('canvas');
            canvas.width = image.width;
            canvas.height = image.height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(image, 0, 0);
            const contrast = y => {
              const pixels = ctx.getImageData(geometry.x, y, 64, 1).data;
              const values = Array.from({ length: 64 }, (_, i) => pixels[i * 4]);
              return Math.max(...values) - Math.min(...values);
            };
            return { levels: geometry.rows.map(contrast), seam: [geometry.edge - 2, geometry.edge - 1, geometry.edge, geometry.edge + 1].map(contrast) };
          }, { data: png.toString('base64'), geometry });
        };
        const blurred = await sample('blur');
        const disable = await page.addStyleTag({ content: '.page-app-bar__blur > span { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }' });
        const clear = await sample('clear');
        await disable.evaluate(el => el.remove());
        const finePattern = await page.addStyleTag({ content: '.course-chat__messages { background: repeating-linear-gradient(to right, #000 0 4px, #fff 4px 8px) !important; }' });
        const fine = await sample('fine');
        await finePattern.evaluate(el => el.remove());
        assert.ok(clear.levels.every(value => value === 255), 'the striped backdrop is actually present at every sample');
        assert.ok(blurred.levels[0] < 30, `strong blur must remain visible below the safe area: ${JSON.stringify(blurred)}`);
        assert.ok(blurred.levels[1] < 170, `the title region must blur, not merely fade the background: ${JSON.stringify(blurred)}`);
        assert.ok(blurred.levels.every((value, i, all) => i === 0 || value > all[i - 1] + 5), 'blur strength must progressively decrease towards the content');
        assert.ok(blurred.levels[3] > 230, 'the reading area returns to sharp content');
        assert.ok(fine.levels[2] < blurred.levels[2] * 0.6, 'fine detail must blur before coarse detail; a uniform blur with an opacity fade is not sufficient');
        assert.ok(Math.max(...blurred.seam) - Math.min(...blurred.seam) <= 5, 'no hard contrast jump at the lower edge');
        assert.ok(geometry.edge >= geometry.headerBottom + 40, 'the transition continues below the toolbar');
        assert.ok(geometry.sampleTop >= geometry.headerTop + geometry.solid - 1, 'safe area must not consume the blur ramp');
        assert.ok(geometry.clickable, 'the blur overlay must not intercept toolbar buttons');
        if (safe) await safe.evaluate(el => el.remove());
      }
      await optics.evaluate(el => el.remove());
      assert.ok(await messages.evaluate(el => el.scrollTop > 0), 'real chat content scrolls behind the toolbar');
      await page.locator('.course-chat__input').fill('多行输入\n'.repeat(7));
      await page.screenshot({ path: `${out}/${width}-${theme}-multiline.png` });
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
      assert.ok(await page.evaluate(() => matchMedia('(prefers-reduced-transparency: reduce)').matches));
      assert.ok(await page.locator('.page-app-bar__blur > span').evaluateAll(spans => spans.every(el => getComputedStyle(el).display === 'none')), 'reduced transparency disables the blur layers');
      assert.equal(await page.locator('.page-app-bar__blur').evaluate(el => getComputedStyle(el).bottom), '0px', 'opaque fallback does not extend over the reading area');
      await page.goto(`${base}/#/library`);
      await page.locator('.finder-toolbar').waitFor();
      assert.equal(await page.locator('.page-app-bar__blur').evaluate(el => getComputedStyle(el).display), 'none', 'the library keeps its existing non-blurred toolbar');
      assert.deepEqual(errors, []);
      console.log(`PASS chat progressive blur ${width} ${theme}: rendered blur ramp, safe area, seamless edge, toolbar interaction, library unchanged`);
      await context.close();
    }
  }
} finally {
  await browser.close();
}
