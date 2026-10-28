import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:5173';
const shots = new URL('../e2e-shots/', import.meta.url);
await mkdir(shots, { recursive: true });
const examples = await readFile(new URL('../packages/study-core/assets/builtin/interactive-explainer/references/examples.md', import.meta.url), 'utf8');
const source = examples.match(/```html\n([\s\S]*?)\n```/)[1].replace('const api = window.__wbw;', 'const api = window.__wbw; root.dataset.runToken = String(Math.random());');
const sources = [source, source.replaceAll('quadratic-explorer', 'second-explorer').replaceAll('抛物线的开口', '对照另一个系数')];
const sse = (delta, finish_reason = 'stop') => 'data: ' + JSON.stringify({ choices: [{ delta, finish_reason }] }) + '\n\ndata: [DONE]\n\n';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, reducedMotion: 'reduce' });
  await context.addInitScript(() => {
    if (window.top !== window) return;
    window.__widgetTestImport = (path) => {
      const resource = performance.getEntriesByType('resource').findLast((entry) => new URL(entry.name).pathname === path);
      return import(resource?.name ?? path);
    };
    if (!localStorage.getItem('wangke-settings')) localStorage.setItem('wangke-settings', JSON.stringify({ version: 3, state: {
      theme: 'light', fontScale: 'standard', accentColor: 'blue',
      providers: [{ id: 'test', name: 'Test', baseUrl: 'https://layout.test/v1', apiKey: 'test', serves: ['chat'], catalogId: 'siliconflow-cn' }],
      llmModel: { providerId: 'test', model: 'test-model' },
    } }));
  });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  const errors = [], requests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let revision = source.replace('抛物线的开口', '修改后的开口');
  await context.route('https://layout.test/**', async (route) => {
    const body = route.request().postDataJSON();
    requests.push(body);
    if (!body.stream) {
      await route.fulfill({ json: { choices: [{ message: { role: 'assistant', content: JSON.stringify({ source: revision }) } }] } });
      return;
    }
    const refs = body.messages.filter((message) => message.role === 'tool').flatMap((message) => [...String(message.content).matchAll(/```wbw-widget\n[^\n]+\n```/g)].map((match) => match[0]));
    await route.fulfill({ contentType: 'text/event-stream', body: refs.length
      ? sse({ role: 'assistant', content: `先固定坐标范围，观察系数对开口的影响。\n\n${refs[0]}\n\n再独立调整下面的系数，对照两条曲线。\n\n${refs[1]}\n\n同一坐标范围下，系数的绝对值越大，曲线越陡。` })
      : sse({ role: 'assistant', tool_calls: sources.map((code, index) => ({ index, id: `draw-${index}`, type: 'function', function: { name: 'show_widget', arguments: JSON.stringify({ format: 'html', code }) } })) }, 'tool_calls') });
  });
  await page.goto(BASE);
  const composer = page.getByRole('textbox', { name: '给 AI 助手发送消息' });
  await composer.fill('用两个图对照系数如何影响抛物线开口，各放在对应的说明旁。');
  await composer.press('Enter');
  await page.getByText('同一坐标范围下，系数的绝对值越大，曲线越陡。', { exact: true }).waitFor();
  await page.waitForFunction(async () => !(await window.__widgetTestImport('/src/store/courseChat.ts')).useCourseChat.getState().loading);
  const row = await page.evaluate(async () => {
    const { useCourseChat } = await window.__widgetTestImport('/src/store/courseChat.ts');
    const { db } = await window.__widgetTestImport('/src/store/db.ts');
    return db.chats.get(useCourseChat.getState().messages.at(-1).rowId);
  });
  assert.equal(row.widgets.length, 2, 'real tool callbacks persist both visuals instead of overwriting');
  assert.equal(row.widget.id, row.widgets[1].id, 'legacy alias remains compatible');
  assert.notEqual(row.widgets[0].id, row.widgets[1].id);
  assert.equal(requests.length, 2, 'one tool round and one final explanation');
  assert.match(requests[0].messages[0].content, /当前回答内容区约 \d+px 宽/, 'generation receives the actual answer-column dimensions');
  const blocks = page.getByTestId('widget-block');
  await blocks.nth(1).getByTestId('widget-frame').contentFrame().getByRole('slider').waitFor();
  assert.equal(await blocks.count(), 2, 'inline references do not duplicate end-of-answer visuals');
  assert.equal(await page.getByRole('button', { name: '修改此 HTML', exact: true }).count(), 0, 'no persistent technical edit row');
  const placement = await page.locator('.course-chat__bubble--ai').last().evaluate((element) => {
    const texts = [...element.querySelectorAll('p')].filter((node) => node.textContent.includes('再独立调整'));
    const frames = element.querySelectorAll('iframe');
    return { firstBeforeText: !!(frames[0].compareDocumentPosition(texts[0]) & Node.DOCUMENT_POSITION_FOLLOWING),
      secondBeforeText: !!(frames[1].compareDocumentPosition(texts[0]) & Node.DOCUMENT_POSITION_FOLLOWING) };
  });
  assert.ok(placement.firstBeforeText && placement.secondBeforeText, 'both delivered figures retain their positions before later explanation and reference echoes');
  const first = () => blocks.nth(0).getByTestId('widget-frame').contentFrame();
  const second = () => blocks.nth(1).getByTestId('widget-frame').contentFrame();
  const token = await first().locator('section').getAttribute('data-run-token');
  await page.evaluate(async () => (await window.__widgetTestImport('/src/store/settings.ts')).useSettings.getState().update({ accentColor: 'rose', fontScale: 'xlarge', theme: 'dark' }));
  await first().locator('html[data-wbw-theme="dark"][style*="17.5px"]').waitFor();
  const theme = await first().locator('body').evaluate((element) => ({ fontSize: getComputedStyle(element).fontSize,
    accent: getComputedStyle(element).getPropertyValue('--wbw-accent').trim(),
    family: getComputedStyle(element).fontFamily }));
  const host = await page.locator('.course-chat__bubble--ai').last().evaluate((element) => ({ accent: getComputedStyle(element).getPropertyValue('--accent').trim(), family: getComputedStyle(element).fontFamily }));
  assert.equal(theme.fontSize, '17.5px');
  assert.equal(theme.accent, host.accent);
  assert.equal(theme.family, host.family);
  assert.equal(await first().locator('section').getAttribute('data-run-token'), token, 'appearance updates retain executing frames');
  // Local palettes (e.g. a course cover) must override the global accent and reach the popout.
  await page.locator('.course-chat__bubble--ai').last().evaluate((element) => element.style.setProperty('--accent', '#15803d'));
  await first().locator('html[style*="#15803d"]').waitFor();
  await blocks.first().getByTestId('widget-more').click();
  const [popup] = await Promise.all([page.waitForEvent('popup'), page.getByTestId('widget-open').click()]).catch(async (error) => {
    await page.screenshot({ path: new URL('widget-layout-debug.png', shots).pathname });
    console.log(await page.locator('body').innerText());
    throw error;
  });
  await popup.getByTestId('widget-frame').contentFrame().locator('html[style*="#15803d"][style*="17.5px"]').waitFor();
  await popup.close();
  await page.locator('.course-chat__bubble--ai').last().evaluate((element) => element.style.removeProperty('--accent'));
  await first().locator('html[style*="#e11d48"]').waitFor();
  await page.getByTestId('course-chat-messages').evaluate((element) => { element.scrollTop = 0; });
  await page.screenshot({ path: new URL('widget-inline-desktop.png', shots).pathname });
  const setCoefficient = async (frame, value) => frame.getByRole('slider').evaluate((input, value) => {
    input.value = String(value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
  await setCoefficient(first(), -2);
  await setCoefficient(second(), 2.5);
  await page.waitForFunction(async ({ id, keys }) => {
    const row = await (await window.__widgetTestImport('/src/store/db.ts')).db.chats.get(id);
    return row.widgetStates?.[keys[0]]?.modelContent['系数 a'] === -2 && row.widgetStates?.[keys[1]]?.modelContent['系数 a'] === 2.5;
  }, { id: row.id, keys: row.widgets.map((widget) => widget.id) });
  assert.equal(requests.length, 2, 'local state never requests model tokens');
  for (const width of [320, 360, 768]) {
    await page.setViewportSize({ width, height: 900 });
    await blocks.first().scrollIntoViewIfNeeded();
    await first().locator('body').evaluate(() => new Promise(resolve => {
      const ready = () => Math.abs(window.__wbw.display.width - innerWidth) <= 1;
      if (ready()) return resolve();
      const onChange = () => {
        if (!ready()) return;
        window.removeEventListener('wbw:displaychange', onChange);
        resolve();
      };
      window.addEventListener('wbw:displaychange', onChange);
    }));
    const display = await first().locator('html').evaluate(el => ({
      ...window.__wbw.display,
      cssHeight: parseFloat(getComputedStyle(el).getPropertyValue('--wbw-available-height')),
    }));
    assert(display.height > 0 && display.height <= 900 * 0.65, 'drawing height comes from host viewport');
    assert.equal(display.height, display.cssHeight, 'CSS and JS receive the same layout budget');
    assert.equal(await first().locator('section').getAttribute('data-run-token'), token, 'responsive updates preserve widget execution and state');
    const geometry = await first().locator('svg').evaluate((svg) => {
      const frame = svg.getBoundingClientRect();
      const labels = [...svg.querySelectorAll('text')].map((text) => ({ box: text.getBoundingClientRect(), size: parseFloat(getComputedStyle(text).fontSize) }));
      return { width: frame.width, viewBox: svg.viewBox.baseVal.width,
        clipped: labels.some(({ box }) => box.left < frame.left - 1 || box.right > frame.right + 1 || box.top < frame.top - 1 || box.bottom > frame.bottom + 1),
        overlapping: labels.some((a, i) => labels.slice(i + 1).some((b) => a.box.left < b.box.right && a.box.right > b.box.left && a.box.top < b.box.bottom && a.box.bottom > b.box.top)),
        minSize: Math.min(...labels.map((label) => label.size)),
        xTicks: svg.querySelector('[data-ticks]').querySelectorAll('text').length,
      };
    });
    assert.ok(Math.abs(geometry.width - geometry.viewBox) < 1, `SVG redraws at actual ${width}px width, not scaled down`);
    assert.ok(!geometry.clipped && !geometry.overlapping && geometry.minSize >= 11, `${width}px labels fit and remain readable: ${JSON.stringify(geometry)}`);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}px host does not overflow`);
    assert.ok(await first().locator('body').evaluate((body) => body.scrollWidth <= innerWidth), `${width}px widget does not overflow`);
    if (width === 320) {
      await page.getByTestId('course-chat-messages').evaluate((element) => { element.scrollTop = 0; });
      await page.screenshot({ path: new URL('widget-inline-mobile.png', shots).pathname });
    }
  }
  await page.setViewportSize({ width: 1280, height: 1000 });
  const siblingToken = await second().locator('section').getAttribute('data-run-token');
  await blocks.first().getByTestId('widget-more').click();
  await page.getByTestId('widget-edit').click();
  await page.getByRole('textbox', { name: '修改要求', exact: true }).fill('只把标题改为修改后的开口');
  // Exercise the native disclosure's keyboard path after the mobile/desktop resize cycle.
  await page.getByTestId('artifact-edit-panel').getByText('更多选项', { exact: true }).press('Enter');
  await page.getByRole('button', { name: '仅重生成此块', exact: true }).press('Enter').catch(async (error) => {
    await page.screenshot({ path: new URL('widget-edit-debug.png', shots).pathname });
    console.log(await page.locator('body').innerText());
    throw error;
  });
  await page.getByRole('button', { name: '应用修改', exact: true }).press('Enter');
  await page.getByTestId('artifact-edit-panel').waitFor({ state: 'hidden' });
  await first().getByText('修改后的开口', { exact: true }).waitFor();
  assert.equal(await second().locator('section').getAttribute('data-run-token'), siblingToken, 'editing one visual does not remount its sibling');
  assert.equal(await second().getByRole('slider').inputValue(), '2.5');
  const edited = await page.evaluate(async (id) => (await window.__widgetTestImport('/src/store/db.ts')).db.chats.get(id), row.id);
  assert.equal(edited.content, row.content, 'source edit preserves prose and reference positions');
  assert.equal(edited.widgets[0].ref, row.widgets[0].ref);
  assert.notEqual(edited.widgets[0].id, row.widgets[0].id);
  assert.equal(edited.widgetStates[row.widgets[0].id], undefined);
  assert.equal(edited.widgetStates[row.widgets[1].id].modelContent['系数 a'], 2.5);
  await page.reload();
  await page.waitForFunction(async () => (await window.__widgetTestImport('/src/store/courseChat.ts')).useCourseChat.getState().ready);
  await page.evaluate(async (id) => (await window.__widgetTestImport('/src/store/courseChat.ts')).useCourseChat.getState().loadSession(id), row.sessionId);
  await second().getByRole('slider').waitFor();
  assert.equal(await blocks.count(), 2);
  assert.equal(await first().getByRole('slider').inputValue(), '1');
  assert.equal(await second().getByRole('slider').inputValue(), '2.5');
  const fork = await page.evaluate(async ({ sessionId, id }) => {
    const { useCourseChat } = await window.__widgetTestImport('/src/store/courseChat.ts');
    const { db } = await window.__widgetTestImport('/src/store/db.ts');
    const forkId = await useCourseChat.getState().forkSession(sessionId, id);
    return (await db.chats.where('sessionId').equals(forkId).toArray()).find((row) => row.role === 'assistant');
  }, row);
  assert.equal(fork.widgets.length, 2);
  assert.ok(!fork.widgetStates && !fork.widgetState, 'forks keep sources/placement, not interaction snapshots');
  assert.deepEqual(errors, []);
  console.log('PASS: real multi-tool flow, interleaved figures, host/local theme and font scale, popout appearance, independent state, 320/360/768px label geometry, targeted edits, refresh and forks.');
} finally { await browser.close(); }
