// 次级页面的 Material You 回归：窄屏功能保留、键盘 disclosure、语义颜色与热力图滚动。
// 在独立浏览器上下文中写入测试记录，不接触用户浏览器数据，也不调用 AI 接口。
// BASE_URL=http://127.0.0.1:5180 node scripts/probe-secondary-material.mjs
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const base = process.env.BASE_URL ?? 'http://127.0.0.1:5180';
const shots = process.env.SHOTS_DIR ?? 'e2e-shots/secondary-material';
await mkdir(shots, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const theme of ['light', 'dark']) {
    for (const width of [360, 390, 768, 1440]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 768 });
      await context.addInitScript(({ theme }) => {
        localStorage.setItem('wangke-settings', JSON.stringify({
          version: 1,
          state: { theme, thinkingEnabled: true, thinkingEffort: 'high', llmModel: 'deepseek-ai/DeepSeek-V4-Flash', studyTrackingEnabled: false },
        }));
      }, { theme });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`${base}/#/chat`, { waitUntil: 'networkidle' });
      await page.locator('.course-chat__effort').waitFor({ state: 'visible' });
      assert.ok(await page.locator('.course-chat__delete-action mdui-button-icon').isVisible(), `${theme}/${width}: 删除会话可见`);
      const geometry = await page.evaluate(() => {
        const toolbar = document.querySelector('.course-chat__toolbar').getBoundingClientRect();
        const selectors = ['.course-chat__session-select', '.course-chat__delete-action', '.course-chat__effort', '[data-testid="model-picker"]', '[data-testid="skill-picker"]'];
        return {
          clipped: selectors.filter((selector) => {
            const rect = document.querySelector(selector).getBoundingClientRect();
            return rect.left < toolbar.left - 1 || rect.right > toolbar.right + 1 || rect.bottom > toolbar.bottom + 1;
          }),
          messageHeight: document.querySelector('.course-chat__messages').clientHeight,
          horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
        };
      });
      assert.deepEqual(geometry.clipped, [], `${theme}/${width}: 工具栏没有裁切`);
      assert.ok(geometry.messageHeight > 160, `${theme}/${width}: 消息区保留有效空间`);
      assert.equal(geometry.horizontalOverflow, false, `${theme}/${width}: 没有页面横向溢出`);

      await page.evaluate(async () => {
        const database = await new Promise((resolve, reject) => {
          const request = indexedDB.open('wangke');
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const sessions = await new Promise((resolve, reject) => {
          const request = database.transaction('chatSessions').objectStore('chatSessions').getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const session = sessions
          .filter((entry) => entry.videoId === '__library_assistant__')
          .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];
        const transaction = database.transaction('chats', 'readwrite');
        const store = transaction.objectStore('chats');
        store.add({ videoId: session.videoId, sessionId: session.id, role: 'user', content: '请概括我的课程学习情况。', createdAt: 1 });
        store.add({ videoId: session.videoId, sessionId: session.id, role: 'assistant', content: '可以先完成已经开始的课程，再安排新主题。', reasoning: '先查看学习进度，再给出建议。', createdAt: 2 });
        await new Promise((resolve, reject) => {
          transaction.oncomplete = resolve;
          transaction.onerror = () => reject(transaction.error);
        });
        database.close();
      });
      await page.reload({ waitUntil: 'networkidle' });
      const reasoning = page.locator('button.course-chat__reason-toggle');
      await reasoning.focus();
      await page.keyboard.press('Enter');
      assert.equal(await reasoning.getAttribute('aria-expanded'), 'true');
      assert.ok(await page.locator('.course-chat__reason-body').isVisible());
      const bubbleColor = await page.locator('.course-chat__bubble--user').evaluate((element) => {
        const style = getComputedStyle(element);
        const sample = document.createElement('span');
        sample.style.color = 'rgb(var(--mdui-color-on-secondary-container))';
        sample.style.backgroundColor = 'rgb(var(--mdui-color-secondary-container))';
        element.append(sample);
        const expected = getComputedStyle(sample);
        const matches = style.backgroundColor === expected.backgroundColor && style.color === expected.color;
        sample.remove();
        return matches;
      });
      assert.ok(bubbleColor, `${theme}/${width}: 用户气泡使用配对的 secondary-container 角色`);
      await page.screenshot({ path: `${shots}/chat-${theme}-${width}.png`, fullPage: true });

      await page.goto(`${base}/#/study`, { waitUntil: 'networkidle' });
      const heatmap = page.locator('[data-testid="heat-scroll"]');
      await heatmap.focus();
      assert.equal(await heatmap.getAttribute('tabindex'), '0');
      assert.equal(await page.locator('[data-testid="study-range"]').getAttribute('aria-label'), '学习记录时间范围');
      if (width < 768) {
        const before = await heatmap.evaluate((element) => {
          element.scrollLeft = element.scrollWidth;
          return element.scrollLeft;
        });
        assert(before > 0, `${theme}/${width}: 热力图在窄屏有可滚动内容`);
        await page.keyboard.press('ArrowLeft');
        await page.waitForFunction((initial) => document.querySelector('[data-testid="heat-scroll"]').scrollLeft < initial, before);
      }
      await page.screenshot({ path: `${shots}/study-${theme}-${width}.png`, fullPage: true });
      assert.deepEqual(errors, [], `${theme}/${width}: 没有页面运行时错误`);
      console.log(`✓ ${theme} ${width}px：工具栏、disclosure、气泡色彩与学习页通过`);
      await context.close();
    }
  }
} finally {
  await browser.close();
}
