import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { openWidgetPreviews } from './helpers/widget-preview.mjs';
const BASE = process.env.BASE_URL || 'http://localhost:5173';
const shots = new URL('../e2e-shots/', import.meta.url);
await mkdir(shots, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-features=MacAppCodeSignClone'] });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  await context.route('**/api/v1/cloud/status', route => route.fulfill({ json: { cloud: false } }));
  await context.route('https://models.dev/**', route => route.fulfill({ json: {} }));
  await context.addInitScript(() => {
    if (window.top !== window) return;
    window.__readingImport = path => {
      const resource = performance.getEntriesByType('resource').findLast(entry => new URL(entry.name).pathname === path);
      return import(resource?.name ?? path);
    };
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  await page.goto(BASE);
  await page.waitForFunction(async () => (await window.__readingImport('/src/store/courseChat.ts')).useCourseChat.getState().ready);
  const ids = await page.evaluate(async () => {
    const { db } = await window.__readingImport('/src/store/db.ts');
    const { useCourseChat } = await window.__readingImport('/src/store/courseChat.ts');
    const sessionId = await db.chatSessions.add({ videoId: '__library_assistant__', title: '阅读融合测试', createdAt: Date.now() });
    const otherId = await db.chatSessions.add({ videoId: '__library_assistant__', title: '重挂目标', createdAt: Date.now() });
    const rowId = await db.chats.add({ sessionId, videoId: '__library_assistant__', role: 'assistant', createdAt: Date.now(), content: '观察这个交互讲解。',
      widget: { id: 'reading-widget', html: `<section id="reading"><p tabindex="0">当前候选为什么保留？这是一段可引用的教学内容。</p>
<button id="expand">展开</button><button id="shrink">收起</button><div id="size" style="height:180px">正常流内容</div>
<div id="tooltip" style="position:fixed;top:1500px">定位提示不应撑高</div>
<div class="wbw-table" tabindex="0" aria-label="对比表"><table style="min-width:700px"><caption>宽表</caption><tbody><tr><th scope="row">第一项</th><td>仅表格内水平滚动</td></tr></tbody></table></div>
<script>(()=>{const root=document.querySelector('#reading');root.dataset.run=String(Math.random());root.querySelector('#expand').onclick=()=>root.querySelector('#size').style.height='600px';root.querySelector('#shrink').onclick=()=>root.querySelector('#size').style.height='180px';})();</script></section>` } });
    await useCourseChat.getState().loadSession(sessionId);
    return { sessionId, otherId, rowId };
  });
  const frame = () => page.getByTestId('widget-frame').contentFrame();
  const height = () => page.getByTestId('widget-block').getAttribute('data-h').then(Number);
  await page.getByTestId('code-block').waitFor();
  await openWidgetPreviews(page);
  await frame().getByRole('button', { name: '展开', exact: true }).waitFor();
  await page.waitForFunction(() => Number(document.querySelector('[data-testid="widget-block"]').dataset.h) > 200);
  const small = await height(); assert.ok(small < 450, 'fixed tooltip is excluded');
  await frame().getByRole('button', { name: '展开', exact: true }).click();
  await page.waitForFunction(() => Number(document.querySelector('[data-testid="widget-block"]').dataset.h) > 600);
  await frame().getByRole('button', { name: '收起', exact: true }).click();
  await page.waitForFunction(value => Number(document.querySelector('[data-testid="widget-block"]').dataset.h) <= value + 2, small);
  const run = await frame().locator('section').getAttribute('data-run');
  await page.evaluate(async () => (await window.__readingImport('/src/store/settings.ts')).useSettings.getState().update({ theme: 'dark' }));
  await frame().locator('html[data-wbw-theme="dark"]').waitFor();
  assert.equal(await frame().locator('section').getAttribute('data-run'), run);
  await frame().getByText('当前候选为什么保留？', { exact: false }).click();
  await frame().locator('p').evaluate(element => {
    const range = document.createRange(); range.setStart(element.firstChild, 0); range.setEnd(element.firstChild, 4);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  });
  await page.keyboard.press('Shift');
  await page.getByRole('button', { name: '引用提问', exact: true }).click();
  await page.getByTestId('widget-follow-up-dialog').waitFor();
  const quoted = await page.getByRole('textbox', { name: '交互讲解追问' }).inputValue();
  assert.ok(quoted.includes('当前候选为什么保留') && quoted.includes('reading-widget') && quoted.includes('版本') && quoted.includes('不可信引用'));
  assert.ok(quoted.includes('附近上下文：'), 'short selections retain bounded surrounding meaning');
  await page.screenshot({ path: new URL('widget-reading-quote.png', shots).pathname });
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  // Capture the frame's initial inline height at insertion, before bridge measurement.
  await page.evaluate(() => {
    window.__initialHeights = [];
    window.__heightObserver = new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        for (const frame of [node, ...node.querySelectorAll('iframe')]) if (frame.matches('[data-testid="widget-frame"]')) window.__initialHeights.push(parseInt(frame.style.height));
      }
    });
    window.__heightObserver.observe(document.body, { childList: true, subtree: true });
  });
  await page.evaluate(async id => (await window.__readingImport('/src/store/courseChat.ts')).useCourseChat.getState().loadSession(id), ids.otherId);
  await page.getByTestId('widget-frame').waitFor({ state: 'detached' });
  await page.evaluate(async id => (await window.__readingImport('/src/store/courseChat.ts')).useCourseChat.getState().loadSession(id), ids.sessionId);
  await page.getByTestId('code-block').waitFor();
  await openWidgetPreviews(page);
  await frame().getByRole('button', { name: '展开', exact: true }).waitFor();
  const initial = await page.evaluate(() => window.__initialHeights);
  assert.ok(initial.some(value => value >= small - 2), `remount restores height, got ${initial}`);
  await page.setViewportSize({ width: 320, height: 780 });
  await frame().getByRole('button', { name: '展开', exact: true }).scrollIntoViewIfNeeded();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.ok(await frame().locator('body').evaluate(element => element.scrollWidth <= innerWidth));
  await page.screenshot({ path: new URL('widget-reading-mobile.png', shots).pathname });
  await page.evaluate(() => {
    window.__intents = 0;
    document.querySelector('[data-testid="course-chat-messages"]').addEventListener('wbw:reading-intent', () => window.__intents++);
  });
  await frame().locator('p').click();
  await page.keyboard.press('PageUp');
  await page.waitForFunction(() => window.__intents > 0);
  const bounds = await page.getByTestId('widget-frame').boundingBox();
  await page.mouse.move(bounds.x + 30, Math.max(80, bounds.y + 80));
  await page.mouse.wheel(0, -160);
  await page.waitForFunction(() => window.__intents > 1);
  console.log('PASS: shrink/expand without feedback, fixed overlay, horizontal table, theme retention, bounded remount height, quoted source identity/version, 320px and real keyboard/wheel reading intent.');
} finally { await browser.close(); }
