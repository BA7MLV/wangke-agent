/* eslint-disable no-console */
// 「资料」库的新交互回归：长按整卡拖拽 → 顶栏左侧置顶 / 右侧删除。
//
// 守的都是构建与类型检查抓不到的静默失败：
//   1. 长按没进入拖拽（计时器没起 / 被按钮抢走 / 被滚动判据提前取消）；
//   2. 长按起拖后松手又把那次 click 放行 → 顺手点进了播放页；
//   3. 顶栏投放区命中判定没生效（拖过去不高亮、松手不动数据）；
//   4. 置顶项没有排到组内最前；
//   5. 手柄那条老路径被长按改动带崩。
//
// 用法：node scripts/e2e-library-pin.mjs   （需先 npm run preview）
//       BASE_URL=http://127.0.0.1:4173 node scripts/e2e-library-pin.mjs
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:4173';

let failed = 0;
const ok = (msg) => console.log(`   ✓ ${msg}`);
const fail = (msg) => {
  failed++;
  console.error(`   ❌ ${msg}`);
};
const check = (cond, msg) => (cond ? ok(msg) : fail(msg));

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-proxy-server'] });
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
page.setDefaultTimeout(8000);
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 250)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text().slice(0, 250));
});

const items = () => page.locator('[data-testid="video-item"]');
const names = () =>
  page.locator('[data-testid="video-item"] .video-row__name').evaluateAll((els) => els.map((e) => e.textContent.trim()));
const waitReady = () => page.waitForSelector('[data-testid="video-item"]', { timeout: 20000 });

