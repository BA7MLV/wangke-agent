/* eslint-disable no-console */
import { chromium } from 'playwright';

const API_KEY = process.env.SF_KEY;
const TEST_FILE = process.env.TEST_FILE;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
page.on('console', (msg) => console.log(`[${msg.type()}]`, msg.text().slice(0, 200)));
page.on('pageerror', (err) => console.log('[pageerror]', String(err).slice(0, 500)));

await page.addInitScript((key) => {
  localStorage.setItem('wangke-settings', JSON.stringify({
    state: { apiKey: key, baseUrl: 'https://api.siliconflow.cn/v1', asrModel: 'XingChenAGI/XingChenASR-V3.2-Ultra', llmModel: 'deepseek-ai/DeepSeek-V4-Flash', visionModel: 'Qwen/Qwen3-VL-32B-Instruct' },
    version: 0,
  }));
}, API_KEY);

await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
await page.setInputFiles('input[type="file"]', TEST_FILE);
await page.waitForSelector('[data-testid="video-item"]', { timeout: 15000 });
await page.click('[data-testid="btn-play"]');
await page.waitForTimeout(5000);
await page.screenshot({ path: 'e2e-shots/debug-player.png', fullPage: true });

const info = await page.evaluate(() => {
  const mp = document.querySelector('media-player');
  const video = document.querySelector('video');
  return {
    hasMediaPlayer: !!mp,
    mpDisplay: mp ? getComputedStyle(mp).display : null,
    mpSize: mp ? `${mp.offsetWidth}x${mp.offsetHeight}` : null,
    hasVideo: !!video,
    videoSrc: video?.currentSrc?.slice(0, 50) ?? null,
    videoReadyState: video?.readyState ?? null,
    videoError: video?.error ? String(video.error.code) : null,
    bodyText: document.body.innerText.slice(0, 300),
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
