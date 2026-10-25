#!/usr/bin/env node
// Real HeroUI controls and chat state, in a fresh browser context. No model calls.
// Requires Vite dev (dynamic source imports), e.g. BASE_URL=http://127.0.0.1:5187.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.BASE_URL || 'http://localhost:5173';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.evaluate(() => {
    // Match the exact HMR URL used by the app, rather than instantiating a second store.
    window.loadPickerTestModule = (path) => {
      const entry = performance.getEntriesByType('resource').findLast((item) => new URL(item.name).pathname === path);
      return import(entry?.name ?? path);
    };
  });
  const open = async () => {
    await page.getByTestId('chat-add').click();
    await page.getByRole('menuitem', { name: /技能/ }).click();
    await page.getByTestId('skill-picker-dialog').waitFor();
  };
  const close = async () => {
    await page.getByTestId('skill-picker-done').click();
    await page.getByTestId('skill-picker-dialog').waitFor({ state: 'detached' });
  };
  const scope = () => page.evaluate(async () => (await window.loadPickerTestModule('/src/store/courseChat.ts')).useCourseChat.getState().skillIds);
  const selected = () => page.locator('[data-testid="skill-scope-item"][data-selected="true"]').count();
  const search = page.getByRole('searchbox', { name: '搜索技能' });
  const waitCount = (count) => page.waitForFunction(n => document.querySelectorAll('[data-testid="skill-scope-item"]').length === n, count);
  const waitSelected = (count) => page.waitForFunction(n => document.querySelectorAll('[data-testid="skill-scope-item"][data-selected="true"]').length === n, count);

  await open();
  await waitCount(5);
  assert.equal(await selected(), 5);
  assert.match(await page.getByTestId('skill-picker-status').innerText(), /5\s*\/\s*5/);
  assert.equal(await page.getByTestId('skill-picker-all').getAttribute('aria-pressed'), 'true');
  assert.equal(await scope(), undefined);
  assert.equal(await page.getByTestId('skill-scope-check').count(), 5);

  // Filtering must never clear hidden selections. The entire named row is clickable.
  await search.fill('数学');
  await waitCount(1);
  await page.locator('.skill-picker__name').click();
  assert.equal((await scope()).length, 4);
  assert.match(await page.getByTestId('skill-picker-status').innerText(), /4\s*\/\s*5/);
  assert.equal(await page.getByTestId('skill-picker-all').getAttribute('aria-pressed'), 'false');
  await search.fill('no-such-skill');
  await page.getByText('没有找到匹配的技能').waitFor();
  assert.equal((await scope()).length, 4);
  await page.getByRole('button', { name: '清除搜索', exact: true }).last().click();
  await waitCount(5);
  await waitSelected(4);
  console.log('PASS: five readable cards; search/clear retains hidden selections and counts.');

  // Keyboard activation, explicit none, and all-selected normalization.
  const handout = page.getByRole('checkbox', { name: '课程讲义', exact: true });
  await handout.focus();
  await page.keyboard.press('Space');
  await waitSelected(5);
  assert.equal(await scope(), undefined);
  await page.getByTestId('skill-picker-none').click();
  await waitSelected(0);
  assert.deepEqual(await scope(), []);
  await page.getByTestId('skill-picker-all').click();
  await waitSelected(5);
  assert.equal(await scope(), undefined);
  console.log('PASS: keyboard selection and automatic/none/custom semantics.');

  await page.evaluate(async () => {
    const { db } = await window.loadPickerTestModule('/src/store/db.ts');
    const { useCourseChat } = await window.loadPickerTestModule('/src/store/courseChat.ts');
    const old = await db.skills.where('name').equals('数学讲义写作').first();
    useCourseChat.getState().setSkillIds([old.id]);
  });
  await waitSelected(1);
  assert.equal(await handout.isChecked(), true);
  await close();
  await open();
  await waitSelected(1);
  assert.equal(await handout.isChecked(), true);
  console.log('PASS: old skill IDs display the merged selection, including after reopening.');

  // Same-name custom skills must retain their own descriptions, not built-in summaries.
  await close();
  await page.evaluate(async () => {
    const { db } = await window.loadPickerTestModule('/src/store/db.ts');
    await db.skills.add({ name: '课程讲义', description: '我的专用说明 ' + 'LongCustomDescription'.repeat(20), body: 'custom', builtin: 0, enabled: 1, updatedAt: Date.now() });
  });
  await open();
  await waitCount(6);
  assert.match(await page.getByRole('region', { name: '我的技能' }).locator('.skill-picker__text').getAttribute('title'), /我的专用说明/);
  await search.fill('我的专用说明');
  await waitCount(1);
  assert.equal(await selected(), 0);
  await page.locator('.skill-picker__name').click();
  assert.equal((await scope()).length, 2);
  console.log('PASS: custom grouping and same-name descriptions; hidden legacy selection retained.');

  // Both narrow phones and a reduced visual viewport keep footer actions reachable.
  await search.fill('');
  await waitCount(6);
  for (const height of [740, 480]) {
    await page.setViewportSize({ width: 360, height });
    // React Aria updates --visual-viewport-height after the resize event.
    await page.waitForFunction(() => {
      const rect = document.querySelector('[data-testid="skill-picker-done"]').getBoundingClientRect();
      return rect.top >= 0 && rect.bottom <= window.innerHeight;
    });
    const bounds = await page.getByTestId('skill-picker-done').boundingBox();
    assert.ok(bounds && bounds.y >= 0 && bounds.y + bounds.height <= height, `footer clipped at ${height}px`);
    const dimensions = await page.getByTestId('skill-picker-dialog').evaluate(el => ({ width: el.clientWidth, scroll: el.scrollWidth }));
    assert.ok(dimensions.scroll <= dimensions.width + 1, 'dialog overflows horizontally');
    const last = page.getByTestId('skill-scope-item').last();
    await last.scrollIntoViewIfNeeded();
    const item = await last.boundingBox();
    assert.ok(item.x >= 0 && item.x + item.width <= 360, 'custom card overflows phone');
  }
  console.log('PASS: mobile/keyboard-height scrolling and long custom descriptions.');

  // A database failure is a retry state, not the empty-catalog state.
  await close();
  await page.evaluate(async () => {
    const { db } = await window.loadPickerTestModule('/src/store/db.ts');
    const filter = db.skills.filter;
    db.skills.filter = function () {
      db.skills.filter = filter;
      throw new Error('Test-only catalog read failure');
    };
  });
  await open();
  await page.getByRole('alert').filter({ hasText: '技能读取失败' }).waitFor();
  assert.equal(await page.getByTestId('skill-picker-empty').count(), 0);
  await page.getByRole('button', { name: '重新加载' }).click();
  await waitCount(6);
  assert.equal((await scope()).length, 2);
  console.log('PASS: load failure is visible; retry restores catalog without losing scope.');

  await close();
  await page.evaluate(async () => {
    const { db } = await window.loadPickerTestModule('/src/store/db.ts');
    await db.skills.toCollection().modify({ enabled: 0 });
  });
  await open();
  await page.getByTestId('skill-picker-empty').waitFor();
  await page.getByTestId('skill-picker-none').click();
  assert.deepEqual(await scope(), []);
  await page.getByTestId('skill-picker-manage').click();
  await page.getByTestId('card-skills').waitFor();
  await page.getByTestId('skill-picker-dialog').waitFor({ state: 'detached' });
  assert.equal(await page.getByTestId('settings-modal').count(), 1);
  assert.deepEqual(errors, []);
  console.log('PASS: empty catalog stays explicitly off; manage opens skill settings. No page errors.');
} finally {
  await browser.close();
}
