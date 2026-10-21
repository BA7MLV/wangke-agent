import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/__study-assistant-test', (route) => route.fulfill({
    contentType: 'text/html', body: '<html><body><div id="root"></div><div id="video-host"><video muted autoplay></video></div></body></html>',
  }));
  const mount = async () => {
    await page.goto(`${process.env.BASE_URL || 'http://localhost:5173'}/__study-assistant-test`);
    await page.evaluate(async () => {
      const { default: refresh } = await import('/@react-refresh');
      refresh.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {};
      window.$RefreshSig$ = () => (type) => type;
      window.__vite_plugin_react_preamble_installed__ = true;
      const { default: React } = await import('/node_modules/.vite/deps/react.js');
      const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
      await import('/node_modules/@heroui/styles/dist/index.css');
      const { default: StudyAssistant } = await import('/src/components/StudyAssistant.tsx');
      const { default: ChatPanel } = await import('/src/components/ChatPanel.tsx');
      const { db } = await import('/src/store/db.ts');
      await import('/src/theme.css');
      await import('/src/ui/layout.css');
      await db.segments.put({ videoId: 'assistant-test', idx: 0, start: 0, end: 60, text: '课程测试内容', status: 1 });
      const canvas = document.createElement('canvas');
      canvas.width = 320; canvas.height = 180;
      canvas.getContext('2d').fillRect(0, 0, 320, 180);
      const video = document.querySelector('video');
      video.srcObject = canvas.captureStream();
      await video.play();
      const playerRef = { current: { el: document.getElementById('video-host'), currentTime: 12 } };
      function Harness() {
        const [open, setOpen] = React.useState(true);
        const [activeTab, setTab] = React.useState('chat');
        return React.createElement(StudyAssistant, {
          open, onOpenChange: setOpen, activeTab, onTabChange: setTab,
          panelKeys: ['chat', 'subs'], panels: {
            chat: React.createElement(ChatPanel, { videoId: 'assistant-test', videoName: '测试课程', playerRef }),
            subs: React.createElement('p', null, '字幕测试'),
          },
        });
      }
      ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Harness));
    });
    await page.getByTestId('panel-chat-add').waitFor();
    await page.waitForFunction(() => !document.querySelector('[data-testid="panel-chat-add"]').disabled);
  };
  await mount();
  const panel = page.getByTestId('study-assistant-panel');
  const input = page.getByRole('textbox', { name: '给学习助手发送消息' });
  await input.fill('保留这份草稿');
  assert.equal(await page.locator('[data-testid="chat-model-bar"]').count(), 0);
  await page.getByTestId('chat-composer').getByTestId('model-picker').click();
  await page.getByRole('searchbox', { name: '搜索已添加模型' }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByTestId('panel-chat-add').click();
  await page.getByTestId('shot-btn').click();
  assert.equal(await page.locator('.chat-shots--pending .chat-shot').count(), 1);
  await page.getByTestId('panel-chat-add').click();
  await page.getByTestId('quiz-btn').waitFor();
  await page.getByRole('menuitem', { name: '技能范围' }).click();
  await page.getByTestId('skill-picker-dialog').waitFor();
  await page.keyboard.press('Escape');
  await page.getByTestId('skill-picker-dialog').waitFor({ state: 'hidden' });
  const before = await panel.boundingBox();
  const handle = page.getByTestId('study-assistant-resize');
  const corner = await handle.boundingBox();
  await handle.click({ trial: true });
  await page.mouse.move(corner.x + 12, corner.y + 12);
  await page.mouse.down();
  await page.mouse.move(corner.x - 108, corner.y - 68, { steps: 12 });
  await page.mouse.up();
  await page.waitForFunction(() => !document.querySelector('[data-resizing]'));
  const after = await panel.boundingBox();
  assert.equal(Math.round(after.width - before.width), 120);
  assert.equal(Math.round(after.height - before.height), 80);
  assert.equal(await input.inputValue(), '保留这份草稿');
  await page.getByTestId('panel-tab-subs').click();
  await page.getByTestId('panel-tab-chat').click();
  assert.equal(await input.inputValue(), '保留这份草稿');
  await handle.focus();
  await page.keyboard.press('ArrowLeft');
  assert.equal(Math.round((await panel.boundingBox()).width), Math.round(after.width + 10));
  const cancelCorner = await handle.boundingBox();
  await page.mouse.move(cancelCorner.x + 16, cancelCorner.y + 16);
  await page.mouse.down();
  await page.mouse.move(cancelCorner.x - 24, cancelCorner.y - 24, { steps: 4 });
  await handle.dispatchEvent('pointercancel', { pointerId: 1 });
  await page.mouse.up();
  assert.equal(Math.round((await panel.boundingBox()).width), Math.round(after.width + 10));
  await page.getByTestId('study-assistant-toggle').click();
  await panel.waitFor({ state: 'hidden' });
  await page.getByTestId('study-assistant-toggle').click();
  assert.equal(await input.inputValue(), '保留这份草稿');
  await mount();
  assert.equal(Math.round((await panel.boundingBox()).width), Math.round(after.width + 10));
  for (const width of [375, 320]) {
    await page.setViewportSize({ width, height: 740 });
    await page.waitForFunction(() => document.querySelector('.study-assistant').getBoundingClientRect().right <= innerWidth);
    const bounds = await panel.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= width);
    const send = await page.getByTestId('chat-send').boundingBox();
    assert.ok(send.x + send.width <= width);
  }
  await page.getByTestId('study-assistant-resize').focus();
  await page.keyboard.press('Home');
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.waitForFunction(() => Math.round(document.querySelector('[data-testid="study-assistant-panel"]').getBoundingClientRect().width) === 480);
  assert.deepEqual(errors, []);
  console.log('PASS assistant menus, screenshot draft, model picker, resizing, keyboard controls, persistence and narrow viewports');
} finally {
  await browser.close();
}
