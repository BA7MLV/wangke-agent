import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';

const browser = await (process.env.BROWSER === 'webkit' ? webkit : chromium).launch({
  ...(process.env.BROWSER === 'webkit' ? {} : { channel: 'chrome' }), headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(15000);
  await page.goto(process.env.BASE_URL || 'http://127.0.0.1:5188');
  await page.evaluate(async () => {
    const load = path => {
      const resource = performance.getEntriesByType('resource').findLast(entry => new URL(entry.name).pathname === path);
      return import(resource?.name ?? path);
    };
    const React = (await load('/node_modules/.vite/deps/react.js')).default;
    const { createRoot } = (await load('/node_modules/.vite/deps/react-dom_client.js')).default;
    const { default: WidgetBlock } = await load('/src/components/WidgetBlock.tsx');
    const { createToolExecutor } = await load('/src/harness/tools.ts');
    const { persistAssistantSnapshot } = await load('/src/store/assistantSnapshot.ts');
    const { widgetReference } = await load('/src/harness/widgetLayout.ts');
    const { db } = await load('/src/store/db.ts');
    const host = document.createElement('main'); host.id = 'protocol-fixture';
    host.style.cssText = 'position:fixed;inset:0;overflow:auto;background:var(--background);z-index:100;padding:20px';
    document.body.append(host);
    const root = createRoot(host, { identifierPrefix: 'protocol-test-' });
    window.__modelRequests = 0;
    window.__renderPayload = (payload, rowId) => root.render(React.createElement(WidgetBlock, {
      payload, rowId, dark: false, allowPopout: false, onPrompt: async () => { window.__modelRequests++; },
    }));
    window.__deliver = async (code, failSave = false) => {
      root.render(null);
      const execute = createToolExecutor('protocol-test', { onWidget: async payload => {
        // A failed awaited host commit must never produce a successful tool reference.
        if (failSave) throw new Error('模拟存储写入失败');
        const rowId = await persistAssistantSnapshot({ sessionId: 9901, videoId: 'protocol-test', role: 'assistant',
          content: widgetReference(payload.ref), createdAt: Date.now(), widget: payload, widgets: [payload],
          interrupted: true, interruptReason: '后续回答尚未完成' });
        window.__delivered = { payload, rowId };
        window.__renderPayload(payload, rowId);
      } });
      return execute('show_widget', { format: 'html', code });
    };
    window.__readDelivery = () => db.chats.get(window.__delivered.rowId);
    window.__cancelDelivery = async () => {
      root.render(null);
      const controller = new AbortController();
      let deliveries = 0;
      const execute = createToolExecutor('protocol-test', { signal: controller.signal, onWidget: () => { deliveries++; } });
      const pending = execute('show_widget', { format: 'html', code: '<p>取消作品</p>' });
      controller.abort();
      await pending.catch(() => {});
      return deliveries;
    };
    window.__replay = async () => {
      const row = await window.__readDelivery();
      window.__renderPayload(row.widgets[0], row.id);
    };
  });
  const host = page.locator('#protocol-fixture');
  let result = await page.evaluate(() => window.__deliver('<section><h2>无脚本静态作品</h2></section>'));
  assert.match(result, /wbw-widget/);
  await host.getByTestId('widget-frame').contentFrame().getByRole('heading', { name: '无脚本静态作品' }).waitFor();
  let saved = await page.evaluate(() => window.__readDelivery());
  assert.equal(saved.interrupted, true, 'tool delivery is already persisted before the remaining answer');
  assert.equal(saved.widgets[0].source, 'tool');
  assert.equal(saved.widgets[0].schemaVersion, 1);

  const code = '<section><label>系数<input type="range" min="1" max="5" value="2"></label><output>2</output></section><script>document.querySelector("section").dataset.run = String(Math.random());document.querySelector("input").oninput=e=>document.querySelector("output").textContent=e.target.value</script>';
  result = await page.evaluate(code => window.__deliver(code), code);
  assert.match(result, /wbw-widget/);
  const frame = () => host.getByTestId('widget-frame').contentFrame();
  await frame().getByRole('slider').fill('4');
  assert.equal(await frame().locator('output').innerText(), '4');
  const token = await frame().locator('section').getAttribute('data-run');
  await page.evaluate(() => window.__replay());
  assert.equal(await frame().locator('section').getAttribute('data-run'), token, 'same persisted revision does not remount');
  assert.equal(await page.evaluate(() => window.__modelRequests), 0, 'local controls never call a model');

  const failingCode = '<section data-run="pending">失败示例</section><script>document.querySelector("section").dataset.run=String(Math.random());throw new Error("初始化示例错误")</script>';
  await page.evaluate(code => window.__deliver(code), failingCode);
  await host.getByTestId('widget-error').waitFor();
  await host.getByText('运行详情', { exact: true }).click();
  await host.getByRole('button', { name: '查看 HTML 源码', exact: true }).click();
  assert.equal(await host.getByTestId('widget-source').textContent(), failingCode);
  const failedToken = await frame().locator('section').getAttribute('data-run');
  await host.getByRole('button', { name: '重试预览' }).click();
  await host.getByTestId('widget-error').waitFor();
  assert.notEqual(await frame().locator('section').getAttribute('data-run'), failedToken, 'retry creates a new runtime');
  assert.equal(await page.evaluate(() => window.__modelRequests), 0, 'retry is local');

  await page.evaluate(() => window.__renderPayload({ html: '<p>未来版本源码</p>', schemaVersion: 99 }));
  await host.getByRole('alert').filter({ hasText: '协议版本暂不支持' }).waitFor();
  assert.equal(await host.getByTestId('widget-frame').count(), 0);
  await host.getByRole('button', { name: '查看 HTML 源码' }).click();
  assert.equal(await host.getByTestId('widget-source').textContent(), '<p>未来版本源码</p>');
  for (const width of [320, 1100]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(await host.evaluate(el => el.scrollWidth <= el.clientWidth + 1), `${width}px: error and source remain readable`);
  }
  await page.evaluate(() => window.__renderPayload({ html: { corrupt: true }, libs: ['chart.js'] }));
  await host.getByRole('alert').filter({ hasText: '作品源码缺失或格式无效' }).waitFor();
  assert.equal(await host.getByTestId('widget-frame').count(), 0, 'malformed imported payload fails before layout or iframe construction');
  result = await page.evaluate(() => window.__deliver('<p>保存失败的作品</p>', true));
  assert.match(result, /模拟存储写入失败/);
  assert.doesNotMatch(result, /```wbw-widget/);
  await host.getByTestId('widget-block').waitFor({ state: 'detached' });
  result = await page.evaluate(() => window.__deliver('<script src="https://blocked.test/code.js"></script>'));
  assert.match(result, /外部脚本/);
  assert.doesNotMatch(result, /```wbw-widget/);
  assert.equal(await host.getByTestId('widget-frame').count(), 0);
  assert.equal(await page.evaluate(() => window.__cancelDelivery()), 0, 'cancellation during document preparation cannot deliver a runtime');
  console.log('PASS: actual show_widget static/interactive delivery, saved-before-display, replay identity, runtime errors/source/local retry, unknown versions, failed commits and 320px recovery.');
} finally { await browser.close(); }
