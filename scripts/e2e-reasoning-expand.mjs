import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/__reasoning-expand-test', (route) => route.fulfill({
    contentType: 'text/html',
    body: '<html><body><div id="root"></div></body></html>',
  }));
  await page.goto(`${process.env.BASE_URL || 'http://localhost:5188'}/__reasoning-expand-test`);
  await page.evaluate(async () => {
    const { default: refresh } = await import('/@react-refresh');
    refresh.injectIntoGlobalHook(window);
    window.$RefreshReg$ = () => {};
    window.$RefreshSig$ = () => (type) => type;
    window.__vite_plugin_react_preamble_installed__ = true;
    const { default: React } = await import('/node_modules/.vite/deps/react.js');
    const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { default: ReasoningChain } = await import('/src/components/ReasoningChain.tsx');
    await import('/src/theme.css');
    await import('/src/transitions.css');
    const root = ReactDOM.createRoot(document.getElementById('root'));
    let props = {
      active: true,
      reasoning: Array.from({ length: 60 }, (_, i) => `第 ${i + 1} 行思考内容`).join('\n'),
    };
    window.renderReasoning = (next) => {
      props = { ...props, ...next };
      root.render(React.createElement(ReasoningChain, props));
    };
    window.renderReasoning({});
  });
  const chain = page.getByTestId('response-process');
  const toggle = page.getByTestId('response-process-toggle');
  const body = page.locator('.reasoning-chain__body');
  const indicator = toggle.locator('.reasoning-chain__indicator');
  const assertArrow = async (expanded) => {
    assert.equal(await indicator.locator('path').count() > 0, true);
    assert.equal(await indicator.evaluate((el) => el.classList.contains('tabler-icon-chevron-right')), true);
    assert.equal(await indicator.evaluate((el) => getComputedStyle(el).transform),
      expanded ? 'matrix(0, 1, -1, 0, 0, 0)' : 'matrix(1, 0, 0, 1, 0, 0)');
  };
  const mode = (value) => page.waitForFunction(
    (expected) => document.querySelector('[data-testid="response-process"]')?.dataset.mode === expected, value);
  for (const width of [320, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await mode('live');
    assert.equal(await body.evaluate((el) => el.scrollHeight > el.clientHeight), true);
    await assertArrow(false);
    const mask = await body.evaluate((el) => getComputedStyle(el).maskImage);
    assert.notEqual(mask, 'none');
    for (const edge of ['top', 'bottom']) {
      await body.evaluate((el, edge) => { el.scrollTop = edge === 'top' ? 0 : el.scrollHeight; }, edge);
      await page.waitForTimeout(100);
      assert.equal(await body.evaluate((el) => getComputedStyle(el).maskImage), mask);
    }
    await toggle.click();
    await mode('expanded');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    await assertArrow(true);
    assert.equal(await body.evaluate((el) => getComputedStyle(el).maskImage), 'none');
    assert.equal(await page.getByRole('button').count(), 1);
    assert.equal(await body.evaluate((el) => el.scrollHeight <= el.clientHeight + 1), true);
    assert.equal(await chain.getAttribute('data-streaming'), 'true');
    assert.equal(await page.getByTestId('reasoning-elapsed').count(), 1);
    await page.evaluate(() => window.renderReasoning({ reasoning: '新增内容\n'.repeat(80) }));
    await mode('expanded');
    await toggle.click();
    await mode('closed');
    await assertArrow(false);
    await toggle.click();
    await mode('expanded');
    await assertArrow(true);
    await page.evaluate(() => window.renderReasoning({ active: false }));
    await page.waitForFunction(() => !document.querySelector('[data-streaming]'));
    await mode('expanded');
    await assertArrow(true);
    await toggle.click();
    await mode('closed');
    await assertArrow(false);
    await page.evaluate(() => window.renderReasoning({ active: true }));
    await mode('live');
    await page.evaluate(() => window.renderReasoning({ active: false }));
    await mode('closed');
    await assertArrow(false);
    await page.evaluate(() => window.renderReasoning({ active: true }));
    await mode('live');
    console.log(`PASS right-arrow preview, down-arrow full expansion, persistent edge fades, collapse and completion at ${width}px`);
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
