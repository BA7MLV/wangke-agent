// 导航角标重新挂载时保持原位；未读状态变化仍保留圆点显隐过渡。
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const layout = await readFile(new URL('../src/ui/layout.css', import.meta.url), 'utf8');
const transitions = await readFile(new URL('../src/transitions.css', import.meta.url), 'utf8');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  await page.setContent(`<style>
    :root { --badge-slide-dur: 500ms; --badge-slide-ease: ease;
      --badge-offset-x: 8px; --badge-offset-y: -8px;
      --badge-pop-dur: 500ms; --badge-pop-ease: ease;
      --badge-fade-dur: 150ms; --badge-pop-close-dur: 150ms;
      --badge-fade-close-dur: 150ms; --badge-close-ease: ease; --badge-blur: 2px; }
    button { position: relative; width: 44px; height: 44px; }
    ${layout}
    ${transitions}
  </style><button></button>`);
  // 通用动效后加载，也不能覆盖导航角标的固定定位。
  for (let mount = 0; mount < 3; mount++) {
    const state = await page.evaluate(() => {
      document.querySelector('button').innerHTML =
        '<span class="t-badge nav-unread" data-open="true"><span class="t-badge-dot"></span></span>';
      const badge = document.querySelector('.nav-unread');
      const style = getComputedStyle(badge);
      return { animation: style.animationName, transform: style.transform,
        top: style.top, right: style.right, opacity: getComputedStyle(badge.firstChild).opacity,
        transition: getComputedStyle(badge.firstChild).transitionProperty };
    });
    assert.equal(state.animation, 'none');
    assert.equal(state.transform, 'none');
    assert.equal(state.top, '8px');
    assert.equal(state.right, '8px');
    assert.equal(state.opacity, '1');
    assert.ok(state.transition.includes('opacity'));
  }
  await page.evaluate(() => document.querySelector('.nav-unread').dataset.open = 'false');
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.t-badge-dot')).opacity === '0');
  await page.evaluate(() => document.querySelector('.nav-unread').dataset.open = 'true');
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.t-badge-dot')).opacity === '1');
  console.log('✓ 导航角标重新挂载不滑动，未读显隐过渡正常');
} finally {
  await browser.close();
}
