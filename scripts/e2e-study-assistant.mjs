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
    await page.evaluate(async (deps) => {
      const { default: refresh } = await import('/@react-refresh');
      refresh.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {};
      window.$RefreshSig$ = () => (type) => type;
      window.__vite_plugin_react_preamble_installed__ = true;
      const { default: React } = await import(`${deps}/react.js`);
      const { default: ReactDOM } = await import(`${deps}/react-dom_client.js`);
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
    }, process.env.VITE_DEPS_URL || '/node_modules/.vite/deps');
    await page.getByTestId('panel-chat-add').waitFor();
    await page.waitForFunction(() => !document.querySelector('[data-testid="panel-chat-add"]').disabled);
  };
  await mount();
  const panel = page.getByTestId('study-assistant-panel');
  const anchorBox = page.locator('.study-assistant');
  assert.equal(await page.getByTestId('study-assistant-toggle').isVisible(), false, '展开时隐藏悬浮入口');
  assert.equal(await page.getByRole('button', { name: '收起学习助手', exact: true }).count(), 1, '展开时只有一个收起按钮');
  const initialSize = await panel.boundingBox();
  assert.equal(Math.round(initialSize.width), 420, '首次展开宽度适中');
  assert.equal(Math.round(initialSize.height), 520, '首次展开高度适中');
  const input = page.getByRole('textbox', { name: '给学习助手发送消息' });
  await input.fill('保留这份草稿');
  assert.equal(await page.locator('[data-testid="chat-model-bar"]').count(), 0);
  assert.equal(await page.getByTestId('chat-composer').getByTestId('model-picker').count(), 0);
  await page.getByTestId('panel-chat-add').click();
  await page.getByTestId('model-picker').click();
  await page.getByRole('searchbox', { name: '搜索已添加模型' }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByTestId('model-picker').waitFor({ state: 'detached' });
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
  const handle = page.getByTestId('study-assistant-resize-nw');
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
  await page.mouse.move(cancelCorner.x + 8, cancelCorner.y + 8);
  await page.mouse.down();
  await page.mouse.move(cancelCorner.x - 24, cancelCorner.y - 24, { steps: 4 });
  await handle.dispatchEvent('pointercancel', { pointerId: 1 });
  await page.mouse.up();
  assert.equal(Math.round((await panel.boundingBox()).width), Math.round(after.width + 10));
  await page.getByTestId('study-assistant-close').click();
  await panel.waitFor({ state: 'hidden' });
  assert.equal(await page.getByTestId('study-assistant-toggle').evaluate((element) => element === document.activeElement), true, '收起后焦点回到入口');
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
  await page.getByTestId('study-assistant-resize-n').focus();
  await page.keyboard.press('Home');
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.waitForFunction(() => Math.round(document.querySelector('[data-testid="study-assistant-panel"]').getBoundingClientRect().width) === 420);
  await input.fill('保留这份草稿');
  assert.equal(await page.getByTestId('study-assistant-resize').count(), 0, '不再显示单独的缩放按钮');
  for (const edge of ['n', 'e', 's', 'w', 'nw', 'ne', 'sw', 'se']) {
    await page.getByTestId('study-assistant-resize-n').focus();
    await page.keyboard.press('Home');
    const original = await panel.boundingBox();
    const anchor = await anchorBox.boundingBox();
    const edgeHandle = page.getByTestId(`study-assistant-resize-${edge}`);
    const hit = await edgeHandle.boundingBox();
    const x = hit.x + hit.width / 2, y = hit.y + hit.height / 2;
    await page.mouse.move(x, y);
    const cursor = await edgeHandle.evaluate((element) => getComputedStyle(element).cursor);
    assert.ok(cursor.endsWith('-resize'), `${edge} 显示对应的缩放光标`);
    await page.mouse.down();
    await page.mouse.move(x - 40, y - 30, { steps: 8 });
    await page.mouse.up();
    const resized = await panel.boundingBox();
    const widthDelta = edge.includes('w') ? 40 : edge.includes('e') ? -40 : 0;
    const heightDelta = edge.includes('n') ? 30 : edge.includes('s') ? -30 : 0;
    assert.equal(Math.round(resized.width - original.width), widthDelta, `${edge} 宽度变化正确`);
    assert.equal(Math.round(resized.height - original.height), heightDelta, `${edge} 高度变化正确`);
    assert.equal(Math.round(resized.x - original.x), edge.includes('w') ? -40 : 0, `${edge} 固定非拖动的水平边`);
    assert.equal(Math.round(resized.y - original.y), edge.includes('n') ? -30 : 0, `${edge} 固定非拖动的垂直边`);
    assert.deepEqual(await anchorBox.boundingBox(), anchor, `${edge} 缩放时入口不移动`);
    assert.equal(await input.inputValue(), '保留这份草稿');
  }
  await page.getByTestId('study-assistant-resize-n').focus();
  await page.keyboard.press('Home');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const anchorBeforeMotion = await anchorBox.boundingBox();
  await page.getByTestId('study-assistant-close').click();
  assert.equal(await panel.evaluate((element) => element.inert), true, '退出过渡期间不再响应点击和键盘');
  await panel.waitFor({ state: 'hidden' });
  const opening = await page.evaluate(() => {
    document.querySelector('[data-testid="study-assistant-toggle"]').click();
    return new Promise((resolve) => requestAnimationFrame(() => {
      const element = document.querySelector('[data-testid="study-assistant-panel"]');
      resolve(element.getAnimations().map((animation) => animation.transitionProperty));
    }));
  });
  assert.ok(opening.includes('opacity'), '打开时实际执行淡入过渡，而不是只声明时长');
  await panel.waitFor();
  assert.equal(await panel.evaluate((element) => getComputedStyle(element).transitionDuration), '0.15s, 0.15s');
  await page.waitForFunction(() => document.querySelector('[data-testid="study-assistant-panel"]').getAnimations().length === 0);
  assert.equal(await panel.evaluate((element) => getComputedStyle(element).opacity), '1', '过渡结束后面板完全可见');
  const anchorAfterMotion = await anchorBox.boundingBox();
  assert.deepEqual(anchorAfterMotion, anchorBeforeMotion, '过渡只作用在面板，入口不缩放、不移位');
  assert.equal(await panel.evaluate((element) => element.contains(document.activeElement)), true, '打开后焦点移至可见面板，不留在已隐藏的入口');
  for (let i = 0; i < 4; i++) await page.evaluate(() => {
    const expanded = document.querySelector('.study-assistant').hasAttribute('data-expanded');
    document.querySelector(`[data-testid="study-assistant-${expanded ? 'close' : 'toggle'}"]`).click();
  });
  await page.waitForFunction(() => document.querySelector('[data-testid="study-assistant-panel"]').getAnimations().length === 0);
  await page.waitForFunction(() => !document.querySelector('[data-testid="study-assistant-panel"]').hasAttribute('hidden'));
  assert.equal(await panel.evaluate((element) => getComputedStyle(element).opacity), '1', '快速反向切换不会被过期的退出回调隐藏');
  assert.equal(await input.inputValue(), '保留这份草稿', '快速切换后草稿和可见状态正确');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await panel.evaluate((element) => getComputedStyle(element).transitionDuration), '0s');
  assert.deepEqual(errors, []);
  console.log('PASS assistant menus, drafts, resizing, persistence, focus return, narrow viewports, transitions and reduced motion');
} finally {
  await browser.close();
}
