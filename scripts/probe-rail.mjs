/**
 * 探针：`mdui-navigation-rail` 放进 `mdui-layout` 后的真实布局行为。
 *
 * 要回答的问题（决定 PageShell 怎么改）：
 *  1. rail 作为 mdui-layout 的直接子元素时，layout 助手是否会给 mdui-layout-main 补 padding-left？
 *  2. rail 自身 `:host{position:fixed}` 会被助手的内联样式改成什么？会不会盖住 top-app-bar？
 *  3. rail 的 items 顺序（rail 在前 / 在后）对 top-app-bar 与 main 的定位有什么影响？
 *  4. display:none 时（窄屏）padding 是否归零？
 *  5. item 的图标插槽写法、激活态是否有 ARIA 角色。
 *
 * 用法：node scripts/probe-rail.mjs [url]
 */
import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:5174/';

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500); // 等 mdui 注册 + 页面首屏

const result = await page.evaluate(async () => {
  document.getElementById('__probe')?.remove();
  const host = document.createElement('div');
  host.id = '__probe';
  host.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#fff';
  host.innerHTML = `
    <div class="page page-mdui" style="height:100%">
      <mdui-layout id="probe-layout">
        <mdui-navigation-rail id="probe-rail" value="home">
          <mdui-navigation-rail-item value="home"><span slot="icon">H</span>课程库</mdui-navigation-rail-item>
          <mdui-navigation-rail-item value="settings"><span slot="icon">S</span>设置</mdui-navigation-rail-item>
        </mdui-navigation-rail>
        <mdui-layout-item placement="top">
          <mdui-top-app-bar class="app-bar"><mdui-top-app-bar-title>课程库</mdui-top-app-bar-title></mdui-top-app-bar>
        </mdui-layout-item>
        <mdui-layout-main><div style="height:1200px">content</div></mdui-layout-main>
      </mdui-layout>
    </div>`;
  document.body.appendChild(host);
  await new Promise((r) => setTimeout(r, 600));

  const rail = document.getElementById('probe-rail');
  const main = host.querySelector('mdui-layout-main');
  const topItem = host.querySelector('mdui-layout-item');
  const bar = host.querySelector('mdui-top-app-bar');
  const item = rail.querySelector('mdui-navigation-rail-item');
  const cs = (el) => getComputedStyle(el);

  return {
    rail: {
      offsetWidth: rail.offsetWidth,
      offsetHeight: rail.offsetHeight,
      position: cs(rail).position,
      inlineStyle: rail.getAttribute('style'),
      rect: rail.getBoundingClientRect().toJSON(),
    },
    topItem: { position: cs(topItem).position, inlineStyle: topItem.getAttribute('style'), rect: topItem.getBoundingClientRect().toJSON() },
    bar: { position: cs(bar).position, rect: bar.getBoundingClientRect().toJSON() },
    main: {
      paddingLeft: cs(main).paddingLeft,
      paddingTop: cs(main).paddingTop,
      inlineStyle: main.getAttribute('style'),
      rect: main.getBoundingClientRect().toJSON(),
    },
    item: {
      role: item.getAttribute('role'),
      innerHTMLHead: item.innerHTML.slice(0, 200),
      ariaChecked: item.getAttribute('aria-checked'),
      rect: item.getBoundingClientRect().toJSON(),
    },
  };
});

console.log(JSON.stringify(result, null, 2));

await page.screenshot({ path: '/tmp/probe-rail.png' });

// 隐藏 rail（模拟窄屏）后再看 padding 是否归零
const hidden = await page.evaluate(async () => {
  const rail = document.getElementById('probe-rail');
  rail.style.display = 'none';
  await new Promise((r) => setTimeout(r, 400));
  const main = document.querySelector('#__probe mdui-layout-main');
  return { paddingLeft: getComputedStyle(main).paddingLeft, top: getComputedStyle(main).paddingTop };
});
console.log('rail display:none →', JSON.stringify(hidden));
await browser.close();
