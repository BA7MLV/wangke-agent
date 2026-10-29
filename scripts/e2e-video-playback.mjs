// Disposable real-server/browser regression. No production account or data.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wangke-video-browser-'));
Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret'), CLOUD_WORKER_DISABLED: '1' });
const { buildServer } = await import('../apps/api/src/server.ts');
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite') });
let vite, browser;
let failMedia = false;
const reads = [];
app.addHook('onRequest', async (request, reply) => {
  if (!request.url.startsWith('/api/v1/resources/courses/')) return;
  reads.push({ method: request.method, range: request.headers.range });
  if (request.method === 'GET' && failMedia) return reply.code(503).send({ error: 'fixture_network_failure' });
});
try {
  const backend = await app.listen({ host: '127.0.0.1', port: 0 });
  const call = async (method, url, payload, headers = {}) => {
    const result = await app.inject({ method, url: `/api/v1${url}`, headers: { cookie, ...headers }, ...(payload === undefined ? {} : { payload }) });
    assert.ok(result.statusCode < 300, result.body); return result.json();
  };
  let cookie = '';
  await call('POST', '/bootstrap/initialize', { adminPassword: 'playback-browser-password' }, { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() });
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/password/login', payload: { password: 'playback-browser-password' } });
  cookie = login.headers['set-cookie'].split(';')[0];
  const config = await call('GET', '/cloud/config');
  await call('PUT', '/cloud/config', { ...config, providers: [{ id: 'offline', name: 'Offline', baseUrl: 'https://offline.invalid/v1', protocol: 'openai-chat', apiKey: 'test-only', catalogId: '', serves: ['chat'] }], llmModel: { providerId: 'offline', model: 'test' }, visionModel: { providerId: '', model: '' }, asrModel: { providerId: '', model: '' }, decisionModel: { providerId: '', model: '' } });
  await call('POST', '/cloud/records', { mutations: [{ id: crypto.randomUUID(), table: 'preferences', key: 'uiLanguage', before: null, after: { id: 'uiLanguage', value: 'zh-CN' } }] });
  const root = await call('GET', '/resources');
  const fixture = path.join(directory, 'files/projects', root.rootId, 'progressive.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=15', '-t', '60', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '24', '-pix_fmt', 'yuv420p', '-g', '15', '-movflags', '+faststart', fixture]);
  // A valid trailing free box makes a 64 MiB file without allocating 64 MiB.
  // Old fetch->Blob cannot display a single frame until all of it arrives.
  const contentBytes = fs.statSync(fixture).size;
  const paddingBytes = 64 * 1024 * 1024;
  const freeBox = Buffer.alloc(8); freeBox.writeUInt32BE(paddingBytes); freeBox.write('free', 4);
  fs.appendFileSync(fixture, freeBox); fs.truncateSync(fixture, contentBytes + paddingBytes);
  const entry = (await call('GET', '/resources')).entries.find(entry => entry.name === 'progressive.mp4');
  const record = (await call('GET', `/cloud/record?table=videos&key=${encodeURIComponent(JSON.stringify(entry.courseId))}`)).value;
  await call('POST', '/cloud/records', { mutations: [{ id: crypto.randomUUID(), table: 'videos', key: record.id, before: record, after: { ...record, duration: 60, coverState: 'ready' } }] });
  process.env.WANGKE_API_PROXY = backend;
  vite = await createServer({ root: new URL('../apps/web', import.meta.url).pathname, server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, plugins: [{
    name: 'video-preview-login', configureServer(server) {
      server.middlewares.use('/__fixture_login', (_request, response) => {
        response.setHeader('set-cookie', cookie + '; Path=/; SameSite=Lax');
        response.writeHead(302, { location: `/#/player/${entry.courseId}` }); response.end();
      });
    },
  }] });
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  if (process.env.VIDEO_PREVIEW) {
    console.log(`VIDEO_PREVIEW ${origin}/__fixture_login`);
    await new Promise(resolve => process.once('SIGTERM', resolve));
  } else {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const context = await browser.newContext({ locale: 'zh-CN', serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });
    await context.route('https://models.dev/**', route => route.fulfill({ json: {} }));
    const page = await context.newPage();
    const errors = [];
    const mediaRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      if (request.url().includes(`/resources/courses/${entry.courseId}`)) mediaRequests.push({ method: request.method(), type: request.resourceType() });
    });
    const session = await context.newCDPSession(page);
    await session.send('Network.enable');
    const mediaIds = new Set();
    let received = 0;
    session.on('Network.responseReceived', event => {
      if (event.response.url.includes(`/resources/courses/${entry.courseId}`)) mediaIds.add(event.requestId);
    });
    session.on('Network.dataReceived', event => { if (mediaIds.has(event.requestId)) received += event.dataLength; });
    await page.goto(`${origin}/__fixture_login`);
    // Throttle once the application bundle is loaded, not its JS dependencies.
    await page.locator('[data-media-player]').waitFor({ timeout: 60000 });
    await session.send('Network.emulateNetworkConditions', { offline: false, latency: 50, downloadThroughput: 256 * 1024, uploadThroughput: -1 });
    const video = page.locator('[data-media-provider] video');
    await page.waitForFunction(() => document.querySelector('[data-media-provider] video')?.readyState >= 2, null, { timeout: 30000 });
    assert.ok(received < fs.statSync(fixture).size / 2, `first frame before full download: ${received} bytes`);
    assert.match(await video.evaluate(video => video.currentSrc), /\/api\/v1\/resources\/courses\//);
    assert.equal(await video.getAttribute('crossorigin'), 'use-credentials');
    assert.equal(await page.locator('.player-preview-video').count(), 0, 'preview must not download while hidden');
    assert.ok(mediaRequests.some(request => request.method === 'HEAD'));
    assert.ok(mediaRequests.filter(request => request.method === 'GET').every(request => request.type === 'media'), 'no whole-file JS fetch');
    console.log(`PASS first frame with partial download (${received} / ${fs.statSync(fixture).size} bytes)`);
    await video.evaluate(video => { video.muted = true; return video.play(); });
    await page.waitForFunction(() => document.querySelector('[data-media-provider] video')?.currentTime > .2);
    await video.evaluate(video => { video.pause(); video.currentTime = 55; });
    await page.waitForFunction(() => {
      const video = document.querySelector('[data-media-provider] video');
      return video && !video.seeking && Math.abs(video.currentTime - 55) < 1 && video.readyState >= 2;
    }, null, { timeout: 30000 });
    assert.ok(reads.some(request => request.method === 'GET' && /^bytes=[1-9]\d*-/.test(request.range ?? '')), 'seeking issues a new byte range');
    console.log('PASS authenticated native playback and seeking to an unbuffered position');
    await session.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await page.locator('.vds-time-slider').hover();
    await page.locator('.player-preview-video').waitFor();
    await page.waitForFunction(() => document.querySelector('.player-preview-video')?.readyState >= 2);
    assert.equal(await page.locator('.player-preview-video').getAttribute('crossorigin'), 'use-credentials');
    await page.mouse.move(5, 5);
    await page.locator('.player-preview-video').waitFor({ state: 'detached' });
    console.log('PASS authenticated timeline preview loads only while pointing');

    // Native media GET fails after the metadata HEAD succeeded. Diagnose/retry.
    failMedia = true;
    await session.send('Network.setCacheDisabled', { cacheDisabled: true });
    await page.reload();
    try { await page.getByTestId('player-playback-error').waitFor({ timeout: 30000 }); }
    catch (error) { console.error({ body: await page.locator('body').innerText(), pane: await page.locator('.video-pane').innerHTML(), errors, reads: reads.slice(-15), mediaRequests: mediaRequests.slice(-15) }); throw error; }
    assert.match(await page.getByTestId('player-playback-error').innerText(), /网络|中断|格式|编码/);
    failMedia = false;
    await page.getByRole('button', { name: '重新加载', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-media-provider] video')?.readyState >= 2);
    assert.equal(await page.getByTestId('player-playback-error').count(), 0);
    console.log('PASS media failure is visible and retry restores playback');

    // Local OPFS / IndexedDB still uses a releasable Blob URL.
    const local = await page.evaluate(async () => {
      const { cloud } = await import('/src/cloud/state.ts');
      const { saveVideoFile } = await import('/src/store/fileStore.ts');
      const { getVideoPlaybackSource } = await import('/src/store/videoPlayback.ts');
      cloud.enabled = false;
      try {
        await saveVideoFile('local-playback-fixture', new Blob(['local-video'], { type: 'video/mp4' }));
        const source = await getVideoPlaybackSource('local-playback-fixture', new AbortController().signal);
        const text = await (await fetch(source.src)).text();
        source.release();
        let released = false;
        try { await fetch(source.src); } catch { released = true; }
        const cancelled = new AbortController(); cancelled.abort();
        let abortRejected = false;
        try { await getVideoPlaybackSource('local-playback-fixture', cancelled.signal); } catch { abortRejected = true; }
        return { text, released, abortRejected, blob: source.src.startsWith('blob:') };
      } finally { cloud.enabled = true; }
    });
    assert.deepEqual(local, { text: 'local-video', released: true, abortRejected: true, blob: true });
    console.log('PASS local files, Blob URL cleanup and cancelled source loading');

    const access = await page.evaluate(async () => {
      const { getVideoPlaybackSource, describeVideoPlaybackError } = await import('/src/store/videoPlayback.ts');
      const originalFetch = window.fetch;
      const requests = [];
      const results = [];
      let status = 200;
      window.fetch = async (_url, init) => {
        requests.push({ method: init.method, credentials: init.credentials });
        return new Response('must-not-download', { status });
      };
      try {
        for (status of [200, 401, 403, 404, 503]) {
          try {
            const source = await getVideoPlaybackSource('access-fixture', new AbortController().signal);
            results.push(source ? 'url' : 'missing'); source?.release();
          } catch (error) { results.push(error.status); }
        }
        status = 401;
        results.push(await describeVideoPlaybackError(4, '/api/v1/resources/courses/access-fixture', new AbortController().signal));
        status = 200;
        results.push(await describeVideoPlaybackError(3, '/api/v1/resources/courses/access-fixture', new AbortController().signal));
        return { results, requests };
      } finally { window.fetch = originalFetch; }
    });
    assert.deepEqual(access.results.slice(0, 5), ['url', 401, 403, 'missing', 503]);
    assert.match(access.results[5], /登录已过期/);
    assert.match(access.results[6], /解码/);
    assert.ok(access.requests.every(request => request.method === 'HEAD' && request.credentials === 'include'));
    console.log('PASS header-only status handling distinguishes login, permissions, missing files and codecs');

    // Cancel an in-flight real fetch, not only an already-aborted signal.
    const cancellation = await page.evaluate(async () => {
      const { getVideoPlaybackSource } = await import('/src/store/videoPlayback.ts');
      const originalFetch = window.fetch;
      const controller = new AbortController();
      let observedAbort = false;
      window.fetch = (url, init) => {
        const pending = originalFetch(url, init);
        init.signal.addEventListener('abort', () => { observedAbort = true; }, { once: true });
        controller.abort();
        return pending;
      };
      try {
        await getVideoPlaybackSource('cancel-fixture', controller.signal);
        return false;
      } catch (error) { return observedAbort && error.name === 'AbortError'; }
      finally { window.fetch = originalFetch; }
    });
    assert.equal(cancellation, true);
    console.log('PASS leaving cancels an in-flight playback-source fetch');

    const localDecode = async (page) => page.evaluate(async ({ courseId, contentBytes }) => {
      const { cloud } = await import('/src/cloud/state.ts');
      const { saveVideoFile, deleteVideoFile } = await import('/src/store/fileStore.ts');
      const { getVideoPlaybackSource } = await import('/src/store/videoPlayback.ts');
      const response = await fetch(`/api/v1/resources/courses/${courseId}`, { headers: { range: `bytes=0-${contentBytes - 1}` } });
      const blob = new Blob([await response.arrayBuffer()], { type: 'video/mp4' });
      cloud.enabled = false;
      let source;
      const video = document.createElement('video');
      try {
        await saveVideoFile('local-decode-fixture', blob);
        source = await getVideoPlaybackSource('local-decode-fixture', new AbortController().signal);
        video.src = source.src;
        video.muted = true;
        video.preload = 'auto';
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('local video decode timed out')), 15_000);
          video.onloadeddata = () => { clearTimeout(timeout); resolve(); };
          video.onerror = () => { clearTimeout(timeout); reject(new Error('local video decode failed')); };
          video.load();
        });
        return source.src.startsWith('blob:') && video.readyState >= 2 && Math.abs(video.duration - 60) < 1;
      } finally {
        video.removeAttribute('src'); video.load(); source?.release();
        await deleteVideoFile('local-decode-fixture');
        cloud.enabled = true;
      }
    }, { courseId: entry.courseId, contentBytes });
    assert.equal(await localDecode(page), true);
    console.log('PASS Chromium offline file decodes through the local Blob source');

    const safari = await webkit.launchPersistentContext(path.join(directory, 'webkit-profile'), { headless: true, viewport: { width: 1280, height: 900 }, locale: 'zh-CN', serviceWorkers: 'block' });
    try {
      await safari.route('https://models.dev/**', route => route.fulfill({ json: {} }));
      const safariPage = await safari.newPage();
      const safariErrors = [];
      safariPage.on('pageerror', error => safariErrors.push(error.message));
      await safariPage.goto(`${origin}/__fixture_login`);
      await safariPage.waitForFunction(() => document.querySelector('[data-media-provider] video')?.readyState >= 2, null, { timeout: 60000 });
      const safariVideo = safariPage.locator('[data-media-provider] video');
      assert.match(await safariVideo.evaluate(video => video.currentSrc), /\/api\/v1\/resources\/courses\//);
      await safariVideo.evaluate(video => { video.currentTime = 25; });
      await safariPage.waitForFunction(() => {
        const video = document.querySelector('[data-media-provider] video');
        return video && !video.seeking && Math.abs(video.currentTime - 25) < 1 && video.readyState >= 2;
      });
      assert.deepEqual(safariErrors, []);
      assert.equal(await localDecode(safariPage), true);
      console.log('PASS WebKit authenticated progressive playback and seeking');
      console.log('PASS WebKit offline file decodes through the local Blob source');
    } finally { await safari.close(); }

    const screenshots = path.resolve('test-results/video-playback'); fs.mkdirSync(screenshots, { recursive: true });
    await page.screenshot({ path: path.join(screenshots, 'progressive-player.png') });
    // Removing the physical file must not restore the old source or hang.
    fs.unlinkSync(fixture);
    await page.reload();
    await page.getByTestId('player-file-missing').waitFor();
    await page.screenshot({ path: path.join(screenshots, 'missing-video.png') });
    console.log('PASS deleted file keeps the learning interface accessible');
    assert.deepEqual(errors, []);
  }
} finally {
  await browser?.close();
  // The deliberate abort test can leave a proxy-side keep-alive/SSE socket.
  // This is a disposable server; don't let those sockets hold teardown open.
  app.server.closeAllConnections();
  await vite?.close(); await app.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
