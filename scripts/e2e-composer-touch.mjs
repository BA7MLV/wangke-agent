import assert from 'node:assert/strict';
import { chromium, devices, webkit } from 'playwright';

const base = process.env.BASE_URL || 'http://localhost:5173';
for (const [name, engine, device] of [
  ['Chromium', chromium, devices['Pixel 7']],
  ['WebKit', webkit, devices['iPhone 13']],
]) {
  const browser = await engine.launch({ headless: true, ...(name === 'Chromium' ? { channel: 'chrome' } : {}) });
  try {
    const context = await browser.newContext({ ...device, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await context.addInitScript(() => {
      window.testVoiceStarts = 0;
      class Recognition {
        constructor() { window.testRecognition = this; }
        start() { window.testVoiceStarts++; this.onstart?.(); }
        stop() { this.onend?.(); }
        abort() { this.aborted = true; this.onend?.(); }
        emit(text) { this.onresult?.({ results: [[{ transcript: text }]] }); }
      }
      window.SpeechRecognition = Recognition;
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/v1/cloud/status', route => route.fulfill({ json: { cloud: false } }));
    await page.route('https://models.dev/**', route => route.fulfill({ json: {} }));
    await page.goto(base);
    const input = page.getByRole('textbox', { name: '给 AI 助手发送消息', exact: true });
    await input.waitFor();
    await page.waitForFunction(() => {
      const input = document.querySelector('textarea.course-chat__input');
      return input && !input.disabled && input.closest('.voice-input-target');
    });
    const draft = '用于检查手机输入框上下滚动的长草稿。\n'.repeat(60);
    await input.fill(draft);
    await input.evaluate(element => { element.blur(); element.scrollTop = 0; });
    assert(await input.evaluate(element => element.scrollHeight > element.clientHeight), 'draft must overflow');
    assert(await input.evaluate(element => {
      for (let node = element; node; node = node.parentElement) {
        if (getComputedStyle(node).touchAction === 'none') return false;
      }
      return true;
    }), `${name}: input and its ancestors must allow native touch panning`);

    // WebKit cannot dispatch native swipe gestures through Playwright. Check the
    // cancelable touchmove contract there as well as Chromium's actual panning.
    const touchMovePrevented = () => input.evaluate(element => {
      const event = new Event('touchmove', { bubbles: true, cancelable: true });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    });
    assert.equal(await touchMovePrevented(), false, 'ordinary moves are not intercepted');
    const box = await input.boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    if (name === 'Chromium') {
      const cdp = await context.newCDPSession(page);
      const touch = (type, y) => cdp.send('Input.dispatchTouchEvent', {
        type, touchPoints: y == null ? [] : [{ x, y, id: 1 }],
      });
      const move = async (from, to) => {
        for (let step = 1; step <= 10; step++) {
          await touch('touchMove', from + (to - from) * step / 10);
          await page.waitForTimeout(20);
        }
      };
      const swipe = async (from, to) => {
        await touch('touchStart', from);
        await move(from, to);
        await touch('touchEnd');
        await page.waitForTimeout(450);
      };
      const upper = box.y + 12;
      const lower = box.y + box.height - 12;
      await swipe(lower, upper);
      const scrolled = await input.evaluate(element => element.scrollTop);
      assert(scrolled > 40, 'a real upward swipe scrolls down the draft');
      await swipe(upper, lower);
      assert(await input.evaluate(element => element.scrollTop) < scrolled - 40, 'a downward swipe scrolls back');
      assert.equal(await page.evaluate(() => window.testVoiceStarts), 0, 'swiping does not start voice input');
      assert.equal(await input.inputValue(), draft, 'swiping leaves the draft unchanged');

      await touch('touchStart', y);
      await page.getByTestId('chat-voice-hold').waitFor();
      const heldTop = await input.evaluate(element => element.scrollTop);
      assert.equal(await touchMovePrevented(), true, 'only active holds intercept touchmove');
      await page.evaluate(() => window.testRecognition.emit('应当取消'));
      await move(y, y - 90);
      assert.equal(await page.getByTestId('chat-voice-hold').getAttribute('data-cancel'), 'true');
      assert.equal(await input.evaluate(element => element.scrollTop), heldTop, 'active voice slides do not scroll the draft');
      await touch('touchEnd');
      await page.getByTestId('chat-voice-hold').waitFor({ state: 'detached' });
      assert.equal(await input.inputValue(), draft, 'sliding up cancels without changing the draft');
      assert.equal(await page.evaluate(() => window.testRecognition.aborted), true);

      await touch('touchStart', y);
      await page.getByTestId('chat-voice-hold').waitFor();
      await page.evaluate(() => window.testRecognition.emit('继续补充'));
      await move(y, y - 90);
      await move(y - 90, y);
      assert.equal(await page.getByTestId('chat-voice-hold').getAttribute('data-cancel'), 'false');
      await touch('touchEnd');
      await page.waitForFunction(() => document.querySelector('textarea.course-chat__input').value.endsWith('继续补充'));

      const saved = await input.inputValue();
      await touch('touchStart', y);
      await page.getByTestId('chat-voice-hold').waitFor();
      await page.evaluate(() => window.testRecognition.emit('中断后丢弃'));
      await touch('touchCancel');
      await page.getByTestId('chat-voice-hold').waitFor({ state: 'detached' });
      await page.evaluate(() => window.testRecognition.emit('迟到结果'));
      assert.equal(await input.inputValue(), saved, 'interruption discards provisional and late results');
      assert.equal(await touchMovePrevented(), false, 'interruption restores native panning');
      await input.evaluate(element => { element.blur(); element.scrollTop = 0; });
      const starts = await page.evaluate(() => window.testVoiceStarts);
      await swipe(lower, upper);
      assert(await input.evaluate(element => element.scrollTop) > 40, 'native scrolling still works after voice input');
      assert.equal(await page.evaluate(() => window.testVoiceStarts), starts);
      await cdp.detach();
    } else {
      // Mouse holds exercise the shared gesture state; touchmove is dispatched
      // separately so this also checks WebKit's non-passive listener behavior.
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.getByTestId('chat-voice-hold').waitFor();
      assert.equal(await touchMovePrevented(), true, 'WebKit intercepts touchmove during an active hold');
      await page.evaluate(() => window.testRecognition.emit('应当取消'));
      await page.mouse.move(x, y - 90);
      assert.equal(await page.getByTestId('chat-voice-hold').getAttribute('data-cancel'), 'true');
      await page.mouse.up();
      assert.equal(await input.inputValue(), draft);
      assert.equal(await touchMovePrevented(), false, 'WebKit restores native panning after release');
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.getByTestId('chat-voice-hold').waitFor();
      await page.evaluate(() => window.testRecognition.emit('补充语音'));
      await page.mouse.up();
      await page.waitForFunction(() => document.querySelector('textarea.course-chat__input').value.endsWith('补充语音'));
    }
    assert.deepEqual(errors, []);
    console.log(`PASS ${name}: long-draft panning, hold-only touch interception, slide cancellation and voice completion`);
  } finally {
    await browser.close();
  }
}
