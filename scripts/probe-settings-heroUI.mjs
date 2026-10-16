/* eslint-disable no-console */
/**
 * 设置面 HeroUI 化的回归探针。
 *
 * 设计文档 `docs/plans/2026-10-14-settings-heroUI-design.md` §4 列了 6 条不变量，
 * 但 §5 声称新增的 `probe-settings-heroUI.mjs` **从来没有存在过**（git 历史里查无此文件，
 * 也没登记进 e2e-all）—— 也就是说这轮迁移**一次自动化验证都没跑过**。
 * 这个脚本就是补上那一层：把不变量变成会红的断言，而不是文档里的一句话。
 *
 * 覆盖：
 *   1. `#/settings` 与 `#/settings/<模块>` 都能打开设置弹窗
 *   2. 一次只渲染一个模块（模型模块会拉能力元数据、内容源会探测 B 站登录态）
 *   3. 分区标题是原生 `<h2>`（页面 h1 是顶栏标题，退到 h3 会让大纲断层）
 *   4. 设置面不出现自写的版式类名（只允许 Tailwind 工具类与 HeroUI 组件类）
 *   5. 关闭弹窗后 hash 还原成进设置前的位置
 *   6. **弹窗里的浮层不得把设置面板本身变成 inert**（否则整个面板点不动）
 *   7. 模型检索面板仍然可用：自动聚焦、检索生效、选中即生效、点外面收起
 *   8. 六模块 × 12 档视口宽度下，弹窗都完整落在屏幕里（否则有一半点不到）
 *   9. **遮罩的层叠**：Container 必须嵌在 Backdrop 里（兄弟结构下遮罩画在面板之上）
 *  10. **点遮罩要能关掉弹窗**（isDismissable 写在 Backdrop 上，兄弟结构下静默失效）
 *
 * 用法：BASE_URL=http://localhost:5173 node scripts/probe-settings-heroUI.mjs
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:4173';
let failures = 0;
const ok = (m) => console.log(`✅ ${m}`);
const fail = (m) => {
  console.log(`❌ ${m}`);
  failures++;
};

/**
 * 设置面里**不该**再出现的自写版式类名。
 *
 * 前三个来自被删掉的 `settings-modal.css`，其余来自 `layout.css` 里已删掉的内容原语段。
 *
 * ⚠️ 不要按「HeroUI 有没有同名类」来筛：`empty-state` 是 HeroUI `EmptyState` 组件自己
 * 的类名（设置面的空状态就靠它），它在本仓库的 CSS 里**已经没有对应规则**了。
 * 这张表守的是「自写 CSS 还在被用」，所以判据是「本仓库的 CSS 里还存不存在这条规则」，
 * 而不是「这个名字听起来像不像旧类」。名字对上了但规则早删了，就该放过。
 */
/**
 * 本仓库**源码 CSS** 里是否还留着这条类的规则。
 *
 * - 先剥注释：`layout.css` 顶部的说明文字里把 `.section-card` / `.empty-state`
 *   这些旧类名列了出来（说明它们被搬走了），那是注释不是规则。
 * - 只扫 `src/`，不扫 `dist*` / `dist-*`：那些是历史构建产物，早就删掉的规则还留在
 *   里面，扫它们会把「源码早就干净了」误报成「还在用」。
 *   （仓库根有好几个 `dist-*` 目录，都是历次构建的残留，不参与这个判断。）
 */
const CSS_ROOTS = ['src'];

const BANNED = [
  'settings-modal__frame',
  'settings-modal__nav',
  'settings-modal__content',
  'section-card',
  'field',
  'empty-state',
  'banner',
  'help-tip',
  'skill-row',
  't-input',
  't-error-msg',
].filter((cls) => projectCssStillDefines(cls));

function projectCssStillDefines(cls) {
  const re = new RegExp(`\\.${cls}(?![\\w-])`);
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        if (walk(p)) return true;
      } else if (name.endsWith('.css')) {
        const code = readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
        if (re.test(code)) return true;
      }
    }
    return false;
  };
  return CSS_ROOTS.some((root) => existsSync(root) && walk(root));
}

