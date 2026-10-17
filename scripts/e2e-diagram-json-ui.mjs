import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  await page.goto(process.env.BASE_URL || 'http://localhost:5173');
  await page.evaluate(async () => {
    const { default: React } = await import('/node_modules/.vite/deps/react.js');
    const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { default: Diagram } = await import('/src/components/mermaid/JsonDiagramBlock.tsx');
    const host = document.createElement('div');
    document.body.replaceChildren(host);
    const root = ReactDOM.createRoot(host);
    window.drawDiagram = (code, closed) => root.render(React.createElement(Diagram, { code, closed, title: '学习进度' }));
    window.drawDiagram('{', false);
  });
  await page.locator('[data-phase="waiting"]').waitFor();
  assert.equal(await page.locator('[data-testid="diagram-source"]').count(), 0);
  const doc = { type: 'chart', kind: 'bar', data: [{ label: '已学', value: 8 }, { label: '待学', value: 4 }] };
  const raw = JSON.stringify(doc);
  await page.evaluate(raw => window.drawDiagram(raw.slice(0, raw.indexOf('},{') + 1), false), raw);
  await page.locator('[data-dkey="datum:0"]').waitFor();
  await page.evaluate(() => { window.firstRoot = document.querySelector('[data-testid="diagram-canvas-root"] svg'); });
  await page.evaluate(raw => window.drawDiagram(raw, false), raw);
  await page.locator('[data-dkey="datum:1"]').waitFor();
  await page.evaluate(() => { window.firstDatum = document.querySelector('[data-dkey="datum:0"]'); });
  await page.evaluate(raw => window.drawDiagram(raw, true), raw);
  await page.locator('[data-phase="ok"]').waitFor();
  assert.ok(await page.evaluate(() => window.firstRoot === document.querySelector('[data-testid="diagram-canvas-root"] svg')));
  assert.ok(await page.evaluate(() => window.firstDatum === document.querySelector('[data-dkey="datum:0"]')));
  assert.equal(await page.locator('[data-testid="diagram-live"]').count(), 0);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const [file] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '下载 JSON', exact: true }).click(),
  ]);
  assert.equal(file.suggestedFilename(), '学习进度.json');
  const stream = await file.createReadStream();
  let text = ''; for await (const chunk of stream) text += chunk;
  assert.deepEqual(JSON.parse(text), doc);
  await page.getByRole('button', { name: '查看大图', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.screenshot({ path: 'e2e-shots/diagram-json-mobile.png' });
  await page.evaluate(() => window.drawDiagram('{"type":"chart","kind":"pie","data":[{"label":"错","value":-1}]}', true));
  await page.getByRole('alert').waitFor();
  assert.equal(await page.locator('[data-testid="diagram-download-json"]').count(), 0);
  console.log('PASS: mobile HeroUI, incremental chart, stable final DOM, JSON round-trip, modal keyboard, invalid data');
} finally { await browser.close(); }
