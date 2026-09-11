/* eslint-disable no-console */
// 「读取本机 Cookie」的回归：既测**应用侧的五种结果提示**，也直接跑一遍**真实油猴脚本的 getCookie 逻辑**。
//
// 为什么分两段：
//   1) 设置页那一段用假桥覆盖 5 种状态（没装桥 / 脚本太旧 / 扩展不给读 / 没登录 / 成功）——
//      原先这五种都被一句「没读到 Cookie：请确认已安装 2.1+…」盖住，用户无法对症；
//   2) 脚本那一段直接把 userscript/wangke-bili-bridge.user.js 跑在 Chromium 里（stub 掉 GM_cookie），
//      验证 domain 过滤、以及「取不到能力时返回 null」的契约 —— 这两点正是状态判定的依据。
//
// 用法：BASE_URL=http://localhost:4173 node scripts/e2e-bili-cookie.mjs
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE_URL || 'http://localhost:4173';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USERSCRIPT = fs.readFileSync(path.join(ROOT, 'userscript/wangke-bili-bridge.user.js'), 'utf8');

let failed = 0;
const ok = (m) => console.log(`   ✓ ${m}`);
const fail = (m) => {
  failed++;
  console.error(`   ❌ ${m}`);
};
const check = (cond, m) => (cond ? ok(m) : fail(m));

const browser = await chromium.launch({ channel: 'chrome', headless: true });

// ───────────────────────── 1) 真实脚本的 getCookie 逻辑 ─────────────────────────
console.log('\n1. 油猴脚本 getCookie()：domain 过滤与能力判定');
{
  const page = await browser.newPage();
  await page.setContent('<html data-wangke="1"><body></body></html>');

  const ALL_COOKIES = [
    { name: 'SESSDATA', value: 'sess', domain: '.bilibili.com' },
    { name: 'bili_jct', value: 'jct', domain: '.bilibili.com' },
    { name: 'buvid3', value: 'buv', domain: 'www.bilibili.com' },
    { name: 'foo', value: 'bar', domain: '.example.com' },
  ];
  // 模拟部分实现「details 为空会报错」，逼脚本走按域名逐个列举的兜底分支
  const installStub = (cookies, mode) =>
    page.evaluate(
      ([cookies, mode]) => {
        window.GM_xmlhttpRequest = () => {};
        if (mode === 'none') {
          delete window.GM_cookie;
          return;
        }
        if (mode === 'error') {
          window.GM_cookie = { list: (_d, cb) => setTimeout(() => cb(null, new Error('denied')), 0) };
          return;
        }
        window.GM_cookie = {
          list: (details, cb) => {
            if (!details || Object.keys(details).length === 0) {
              setTimeout(() => cb(null, new Error('no url or domain')), 0);
              return;
            }
            const hit = cookies.filter((c) => c.domain === details.domain || c.domain.endsWith(details.domain));
            setTimeout(() => cb(mode === 'empty' ? [] : hit, 0), 0);
          },
        };
      },
      [cookies, mode],
    );

  const runScript = async () => {
    await page.addScriptTag({ content: USERSCRIPT });
    return page.evaluate(() => window.__wangkeBiliBridge?.version ?? null);
  };
  const getCookie = () => page.evaluate(() => window.__wangkeBiliBridge.getCookie());

  await installStub(ALL_COOKIES, 'normal');
  const version = await runScript();
  check(version === '2.1.1', `脚本注入成功（v${version}）`);
  const cookie = await getCookie();
  check(
    cookie === 'SESSDATA=sess; bili_jct=jct; buvid3=buv',
    `拼接正确且滤掉别的域名（${JSON.stringify(cookie)}）`,
  );

  await installStub(ALL_COOKIES, 'empty');
  await runScript();
  check((await getCookie()) === '', '能读但没命中 → 空串（= 没登录）');

  // 真实世界的坑：整体列举「成功但空」（很多实现要求 details 带 url/domain），按域名才给结果。
  // 早先只看整体列举，会把这种情况误判成「没登录」。
  await page.evaluate(() => {
    const cookies = [
      { name: 'SESSDATA', value: 'sess', domain: '.bilibili.com' },
      { name: 'buvid3', value: 'buv', domain: 'www.bilibili.com' },
    ];
    window.GM_cookie = {
      list: (details, cb) =>
        setTimeout(() => cb(!details || !details.domain ? [] : cookies, undefined), 0),
    };
  });
  await runScript();
  check(
    (await getCookie()) === 'SESSDATA=sess; buvid3=buv',
    '整体列举成功但为空时，仍会按域名兜底查出 Cookie（不再误报「没登录」）',
  );

  await installStub(ALL_COOKIES, 'error');
  await runScript();
  check((await getCookie()) === null, '调用全失败 → null（= 扩展不给读）');

  await installStub(ALL_COOKIES, 'none');
  await runScript();
  check((await getCookie()) === null, '没有 GM_cookie → null（Safari 的 Userscripts 属于这种）');

  await page.close();
}

