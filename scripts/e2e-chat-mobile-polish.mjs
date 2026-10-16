import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.BASE_URL || 'http://localhost:5190';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const reducedMotion of ['no-preference', 'reduce']) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(base);
    const input = page.locator('textarea[aria-label="给 AI 助手发送消息"]');
    await input.waitFor();
    for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await page.waitForTimeout(100);
      const bounds = await input.boundingBox();
      assert(bounds.x >= 0 && bounds.x + bounds.width <= viewport.width);
      assert(bounds.y > viewport.height * 0.65, 'Empty-session composer stays near the bottom');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    }
    for (let i = 0; i < 3; i++) {
      await page.getByTestId('nav-rail-open').click();
      await page.getByRole('button', { name: '关闭导航', exact: true }).click();
      await page.locator('.app-nav-backdrop').waitFor({ state: 'detached' });
    }
    await page.getByTestId('nav-rail-open').click();
    await page.getByTestId('nav-rail-settings').click();
    await page.locator('.app-nav-backdrop').waitFor({ state: 'detached' });
    const sheet = page.getByTestId('settings-modal');
    await sheet.waitFor();
    assert.equal(await sheet.getAttribute('data-placement'), 'bottom');
    await page.getByTestId('settings-nav-appearance').click();
    await page.getByTestId('settings-module-appearance').waitFor();
    await page.getByRole('button', { name: '关闭设置', exact: true }).click();
    await page.locator('.settings-sheet__backdrop').waitFor({ state: 'detached' });
    await input.fill('检查关闭后输入仍可用');
    await input.fill('');
    await page.getByTestId('chat-voice').click();
    await page.getByRole('status').filter({ hasText: '配置语音识别' }).waitFor();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByTestId('nav-rail-settings').click();
    await sheet.waitFor();
    assert.equal(await sheet.getAttribute('data-placement'), 'center', 'Desktop retains Modal');
    await page.getByRole('button', { name: '关闭设置', exact: true }).click();
    await sheet.waitFor({ state: 'detached' });
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`PASS layout, repeated drawer close, settings sheet, desktop modal, voice setup error (${reducedMotion})`);
  }

  // All audio and network activity is mocked: no microphone access or paid API calls.
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(() => {
    localStorage.setItem('wangke-settings', JSON.stringify({ state: {
      providers: [{ id: 'sf', name: 'Test', baseUrl: 'https://voice.test/v1', apiKey: 'fake', catalogId: '', serves: ['chat', 'vision', 'asr'] }],
      asrModel: { providerId: 'sf', model: 'mock-asr' },
      llmModel: { providerId: 'sf', model: 'mock-chat' },
      visionModel: { providerId: 'sf', model: 'mock-vision' },
      contextWindow: 32768,
      agentRounds: 6,
    }, version: 3 }));
    window.__tracksStopped = 0;
    navigator.mediaDevices.getUserMedia = async () => ({ getTracks: () => [{ stop: () => window.__tracksStopped++ }] });
    window.MediaRecorder = class {
      state = 'inactive';
      mimeType = 'audio/wav';
      start() { this.state = 'recording'; }
      stop() {
        this.state = 'inactive';
        const buffer = new ArrayBuffer(44 + 16000);
        const view = new DataView(buffer);
        const text = (offset, str) => [...str].forEach((ch, i) => view.setUint8(offset + i, ch.charCodeAt(0)));
        text(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
        view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
        view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
        text(36, 'data'); view.setUint32(40, 16000, true);
        queueMicrotask(() => { this.ondataavailable?.({ data: new Blob([buffer], { type: this.mimeType }) }); this.onstop?.(); });
      }
    };
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => console.error(error));
  let transcriptions = 0;
  await page.route('https://voice.test/v1/audio/transcriptions', async (route) => {
    transcriptions++;
    await route.fulfill({ json: { text: '这是一段语音草稿' } });
  });
  await page.goto(base);
  const voice = page.getByTestId('chat-voice');
  await voice.waitFor();
  const input = page.locator('textarea[aria-label="给 AI 助手发送消息"]');
  await input.fill('原有草稿');
  const box = await voice.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.getByRole('status').filter({ hasText: '正在聆听' }).waitFor();
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('textarea').value.includes('这是一段语音草稿'));
  assert.equal(await input.inputValue(), '原有草稿 这是一段语音草稿');
  assert.equal(transcriptions, 1);
  assert(await page.evaluate(() => window.__tracksStopped > 0));
  assert.equal(await page.getByTestId('chat-user-message').count(), 0, 'Dictation must not auto-send');
  await voice.click();
  await page.getByRole('status').filter({ hasText: '正在聆听' }).waitFor();
  await voice.click();
  await page.waitForFunction(() => document.querySelector('textarea').value.endsWith('语音草稿 这是一段语音草稿'));
  assert.equal(transcriptions, 2);
  console.log('PASS mocked hold/release and tap dictation, append draft, tracks stopped, no auto-send');
  await context.close();
} finally {
  await browser.close();
}