// ── 静态：全仓每个 `Modal.Container` 都必须在某个 `Modal.Backdrop` 里面 ─────
//
// 运行时那条「遮罩层叠」断言（下面 1b）只能证明设置面这一处，而
// `MODAL_CONTAINER_CLASS` 是 12 个调用点共用的：任何一处退回「兄弟节点」写法，
// 那一处就会重现「遮罩盖住面板 + isDismissable 静默失效」。
// 结构问题用静态扫描守最划算 —— 不需要浏览器，且覆盖全部调用点。
// （判据只看嵌套关系：`<Modal.Backdrop ...>` 与 `</Modal.Backdrop>` 之间的
// `Modal.Container` 才算数；自闭合的 `<Modal.Backdrop />` 不构成容器。）
function containersOutsideBackdrop() {
  const bad = [];
  let total = 0;
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        walk(p);
      } else if (name.endsWith('.tsx')) {
        let open = 0;
        readFileSync(p, 'utf8')
          .split('\n')
          .forEach((line, i) => {
            if (/<\/Modal\.Backdrop>/.test(line)) open = Math.max(0, open - 1);
            else if (/<Modal\.Backdrop\b/.test(line) && !/\/>\s*$/.test(line)) open++;
            if (/<Modal\.Container\b/.test(line)) {
              total++;
              if (open <= 0) bad.push(`${p}:${i + 1}`);
            }
          });
      }
    }
  };
  for (const root of CSS_ROOTS) if (existsSync(root)) walk(root);
  return { bad, total };
}

{
  const { bad, total } = containersOutsideBackdrop();
  if (bad.length === 0) ok(`Modal 结构：${total} 个调用点全部把 Container 嵌在 Backdrop 里`);
  else fail(`Modal 结构：${bad.length}/${total} 个 Container 不在 Backdrop 里（${bad.join('，')}）`);
}

const MODULES = ['appearance', 'playback', 'models', 'sources', 'live', 'data'];

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));

