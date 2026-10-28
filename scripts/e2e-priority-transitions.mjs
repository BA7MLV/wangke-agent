// State transitions on the actual components, with isolated storage and no model calls.
// Run: node scripts/e2e-priority-transitions.mjs
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const cache = mkdtempSync(path.join(os.tmpdir(), 'opencode/priority-transitions-'));
const screenshots = process.env.SCREENSHOT_DIR ?? path.resolve('test-results/priority-transitions');
mkdirSync(screenshots, { recursive: true });
const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import '@heroui/styles/css';
import '/src/theme.css';
import '/src/transitions.css';
import '/src/materials/material-reader.css';
import AppLocaleProvider from '/src/i18n/AppLocaleProvider';
import { applyLocale } from '/src/i18n';
import { db } from '/src/store/db';
import { useSettings } from '/src/store/settings';
const mode = new URLSearchParams(location.search).get('case');
applyLocale('zh-CN');
useSettings.getState().update({ providers: [], savedModels: [] });
let view;
if (mode === 'resources') {
  const { default: ResourceLibrary } = await import('/src/pages/ResourceLibrary');
  view = <MemoryRouter><ResourceLibrary onImport={() => {}} /></MemoryRouter>;
} else if (mode === 'comments') {
  const { default: CommentsSection } = await import('/src/components/CommentsSection');
  await db.comments.bulkPut(Array.from({ length: 10 }, (_, i) => ({
    id: i + 1, videoId: 'motion-comments', time: i * 10, author: '同学' + i,
    role: 'note', text: '讨论正文，验证展开与收起时保留内容。'.repeat(4), createdAt: i,
  })));
  view = <div style={{ padding: 16 }}><CommentsSection videoId="motion-comments" playerRef={{ current: null }} hasSubtitles={true} /><button data-testid="after-comments">下一项</button></div>;
} else if (mode === 'models') {
  const { default: ModelLibrary } = await import('/src/components/settings/ModelLibrary');
  view = <div style={{ padding: 16 }}><ModelLibrary providerId="fixture" checking={false} onRefresh={() => {}} discovered={Array.from({ length: 40 }, (_, i) => ({ id: 'model-' + i }))} /><button data-testid="after-models">下一项</button></div>;
} else if (mode === 'editor') {
  const { default: MdEditor } = await import('/src/md-editor/MdEditor');
  const text = '# 保存状态\\n\\n初始正文';
  await db.videos.put({ id: 'motion-md', kind: 'material', materialFormat: 'md', name: 'motion.md', size: text.length, mimeType: 'text/markdown', duration: 0, createdAt: 1, status: 'transcribed' });
  await db.files.put({ id: 'motion-md', blob: new Blob([text], { type: 'text/markdown' }) });
  view = <div className="mr-editor" style={{ padding: 16 }}><MdEditor materialId="motion-md" initialText={text} debounceMs={800} /></div>;
}
createRoot(document.getElementById('root')).render(<React.StrictMode><AppLocaleProvider>{view}</AppLocaleProvider></React.StrictMode>);
`;

let server, browser;
const errors = [];
try {
  server = await createServer({
    root: new URL('../apps/web', import.meta.url).pathname,
    cacheDir: cache,
    server: { host: '127.0.0.1', port: 0, hmr: false },
    plugins: [{
      name: 'priority-motion-fixture',
      resolveId(id) { if (id === '/__priority-motion.tsx') return id; },
      load(id) { if (id === '/__priority-motion.tsx') return fixture; },
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith('/__priority-motion?')) return next();
          const html = await vite.transformIndexHtml(req.url, '<html><head></head><body><div id="root"></div><script type="module" src="/__priority-motion.tsx"></script></body></html>');
          res.setHeader('Content-Type', 'text/html');
          res.end(html);
        });
      },
    }],
  });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
  for (const reducedMotion of ['no-preference', 'reduce']) {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 }, reducedMotion });
    await context.route('https://models.dev/**', route => route.fulfill({ json: {} }));
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    const open = mode => page.goto(`${origin}/__priority-motion?case=${mode}`);
    const height = panel => panel.evaluate(el => el.getBoundingClientRect().height);
    const settle = panel => panel.evaluate(el => Promise.all(el.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {}))));

    // Slow directory loads get a skeleton and reveal; quick navigation never flashes one.
    const pending = [];
    let hold = true;
    await page.route('**/api/v1/resources?*', async route => {
      if (hold) await new Promise(resolve => pending.push(resolve));
      try {
        await route.fulfill({ json: { rootId: 'root', path: '', entries: [{ projectId: 'root', path: 'folder', name: '测试目录', kind: 'directory', size: 0 }] } });
      } catch { /* StrictMode aborts the first request on cleanup. */ }
    });
    await open('resources');
    await page.getByTestId('resource-skeleton').waitFor();
    assert.equal(await page.getByTestId('resource-entry').count(), 0);
    const skeletonIcon = page.locator('.resource-skeleton__icon').first();
    assert.ok(await height(skeletonIcon) > 0, 'skeleton icon occupies real space');
    if (reducedMotion === 'reduce') assert.equal(await skeletonIcon.evaluate(el => getComputedStyle(el).animationName), 'none');
    if (reducedMotion === 'no-preference') await page.screenshot({ path: path.join(screenshots, 'resource-skeleton.png') });
    hold = false;
    pending.splice(0).forEach(resolve => resolve());
    await page.getByTestId('resource-entry').waitFor();
    if (reducedMotion === 'no-preference') assert.equal(await page.locator('.skel-reveal.is-revealing').count(), 1, 'slow loads cross-fade to content');
    await page.waitForFunction(() => document.querySelector('.skel-reveal')?.classList.contains('is-idle'));
    assert.equal(await page.getByTestId('resource-skeleton').count(), 0, 'skeleton is removed after reveal');
    // Observe every frame on a fast in-app navigation, not just the final DOM.
    await page.evaluate(() => {
      window.skeletonFlashed = false;
      window.motionObserver = new MutationObserver(() => { window.skeletonFlashed ||= !!document.querySelector('[data-testid="resource-skeleton"]'); });
      window.motionObserver.observe(document.querySelector('[data-testid="resource-list"]'), { subtree: true, childList: true });
    });
    await page.getByTestId('resource-entry').locator('.resource-open').click();
    await page.waitForFunction(() => location.href.includes('resources') && document.querySelector('[data-testid="resource-list"]')?.getAttribute('aria-busy') === 'false');
    assert.equal(await page.evaluate(() => window.skeletonFlashed), false, 'quick loads skip the skeleton');

    // Closed panels remain mounted for exit motion, but neither screen readers nor Tab can reach them.
    for (const mode of ['comments', 'models']) {
      await open(mode);
      const toggle = page.getByTestId(mode === 'comments' ? 'comments-toggle' : 'discovered-model-select');
      await toggle.waitFor();
      const id = await toggle.getAttribute('aria-controls');
      const panel = page.locator(`[id="${id}"]`);
      if (mode === 'models') {
        assert.equal(await height(panel), 0);
        await toggle.focus();
        await page.keyboard.press('Enter');
      }
      await settle(panel);
      const expanded = await height(panel);
      assert.ok(expanded > 80, `${mode} expands`);
      if (reducedMotion === 'no-preference') await page.screenshot({ path: path.join(screenshots, `${mode}-expanded.png`) });
      const retained = await panel.locator('button').first().elementHandle();
      await toggle.click();
      assert.equal(await panel.getAttribute('aria-hidden'), 'true');
      assert.equal(await panel.evaluate(el => el.inert), true);
      assert.equal(await retained.evaluate(el => el.isConnected), true, `${mode} keeps exit content mounted`);
      if (reducedMotion === 'no-preference') {
        assert.ok(await panel.evaluate(el => el.getAnimations().length > 0), `${mode} actually animates height`);
      } else {
        assert.equal(await panel.evaluate(el => getComputedStyle(el).transitionDuration), '0s');
      }
      await settle(panel);
      assert.equal(await height(panel), 0, `${mode} leaves no residual height`);
      await toggle.focus();
      await page.keyboard.press('Tab');
      assert.equal(await page.getByTestId(`after-${mode}`).evaluate(el => el === document.activeElement), true, `${mode} skips hidden controls`);
      await toggle.focus();
      await page.keyboard.press('Space');
      await settle(panel);
      assert.equal(await panel.getAttribute('aria-hidden'), 'false');
      assert.equal(await retained.evaluate(el => el.isConnected), true, `${mode} reuses the same content`);
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${mode} fits mobile`);
      await toggle.click();
      await settle(panel);
      assert.equal(await height(panel), 0, `${mode} also closes on mobile`);
      await page.setViewportSize({ width: 1280, height: 900 });
    }

    // Save state uses the actual saver, including its error and retry states.
    await open('editor');
    const status = page.getByTestId('md-edit-state');
    const input = page.getByTestId('md-editor').locator('.cm-content');
    await input.waitFor();
    assert.equal(await status.getAttribute('role'), 'status');
    await input.fill('# 第一版\n\n修改正文');
    await status.filter({ hasText: '有未保存的修改' }).waitFor();
    await status.filter({ hasText: '已保存' }).waitFor({ timeout: 10000 });
    assert.equal(await status.locator('.t-text-swap').evaluate(el => el.classList.contains('is-exit')), false);
    // A stale local file induces the existing conflict error without changing the saver.
    await page.evaluate(async () => {
      const { db } = await import('/src/store/db');
      await db.files.put({ id: 'motion-md', blob: new Blob(['其他页面的修改'], { type: 'text/markdown' }) });
    });
    await input.fill('# 第二版\n\n冲突草稿');
    await page.getByTestId('md-save-error').waitFor();
    await status.filter({ hasText: '保存失败' }).waitFor();
    assert.equal(await status.evaluate(el => el.classList.contains('mr-edit-state--error')), true);
    if (reducedMotion === 'reduce') assert.equal(await status.locator('.t-text-swap').evaluate(el => getComputedStyle(el).transitionDuration), '0s');
    await page.evaluate(async () => {
      const { db } = await import('/src/store/db');
      await db.files.put({ id: 'motion-md', blob: new Blob(['# 第一版\n\n修改正文'], { type: 'text/markdown' }) });
    });
    await input.fill('# 第三版');
    await input.fill('# 第四版\n\n最终正文');
    await status.filter({ hasText: '已保存' }).waitFor({ timeout: 10000 });
    assert.equal(await page.getByTestId('md-save-error').count(), 0, 'a successful retry clears the error');
    assert.equal(await page.evaluate(async () => {
      const { db } = await import('/src/store/db');
      return (await db.files.get('motion-md')).blob.text();
    }), '# 第四版\n\n最终正文', 'rapid changes persist the latest text, not an intermediate status');
    if (reducedMotion === 'no-preference') await page.screenshot({ path: path.join(screenshots, 'editor-saved.png') });
    await context.close();
    console.log(`PASS (${reducedMotion}): resource slow/fast loading, comments/model accordion exits + inert + keyboard + mobile, Markdown save success/failure/retry + rapid changes`);
  }
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await server?.close();
  rmSync(cache, { recursive: true, force: true });
}
