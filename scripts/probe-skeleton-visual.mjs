/* eslint-disable no-console */
// 骨架屏的**视觉**核验：光有断言（元素出没出现）不够，还得看一眼它长什么样。
//
// 断言只能证明「骨架元素在 DOM 里出现过」，证明不了：
//   · 它是不是和真卡片对齐（对不齐 = 加载完抖一下，比不显示更差）
//   · 深浅色下底色对不对（写死灰值在深色下会变成一块发光白斑）
//   · 呼吸动画有没有在动
// 这三件事只能靠截图看。所以这个脚本产出四张图给人眼过：
//   skel-1-slow-desktop.png   慢速路径：露出的骨架（浅色）
//   skel-2-final-desktop.png  同一页内容就位后的样子（与上一张对比高度/对齐）
//   skel-3-slow-dark.png      慢速路径（深色）
//   skel-4-slow-mobile.png    慢速路径（窄屏单列）
//
// 几何那一条已经由 scripts/probe-loading-latency.mjs 的 H 组按 ±4px 断言了，
// 这里只管「底色对不对、像不像、有没有在动」这些数不出来、只能用眼睛判断的事。
//
// ── 两个必须守住的量测前提（都踩过，都静默出错） ─────────────────────────────
//
// 1. **每张图都要在自己的 context 里先导入一次视频。**
//    `browser.newContext()` 是隔离存储（相当于无痕）：IndexedDB / OPFS 各自独立。
//    不导入的话资料库是空的 → 走「空库」分支，骨架永远不会出现，
//    截出来全是空态（看着还挺正常，其实全错）。
//
// 2. **不要和骨架的独占窗口赛跑 —— 把状态钉住。**
//    骨架独占只有几百毫秒，而降速下「等元素出现 + 截一帧」的往返本身就要好几秒，
//    于是截图落在窗口之外是常态。这个脚本先后踩过两次：
//    先是**静默**写出一张「内容已就位」的图、文件名却叫 `skel-1-slow-desktop`；
//    改成「截完回读状态校验」之后，又把降速从 30× 一路加到 120× 仍然全部失败 ——
//    因为问题不在窗口不够长，而在**校验读数发生在截图之后**，测的根本不是那一刻。
//    现在的做法是把「加载中」直接钉住（见 PIN_LOADING），不降速、不赛跑。
//
// 用法：node scripts/probe-skeleton-visual.mjs   （需先 npm run preview）
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173';
const LIBRARY_URL = `${BASE}/#/library`;
const TEST_FILE = process.env.TEST_FILE || '/tmp/wangke-test.mp4';
const OUT = join(__dirname, '..', 'e2e-shots', 'skeleton');
const WAIT_MS = 60000;

/**
 * 把「加载中」钉住的脚本（与 probe-loading-latency.mjs 的 H 组同源）。
 *
 * 让 IndexedDB 请求的 success / error 永不派发 → 库读一直悬着 → `loadState` 停在
 * `loading` → 骨架稳定留在台上。不降速、不赛跑，截图想什么时候截就什么时候截。
 * 捕获阶段注册 + `stopImmediatePropagation` 能同时挡住 Dexie 用的
 * `addEventListener` 与 `onsuccess` 属性两条路（实测确认）。
 */
const PIN_LOADING = `
(() => {
  const realOpen = indexedDB.open.bind(indexedDB);
  indexedDB.open = function (...args) {
    const req = realOpen(...args);
    for (const type of ['success', 'error']) {
      req.addEventListener(type, (e) => e.stopImmediatePropagation(), true);
    }
    return req;
  };
})();
`;

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true });

/**
 * 在一个隔离 context 里造数据 → （可选）钉住加载态 → 冷启动 → 截图。
 * 返回截图那一刻的实际 DOM 状态，供调用方校验。
 */
async function capture({ name, pin, dark = false, viewport }) {
  const context = await browser.newContext({
    viewport,
    colorScheme: dark ? 'dark' : 'light',
  });
  const page = await context.newPage();

  // ① 造数据
  await page.goto(LIBRARY_URL, { waitUntil: 'load' });
  await page.waitForSelector('[data-testid="import-input"]', { timeout: WAIT_MS });
  await page.setInputFiles('[data-testid="import-input"]', TEST_FILE);
  await page.waitForSelector('[data-testid="video-item"]', { timeout: 120000 });

  // ② 钉住加载态（只影响之后的导航，所以必须排在导入之后）
  if (pin) await page.addInitScript({ content: PIN_LOADING });

  // ③ 冷启动（先 about:blank，否则同 hash 的 goto 不会重新加载文档）
  await page.goto('about:blank');
  await page.goto(LIBRARY_URL, { waitUntil: 'load' });

  if (pin) {
    await page.waitForSelector('[data-testid="library-skeleton"]', { timeout: WAIT_MS });
  } else {
    await page.waitForSelector('[data-testid="video-item"]', { timeout: WAIT_MS });
    await page.waitForTimeout(600); // 让交叉淡入走完
  }

  const file = join(OUT, `${name}.png`);
  await page.screenshot({ path: file });

  // 发布前校验：状态是钉住的，所以这次回读**必然**与截图那一刻一致。
  // 正是这一点让「校验发生在截图之后」不再是个问题。
  const state = await page.evaluate(() => ({
    skeleton: !!document.querySelector('[data-testid="library-skeleton"]'),
    content: !!document.querySelector('[data-testid="video-item"]'),
  }));
  await context.close();
  return { file, state };
}

/** 骨架图：必须是「骨架在场、内容还没来」 */
async function shootSkeleton({ name, dark = false, viewport }) {
  const { file, state } = await capture({ name, pin: true, dark, viewport });
  if (!state.skeleton || state.content) {
    throw new Error(`${name}: 截到的不是骨架（骨架在=${state.skeleton} / 内容已在=${state.content}）`);
  }
  console.log(`  → ${file}  [骨架在=${state.skeleton} 内容已在=${state.content}]`);
}

/** 内容图：不钉住，等交叉淡入走完 */
async function shootFinal({ name, viewport }) {
  const { file, state } = await capture({ name, pin: false, viewport });
  if (!state.content) throw new Error(`${name}: 内容没就位`);
  console.log(`  → ${file}  [内容已在=true]`);
}

await shootSkeleton({ name: 'skel-1-loading-desktop', viewport: { width: 1280, height: 900 } });
await shootFinal({ name: 'skel-2-final-desktop', viewport: { width: 1280, height: 900 } });
await shootSkeleton({ name: 'skel-3-loading-dark', dark: true, viewport: { width: 1280, height: 900 } });
await shootSkeleton({ name: 'skel-4-loading-mobile', viewport: { width: 420, height: 900 } });

await browser.close();
console.log(`\n截图写入 ${OUT}`);
