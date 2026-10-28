import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const base = process.env.BASE_URL || 'http://localhost:5188';
const out = process.env.SHOTS || 'test-results/chat-shell';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.loadTestModule = path => {
      const entry = performance.getEntriesByType('resource').findLast(entry => new URL(entry.name).pathname === path);
      return import(entry?.name ?? path);
    };
  });
  await page.goto(base);
  await page.getByTestId('nav-rail-home').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="nav-rail-home"]')?.getAttribute('aria-selected') === 'true');
  assert.ok(await page.getByTestId('nav-rail-home').evaluate(el => parseFloat(getComputedStyle(el).borderRadius) >= el.clientHeight / 2));
  assert.equal(await page.locator('.page-shell__surface').evaluate(el => getComputedStyle(el).borderRadius), '18px');
  await page.evaluate(() => {
    window.railWidths = [];
    const until = performance.now() + 800;
    const sample = () => {
      const rail = document.querySelector('.page-shell__rail');
      const surface = document.querySelector('.page-shell__surface');
      window.railWidths.push([rail.getBoundingClientRect().width, surface.getBoundingClientRect().left]);
      if (performance.now() < until) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.getByTestId('nav-rail-toggle').click();
  await page.getByTestId('nav-rail-compact').waitFor();
  await page.waitForFunction(() => Math.round(document.querySelector('.page-shell__rail').getBoundingClientRect().width) === 60);
  assert.ok(await page.evaluate(() => window.railWidths.some(([width, left]) => width > 61 && width < 263 && Math.abs(width - left) < 1)), 'sidebar and main content move together through intermediate widths');
  assert.equal(Math.round((await page.getByTestId('nav-rail-compact').boundingBox()).width), 60);
  assert.equal(await page.getByTestId('nav-rail-home').getAttribute('aria-current'), 'page');
  await page.getByTestId('nav-rail-chat').click();
  await page.getByTestId('course-chat-page').waitFor();
  await page.reload();
  await page.getByTestId('nav-rail-compact').waitFor();
  await page.screenshot({ path: `${out}/desktop-collapsed.png`, animations: 'disabled' });
  await page.getByTestId('nav-rail-toggle').click();
  await page.getByTestId('nav-rail').waitFor();
  await page.screenshot({ path: `${out}/desktop-expanded.png`, animations: 'disabled' });

  // Real Bot UI, local deterministic transport: no model/network calls.
  await page.evaluate(async () => {
    const { serverClient } = await window.loadTestModule('/src/api/serverClient.ts');
    const thread = { id: 'shell-test', mode: 'bot', title: '测试会话', agentId: 'agent-test', archived: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages: [], approvals: [] };
    serverClient.bootstrapStatus = async () => ({ initialized: true });
    serverClient.session = async () => ({ authenticated: true, user: { id: 'test', name: 'Test' } });
    serverClient.threads = async () => ({ threads: [thread] });
    serverClient.agents = async () => ({ agents: [{ id: 'agent-test', name: '学习助手', enabled: true }] });
    serverClient.thread = async () => thread;
    serverClient.events = async (_id, _cursor, receive, signal) => {
      window.botTestReceive = receive;
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    };
    serverClient.sendMessage = async (_id, content, nonce) => {
      window.sentText = content;
      return { id: crypto.randomUUID(), threadId: thread.id, clientNonce: nonce, seq: 1, role: 'user', kind: 'text', content, createdAt: new Date().toISOString(), replyTo: null };
    };
    serverClient.stopThread = async () => ({ stopped: true });
    (await window.loadTestModule('/src/store/botPanel.ts')).useBotPanel.getState().setOpen(true);
  });
  const bot = page.getByTestId('bot-panel');
  const input = bot.locator('textarea');
  await input.waitFor();
  assert.equal(await bot.locator('.study-composer__input').count(), 1, 'Bot uses the shared composer input');
  assert.equal(await page.getByTestId('app-aside').evaluate(el => getComputedStyle(el).borderRadius), '16px');
  await input.fill('第一行');
  await input.press('Shift+Enter');
  await input.press('b');
  assert.equal(await input.inputValue(), '第一行\nb');
  await input.dispatchEvent('compositionstart');
  await input.press('Enter');
  assert.equal(await page.evaluate(() => window.sentText), undefined, 'IME confirmation does not send');
  await input.dispatchEvent('compositionend');
  await bot.getByRole('button', { name: '发送', exact: true }).click();
  const receipt = bot.getByTestId('message-receipt');
  await receipt.waitFor({ state: 'attached' });
  assert.equal(await receipt.textContent(), '', 'no immediate receipt');
  await page.waitForFunction(() => document.querySelector('[data-testid="message-receipt"]')?.dataset.status === 'sent');
  assert.equal(await receipt.textContent(), '已送达');
  await page.waitForTimeout(1100);
  assert.equal(await receipt.textContent(), '已送达', 'optimistic running does not claim read');
  await receipt.locator('.t-text-swap').evaluate(el => {
    window.receiptExits = [];
    new MutationObserver(records => {
      window.receiptExits.push(...records.map(record => record.oldValue));
    }).observe(el, { attributes: true, attributeFilter: ['class'], attributeOldValue: true });
  });
  await page.evaluate(() => window.botTestReceive({ type: 'message.created', message: { id: 'answer', threadId: 'shell-test', clientNonce: null, seq: 2, role: 'assistant', kind: 'text', content: '收到你的消息', createdAt: new Date().toISOString(), replyTo: null } }, 1));
  assert.equal(await receipt.textContent(), '已送达', 'read is not displayed immediately on reply');
  await page.waitForFunction(() => document.querySelector('[data-testid="message-receipt"]')?.textContent === '已读');
  assert.ok(await page.evaluate(() => window.receiptExits.some(value => value?.includes('is-exit'))), 'read uses the three-phase transitions.dev swap');
  await page.screenshot({ path: `${out}/desktop-bot.png`, animations: 'disabled' });
  for (const width of [390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    await page.getByTestId('bot-panel').waitFor();
    await page.screenshot({ path: `${out}/bot-${width}.png`, animations: 'disabled' });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const bounds = await page.getByTestId('bot-panel').locator('.study-composer').boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
  }
  await page.getByTestId('bot-panel-close').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId('nav-rail-open').click();
  await page.getByTestId('nav-rail-home').click();
  await page.getByTestId('nav-rail-open').click();
  assert.ok(await page.getByTestId('nav-rail-home').evaluate(el => parseFloat(getComputedStyle(el).borderRadius) >= el.clientHeight / 2));
  // A very fast reply must still show delivery before read; restored history is already settled.
  await page.evaluate(async () => {
    const { default: React } = await window.loadTestModule('/node_modules/.vite/deps/react.js');
    const { default: ReactDOM } = await window.loadTestModule('/node_modules/.vite/deps/react-dom_client.js');
    const { default: Receipt } = await window.loadTestModule('/src/components/DeliveryReceipt.tsx');
    const host = document.createElement('div');
    host.id = 'receipt-fixture';
    document.body.append(host);
    ReactDOM.createRoot(host).render(React.createElement(React.Fragment, null,
      React.createElement(Receipt, { status: 'read', createdAt: Date.now() }),
      React.createElement(Receipt, { status: 'read', createdAt: Date.now() - 60_000 })));
  });
  const fast = page.locator('#receipt-fixture [data-testid="message-receipt"]').first();
  const history = page.locator('#receipt-fixture [data-testid="message-receipt"]').last();
  await history.waitFor({ state: 'attached' });
  assert.equal(await history.textContent(), '已读');
  assert.equal(await fast.textContent(), '');
  await page.waitForFunction(() => document.querySelector('#receipt-fixture [data-testid="message-receipt"]')?.textContent === '已送达');
  await page.waitForTimeout(400);
  assert.equal(await fast.textContent(), '已送达', 'fast read cannot skip the delivery hold');
  await page.waitForFunction(() => document.querySelector('#receipt-fixture [data-testid="message-receipt"]')?.textContent === '已读');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await fast.locator('.t-text-swap').evaluate(el => getComputedStyle(el).transitionDuration), '0s');
  assert.deepEqual(errors, []);
  console.log('PASS: rounded selection/surfaces, persistent compact navigation, shared Bot composer, IME/newlines, delayed receipts, actual read event with text swap, mobile/tablet fit.');
} finally { await browser.close(); }
