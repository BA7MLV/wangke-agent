/* eslint-disable no-console */
// 探针：```svg 围栏的**流式增量**解析（src/components/mermaid/svgRender.ts 的 peekSvgProgress）
//
// 为什么单独立一个探针，而不是并进 probe-svg-sanitize：
// 那条守的是「完整源码的净化契约」，这里守的是**半截源码** —— 而半截的失效方式
// 完整源码那条一条都碰不到：把 `d="M 0 0 L 1` 提前画出去、把闭合标签算错、
// 某一拍丢元素 / 多元素，都只在流式下才成立。
//
// 核心断言是**不变量**而不是逐例的期望值：
//   逐字符喂进去，已经「上屏」的元素集合必须始终是最终元素集合的**前缀**，且只增不减。
//   这条一旦成立，就同时钉死了三件事 —— 没画半截元素、没漏元素、没打乱顺序。
//
// 用法：node scripts/probe-svg-stream.mjs   （需先 npm run dev）
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:5173';

/** 直接 import 源码模块：dev 档下 vite 会就地编译，跑的就是应用自己那份 */
const SVG_MODULE = '/src/components/mermaid/svgRender.ts';

let failed = 0;
const ok = (msg) => console.log(`   ✓ ${msg}`);
const fail = (msg) => {
  failed++;
  console.error(`   ❌ ${msg}`);
};
const check = (cond, msg) => (cond ? ok(msg) : fail(msg));

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
await page.goto(BASE, { waitUntil: 'networkidle' });

/** 在页面里跑一段纯函数（拿到真实的 DOMPurify 与 HTML 解析器） */
const run = (body, arg) =>
  page.evaluate(
    async ([src, code, a]) => {
      const mod = await import(src);
      // eslint-disable-next-line no-new-func
      const fn = new Function('peek', 'sanitizeSvg', 'A', code);
      return fn(mod.peekSvgProgress, mod.sanitizeSvg, a);
    },
    [SVG_MODULE, body, arg],
  );

// 一段真实的教学 SVG：坐标轴 + 两条曲线 + 渐变 defs + 中文标签 + 带 `>` 与引号的属性值
const FIG = [
  '<svg viewBox="0 0 240 140" xmlns="http://www.w3.org/2000/svg">',
  '<defs><linearGradient id="g" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#1677ff"/></linearGradient></defs>',
  '<rect x="0" y="0" width="240" height="140" fill="url(#g)"/>',
  '<line x1="20" y1="120" x2="220" y2="120" stroke="#888"/>',
  '<path d="M30 110 Q120 -10 210 110" fill="none" stroke="#1677ff" stroke-width="2"/>',
  '<g><circle cx="120" cy="50" r="3" fill="#f5222d"/><text x="120" y="134" font-size="10" text-anchor="middle">顶点 &gt; 原点</text></g>',
  '</svg>',
].join('\n');

console.log('=== 1. 逐字符喂入：已上屏集合始终是最终集合的前缀 ===');
const walk = await run(`
  const full = (peek(A) ?? { elements: [] }).elements;
  let seen = [];
  let grew = -1;
  let bad = null;
  let rootOk = true;
  let rootDims = null;
  for (let i = 1; i <= A.length; i++) {
    const p = peek(A.slice(0, i));
    if (!p) continue;
    if (!/(^|\\s)viewBox="0 0 240 140"/.test(p.rootAttrs)) rootOk = false;
    if (rootDims === null) rootDims = p.rootAttrs;
    if (p.elements.length < grew) bad = '元素数回退：' + grew + ' → ' + p.elements.length + ' @ ' + i;
    grew = p.elements.length;
    if (JSON.stringify(p.elements) !== JSON.stringify(seen)) seen = p.elements;
  }
  return { full, seen, bad, rootOk, rootDims };
`, FIG);
check(walk.full.length === 5, `完整源码切出 5 个顶层元素（实得 ${walk.full.length}）`);
check(!walk.bad, `元素数只增不减${walk.bad ? '：' + walk.bad : ''}`);
check(
  JSON.stringify(walk.seen) === JSON.stringify(walk.full),
  '最后一拍的上屏集合 === 完整源码的切分结果',
);
check(walk.rootOk, '每一拍的根属性都带着 viewBox（画布尺寸从根标签那一刻就定了）');
check(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(walk.rootDims ?? ''), '根属性保留 xmlns');