await page.goto(`${BASE}/#/settings`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

// ── 1. 弹窗能从 `#/settings` 打开 ────────────────────────────────────────
if ((await page.locator('[data-testid="settings-modal"]').count()) === 1) ok('#/settings 打开设置弹窗');
else fail('#/settings 没有打开设置弹窗');

// ── 1b. 遮罩的层叠：Container 必须嵌在 Backdrop **里面** ────────────────────
//
// 守的是「遮罩画在面板之上」这个**看不见**的回归。
//
// 兄弟结构下 `.modal__backdrop` 带 `z-index: var(--z-index-overlay)`（100000）而
// `.modal__container` 没有 z-index：两者同为 fixed、同为 body 子节点时绘制顺序由
// z-index 决定 —— 遮罩盖住面板，面板被自己那层半透明黑压暗（用 variant="blur" 时
// 就是「整块面板都是模糊的」）。
//
// 它**测不出来**：react-aria 的 ariaHideOutside 会把遮罩打成 `inert`，而 inert 不
// 参与命中测试 —— 点击照样穿过去，`page.click` / `elementFromPoint` 全绿。
// 所以只能断言结构本身：面板画在遮罩背景之上是结构决定的，不是靠 CSS 数值碰巧对。
const layered = await page.evaluate(() => {
  const backdrop = document.querySelector('[data-slot="modal-backdrop"]');
  const container = document.querySelector('[data-slot="modal-container"]');
  return {
    hasBackdrop: !!backdrop,
    hasContainer: !!container,
    nested: !!backdrop && !!container && backdrop.contains(container),
  };
});
if (layered.nested) ok('遮罩层叠：Container 嵌在 Backdrop 里（面板画在遮罩背景之上）');
else if (!layered.hasBackdrop || !layered.hasContainer)
  fail('遮罩层叠：Backdrop 或 Container 不在 DOM 里，这条断言等于空集');
else
  fail(
    '遮罩层叠：Container 与 Backdrop 是兄弟节点 —— 遮罩会画在面板之上把面板压暗，' +
      '且遮罩上的 isDismissable / isKeyboardDismissDisabled 会静默失效',
  );

// ── 1c. 点遮罩要能关掉弹窗 ────────────────────────────────────────────────
//
// 同一条根因的另一半：isDismissable 写在 Backdrop 上，只有 Container 在它里面时
// react-aria 的 useOverlay 才会把它接到 onInteractOutside 上（兄弟结构下真正干活的
// 是 Container 自建的匿名浮层，它拿不到 isDismissable → 点遮罩毫无反应）。
// 这条此前没有任何脚本覆盖：下面第 7 步点的是**面板内部**（关检索面板），
// e2e-settings-skills 只按 Esc。
const maskBox = await page.locator('[data-testid="settings-modal"]').boundingBox();
await page.mouse.click(Math.max(maskBox.x - 24, 4), Math.max(maskBox.y - 24, 4));
await page.waitForTimeout(900);
if ((await page.locator('[data-testid="settings-modal"]').count()) === 0) ok('点遮罩关闭：弹窗关掉了');
else fail('点遮罩关闭：点面板外面弹窗没反应（isDismissable 没接上）');

// ── 2/3/4. 逐个模块验不变量 ──────────────────────────────────────────────
for (const mod of MODULES) {
  await page.goto(`${BASE}/#/settings/${mod}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);

  const modalCount = await page.locator('[data-testid="settings-modal"]').count();
  if (modalCount !== 1) {
    fail(`${mod}：弹窗没打开`);
    continue;
  }

  // 一次只渲染一个模块
  const rendered = await page.locator('[data-testid^="settings-module-"]').count();
  const activeOne = await page.locator(`[data-testid="settings-module-${mod}"]`).count();
  if (rendered === 1 && activeOne === 1) ok(`${mod}：只渲染了这一个模块`);
  else fail(`${mod}：渲染了 ${rendered} 个模块（应为 1，且是 ${mod}）`);

  // 分区标题必须是原生 h2
  const headings = await page.evaluate(() =>
    [...document.querySelectorAll('[data-slot="card-title"]')].map((el) => el.tagName),
  );
  const bad = headings.filter((t) => t !== 'H2');
  if (headings.length > 0 && bad.length === 0) ok(`${mod}：${headings.length} 个分区标题都是原生 h2`);
  else if (headings.length === 0) fail(`${mod}：一个分区标题都没渲染出来`);
  else fail(`${mod}：分区标题里有 ${bad.length} 个不是 h2（${[...new Set(bad)].join(',')}）`);

  // 自写版式类名残留
  const found = await page.evaluate((banned) => {
    const hits = new Set();
    const walk = document.querySelector('[data-testid="settings-modal"]');
    if (!walk) return [];
    for (const el of walk.querySelectorAll('*')) {
      for (const cls of el.classList ?? []) {
        const bare = cls.split(':')[0];
        if (banned.includes(bare)) hits.add(cls);
      }
    }
    return [...hits];
  }, BANNED);
  if (found.length === 0) ok(`${mod}：没有自写版式类名残留`);
  else fail(`${mod}：仍有自写类名 ${found.join(', ')}`);
}

// ── 5. 关闭后 hash 还原 ──────────────────────────────────────────────────
await page.goto(`${BASE}/#/settings/data`, { waitUntil: 'networkidle' });
await page.waitForTimeout(900);
await page.click('[data-testid="settings-modal"] button[aria-label="关闭设置"], [aria-label="关闭设置"]');
await page.waitForTimeout(800);
const hash = await page.evaluate(() => location.hash);
if (hash === '#/' || hash === '') ok(`关闭设置后 hash 还原成 ${hash}`);
else fail(`关闭设置后 hash 是 ${hash}，没有还原`);

// ── 6. 弹窗里开浮层不能把设置面板 itself 变成 inert ─────────────────────────
//
// 这条是「设置页面根本点不动」的守门断言。
//
// 机制：RAC 的浮层默认是**模态**的，展开时 react-aria 的 ariaHideOutside 会给
// 「它之外的一切」打 `inert`。设置弹窗就开在它里面，于是整块
// `.react-aria-ModalOverlay` 被 inert —— inert 的子树在浏览器里既不能命中测试
// 也不能聚焦，用户看到的就是「面板弹出来了，但整个设置面板点不动，只能刷新」。
//
// 因此浮层（模型检索面板、供应商下拉）必须显式 isNonModal。
const await_interactive = async () =>
  page.evaluate(() => {
    const dialog = document.querySelector('[data-testid="settings-modal"]');
    if (!dialog) return { inert: null, hit: '设置弹窗不在 DOM 里' };
    const inerted = !!dialog.closest('[inert]');
    const nav = document.querySelector('[data-testid="settings-nav-data"]');
    const r = nav.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { inert: inerted, hit: nav.contains(hit) || hit === nav };
  });

/** 打开一个浮层 → 断言设置面板仍可点 → 收掉浮层 */
async function overlayKeepsPanelClickable(label, open, close) {
  try {
    await open();
  } catch (e) {
    fail(`${label}：打不开（${String(e).split('\n')[0]}）`);
    return;
  }
  await page.waitForTimeout(600);
  const { inert, hit } = await await_interactive();
  if (!inert && hit) ok(`${label}：设置面板仍可点（没被 inert）`);
  else fail(`${label}：浮层一打开，设置面板就 ${inert ? '被 inert' : '点不到'} 了 —— 整个设置面板会僵住`);

  try {
    await close();
  } catch {
    /* 收不掉本身就是问题，下面会断言 */
  }
  await page.waitForTimeout(500);
}

await page.goto(`${BASE}/#/settings/models`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

// 供应商下拉
await overlayKeepsPanelClickable(
  '模型·供应商下拉',
  () => page.locator('[data-slot="select-trigger"]').first().click(),
  () => page.keyboard.press('Escape'),
);

// 模型检索面板（三个槽位各一个，逐个查）
for (const slot of ['llmModel', 'visionModel', 'asrModel']) {
  await overlayKeepsPanelClickable(
    `模型·${slot} 检索面板`,
    () => page.click(`[data-testid="model-button-${slot}"]`),
    () => page.keyboard.press('Escape'),
  );
}

// ── 7. 模型检索面板本身还能用（修 inert 不能把面板改坏）──────────────────────
// 打桩 `/models`，让面板里有真候选可点，否则「能搜不能选」这类退化测不出来。
await page.route('**/models', (route) =>
  route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      data: [
        { id: 'deepseek-ai/DeepSeek-V4-Flash' },
        { id: 'Qwen/Qwen3.6-35B-A3B' },
        { id: 'deepseek-ai/DeepSeek-R1-Distill-Qwen-32B' },
      ],
    }),
  }),
);
// 候选列表是「拉取模型列表」从供应商拉回来的：供应商得先有地址与 Key，
// 否则那一步直接 return（只弹一句 toast），面板里就永远是空的。
// 在**应用起来之前**塞好凭据（store 的持久化键是 wangke-settings），再打桩 /models。
await page.addInitScript(() => {
  localStorage.setItem(
    'wangke-settings',
    JSON.stringify({
      state: {
        providers: [
          {
            id: 'probe',
            name: '探针供应商',
            baseUrl: 'https://api.siliconflow.cn/v1',
            apiKey: 'sk-probe',
            serves: ['asr', 'chat', 'vision'],
            catalogId: 'siliconflow-cn',
          },
        ],
        llmModel: { providerId: 'probe', model: 'deepseek-ai/DeepSeek-V4-Flash' },
        visionModel: { providerId: 'probe', model: 'Qwen/Qwen3.6-35B-A3B' },
        asrModel: { providerId: 'probe', model: 'XingChenAGI/XingChenASR-V3.2-Ultra' },
      },
      version: 2,
    }),
  );
});
await page.goto(`${BASE}/#/settings/models`, { waitUntil: 'networkidle' });
// 只差 hash 的 goto 是「同文档导航」，不会新建文档，addInitScript 也就不会跑 ——
// 上一步已经停在 #/settings/models 了，所以这里必须显式 reload 让种子落地。
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
await page.click('[data-testid="btn-check-models"]');
await page.waitForTimeout(1800);

