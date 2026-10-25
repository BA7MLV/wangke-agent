// All preview entry points, deterministic history, no model or file server needed.
// Requires Vite: node scripts/e2e-image-preview.mjs
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const base = process.env.BASE_URL || 'http://localhost:5173';
await mkdir('e2e-shots', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.__playerKeys = [];
    document.addEventListener('keydown', (event) => {
      if (/^(?: |k|ArrowLeft|ArrowRight|ArrowUp|ArrowDown|0)$/.test(event.key)) window.__playerKeys.push(event.key);
    });
    window.__revokedUrls = [];
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (url) => { window.__revokedUrls.push(url); revoke(url); };
  });
  await page.goto(base);
  await page.locator('textarea').waitFor();
  await page.evaluate(async () => {
    const { db } = await import('/src/store/db.ts');
    const { LIBRARY_ASSISTANT_ID } = await import('/src/harness/libraryAssistant.ts');
    const { useCourseChat } = await import('/src/store/courseChat.ts');
    const { listMaterialImages } = await import('/src/materials/images.ts');
    const { materialImageHref } = await import('/src/materials/imageRefs.ts');
    const image = (width, height, color) => {
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = color; ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = '#fff'; ctx.font = '40px sans-serif'; ctx.fillText(`${width} × ${height}`, 20, 60);
      return canvas.toDataURL('image/png');
    };
    const tall = image(400, 1600, '#235c48');
    const wide = image(1600, 400, '#3154a0');
    const attachments = [tall, wide].map((dataUrl, i) => ({ id: `preview-${i}`, name: i ? '横图.png' : '长图.png', mimeType: 'image/png', size: 100, dataUrl }));
    for (const file of attachments) await db.files.put({ id: file.id, blob: await (await fetch(file.dataUrl)).blob() });
    const course = { id: 'preview-material', name: '预览测试材料', kind: 'material', materialFormat: 'md', status: 'transcribed', createdAt: Date.now() };
    const blob = new Blob([`![材料长图](${tall})`]);
    await db.videos.put(course);
    await db.files.put({ id: course.id, blob });
    const [material] = await listMaterialImages(course, blob);
    const href = materialImageHref(course.id, material.key);
    const sessionId = await db.chatSessions.add({ videoId: LIBRARY_ASSISTANT_ID, title: '统一预览验收', createdAt: Date.now() });
    await db.chats.bulkAdd([
      { videoId: LIBRARY_ASSISTANT_ID, sessionId, role: 'user', content: '查看图片', attachments, createdAt: Date.now() },
      { videoId: LIBRARY_ASSISTANT_ID, sessionId, role: 'assistant', createdAt: Date.now() + 1, content: [
        '```svg title="宽幅 SVG"',
        '<svg viewBox="0 0 1600 400"><rect width="1600" height="400" fill="#ddede7"/><text x="50" y="100" font-size="48">共享矢量预览</text></svg>',
        '```', '',
        '```mermaid title="流程图"', 'flowchart LR', 'A[开始] --> B[结束]', '```', '',
        '```diagram title="关系图"', JSON.stringify({ type: 'graph', nodes: [{ id: 'a', label: '节点甲' }, { id: 'b', label: '节点乙' }], edges: [{ from: 'a', to: 'b' }] }), '```', '',
        `![材料长图](${href})`, '', `[材料原图链接](${href})`,
      ].join('\n') },
    ]);
    await useCourseChat.getState().loadSession(sessionId);
  });

  const dialog = page.locator('.image-preview');
  const zoom = () => dialog.getAttribute('data-zoom');
  const close = async () => {
    await dialog.getByRole('button', { name: '关闭图片预览', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
  };
  const settled = async () => {
    await dialog.waitFor();
    await page.waitForFunction(() => {
      const el = document.querySelector('.image-preview__content');
      return el && el.getBoundingClientRect().width > 0 && getComputedStyle(el).visibility !== 'hidden';
    });
    await dialog.evaluate(async (el) => { await Promise.allSettled(el.closest('[data-slot="modal-backdrop"]').getAnimations({ subtree: true }).map((a) => a.finished)); });
  };
  const checkFit = async (ratio) => {
    const size = await dialog.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const scroll = el.querySelector('.image-preview__scroll');
      const picture = el.querySelector('.image-preview__content').getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, viewportWidth: innerWidth, viewportHeight: innerHeight,
        pictureWidth: picture.width, pictureHeight: picture.height, availableWidth: scroll.clientWidth, availableHeight: scroll.clientHeight,
        scrollWidth: scroll.scrollWidth, scrollHeight: scroll.scrollHeight };
    });
    assert(size.x >= -1 && size.y >= -1 && size.x + size.width <= size.viewportWidth + 1 && size.y + size.height <= size.viewportHeight + 1, JSON.stringify(size));
    assert(size.pictureWidth <= size.availableWidth + 1 && size.pictureHeight <= size.availableHeight + 1, `Fit must show the entire image: ${JSON.stringify(size)}`);
    assert(Math.abs(size.pictureWidth / size.pictureHeight - ratio) < 0.02, `Aspect ratio must be retained: ${JSON.stringify(size)}`);
    assert(size.scrollWidth <= size.availableWidth + 1 && size.scrollHeight <= size.availableHeight + 1, `No scrolling at fit: ${JSON.stringify(size)}`);
  };
  const checkControls = async () => {
    assert.equal(await zoom(), '1');
    const before = await dialog.locator('.image-preview__content').boundingBox();
    await dialog.getByRole('button', { name: '放大图片', exact: true }).click();
    assert.equal(await zoom(), '1.5');
    const after = await dialog.locator('.image-preview__content').boundingBox();
    assert(Math.abs(after.width / before.width - 1.5) < 0.03);
    await dialog.getByRole('button', { name: '适应窗口', exact: true }).click();
    await dialog.locator('.image-preview__content').dblclick();
    assert.equal(await zoom(), '2');
    await dialog.locator('.image-preview__content').dblclick();
    assert.equal(await zoom(), '1');
    for (let step = 0; step < 6; step++) await dialog.getByRole('button', { name: '放大图片', exact: true }).click();
    assert.equal(await zoom(), '4');
    assert(await dialog.getByRole('button', { name: '放大图片', exact: true }).isDisabled());
    await dialog.locator('.image-preview__scroll').evaluate((el) => { el.scrollLeft = 200; el.scrollTop = 200; });
    await dialog.getByRole('button', { name: '适应窗口', exact: true }).click();
    assert.equal(await zoom(), '1');
    assert.deepEqual(await dialog.locator('.image-preview__scroll').evaluate((el) => [el.scrollLeft, el.scrollTop]), [0, 0]);
    await dialog.getByRole('button', { name: '缩小图片', exact: true }).click();
    assert.equal(await zoom(), '0.5');
    assert(await dialog.getByRole('button', { name: '缩小图片', exact: true }).isDisabled());
    await dialog.getByRole('button', { name: '适应窗口', exact: true }).click();
    // Space must still activate a focused button while being isolated from the player.
    await dialog.getByRole('button', { name: '放大图片', exact: true }).focus();
    await page.keyboard.press('Space');
    assert.equal(await zoom(), '1.5');
    await page.keyboard.press('k');
    const scroll = dialog.locator('.image-preview__scroll');
    await scroll.focus();
    await page.keyboard.press('0');
    assert.equal(await zoom(), '1');
    await page.keyboard.press('+');
    assert.equal(await zoom(), '1.5');
    await page.keyboard.press('-');
    assert.equal(await zoom(), '1');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Tab');
    assert(await dialog.evaluate((el) => el.contains(document.activeElement)), 'Tab stays within the modal');
    assert.deepEqual(await page.evaluate(() => window.__playerKeys), [], 'No player shortcuts escape the viewer');
  };

  const tallButton = page.getByRole('button', { name: '预览图片 长图.png', exact: true });
  for (const viewport of [{ width: 1280, height: 900 }, { width: 820, height: 1180 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await tallButton.click();
    await settled();
    await page.waitForFunction(() => document.querySelector('.image-preview img')?.src.startsWith('blob:'));
    const original = await dialog.locator('img').getAttribute('src');
    await checkFit(0.25);
    await checkControls();
    await page.keyboard.press('ArrowRight');
    await settled();
    assert(await page.evaluate((url) => window.__revokedUrls.includes(url), original), 'Previous original URL is released on navigation');
    assert.equal(await zoom(), '1');
    assert.equal(await dialog.locator('.image-preview__count').innerText(), '2 / 2');
    await checkFit(4);
    assert(await dialog.getByRole('button', { name: '下一张图片', exact: true }).isDisabled());
    await page.keyboard.press('ArrowLeft');
    await settled();
    await checkFit(0.25);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    assert(await tallButton.evaluate((el) => el === document.activeElement), 'Escape restores thumbnail focus');
  }
  console.log('✓ Shared raster viewer: desktop/tablet/mobile, tall/wide fit, zoom/double-click/reset, gallery, keyboard isolation and focus');

  await page.setViewportSize({ width: 1280, height: 900 });
  await tallButton.click(); await settled();
  await page.waitForFunction(() => document.querySelector('.image-preview img')?.src.startsWith('blob:'));
  const original = await dialog.locator('img').getAttribute('src');
  const imageDownload = page.waitForEvent('download');
  await dialog.getByRole('button', { name: '下载图片', exact: true }).click();
  assert.equal((await imageDownload).suggestedFilename(), '长图.png');
  await close();
  assert(await page.evaluate((url) => window.__revokedUrls.includes(url), original), 'Original URL is released on close');
  await page.evaluate(async () => { const { db } = await import('/src/store/db.ts'); await db.files.delete('preview-0'); });
  await tallButton.click(); await settled();
  assert.match(await dialog.locator('img').getAttribute('src'), /^data:image/, 'A cleaned-up original still falls back to the persisted thumbnail');
  await close();
  for (const kind of ['svg', 'mermaid', 'diagram']) {
    await page.getByTestId(`${kind}-block`).getByTestId(`${kind}-more`).click();
    await page.getByTestId(`${kind}-zoom`).click();
    await settled();
    await dialog.locator('.image-preview__svg svg').waitFor();
    await checkControls();
    if (kind === 'mermaid') {
      assert.match((await dialog.locator('foreignObject').allTextContents()).join(''), /开始/);
    }
    const download = page.waitForEvent('download');
    await dialog.getByRole('button', { name: '下载 SVG', exact: true }).click();
    const file = await download;
    assert.match(file.suggestedFilename(), /\.svg$/);
    const text = await readFile(await file.path(), 'utf8');
    assert(text.startsWith('<?xml') && text.includes('<svg'));
    if (kind === 'svg') {
      assert.match(text, /共享矢量预览/);
      await checkFit(4);
      await page.setViewportSize({ width: 390, height: 844 });
      await checkFit(4);
      await page.screenshot({ path: 'e2e-shots/unified-preview-svg-mobile.png', animations: 'disabled' });
      await page.setViewportSize({ width: 1280, height: 900 });
    }
    await close();
  }
  console.log('✓ SVG / Mermaid / diagram share controls; foreignObject labels and vector downloads retained');

  const materialButton = page.getByRole('button', { name: '放大查看：材料长图', exact: true });
  await page.locator('.material-image').filter({ hasText: '材料长图' }).scrollIntoViewIfNeeded();
  await materialButton.click(); await settled();
  await checkFit(0.25);
  await checkControls();
  await dialog.getByRole('link', { name: /打开原文/ }).waitFor();
  const materialDownload = page.waitForEvent('download');
  await dialog.getByRole('button', { name: '下载图片', exact: true }).click();
  assert.equal((await materialDownload).suggestedFilename(), '材料长图.png');
  await close();
  await page.getByRole('link', { name: '材料原图链接', exact: true }).click(); await settled();
  assert.equal(await zoom(), '1');
  // Dismiss by backdrop as well as Escape and the common close button.
  await page.mouse.click(5, 5);
  await dialog.waitFor({ state: 'hidden' });
  assert.deepEqual(errors, []);
  console.log('✓ Material image and link use shared preview, source link, original download, reopen reset and backdrop dismissal; no page errors');
} finally { await browser.close(); }