console.log('\n=== 2. 词法坑：引号 / 注释 / CDATA / 嵌套 / 正文里的尖括号 ===');
// 每一行一个坑，逐个验证「切出来的元素里没有半个」
const lex = [
  ['属性值里的 >', '<svg viewBox="0 0 10 10"><path d="M0 0 L9 9"/></svg>', 1],
  ['属性值里的单引号', `<svg viewBox='0 0 10 10'><text data-t="it's">x</text></svg>`, 1],
  ['正文里的 > 与 <', '<svg viewBox="0 0 10 10"><text>a &gt; b &amp; c</text></svg>', 1],
  ['注释', '<svg viewBox="0 0 10 10"><!-- 注释里有 <path d="x"/> 这种字样 --><rect width="4" height="4"/></svg>', 1],
  ['注释未闭合（不算元素）', '<svg viewBox="0 0 10 10"><!-- 写到一半', 0],
  ['CDATA（里含 > 与 <path/> 字样）', '<svg viewBox="0 0 10 10"><desc><![CDATA[ 图里有 > 和 <path d="x"/> ]]></desc><rect width="4" height="4"/></svg>', 2],
  ['嵌套 g（算一个顶层）', '<svg viewBox="0 0 10 10"><g><rect width="4" height="4"/><circle r="2"/></g></svg>', 1],
  ['g 未闭合（不算元素）', '<svg viewBox="0 0 10 10"><g><rect width="4" height="4"/>', 0],
  ['多元素', '<svg viewBox="0 0 10 10"><rect width="4" height="4"/><circle r="2"/><line x1="0" y1="0" x2="1" y2="1"/></svg>', 3],
  ['收尾的 </svg> 之后', '<svg viewBox="0 0 10 10"><rect width="4" height="4"/></svg>\n（横轴为 x）', 1],
];
for (const [name, src, want] of lex) {
  const got = await run(`const p = peek(A); return p ? p.elements.length : 0;`, src);
  check(got === want, `${name} → ${want} 个元素（实得 ${got}）`);
}

console.log('\n=== 3. 安全闸门与 sanitizeSvg 同源 ===');
// 增量那条路是绕过完整源码直接落画的，所以它自己必须守得住
const gate = await run(`
  const t = (s) => { try { return { ok: true, ...peek(s) }; } catch (e) { return { ok: false, err: e.message }; } };
  return {
    script: t('<svg viewBox="0 0 10 10"><rect width="4" height="4"/><script>alert(1)</script></svg>'),
    onclick: t('<svg viewBox="0 0 10 10"><rect width="4" height="4" onclick="alert(1)"/></svg>'),
    extUrl: t('<svg viewBox="0 0 10 10"><rect width="4" height="4" fill="url(https://evil.example/x.svg#a)"/></svg>'),
    // 这些是「剔除」不是「拒绝」：净化器会剥掉，剩下能画的就照画
    stripped: peek('<svg viewBox="0 0 10 10"><image href="https://evil.example/x.png"/><rect width="4" height="4"/></svg>'),
    // 与 sanitizeSvg 逐字比：同一段源码，增量拼回去必须等于完整净化产物
    diff: (() => {
      const src = A;
      const p = peek(src);
      const full = sanitizeSvg(src);
      const pieces = ['<svg ' + p.rootAttrs + '>', ...p.elements, '</svg>'].join('');
      const squash = (s) => s.replace(/\\s+/g, '');
      return squash(full) === squash(pieces);
    })(),
  };
`, FIG);
// 净化器是「剔除」不是「拒绝」（与 probe-svg-sanitize §2 同一条语义）：
// 事件属性与 <script> 被静默剥掉，剩下的图元照画，不该抛错。
check(gate.script.ok && !/script|alert/i.test(gate.script.elements.join('')), '<script> 被剥后无残留');
check(gate.script.elements.some((e) => e.includes('<rect')), '<script> 被剥后同段图元仍在');
check(gate.onclick.ok && !/onclick|alert/i.test(gate.onclick.elements.join('')), 'onclick 被剥后无残留');
check(!gate.extUrl.ok && /外部资源/.test(gate.extUrl.err), `外部 url() 才真的拒绝（${gate.extUrl.err}）`);
check(!!gate.stripped && !/evil/.test(JSON.stringify(gate.stripped.elements)), '<image href> 段被剥离而非放行');
check(gate.stripped.elements.some((e) => e.includes('<rect')), '<image> 被剥后同段图元仍在');
check(gate.diff, '增量拼回去（根+元素+闭标签）=== sanitizeSvg 的完整产物');