await page.click('[data-testid="model-button-llmModel"]');
await page.waitForTimeout(700);
const searchFocused = await page.evaluate(() => {
  const input = document.querySelector('[data-slot="search-field"] input');
  return !!input && document.activeElement === input;
});
if (searchFocused) ok('模型检索面板：打开后焦点落在检索框');
else fail('模型检索面板：打开后焦点没落在检索框（面板开起来是「盲的」）');

await page.locator('[data-slot="search-field"] input').fill('qwen');
await page.waitForTimeout(500);
const filtered = await page.locator('[data-testid^="model-option-"]').count();
if (filtered > 0 && filtered < 3) ok(`模型检索面板：检索生效，剩 ${filtered} 条候选`);
else fail(`模型检索面板：检索后候选数是 ${filtered}（应 1~2 条）`);

if (filtered > 0) {
  const before = await page.getAttribute('[data-testid="model-button-llmModel"]', 'aria-label');
  await page.locator('[data-testid^="model-option-"]').first().click({ timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(700);
  const after = await page.getAttribute('[data-testid="model-button-llmModel"]', 'aria-label');
  const panelGone = (await page.locator('[data-model-picker]').count()) === 0;
  if (after !== before && panelGone) ok(`模型检索面板：选中即生效并自动收起（${after}）`);
  else fail(`模型检索面板：选中后 label=${after} 面板仍在=${!panelGone}`);
}

// 点外面要收起（isNonModal 之后 react-aria 不再代劳，这条守的是我们补的那段）
await page.click('[data-testid="model-button-llmModel"]');
await page.waitForTimeout(600);
const dialogBox = await page.locator('[data-testid="settings-modal"]').boundingBox();
await page.mouse.click(dialogBox.x + 30, dialogBox.y + 30);
await page.waitForTimeout(700);
const dismissedOutside = (await page.locator('[data-model-picker]').count()) === 0;
if (dismissedOutside) ok('模型检索面板：点面板外面会收起');
else fail('模型检索面板：点面板外面不收起，面板会赖在设置面板上挡住内容');

await page.unroute('**/models');

// ── 8. 各视口宽度下弹窗必须整个落在屏幕里 ─────────────────────────────────
//
// 面板被推出屏幕右侧时，超出去的那半边不是「不好看」，是**点不到** ——
// 常见的笔记本宽度（1280 / 1000）上就能触发，用户描述就是「设置页面点不动」。
//
// 成因是 HeroUI 的 `.modal__container` 带 `sm:w-fit`：容器在遮罩里本该是视口宽，
// 而「数据」模块里有一堆不可断的长串（地址 / Key / 模型 id）把 min-content 顶到 1700px 开外，
// 于是容器比视口还宽，`items-center` 把 dialog 居中在这个超宽盒子里 → 右半边出屏。
// 守的是 Modal.Container 上那个 `w-full`（配合 HeroUI 自带的 `min-w-0`）。
const WIDTHS = [1600, 1440, 1280, 1100, 1000, 900, 820, 760, 700, 600, 480, 390];
for (const mod of MODULES) {
  const bad = [];
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${BASE}/#/settings/${mod}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(700);
    const m = await page.evaluate(() => {
      const dialog = document.querySelector('[data-testid="settings-modal"]');
      const container = document.querySelector('[data-slot="modal-container"]');
      if (!dialog || !container) return null;
      const d = dialog.getBoundingClientRect();
      const c = container.getBoundingClientRect();
      return {
        left: Math.round(d.left),
        right: Math.round(d.right - window.innerWidth),
        top: Math.round(d.top),
        bottom: Math.round(d.bottom - window.innerHeight),
        containerW: Math.round(c.width),
        vw: window.innerWidth,
      };
    });
    if (!m) {
      bad.push(`${width}:弹窗没渲染`);
      continue;
    }
    if (m.left < -1 || m.right > 1 || m.top < -1 || m.bottom > 1) {
      bad.push(`${width}:左${m.left}/右出${m.right}/上${m.top}/下出${m.bottom}`);
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  if (bad.length === 0) ok(`${mod}：${WIDTHS.length} 档视口宽度下弹窗都完整落在屏幕里`);
  else fail(`${mod}：弹窗有部分跑到屏幕外，点不到 —— ${bad.join('，')}`);
}

if (errors.length === 0) ok('没有 pageerror');
else for (const e of [...new Set(errors)]) fail(`pageerror: ${e}`);

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
await browser.close();
process.exit(failures ? 1 : 0);