/** 直接往 IndexedDB 里塞三条视频（不经过导入，省掉 OPFS 写盘与探时长）。 */
async function seed() {
  await page.evaluate(async () => {
    const rows = [
      { id: 'pin-a', name: '资料A', size: 100, mimeType: 'video/mp4', duration: 60, createdAt: 1000, status: 'new' },
      { id: 'pin-b', name: '资料B', size: 100, mimeType: 'video/mp4', duration: 60, createdAt: 3000, status: 'new' },
      { id: 'pin-c', name: '资料C', size: 100, mimeType: 'video/mp4', duration: 60, createdAt: 2000, status: 'new' },
    ];
    await new Promise((resolve, reject) => {
      const req = indexedDB.open('wangke');
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('videos', 'readwrite');
        const store = tx.objectStore('videos');
        for (const r of rows) store.put(r);
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
  });
}

/** 长按某张卡（在标题区按下，避开按钮）→ 拖到 (x,y) 仍按住。返回后调用方判断再松手。 */
async function longPressTo(targetName, x, y) {
  const nameEl = page.locator('[data-testid="video-item"]', { hasText: targetName }).locator('.video-row__name');
  await nameEl.scrollIntoViewIfNeeded();
  const box = await nameEl.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(520); // 过 LONG_PRESS_MS(400)
  await page.mouse.move(x, y, { steps: 14 });
  await page.waitForTimeout(120);
}

console.log('=== 资料库：置顶 / 删除拖拽回归 ===');

await page.goto(`${BASE}/#/library`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="drop-zone"]', { timeout: 20000 });

// ── 0. 改名：导航项与页面标题都是「资料」 ────────────────────────────────
check((await page.locator('[data-testid="nav-rail-home"]').innerText()).includes('资料'), '侧栏导航项显示「资料」');
check((await page.locator('[data-testid="top-app-bar"] h1').innerText()).trim() === '资料', '页面标题是「资料」');

await seed();
await page.reload({ waitUntil: 'networkidle' });
await waitReady();
await page.waitForTimeout(300);
check((await items().count()) === 3, `种入 3 条资料（实际 ${await items().count()}）`);
check(JSON.stringify(await names()) === JSON.stringify(['资料B', '资料C', '资料A']), `初始顺序按导入倒序（${(await names()).join(' / ')}）`);

// ── 1. 整卡长按 → 拖到顶栏左侧「置顶」 ──────────────────────────────────
// 投放区拖拽时才挂载，先起拖再量它的位置
await longPressTo('资料A', 600, 700);
await page.waitForTimeout(120);
check((await page.locator('.drag-ghost').count()) === 1, '长按后出现拖拽悬浮卡片');
const pinBox = await page.locator('[data-testid="drag-zone-pin"]').boundingBox();
const delBox = await page.locator('[data-testid="drag-zone-delete"]').boundingBox();
check(!!pinBox && !!delBox, '拖拽中顶栏出现「置顶」「删除」两个投放区');
if (pinBox) {
  await page.mouse.move(pinBox.x + pinBox.width / 2, pinBox.y + pinBox.height / 2, { steps: 10 });
  await page.waitForTimeout(120);
  check(
    await page.locator('[data-testid="drag-zone-pin"]').evaluate((e) => e.classList.contains('drag-zone--over')),
    '拖到左侧置顶区时有投放高亮',
  );
  await page.screenshot({ path: 'e2e-shots/library-drag-pin.png' });
}
await page.mouse.up();
await page.waitForTimeout(900);
check(/资料A/.test((await names())[0] ?? ''), `置顶后资料A排到最前（${(await names()).join(' / ')}）`);
check(
  await page.locator('[data-testid="video-item"]').first().evaluate((e) => e.dataset.pinned === '1'),
  '置顶项带 data-pinned=1',
);
await page.screenshot({ path: 'e2e-shots/library-pinned.png' });
check(page.url().includes('#/library'), '长按拖拽松手没有误跳路由（长按那一下 click 被吃掉）');

// ── 2. 普通点击缩略图仍能进播放页（长按逻辑没有偷走点击） ───────────────
await page.locator('[data-testid="video-item"]').first().locator('[data-testid="video-thumb"]').click();
await page.waitForTimeout(600);
check(page.url().includes('#/player/'), '普通点击缩略图照常进入播放页');
await page.goBack();
await waitReady();
await page.waitForTimeout(300);

// ── 3. 整卡长按 → 拖到顶栏右侧「删除」 → 弹确认框 ───────────────────────
await longPressTo('资料B', 600, 700);
const delBox2 = await page.locator('[data-testid="drag-zone-delete"]').boundingBox();
check(!!delBox2, '第二次拖拽仍能起拖');
if (delBox2) {
  await page.mouse.move(delBox2.x + delBox2.width / 2, delBox2.y + delBox2.height / 2, { steps: 10 });
  await page.waitForTimeout(120);
  check(
    await page.locator('[data-testid="drag-zone-delete"]').evaluate((e) => e.classList.contains('drag-zone--over')),
    '拖到右侧删除区时有投放高亮',
  );
}
await page.mouse.up();
await page.waitForTimeout(400);
check((await page.locator('[data-testid="confirm-dialog-danger"]').count()) === 1, '拖到删除区松手弹出危险确认框');
// 取消这次删除，别真的把数据删掉
await page.keyboard.press('Escape');
await page.waitForTimeout(500);
check((await items().count()) === 3, '取消删除后资料一条没少');

// ── 4. 手柄那条老路径没被长按改动带崩 ───────────────────────────────────
const handle = page.locator('[data-testid="video-item"]').first().locator('[data-testid="drag-handle"]');
const hb = await handle.boundingBox();
await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
await page.mouse.down();
await page.mouse.move(600, 700, { steps: 8 });
await page.waitForTimeout(120);
check((await page.locator('.drag-ghost').count()) === 1, '手柄按下即拖（无需长按）也出现悬浮卡片');
check((await page.locator('[data-testid="drag-zone-pin"]').count()) === 1, '手柄拖拽时同样出现顶栏投放区');
await page.mouse.up();
await page.waitForTimeout(300);

// ── 5. 手柄拖到组头仍能真移动（事件从手柄冒泡到整卡的改动不能碰坏这条） ──
await page.click('[data-testid="btn-new-folder"]');
await page.locator('[data-testid="folder-input"] input').fill('测试夹');
await page.click('[data-testid="folder-save"]');
await page.waitForTimeout(800);
const folderKey = await page
  .locator('[data-testid="group-header"]')
  .evaluateAll((els) => els.map((e) => e.dataset.groupKey).find((k) => k !== '__uncat__'));
check(!!folderKey, '新建文件夹后出现新分组');
const rowsInGroup = (k) =>
  page.evaluate(
    (key) =>
      document
        .querySelector(`[data-testid="group-header"][data-group-key="${key}"]`)
        ?.parentElement?.querySelectorAll('[data-testid="video-item"]').length ?? -1,
    k,
  );
const targetRow = page.locator('[data-testid="video-item"]', { hasText: '资料C' });
const handleC = targetRow.locator('[data-testid="drag-handle"]');
await handleC.scrollIntoViewIfNeeded();
const hbox = await handleC.boundingBox();
const hdrBox = await page.locator(`[data-testid="group-header"][data-group-key="${folderKey}"]`).boundingBox();
await page.mouse.move(hbox.x + hbox.width / 2, hbox.y + hbox.height / 2);
await page.mouse.down();
await page.mouse.move(hdrBox.x + hdrBox.width / 2, hdrBox.y + hdrBox.height / 2, { steps: 12 });
await page.waitForTimeout(200);
check(
  await page
    .locator(`[data-testid="group-header"][data-group-key="${folderKey}"]`)
    .evaluate((e) => e.classList.contains('group-header--over')),
  '拖到组头时有投放高亮',
);
await page.mouse.up();
await page.waitForTimeout(1000);
check((await rowsInGroup(folderKey)) === 1, '手柄拖拽后资料进入目标文件夹');

console.log(errors.length ? `[console/page errors]\n${errors.join('\n')}` : '无 console/page 错误');
console.log(failed === 0 && errors.length === 0 ? '\n✅ 资料库置顶/删除拖拽回归通过' : `\n❌ 有 ${failed} 项未通过${errors.length ? '（另有 console 错误）' : ''}`);
await browser.close();
process.exit(failed === 0 && errors.length === 0 ? 0 : 1);