console.log('\n=== 4. 拿不到几何信息时老实退回等待态 ===');
const geo = await run(`
  return {
    noRoot: peek('\`\`\`svg\\n<svg>') === null,
    noViewBox: peek('<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>'),
    widthOnly: peek('<svg width="120"><rect width="4" height="4"/></svg>'),
    halfRoot: peek('<svg viewBox="0 0 10 10"') === null,
    proseFirst: peek('这是函数图像：\\n<svg viewBox="0 0 10 10"><rect width="4" height="4"/></svg>'),
    empty: peek('   ') === null,
  };
`);
check(geo.noRoot, '没有 <svg 时返回 null（退回等待态）');
check(geo.noViewBox === null, '根标签没有 viewBox / width 时返回 null');
check(geo.widthOnly !== null && /width="120"/.test(geo.widthOnly.rootAttrs), '只给 width 也够（能定尺寸）');
check(geo.halfRoot, '根标签属性没写完时返回 null');
check(geo.proseFirst !== null && geo.proseFirst.elements.length === 1, '围栏里前面有话术仍能切出根与元素');
check(geo.empty, '空内容返回 null');

console.log('\n=== 5. 元素顺序 = 文档顺序（笔顺） ===');
const order = await run(`
  const p = peek(A);
  return p.elements.map((e) => (e.match(/^<([a-zA-Z]+)/) || [])[1]);
`, '<svg viewBox="0 0 10 10"><line/><rect/><path/><circle/><text>t</text><g><polyline/></g></svg>');
check(JSON.stringify(order) === JSON.stringify(['line', 'rect', 'path', 'circle', 'text', 'g']),
  `顶层元素按出现顺序返回（${JSON.stringify(order)}）`);

console.log('\n=== 6. 净化结果逐元素与完整源码同形（抽三个元素验属性大小写） ===');
// 增量是对「元素」而不是对「整篇文档」做净化的，最容易出的岔子就是
// 某个 camelCase 属性（viewBox / gradientUnits / clipPathUnits）在片段里被小写化
const camel = await run(`
  const p = peek(A);
  return p.elements.join('|');
`, '<svg viewBox="0 0 10 10"><clipPath id="c" clipPathUnits="userSpaceOnUse"><rect width="4" height="4"/></clipPath><text textLength="8" lengthAdjust="spacingAndGlyphs">字</text><path pathLength="100" d="M0 0 L1 1"/></svg>');
check(/clipPathUnits="userSpaceOnUse"/.test(camel), 'clipPathUnits 大小写被保留（没被小写化后剔掉）');
check(/textLength="8"/.test(camel) && /lengthAdjust="spacingAndGlyphs"/.test(camel), 'textLength / lengthAdjust 保留');
check(/pathLength="100"/.test(camel), 'pathLength 保留（LiveSvg 靠它判断能不能走描边）');

console.log('\n=== 7. 完整源码路径没被这次改动动过 ===');
const keep = await run(`
  return {
    ok: sanitizeSvg('<svg viewBox="0 0 10 10"><rect width="5" height="5"/></svg>'),
    noShell: (() => { try { sanitizeSvg('<rect width="5" height="5"/>'); return 'no-throw'; } catch (e) { return e.message; } })(),
    unclosed: (() => { try { sanitizeSvg('<svg viewBox="0 0 10 10"><rect width="5" height="5"/>'); return 'no-throw'; } catch (e) { return e.message; } })(),
    extUrl: (() => { try { sanitizeSvg('<svg viewBox="0 0 10 10"><rect width="5" height="5" fill="url(https://evil.example/a)"/></svg>'); return 'no-throw'; } catch (e) { return e.message; } })(),
  };
`);
check(keep.ok.startsWith('<svg') && /viewBox="0 0 10 10"/.test(keep.ok), '完整源码照常净化出 <svg>');
check(/没有找到 <svg/.test(keep.noShell), `缺外壳仍报错（${keep.noShell}）`);
check(/没有闭合/.test(keep.unclosed), `未闭合仍报错（${keep.unclosed}）`);
check(/外部资源/.test(keep.extUrl), `外部 url() 仍拒绝（${keep.extUrl}）`);

await browser.close();
console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
