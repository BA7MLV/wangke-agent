import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, reducedMotion: 'reduce', hasTouch: viewport.width < 640 });
    await context.addInitScript(() => {
      class Recognition {
        constructor() { window.testRecognition = this; }
        start() { this.onstart?.(); }
        stop() { this.onend?.(); }
        abort() { this.aborted = true; this.onend?.(); }
        emit(text) { this.onresult?.({ results: [[{ transcript: text }]] }); }
      }
      window.SpeechRecognition = Recognition;
    });
    const page = await context.newPage();
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      return ['localhost', '127.0.0.1'].includes(url.hostname) ? route.continue() : route.abort();
    });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(process.env.BASE_URL || 'http://localhost:5173');
    const input = page.getByRole('textbox', { name: '给 AI 助手发送消息' });
    await input.waitFor();
    await page.locator('.course-chat__empty h2').waitFor();
    await page.locator('.course-chat__starters').waitFor();
    await page.getByTestId('chat-voice').waitFor();
    assert.equal(await page.getByTestId('chat-send').count(), 0);
    const geometry = () => page.evaluate(() => {
      const rect = (selector) => {
        const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect();
        return { x, y, width, height };
      };
      return {
        title: rect('.course-chat__empty h2'),
        card: rect('.course-chat__composer'),
        starters: rect('.course-chat__starters'),
        action: rect('.voice-input__button'),
        scrollY,
      };
    });
    const before = await geometry();
    await input.fill('一行内容');
    await page.getByTestId('chat-send').waitFor();
    assert.deepEqual(await geometry(), before, 'typing must not shift the page or action slot');
    await input.fill('多行内容\n'.repeat(80));
    assert.deepEqual(await geometry(), before, 'long input stays within the composer');
    assert.equal(await input.evaluate((el) => el.scrollHeight > el.clientHeight), true);
    await input.fill('   ');
    await page.getByTestId('chat-voice').waitFor();
    await input.fill('');
    await page.getByTestId('chat-voice').click();
    assert.equal(await page.evaluate(() => window.testRecognition.interimResults), true);
    await page.evaluate(() => window.testRecognition.emit('实时'));
    await page.waitForFunction(() => document.querySelector('textarea').value === '实时');
    await page.getByTestId('chat-send').waitFor();
    await page.evaluate(() => window.testRecognition.emit('实时转写测试'));
    await page.waitForFunction(() => document.querySelector('textarea').value === '实时转写测试');
    assert.deepEqual(await geometry(), before, 'live dictation must not move surrounding content');
    await page.getByRole('button', { name: '结束语音', exact: true }).click();
    assert.equal(await input.inputValue(), '实时转写测试');
    // Manual corrections cancel recognition, and stale callbacks cannot overwrite them.
    await input.fill('');
    await page.getByTestId('chat-voice').click();
    await page.evaluate(() => window.testRecognition.emit('未完成'));
    await page.waitForFunction(() => document.querySelector('textarea').value === '未完成');
    await input.fill('手动更正');
    await page.evaluate(() => window.testRecognition.emit('迟到的识别结果'));
    assert.equal(await input.inputValue(), '手动更正');
    assert.equal(await page.evaluate(() => window.testRecognition.aborted), true);
    // Send while listening: one send, microphone off, no late refill.
    await input.fill('');
    await page.getByTestId('chat-voice').click();
    await page.evaluate(() => window.testRecognition.emit('发送这一句'));
    await page.waitForFunction(() => document.querySelector('textarea').value === '发送这一句');
    await page.evaluate(async () => {
      // Vite's HMR graph may use a timestamped URL. Import that exact module,
      // not a second, unversioned store instance.
      const moduleUrl = performance.getEntriesByType('resource')
        .find((entry) => new URL(entry.name).pathname === '/src/store/courseChat.ts')?.name;
      const { useCourseChat } = await import(moduleUrl || '/src/store/courseChat.ts');
      useCourseChat.setState({ send: async (text) => {
        window.sentTexts = [...(window.sentTexts || []), text];
        useCourseChat.setState({ draft: '' });
      } });
    });
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await page.getByTestId('chat-send').click();
    await page.evaluate(() => window.testRecognition.emit('不应回填'));
    assert.deepEqual(await page.evaluate(() => window.sentTexts), ['发送这一句']);
    assert.equal(await input.inputValue(), '');
    await page.getByTestId('chat-voice').waitFor();
    await page.getByTestId('chat-voice').click();
    await page.evaluate(() => {
      window.testRecognition.onerror({ error: 'not-allowed' });
      window.testRecognition.onend();
    });
    await page.waitForFunction(() => document.querySelector('.voice-input__status[data-error="true"]')?.textContent.includes('权限'));
    // The input area, not just the microphone, supports hold-to-talk.
    await input.fill('已有草稿');
    const box = await input.boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.getByTestId('chat-voice-hold').waitFor();
    await page.evaluate(() => window.testRecognition.emit('补充语音'));
    assert.equal(await input.inputValue(), '已有草稿', 'held results stay provisional until release');
    await page.mouse.up();
    await page.waitForFunction(() => document.querySelector('textarea').value === '已有草稿 补充语音');
    assert.deepEqual(await page.evaluate(() => window.sentTexts), ['发送这一句'], 'release must not send');
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.getByTestId('chat-voice-hold').waitFor();
    await page.evaluate(() => window.testRecognition.emit('应当丢弃'));
    await page.mouse.move(x, y - 90);
    assert.equal(await page.getByTestId('chat-voice-hold').getAttribute('data-cancel'), 'true');
    await page.mouse.up();
    await page.evaluate(() => window.testRecognition.emit('取消后的迟到结果'));
    assert.equal(await input.inputValue(), '已有草稿 补充语音', 'cancel preserves the original draft');
    assert.equal(await page.evaluate(() => window.testRecognition.aborted), true);
    // Move back down before release to resume the same recording.
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.getByTestId('chat-voice-hold').waitFor();
    await page.evaluate(() => window.testRecognition.emit('继续说话'));
    await page.mouse.move(x, y - 90);
    await page.mouse.move(x, y);
    assert.equal(await page.getByTestId('chat-voice-hold').getAttribute('data-cancel'), 'false');
    await page.mouse.up();
    await page.waitForFunction(() => document.querySelector('textarea').value.endsWith('继续说话'));
    // Let go before permission resolves: abort, ignore any late onstart/results.
    await page.evaluate(() => {
      window.SpeechRecognition.prototype.start = function () {};
    });
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.getByTestId('chat-voice-hold').waitFor();
    const saved = await input.inputValue();
    await page.mouse.up();
    await page.evaluate(() => {
      window.testRecognition.onstart?.();
      window.testRecognition.emit('权限晚到');
    });
    assert.equal(await input.inputValue(), saved);
    assert.equal(await page.evaluate(() => window.testRecognition.aborted), true);
    assert.equal(await page.getByTestId('chat-voice-hold').count(), 0);
    if (viewport.width < 640) {
      await page.evaluate(() => {
        window.SpeechRecognition.prototype.start = function () { this.onstart?.(); };
      });
      const cdp = await context.newCDPSession(page);
      const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
      await touch('touchStart', [{ x, y }]);
      await page.getByTestId('chat-voice-hold').waitFor();
      await page.evaluate(() => window.testRecognition.emit('触屏取消'));
      await touch('touchMove', [{ x, y: y - 90 }]);
      assert.equal(await page.getByTestId('chat-voice-hold').getAttribute('data-cancel'), 'true');
      await touch('touchEnd', []);
      assert.equal(await input.inputValue(), saved, 'real touch slide cancels without changing the draft');
      await touch('touchStart', [{ x, y }]);
      await page.getByTestId('chat-voice-hold').waitFor();
      await page.evaluate(() => window.testRecognition.emit('触屏完成'));
      await touch('touchEnd', []);
      await page.waitForFunction(() => document.querySelector('textarea').value.endsWith('触屏完成'));
      await cdp.detach();
    }
    assert.deepEqual(errors, []);
    console.log(`PASS ${viewport.width}px: stable composer, live dictation, whole-composer hold, release, slide cancel/resume, draft preservation, late permissions`);
    await context.close();
  }
} finally {
  await browser.close();
}
