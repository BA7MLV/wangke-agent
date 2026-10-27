import assert from 'node:assert/strict';
import { chromium } from 'playwright';

// Isolated browser database; exercises the saved Markdown reader, not a chat-only preview.
const base = process.env.BASE_URL || 'http://localhost:5173';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base);
  await page.locator('textarea').first().waitFor();
  const fileId = await page.evaluate(async () => {
    const { db } = await import('/src/store/db.ts');
    const { createResourceExecutor } = await import('/src/harness/resources.ts');
    const { handoutFileOf } = await import('/src/materials/handoutFile.ts');
    const canvas = document.createElement('canvas');
    canvas.width = 960; canvas.height = 320;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#f4f7fb'; ctx.fillRect(0, 0, 960, 320);
    ctx.fillStyle = '#20334c'; ctx.font = '32px sans-serif';
    ctx.fillText('概念 → 适用条件 → 例题应用', 120, 155);
    ctx.font = '22px sans-serif'; ctx.fillText('课程原图测试', 120, 220);
    const dataUrl = canvas.toDataURL('image/png');
    const frameBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    const source = { id: 'handout-image-video', name: '讲义配图测试课程', duration: 60, fileDeleted: 1, createdAt: Date.now(), status: 'transcribed' };
    const material = { id: 'handout-image-material', name: '例题原始笔记.md', kind: 'material', materialFormat: 'md', createdAt: Date.now() };
    await db.videos.bulkPut([source, material]);
    await db.frames.add({ videoId: source.id, ts: 25.125, kind: 'slide', caption: '概念与适用条件', blob: frameBlob });
    await db.files.put({ id: material.id, blob: new Blob([`# 例题原始笔记\n\n![例题原图](${dataUrl})`]) });
    const execute = createResourceExecutor();
    const frameCatalog = await execute('read', { path: `/courses/${source.id}/frames` });
    const imageCatalog = await execute('read', { path: `/courses/${material.id}/images` });
    const frameMarkdown = frameCatalog.match(/!\[[^\]]*\]\(#source-image\/[^)]+\)/)?.[0];
    const imageMarkdown = imageCatalog.match(/!\[[^\]]*\]\(#source-image\/[^)]+\)/)?.[0];
    if (!frameMarkdown || !imageMarkdown) throw new Error('Missing real inline image references');
    const content = `# 讲义配图测试\n\n来源：讲义配图测试课程；覆盖范围：00:00–01:00。\n\n## 核心要点\n\n- 概念应结合适用条件理解。[00:00]\n- 通过原文例题核对应用步骤。[00:25]\n\n## 内容大纲\n\n- 概念与条件\n- 例题应用\n\n## 概念与条件\n\n先明确对象与边界，再核对适用条件。[00:00]\n\n${frameMarkdown}\n\n## 例题应用\n\n结合原始笔记中的例题进行复习。\n\n${imageMarkdown}\n`;
    const result = await execute('edit', { path: `/courses/${source.id}/handout.md`, create: true, content });
    if (!result.includes('已创建')) throw new Error(result);
    return handoutFileOf(source).id;
  });
  await page.goto(`${base}/#/player/${fileId}`);
  const checkHeadings = async () => {
    await page.getByText('核心要点', { exact: true }).waitFor();
    await page.getByText('内容大纲', { exact: true }).waitFor();
  };
  try { await checkHeadings(); }
  catch (error) {
    console.error('Reader state:', await page.locator('body').innerText(), 'Page errors:', errors);
    throw error;
  }
  const framePreview = page.getByRole('button', { name: '放大查看：课程画面 0:25', exact: true });
  await framePreview.scrollIntoViewIfNeeded();
  await framePreview.waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('.material-image__preview img')].some((img) => img.alt === '课程画面 0:25' && img.naturalWidth === 960));
  await framePreview.click();
  const dialog = page.getByTestId('material-image-dialog');
  await dialog.waitFor();
  assert.match(await dialog.getByRole('link', { name: /打开来源视频/ }).getAttribute('href'), /handout-image-video$/);
  await dialog.getByRole('button', { name: '下载图片', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  const materialPreview = page.getByRole('button', { name: '放大查看：例题原图', exact: true });
  await materialPreview.scrollIntoViewIfNeeded();
  await materialPreview.waitFor();
  await materialPreview.click();
  await dialog.waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="material-image-dialog"] img')?.naturalWidth === 960);
  await page.keyboard.press('Escape');
  await page.reload();
  await checkHeadings();
  await framePreview.scrollIntoViewIfNeeded();
  await framePreview.waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await framePreview.scrollIntoViewIfNeeded();
  assert(await framePreview.evaluate((el) => el.getBoundingClientRect().right <= innerWidth));
  await framePreview.click();
  await dialog.waitFor();
  assert(await dialog.evaluate((el) => el.getBoundingClientRect().width <= innerWidth));
  await page.keyboard.press('Escape');
  await page.evaluate(async () => {
    const { db } = await import('/src/store/db.ts');
    await db.frames.where('videoId').equals('handout-image-video').delete();
  });
  await page.reload();
  await checkHeadings();
  await page.getByTestId('material-image').filter({ hasText: '课程画面 0:25' }).scrollIntoViewIfNeeded();
  const missing = page.getByRole('status').filter({ hasText: '已保存的课程画面不存在，请重新读取画面目录或打开来源视频' });
  await missing.waitFor();
  await materialPreview.scrollIntoViewIfNeeded();
  await materialPreview.waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS saved handout key takeaways, outline, inline material/video images, preview/download, reload, mobile and missing-frame fallback');
} finally {
  await browser.close();
}