// ───────────────────────── 2) 设置页的五种提示 ─────────────────────────
console.log('\n2. 设置页「读取本机 Cookie」的结果提示');
const NAV_OK = { isLogin: true, uname: 'e2e 测试号' };
const FAKE_FETCH = `
  async fetch(url) {
    const json = (data) => ({ ok: true, status: 200, headers: {}, arrayBuffer: async () => new ArrayBuffer(0),
      json: async () => data, text: async () => JSON.stringify(data) });
    if (url.includes('/x/web-interface/nav')) return json({ code: 0, data: ${JSON.stringify(NAV_OK)} });
    return { ok: false, status: 404, headers: {}, arrayBuffer: async () => new ArrayBuffer(0),
      json: async () => ({ code: -404 }), text: async () => '' };
  },`;

// 「备用出口」折叠区默认状态：没桥时它是主路径 → 展开；装了桥 → 收起（避免一屏都在说「不用填」）
const cases = [
  { name: '没装桥', init: 'window.__wangkeBiliBridge = undefined;', expect: ['没检测到油猴桥'], advOpen: true },
  {
    name: '脚本太旧（2.0 无 getCookie）',
    init: `window.__wangkeBiliBridge = { version: '2.0.0', fetch: async () => ({ ok: false, status: 500, headers: {}, json: async () => ({}), text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) }) };`,
    expect: ['2.0.0', '重新安装'],
    advOpen: false,
  },
  {
    name: '扩展不给读（getCookie → null）',
    init: `window.__wangkeBiliBridge = { version: '2.1.1', ${FAKE_FETCH} getCookie: async () => null };`,
    expect: ['GM_cookie', '留空'],
    advOpen: false,
  },
  {
    name: '读到 0 项但桥出口已登录（不该吓唬用户）',
    init: `window.__wangkeBiliBridge = { version: '2.1.1', ${FAKE_FETCH} getCookie: async () => '' };`,
    expect: ['读到 0 项', '已登录', '留空即可'],
    advOpen: false,
  },
  {
    name: '能读但没登录（空串）',
    init: `window.__wangkeBiliBridge = { version: '2.1.1', getCookie: async () => '',
      fetch: async () => ({ ok: true, status: 200, headers: {}, arrayBuffer: async () => new ArrayBuffer(0),
        json: async () => ({ code: 0, data: { isLogin: false } }), text: async () => '' }) };`,
    expect: ['没有 bilibili.com'],
    advOpen: false,
  },
  {
    name: '成功读到',
    init: `window.__wangkeBiliBridge = { version: '2.1.1', ${FAKE_FETCH} getCookie: async () => 'SESSDATA=e2e-sess; bili_jct=e2e-jct' };`,
    expect: ['已读取', 'SESSDATA'],
    advOpen: false,
  },
];

