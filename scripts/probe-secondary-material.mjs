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
        const readSessions = async (database) =>
          new Promise((resolve, reject) => {
            const request = database.transaction('chatSessions').objectStore('chatSessions').getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });

        const database = await new Promise((resolve, reject) => {
          const request = indexedDB.open('wangke');
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });

        /**
         * 首个会话行是 store 的 `bootstrap()` **异步**建的（没有就现建一个）。
         * 这里必须轮询等它落库 —— 抢在它前面读会拿到空数组，
         * 于是这轮探针静默地什么也没种进去，后面查思考链必然扑空（随机失败，排查起来最费时间）。
         */
        let targets = [];
        for (let attempt = 0; attempt < 100 && targets.length === 0; attempt += 1) {
          targets = (await readSessions(database))
            .filter((entry) => entry.videoId === '__library_assistant__');
          if (targets.length === 0) await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (targets.length === 0) throw new Error('等不到课程助手的会话行，bootstrap() 没跑？');

        /**
         * 种进**每一个**课程助手会话，而不是「最新的那个」。
         *
         * dev 下 StrictMode 会把 effect 跑两遍，`bootstrap()` 里 `ready` 的置位发生在
         * await 之后，两次调用都认为「还没 ready」，于是**建了两个会话**，页面随后展示的是
         * 后建的那个。只往单个会话里种，就有一半概率种了个页面上根本不会打开的会话 ——
         * 表现是随机失败，跟这轮探针要验的东西毫无关系。
         */
        const transaction = database.transaction('chats', 'readwrite');
        const store = transaction.objectStore('chats');
        const now = Date.now();
        for (const target of targets) {
          // 用真实时间戳：消息按 createdAt 排序，1/2 这种常量会让它们排到会话最前面
          store.add({ videoId: target.videoId, sessionId: target.id, role: 'user', content: '请概括我的课程学习情况。', createdAt: now });
          store.add({ videoId: target.videoId, sessionId: target.id, role: 'assistant', content: '可以先完成已经开始的课程，再安排新主题。', reasoning: '先查看学习进度，再给出建议。', reasoningMs: 7340, createdAt: now + 1 });
        }
        await new Promise((resolve, reject) => {
          transaction.oncomplete = resolve;
          transaction.onerror = () => reject(transaction.error);
        });
        database.close();
      });
      await page.reload({ waitUntil: 'networkidle' });
      // 会话是异步从 IndexedDB 灌进 store 的，reload 后不会同步就绪。
      // 不等它就去查思考链，会随机扑空（消息压根还没挂上 DOM）。
      await page.locator('.course-chat__message').first().waitFor({ state: 'attached', timeout: 15000 });
      const reasoning = page.locator('button.reasoning-chain__toggle');
      await reasoning.focus();
      await page.keyboard.press('Enter');
      assert.equal(await reasoning.getAttribute('aria-expanded'), 'true');
      // 正文是 0fr → 1fr 的 grid 轨道，展开有几百毫秒的过渡。
      // isVisible() 只查当下的盒子，紧跟着按回车去查，高度还停在动画起点（=0）→ 误报。
      await page.locator('.reasoning-chain__body').waitFor({ state: 'visible', timeout: 3000 });
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
