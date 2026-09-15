/* eslint-disable no-console */
/**
 * 回归探针：作答「跳位」——点完选项，卡片上不该有任何东西改变位置。
 *
 * 用**生产构建的真实样式表**量测：脚本打开发布页把 replica DOM 注进同一个文档，
 * 所以拿到的 `.quiz-card` / `.quiz-option` 盒模型与真实题卡完全一致
 * （mdui 的 `--mdui-color-*` 令牌、body 字体链都在）。
 * 唯一替身是判定图标：`<mdui-sym-*>` 的 `:host` 是 `1em × 1em / font-size:1.5rem` 的
 * 空盒（SVG 填满），这里用一个同等尺寸的 span 顶替 —— 自定义元素在本页面没注册。
 *
 * 两类位移都量（修复前实测按钮宽 320px 时 19/30 组都有位移）：
 *   1. 行高：图标进 DOM 会把行从 40 顶到 42（min-height:40 减掉 padding 只剩 22px 内容盒）
 *   2. 换行：行尾多占 24px 宽，长选项被挤成第二行，下面的选项整行下移（实测 20px）
 *
 * 用法：先起服务再跑
 *   npm run build && npm run preview &
 *   node scripts/probe-quiz-option-shift.mjs          # 或 BASE_URL=http://localhost:4173
 * 退出码：0 = 零位移；3 = 有位移（回归）。
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:4173';
const PANE_WIDTHS = [280, 320, 360, 400, 440]; // 卡片宽：侧栏在窄屏/宽屏下的常见档位
const TEXT_LENS = [10, 14, 18, 22, 26, 30]; // 选项字数：中文全角，14px 字号下约 14px/字

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
await page.goto(BASE, { waitUntil: 'networkidle' });

const rows = await page.evaluate(
  ({ widths, lens }) => {
    const ICON_HOST_CSS = 'display:inline-block;width:1em;height:1em;font-size:1.5rem;flex:none';

    /** 两种状态：未作答（空槽位）→ 作答（槽位里放图标）。槽位与图标都走真实 CSS。 */
    function buildCard(btnWidth, len, filled) {
      const card = document.createElement('div');
      card.className = 'quiz-card';
      card.style.width = btnWidth + 'px';
      const q = document.createElement('div');
      q.className = 'quiz-q';
      const stem = document.createElement('div');
      stem.className = 'quiz-stem';
      stem.textContent = '题干';
      const opts = document.createElement('div');
      opts.className = 'quiz-options';
      for (let i = 0; i < 2; i++) {
        const b = document.createElement('button');
        b.className = 'quiz-option';
        const letter = document.createElement('b');
        letter.className = 'quiz-option__letter';
        letter.textContent = 'A.';
        b.appendChild(letter);
        b.appendChild(document.createTextNode('汉'.repeat(len)));
        const slot = document.createElement('span');
        slot.className = 'quiz-option__mark';
        if (filled) {
          const ic = document.createElement('span');
          ic.style.cssText = ICON_HOST_CSS;
          slot.appendChild(ic);
        }
        b.appendChild(slot);
        opts.appendChild(b);
      }
      q.appendChild(stem);
      q.appendChild(opts);
      card.appendChild(q);
      return card;
    }

    function measure(card) {
      const [b0, b1] = card.querySelectorAll('.quiz-option');
      const rng = document.createRange();
      rng.selectNodeContents(b0.childNodes[1]);
      return {
        h: Math.round(b0.getBoundingClientRect().height * 100) / 100,
        lines: rng.getClientRects().length,
        dy: Math.round((b1.offsetTop - b0.offsetTop) * 100) / 100,
      };
    }

    // 离屏容器：不干扰应用自己的布局，同时继承 body 的字体链
    const stage = document.createElement('div');
    stage.style.cssText = 'position:absolute;left:-99999px;top:0;width:520px';
    document.body.appendChild(stage);

    const out = [];
    for (const w of widths) {
      for (const len of lens) {
        const rec = { w, len };
        for (const [key, filled] of [['empty', false], ['filled', true]]) {
          stage.textContent = '';
          const card = buildCard(w, len, filled);
          stage.appendChild(card);
          rec[key] = measure(card);
        }
        rec.jump = Math.round((rec.filled.h - rec.empty.h) * 100) / 100;
        rec.push = Math.round((rec.filled.dy - rec.empty.dy) * 100) / 100;
        out.push(rec);
      }
    }
    stage.remove();
    return out;
  },
  { widths: PANE_WIDTHS, lens: TEXT_LENS },
);

console.log('卡片宽 文字数 | 未答(h/行) 作答(h/行) Δ行高 Δ下移');
for (const r of rows) {
  console.log(
    String(r.w).padStart(6) + String(r.len).padStart(7) +
    ' | ' + `${r.empty.h}/${r.empty.lines}`.padStart(10) + `${r.filled.h}/${r.filled.lines}`.padStart(11) +
    String(r.jump).padStart(6) + String(r.push).padStart(7),
  );
}

const bad = rows.filter((r) => r.jump !== 0 || r.push !== 0);
console.log('');
console.log(bad.length ? `⚠️ ${bad.length}/${rows.length} 组作答后发生位移` : `✅ ${rows.length}/${rows.length} 组作答前后几何完全一致`);
await browser.close();
process.exit(bad.length ? 3 : 0);