for (const c of cases) {
  const page = await browser.newPage();
  await page.addInitScript(
    ([init]) => {
      localStorage.setItem(
        'wangke-settings',
        JSON.stringify({ state: { apiKey: 'sk-fake-e2e' }, version: 1 }),
      );
      // eslint-disable-next-line no-new-func
      new Function(init)();
    },
    [c.init],
  );
  await page.goto(`${BASE}/#/settings`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="bili-adv-toggle"]', { timeout: 20000 });
  await page.waitForTimeout(600);

  // 「备用出口」默认状态：没桥时它是主路径 → 展开；装了桥 → 收起（整块不渲染，不是 CSS 隐藏）
  const advRendered = (await page.locator('[data-testid="bili-adv"]').count()) > 0;
  check(advRendered === c.advOpen, `备用出口默认${c.advOpen ? '展开' : '收起'}（内容在 DOM 里=${advRendered}）`);
  if (!c.advOpen) {
    const statusText = (await page.textContent('[data-testid="bili-bridge-status"]'))?.trim() ?? '';
    check(/已连接 v|未检测到/.test(statusText), `收起时状态行仍给出结论（${statusText.slice(0, 48)}）`);
    // 收起时卡片里不该再有备用出口那套文案（这正是「一屏都在说不用填」的来源）
    const cardText = ((await page.textContent('[data-testid="card-bilibili"]')) ?? '').replace(/\s+/g, ' ');
    const noise = ['Cloudflare', 'SESSDATA', 'localStorage', '不用填', '读取本机'].filter((k) => cardText.includes(k));
    check(noise.length === 0, `收起时无备用出口文案噪音（命中 ${JSON.stringify(noise)}）`);
    await page.locator('[data-testid="bili-adv-toggle"]').click();
    await page.waitForTimeout(400);
    check((await page.locator('[data-testid="bili-adv"]').count()) > 0, '点「备用出口」后展开');
  }
  await page.click('[data-testid="bili-cookie-read"]');
  await page.waitForFunction(
    () => (document.querySelector('[data-testid="bili-cookie-note"]')?.textContent ?? '').trim().length > 0,
    undefined,
    { timeout: 15000 },
  );
  const note = (await page.textContent('[data-testid="bili-cookie-note"]'))?.trim() ?? '';
  console.log(`   · ${c.name}：${note.slice(0, 78)}`);
  check(
    c.expect.every((kw) => note.includes(kw)),
    `提示对症（含 ${c.expect.map((k) => `「${k}」`).join(' ')}）`,
  );
  if (c.name.includes('已登录')) {
    // 「只是读不到明细」不该渲染成报错色：和普通说明文字同色即可（避免主题差异，直接两处对比）
    const [noteColor, plainColor] = await page.evaluate(() => [
      getComputedStyle(document.querySelector('[data-testid="bili-cookie-note"]')).color,
      getComputedStyle(document.querySelector('[data-testid="bili-login-state"]')).color,
    ]);
    console.log(`   · 提示颜色 ${noteColor}（普通说明 ${plainColor}）`);
    check(noteColor === plainColor, '用普通说明色而非报错色');
  }
  if (c.name === '成功读到') {
    const value = await page.$eval('[data-testid="bili-cookie"]', (el) => el.value);
    check(value.includes('SESSDATA=e2e-sess'), `Cookie 已填入输入框（${value.slice(0, 40)}）`);
    const bridgeLine = (await page.textContent('[data-testid="bili-bridge-status"]')) ?? '';
    check(bridgeLine.includes('v2.1.1'), `桥版本可见（${bridgeLine.trim().slice(0, 40)}）`);
  }
  await page.close();
}

await browser.close();
console.log(failed === 0 ? '\n✅ Cookie 读取链路正常' : `\n❌ ${failed} 项失败`);
process.exit(failed > 0 ? 1 : 0);
