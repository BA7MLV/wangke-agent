import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';

// Tests the page-side contract, NOT the native Safari / Android browser chrome.
// Use real devices for toolbar tinting, Home Screen launch and safe-area env values.
const base = process.env.BASE_URL || 'http://localhost:5173';
const output = process.env.SHOTS_DIR || '/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/browser-chrome';
await mkdir(output, { recursive: true });

for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
  const browser = await engine.launch(name === 'chromium' ? { channel: 'chrome', headless: true } : { headless: true });
  try {
    for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }, { width: 1280, height: 900 }]) {
      const context = await browser.newContext({ viewport, colorScheme: 'light', reducedMotion: 'reduce' });
      const page = await context.newPage();
      page.setDefaultTimeout(20000);
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.route('**/api/v1/cloud/status', (route) => route.fulfill({ json: { cloud: false } }));
      await page.route('https://models.dev/**', (route) => route.fulfill({ json: {} }));
      await page.addInitScript(() => {
        localStorage.setItem('wangke-settings', JSON.stringify({ version: 5, state: {
          theme: 'light', dynamicColor: true, studyTrackingEnabled: false,
        } }));
        window.__chromeImport = (path) => {
          const resource = performance.getEntriesByType('resource').findLast((entry) => new URL(entry.name).pathname === path);
          return import(resource?.name || path);
        };
      });
      await page.goto(`${base}/#/chat`);
      await page.getByTestId('top-app-bar').waitFor();
      const settings = (patch) => page.evaluate(async (patch) => {
        (await window.__chromeImport('/src/store/settings.ts')).useSettings.getState().update(patch);
      }, patch);
      const read = () => page.evaluate(() => {
        const edge = document.querySelector('.page-shell__top-edge');
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = getComputedStyle(edge).backgroundColor;
        ctx.fillRect(0, 0, 1, 1);
        const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
        return {
          edge: `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`,
          meta: document.querySelector('meta[name="theme-color"]').content,
          root: document.documentElement.style.getPropertyValue('--browser-chrome-color'),
          alpha: a, brightness: (r + g + b) / 3,
          width: edge.getBoundingClientRect().width, top: edge.getBoundingClientRect().top,
          height: edge.getBoundingClientRect().height,
          blur: [...document.querySelectorAll('.page-app-bar__blur > span')].map((span) => getComputedStyle(span).backdropFilter),
          overlay: getComputedStyle(document.querySelector('.page-app-bar__blur'), '::after').backgroundImage,
        };
      });
      const consistent = async () => {
        await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--browser-chrome-color') === document.querySelector('meta[name="theme-color"]').content);
        const state = await read();
        assert.equal(state.edge, state.meta, 'visible edge and theme-color match');
        assert.equal(state.root, state.meta, 'root fallback and theme-color match');
        assert.equal(state.alpha, 255, 'sampling edge is opaque');
        assert.equal(state.width, viewport.width, 'sampling edge spans the viewport');
        assert.equal(state.top, 0);
        return state;
      };
      const capture = async (suffix) => {
        const state = await consistent();
        const png = await page.screenshot({ path: `${output}/${name}-${viewport.width}-${suffix}.png` });
        const pixel = await page.evaluate(async (data) => {
          const image = new Image();
          image.src = `data:image/png;base64,${data}`;
          await image.decode();
          const canvas = document.createElement('canvas');
          canvas.width = image.width;
          canvas.height = image.height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(image, 0, 0);
          return [...ctx.getImageData(Math.floor(image.width / 2), 1, 1, 1).data];
        }, png.toString('base64'));
        const expected = state.meta.slice(1).match(/../g).map((hex) => parseInt(hex, 16));
        expected.forEach((value, channel) => assert.ok(Math.abs(pixel[channel] - value) <= 1, 'rendered top pixel matches browser UI color'));
      };
      const light = await consistent();
      assert.ok(light.brightness > 200);
      assert.equal(light.height, 4);
      assert.deepEqual(light.blur, ['blur(1px)', 'blur(2px)', 'blur(4px)', 'blur(8px)']);
      assert.match(light.overlay, /gradient/);
      await settings({ theme: 'dark' });
      await page.waitForFunction(() => document.documentElement.classList.contains('dark'));
      const dark = await consistent();
      assert.ok(dark.brightness < 80);
      assert.notEqual(dark.meta, light.meta);
      await settings({ theme: 'auto' });
      await page.waitForFunction(() => !document.documentElement.classList.contains('dark'));
      assert.equal((await consistent()).meta, light.meta);
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.waitForFunction(() => document.documentElement.classList.contains('dark'));
      assert.equal((await consistent()).meta, dark.meta, 'auto tracks live system changes');

      // Real Player -> useDynamicColor -> PageShell, including asynchronous image decode.
      await page.evaluate(async (engineName) => {
        const { db } = await window.__chromeImport('/src/store/db.ts');
        const folderId = await db.folders.add({ name: '顶部取色回归', createdAt: Date.now() });
        await db.videos.put({ id: 'chrome-test', folderId, name: '顶部取色', duration: 60, size: 0, mimeType: 'video/mp4', fileDeleted: 1, createdAt: Date.now(), status: 'transcribed' });
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 48;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#3478d4';
        ctx.fillRect(0, 0, 48, 48);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve));
        // Playwright WebKit on macOS cannot persist Blob rows in IndexedDB in this environment.
        // Chromium exercises the real frames path; WebKit uses the same hook with a data URL below.
        if (engineName !== 'webkit') await db.frames.add({ videoId: 'chrome-test', ts: 0, kind: 'slide', blob });
        window.__chromeCover = canvas.toDataURL();
        location.hash = '/player/chrome-test';
      }, name);
      if (name === 'webkit') {
        await page.locator('.page-player').waitFor();
        await page.evaluate(async () => {
          const { default: React } = await import('/node_modules/.vite/deps/react.js');
          const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
          const { useDynamicColor } = await window.__chromeImport('/src/ui/theme.ts');
          const { useSettings } = await window.__chromeImport('/src/store/settings.ts');
          const target = document.querySelector('.page-player');
          const host = document.createElement('div');
          target.append(host);
          const root = ReactDOM.createRoot(host);
          function DynamicFixture() {
            const enabled = useSettings((s) => s.dynamicColor);
            const ref = useDynamicColor({ sourceUrl: window.__chromeCover, enabled });
            React.useEffect(() => { ref(target); return () => ref(null); }, [ref]);
            return null;
          }
          root.render(React.createElement(DynamicFixture));
          window.__unmountChromeFixture = () => { root.unmount(); host.remove(); };
        });
      }
      await page.locator('.page-player[data-dyn-color="on"]').waitFor();
      const dynamicDark = await consistent();
      assert.notEqual(dynamicDark.meta, dark.meta);
      assert.ok(dynamicDark.brightness < 100, 'dynamic edge stays dark in dark mode');
      await capture('dynamic-dark');
      await page.emulateMedia({ colorScheme: 'light' });
      await page.waitForFunction(() => !document.documentElement.classList.contains('dark'));
      const dynamicLight = await consistent();
      assert.ok(dynamicLight.brightness > 180);
      assert.notEqual(dynamicLight.meta, light.meta);
      await capture('dynamic-light');
      await settings({ dynamicColor: false });
      await page.waitForFunction(() => !document.querySelector('.page-player')?.hasAttribute('data-dyn-color'));
      assert.equal((await consistent()).meta, light.meta, 'disabling dynamic color restores canvas');
      await settings({ dynamicColor: true });
      await page.locator('.page-player[data-dyn-color="on"]').waitFor();
      await page.evaluate(() => { window.__unmountChromeFixture?.(); location.hash = '/study'; });
      await page.waitForFunction(() => !document.querySelector('.page-player'));
      assert.equal((await consistent()).meta, light.meta, 'navigation does not restore stale blue or cover color');

      // Scrolling stays compositor-only and cannot change the solid sampling edge.
      await page.evaluate(() => {
        const content = document.querySelector('.page-shell__content');
        const fixture = document.createElement('div');
        fixture.style.cssText = 'height:3000px;background:repeating-linear-gradient(#ed334e 0 80px,#3869dd 80px 160px)';
        content.append(fixture);
        document.querySelector('[data-testid="page-main"]').scrollTop = 1600;
      });
      assert.ok(await page.getByTestId('page-main').evaluate((main) => main.scrollTop > 0), 'content actually scrolls behind header');
      assert.equal((await consistent()).meta, light.meta);
      await capture('scroll');
      // Simulate a tall safe-area band without pretending headless browsers emulate a notch.
      await page.addStyleTag({ content: '.page-shell { --app-edge-solid-height: 47px; } [data-testid="top-app-bar"] { padding-top: 57px; }' });
      assert.equal((await consistent()).height, 47);
      assert.deepEqual(errors, [], 'no page runtime errors');
      console.log(`PASS ${name} ${viewport.width}x${viewport.height}: light/dark/auto, dynamic color, cleanup, scrolling, safe-area band`);
      await context.close();
    }
  } finally {
    await browser.close();
  }
}
