// Run against Vite: BASE_URL=http://localhost:5173 node scripts/e2e-library-finder.mjs
// Uses an isolated browser context; never changes the user's library.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const base = process.env.BASE_URL ?? 'http://localhost:5173';
const browser = await chromium.launch({ headless: true });
const errors = [];
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.goto(`${base}/#/library`);
  await page.getByTestId('btn-new-folder').waitFor();
  await page.evaluate(async () => {
    const { db } = await import('/src/store/db.ts');
    const createdAt = Date.now();
    await db.folders.bulkAdd([
      { id: 1, name: '02_学习考试', createdAt },
      { id: 2, name: '03_论文与学校', createdAt },
      { id: 3, name: '04_设计素材', createdAt },
    ]);
    await db.videos.bulkAdd([
      { id: 'finder-exam', name: '社会工作综合能力复习资料.pdf', kind: 'material', materialFormat: 'pdf', unitCount: 24, folderId: 1, status: 'new', size: 102400, duration: 0, createdAt },
      { id: 'finder-paper', name: '四级翻译历年真题及译文.pdf', kind: 'material', materialFormat: 'pdf', unitCount: 12, status: 'new', size: 204800, duration: 0, createdAt },
      { id: 'finder-word', name: '2026年考试报名通知.docx', kind: 'material', materialFormat: 'docx', unitCount: 8, status: 'new', size: 88400, duration: 0, createdAt },
    ]);
  });
  await page.reload();
  const folder = page.locator('[data-group-key="1"]');
  await folder.waitFor();
  // Blank-space marquee works in either layout and survives the release click.
  const marqueeAll = async () => {
    const canvas = await page.getByTestId('video-list').boundingBox();
    const items = await page.locator('.finder-item').all();
    const rects = await Promise.all(items.map((item) => item.boundingBox()));
    const x = Math.max(...rects.map((rect) => rect.x + rect.width)) + 2;
    const y = Math.max(...rects.map((rect) => rect.y + rect.height)) + 2;
    await page.mouse.move(canvas.x + 3, canvas.y + 3);
    await page.mouse.down();
    await page.mouse.move(x, y, { steps: 12 });
    await page.getByTestId('selection-box').waitFor();
    await page.mouse.up();
    assert.equal(await page.locator('.finder-item[aria-selected="true"]').count(), items.length);
    assert.match(await page.locator('.finder-status').innerText(), new RegExp(`已选择 ${items.length} 项`));
    await page.getByTestId('selection-box').waitFor({ state: 'detached' });
    assert.equal(await page.getByRole('button', { name: '所选项目的操作', exact: true }).isDisabled(), true, 'multi-selection must not silently act on the first item');
  };
  await marqueeAll();
  await page.getByLabel('列表视图', { exact: true }).click();
  await marqueeAll();
  // Escape cancels the gesture, restoring the original selection.
  const canvas = await page.getByTestId('video-list').boundingBox();
  await page.mouse.move(canvas.x + 3, canvas.y + 3);
  await page.mouse.down();
  await page.mouse.move(canvas.x + 10, canvas.y + 15, { steps: 3 });
  await page.getByTestId('selection-box').waitFor();
  await page.keyboard.press('Escape');
  await page.mouse.up();
  assert.equal(await page.locator('.finder-item[aria-selected="true"]').count(), 5);
  await page.getByLabel('图标视图', { exact: true }).click();
  await folder.click();
  assert.equal(await folder.getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('.finder-title').innerText(), '全部资料', 'single click must select, not open');
  await folder.dblclick();
  assert.equal(await page.locator('.finder-title').innerText(), '02_学习考试');
  assert.equal(await page.getByTestId('video-item').count(), 1);
  await page.getByRole('button', { name: '后退', exact: true }).click();
  await page.getByRole('button', { name: '前进', exact: true }).click();
  assert.equal(await page.locator('.finder-title').innerText(), '02_学习考试');
  await page.getByRole('button', { name: '后退', exact: true }).click();
  await folder.click();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('.finder-title').innerText(), '02_学习考试', 'Enter opens selected folder');
  await page.getByRole('button', { name: '后退', exact: true }).click();
  await page.getByTestId('library-search').fill('论文');
  await page.locator('[data-group-key="2"]').dblclick();
  await page.getByText('文件夹还是空的', { exact: true }).waitFor();
  await page.getByRole('button', { name: '后退', exact: true }).click();

  // Right-click selects that item and exposes its operations at the pointer.
  await page.locator('[data-video-id="finder-paper"]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '重命名', exact: true }).click();
  await page.getByTestId('rename-input').locator('input').fill('四级历年真题.pdf');
  await page.getByTestId('rename-save').click();
  await page.getByRole('option').filter({ hasText: '四级历年真题.pdf' }).waitFor();

  // Real pointer drag moves an unfiled document into the folder.
  await page.locator('[data-video-id="finder-paper"] .finder-item__icon').dragTo(page.locator('[data-group-key="1"] .finder-item__icon'));
  await page.waitForFunction(async () => {
    const { db } = await import('/src/store/db.ts');
    return (await db.videos.get('finder-paper')).folderId === 1;
  });
  await page.locator('[data-video-id="finder-paper"]').waitFor({ state: 'detached' });
  await folder.dblclick();
  await page.locator('[data-video-id="finder-paper"]').waitFor();
  assert.equal(await page.getByTestId('video-item').count(), 2);

  // Native imports belong to the currently open folder.
  await page.getByTestId('import-input').setInputFiles({ name: '复习提纲.md', mimeType: 'text/markdown', buffer: Buffer.from('# 复习提纲\n\n考试知识点。') });
  await page.waitForFunction(async () => {
    const { db } = await import('/src/store/db.ts');
    return (await db.videos.toArray()).some((video) => video.name === '复习提纲' && video.folderId === 1);
  });
  await page.getByRole('button', { name: '后退', exact: true }).click();
  // Move a folder with its contents, then move it back using the path bar.
  await page.locator('[data-group-key="1"] .finder-item__content').dragTo(page.locator('[data-group-key="2"] .finder-item__name'));
  await page.waitForFunction(async () => {
    const { db } = await import('/src/store/db.ts');
    return (await db.folders.get(1)).parentId === 2;
  });
  await page.locator('[data-group-key="2"]').dblclick();
  await page.locator('[data-group-key="1"]').waitFor();
  await page.locator('[data-group-key="1"] .finder-item__name').dragTo(page.locator('.finder-path-target').first());
  await page.waitForFunction(async () => {
    const { db } = await import('/src/store/db.ts');
    return (await db.folders.get(1)).parentId == null;
  });
  await page.locator('.finder-path-target').first().getByRole('button').click();
  // Finder-style mixed multi-selection drag in list layout.
  await page.getByLabel('列表视图', { exact: true }).click();
  await page.locator('[data-group-key="3"]').click();
  await page.locator('[data-video-id="finder-word"]').click({ modifiers: ['ControlOrMeta'] });
  assert.equal(await page.locator('.finder-item[aria-selected="true"]').count(), 2);
  await page.locator('[data-group-key="3"] .finder-item__name').dragTo(page.locator('[data-group-key="2"] .finder-item__name'));
  await page.waitForFunction(async () => {
    const { db } = await import('/src/store/db.ts');
    return (await db.folders.get(3)).parentId === 2 && (await db.videos.get('finder-word')).folderId === 2;
  });
  await page.locator('[data-group-key="3"]').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '撤销移动', exact: true }).click();
  await page.locator('[data-group-key="3"]').waitFor();
  await page.locator('[data-video-id="finder-word"]').waitFor();
  await page.locator('[data-group-key="3"]').click();
  await page.locator('[data-video-id="finder-word"]').click({ modifiers: ['ControlOrMeta'] });
  // Capture real drag feedback before releasing the mixed selection.
  const dragFrom = await page.locator('[data-group-key="3"] .finder-item__name').boundingBox();
  const dragTo = await page.locator('[data-group-key="2"]').boundingBox();
  await page.mouse.move(dragFrom.x + 8, dragFrom.y + 8);
  await page.mouse.down();
  // Hit the option's outer padding, not its icon/name/content wrapper.
  await page.mouse.move(dragTo.x + dragTo.width - 2, dragTo.y + dragTo.height / 2, { steps: 10 });
  assert.equal(await page.locator('.finder-drag-preview__badge').innerText(), '2');
  assert.equal(await page.locator('[data-group-key="2"] .finder-item__content').getAttribute('data-drop-target'), 'true');
  assert.equal(await page.locator('[data-group-key="2"] .finder-item__content').evaluate((el) => getComputedStyle(el).backgroundColor), await page.locator('[data-group-key="3"]').evaluate((el) => getComputedStyle(el).backgroundColor), 'destination must visibly use the selected accent, including on row padding');
  await page.screenshot({ path: '.openchamber/finder-drag-feedback.png' });
  await page.mouse.up();
  await page.locator('[data-group-key="3"]').waitFor({ state: 'detached' });
  await page.locator('[data-group-key="2"]').dblclick();
  await page.locator('[data-group-key="3"]').waitFor();
  await page.locator('[data-video-id="finder-word"]').waitFor();
  // The entire path remains navigable after nesting.
  await page.locator('[data-group-key="3"]').dblclick();
  assert.equal(await page.locator('.finder-path-target').count(), 3);
  await page.locator('.finder-path-target').first().getByRole('button').click();
  // Native drag stays alive through spring-loaded navigation into an empty folder.
  await page.locator('[data-group-key="2"]').dblclick();
  const source = await page.locator('[data-video-id="finder-word"] .finder-item__name').boundingBox();
  const destination = await page.locator('[data-group-key="3"] .finder-item__name').boundingBox();
  await page.mouse.move(source.x + 8, source.y + 8);
  await page.mouse.down();
  await page.mouse.move(destination.x + 8, destination.y + 8, { steps: 10 });
  await page.waitForFunction(() => document.querySelector('.finder-title').textContent === '04_设计素材');
  assert.equal(await page.locator('.finder-drag-preview').count(), 1);
  assert.match(await page.locator('.finder-drag-status').innerText(), /已打开|松手|移入/);
  const blank = await page.getByTestId('video-list').boundingBox();
  await page.mouse.move(blank.x + 20, blank.y + blank.height - 40, { steps: 5 });
  await page.mouse.up();
  await page.waitForFunction(async () => {
    const { db } = await import('/src/store/db.ts');
    return (await db.videos.get('finder-word')).folderId === 3;
  });
  await page.locator('[data-video-id="finder-word"]').waitFor();
  assert.equal(await page.locator('[data-video-id="finder-word"]').getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('.finder-drag-preview').count(), 0);
  // Escape restores the original directory after spring navigation, without moving.
  const moved = await page.locator('[data-video-id="finder-word"] .finder-item__name').boundingBox();
  await page.mouse.move(moved.x + 8, moved.y + 8);
  await page.mouse.down();
  await page.mouse.move(moved.x + 30, moved.y + 10, { steps: 4 });
  await page.locator('.finder-drag-status').waitFor();
  const parentPath = await page.locator('.finder-path-target').nth(1).boundingBox();
  await page.mouse.move(parentPath.x + parentPath.width / 2, parentPath.y + parentPath.height / 2, { steps: 10 });
  await page.waitForFunction(() => document.querySelector('.finder-title').textContent === '03_论文与学校');
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('.finder-title').textContent === '04_设计素材');
  assert.equal(await page.locator('.finder-drag-preview').count(), 0);
  await page.locator('.finder-path-target').first().getByRole('button').click();
  await page.getByLabel('图标视图', { exact: true }).click();
  await mkdir('.openchamber', { recursive: true });
  await page.getByText(/已导入《复习提纲.md》/).waitFor({ state: 'hidden' });
  await page.mouse.move(1400, 900);
  await page.screenshot({ path: '.openchamber/finder-v2-desktop.png' });
  await page.getByLabel('列表视图', { exact: true }).click();
  assert.equal(await page.locator('.finder-items--list').count(), 1);
  await page.screenshot({ path: '.openchamber/finder-v2-list.png' });
  await page.getByLabel('图标视图', { exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: '.openchamber/finder-v2-mobile.png' });
  assert.deepEqual(errors, []);
  console.log('PASS: marquee, selection, keyboard, history, search, context menu, rename, file/folder/mixed drag, nested paths, import destination, both layouts, mobile layout');
} catch (error) {
  console.error(await page.evaluate(async () => { const { db } = await import('/src/store/db.ts'); return { folders: await db.folders.toArray(), videos: await db.videos.toArray() }; }));
  console.error(await page.locator('.finder-window').innerText());
  await page.screenshot({ path: '.openchamber/finder-test-failure.png' });
  throw error;
} finally {
  await browser.close();
}
