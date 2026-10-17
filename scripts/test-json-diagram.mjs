#!/usr/bin/env node
/**
 * ```diagram 围栏（JSON 中间层）契约测试：schema 校验 / 确定性渲染 / 流式不变量。
 *
 * 这条链路是「AI 定义结构 + 确定性工具渲染」的那一半：模型只写 JSON，坐标、布局、
 * 采样全部由 diagramRender.ts 算。这里守四组硬契约：
 *
 * 1. **锁 schema**：未知字段、坏类型、悬空引用都必须被拒绝，且报错可执行
 *    （模型在 show_widget 预检里拿到的就是这些文案，改完能一次对上）。
 * 2. **确定性**：同一份 JSON 渲染两次逐字节相同；改一个 label 只动那一个图元
 *    （这是「JSON 可进 Git diff」在渲染层的对应物）。
 * 3. **转义**：label 是第三方文本，`<script>` / 引号 / & 必须原样变成文字。
 * 4. **流式不变量**：逐字符喂入时，已上屏的 key 集合只增不减、且最后一拍
 *    与闭合后的完整渲染**完全一致**（预览收敛到终态，闭合那一刻画面不变）。
 *
 * 运行：node scripts/test-json-diagram.mjs
 */
import assert from 'node:assert/strict';
import { compileExpression } from '../src/components/mermaid/expr.ts';
import {
  validateDiagram,
  DiagramSchemaError,
} from '../src/components/mermaid/diagramSchema.ts';
import { renderDiagram } from '../src/components/mermaid/diagramRender.ts';
import { peekDiagramProgress } from '../src/components/mermaid/diagramStream.ts';
import { diagramKindOf } from '../src/components/mermaid/fence.ts';

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

/** 取某个 key 的形状（找不到就报出全部 key，失败信息好读） */
function shapeOf(rendered, key) {
  const s = rendered.shapes.find((x) => x.key === key);
  assert.ok(s, `找不到形状 ${key}（实有：${rendered.shapes.map((x) => x.key).join(', ')}）`);
  return s;
}

// ───────────────────────────────────────────────────────────────────────────────
// 1. 围栏契约（与提示词 DIAGRAM_RULE 对同一份 LANG_RULES）
// ───────────────────────────────────────────────────────────────────────────────

test('diagramKindOf 认 mermaid / diagram / svg 三种块级围栏', () => {
  assert.equal(diagramKindOf({ block: true, lang: 'mermaid' }), 'mermaid');
  assert.equal(diagramKindOf({ block: true, lang: 'diagram' }), 'diagram');
  assert.equal(diagramKindOf({ block: true, lang: 'svg' }), 'svg');
  assert.equal(diagramKindOf({ block: true, lang: 'DIAGRAM' }), 'diagram');
  assert.equal(diagramKindOf({ block: true, lang: '  diagram title=xx ' }), 'diagram');
});

test('diagramKindOf 不吃前缀相近的语言名，普通 json 代码块不遭殃', () => {
  assert.equal(diagramKindOf({ block: true, lang: 'diagrams' }), null);
  assert.equal(diagramKindOf({ block: true, lang: 'json' }), null, '普通 ```json 代码块不能被当成图表');
  assert.equal(diagramKindOf({ block: false, lang: 'diagram' }), null, '行内 code 不该建图块');
  assert.equal(diagramKindOf({ block: true }), null);
});

// ───────────────────────────────────────────────────────────────────────────────
// 2. schema：锁字段、可执行报错
// ───────────────────────────────────────────────────────────────────────────────

const GOOD_GRAPH = {
  type: 'graph',
  direction: 'LR',
  nodes: [
    { id: 'c', label: '客户端' },
    { id: 's', label: '服务端', shape: 'round' },
  ],
  edges: [{ from: 'c', to: 's', label: '请求' }],
};
const GOOD_PLOT = {
  type: 'plot',
  x: [-3, 3],
  y: [-1, 5],
  curves: [{ fn: 'x^2', label: 'y=x²', color: '#1677ff' }],
  points: [{ at: [0, 0], label: '顶点' }],
};

test('合法 graph / plot 通过校验并原样保留字段', () => {
  assert.deepEqual(validateDiagram(structuredClone(GOOD_GRAPH)), GOOD_GRAPH);
  const p = validateDiagram(structuredClone(GOOD_PLOT));
  assert.equal(p.curves[0].fn, 'x^2');
  assert.deepEqual(p.points[0].at, [0, 0]);
});

test('type 缺失 / 写错 → 报错点明两种合法值与 mermaid 的分工', () => {
  for (const t of [undefined, 'flowchart', 'unknown', 42]) {
    assert.throws(
      () => validateDiagram({ type: t, nodes: [{ id: 'a', label: 'x' }] }),
      (e) => e instanceof DiagramSchemaError && /type 必须是/.test(e.message) && /```mermaid/.test(e.message),
      `type=${JSON.stringify(t)} 应被拒绝`,
    );
  }
});

test('type 写错时报的是 type，不是同一处的未知字段（归因优先级）', () => {
  // type 是其余字段的解释上下文：它错了的时候报「不认识的字段」会把模型引到错误的方向
  assert.throws(
    () => validateDiagram({ type: 'mindmap', root: 'x' }),
    (e) => e instanceof DiagramSchemaError && /type 必须是/.test(e.message) && !/不认识的字段/.test(e.message),
  );
});

test('未知字段一律拒绝并列出可用字段（防字段漂移）', () => {
  assert.throws(
    () => validateDiagram({ type: 'graph', nodes: [{ id: 'a', label: 'x' }], colour: 'red' }),
    (e) => /不认识的字段「colour」/.test(e.message) && /type/.test(e.message),
  );
  assert.throws(
    () => validateDiagram({ type: 'graph', nodes: [{ id: 'a', label: 'x', vertex: 1 }] }),
    (e) => /不认识的字段「vertex」/.test(e.message) && /id/.test(e.message) && /label/.test(e.message),
  );
  assert.throws(
    () => validateDiagram({ type: 'plot', curves: [{ fn: 'x', dash: true }] }),
    (e) => /不认识的字段「dash」/.test(e.message),
  );
});

test('graph 节点上限 / 空 / id 重复 / 悬空边 / 自环全部可执行报错', () => {
  const node = (i) => ({ id: `n${i}`, label: `节点${i}` });
  assert.throws(() => validateDiagram({ type: 'graph', nodes: [] }), /nodes 不能为空/);
  assert.throws(
    () => validateDiagram({ type: 'graph', nodes: Array.from({ length: 11 }, (_, i) => node(i)) }),
    (e) => /超过 10 个/.test(e.message) && /拆成两张图/.test(e.message),
  );
  assert.throws(
    () => validateDiagram({ type: 'graph', nodes: [node(0), { id: 'n0', label: '重名' }] }),
    (e) => /id 重复/.test(e.message),
  );
  assert.throws(
    () => validateDiagram({ type: 'graph', nodes: [node(0)], edges: [{ from: 'n0', to: 'ghost' }] }),
    (e) => /不存在的节点「ghost」/.test(e.message) && /n0/.test(e.message),
  );
  assert.throws(
    () => validateDiagram({ type: 'graph', nodes: [node(0)], edges: [{ from: 'n0', to: 'n0' }] }),
    /自环/,
  );
  assert.throws(
    () => validateDiagram({ type: 'graph', nodes: [{ id: 'a', label: 'x'.repeat(21) }] }),
    (e) => /超过 20 字/.test(e.message),
  );
  assert.throws(() => validateDiagram({ type: 'graph', nodes: [{ id: 'a', label: 'x', shape: 'star' }] }), /shape 只能/);
  assert.throws(() => validateDiagram({ type: 'graph', direction: 'RL', nodes: [node(0)] }), /direction 只能/);
});

test('plot 范围 / 几何 / 颜色的报错都可执行', () => {
  assert.throws(() => validateDiagram({ type: 'plot', x: [3, -3] }), /最小值小于最大值/);
  assert.throws(() => validateDiagram({ type: 'plot', x: [0] }), /必须是 \[a, b\]/);
  assert.throws(
    () => validateDiagram({ type: 'plot', x: [-1, 1], curves: [{ fn: 'x', domain: [-2, 2] }] }),
    (e) => /domain/.test(e.message) && /超出/.test(e.message),
  );
  assert.throws(() => validateDiagram({ type: 'plot', polygons: [{ points: [[0, 0], [1, 1]] }] }), /至少需要 3 个点/);
  assert.throws(() => validateDiagram({ type: 'plot', circles: [{ center: [0, 0], r: 0 }] }), /r 必须是正数/);
  assert.throws(() => validateDiagram({ type: 'plot', curves: [{ fn: 'x', color: 'url(#x)' }] }), /十六进制颜色/);
  assert.throws(() => validateDiagram({ type: 'plot', labels: [{ at: [0, 0], text: 'x', anchor: 'center' }] }), /anchor 只能/);
  assert.throws(() => validateDiagram({ type: 'plot', curves: [{ fn: 'x' }, { fn: 'y' }, { fn: 'z' }, { fn: 'w' }, { fn: 'v' }] }), /超过 4 项/);
  assert.throws(() => validateDiagram('not an object'), /必须是一个 JSON 对象/);
});

// ───────────────────────────────────────────────────────────────────────────────
// 3. 表达式（plot 的 fn）
// ───────────────────────────────────────────────────────────────────────────────

test('表达式求值：优先级 / 右结合 / 隐式乘法 / 常量 / 函数', () => {
  const at = (src, x) => compileExpression(src)(x);
  assert.ok(Math.abs(at('sin(x) + 2x^2', 1) - (Math.sin(1) + 2)) < 1e-9);
  assert.equal(at('-x^2', 3), -9, '-x^2 应等于 -(x^2)');
  assert.equal(at('2^-3', 0), 0.125, '^ 右结合且允许右侧带负号');
  assert.equal(at('2x', 4), 8);
  assert.equal(at('x(x-1)', 3), 6, 'x(x-1) 是隐式乘法不是函数调用');
  assert.equal(at('log(2, 8)', 0), 3, 'log(a,b) 以 a 为底');
  assert.ok(Math.abs(at('pi', 0) - Math.PI) < 1e-9);
  assert.ok(Math.abs(at('e^x', 1) - Math.E) < 1e-9);
  assert.equal(at('min(x, 2)', 5), 2);
});

test('表达式报错带字符位置与可用函数表（模型能一次改对）', () => {
  assert.throws(() => compileExpression('sinn(x)'), (e) => /第 \d+ 字符附近/.test(e.message) && /sin/.test(e.message));
  assert.throws(() => compileExpression('sin(x'), /缺少 ）|括号没有闭合/);
  assert.throws(() => compileExpression('x +'), /表达式在这里断了/);
  assert.throws(() => compileExpression('y'), /不认识的标识符/);
  assert.throws(() => compileExpression(''), /fn 不能为空/);
});

// ───────────────────────────────────────────────────────────────────────────────
// 4. 渲染确定性（JSON 可 diff 的渲染层对应物）
// ───────────────────────────────────────────────────────────────────────────────

test('同一份 JSON 渲染两次逐字节相同', () => {
  const a = renderDiagram(validateDiagram(structuredClone(GOOD_GRAPH)));
  const b = renderDiagram(validateDiagram(structuredClone(GOOD_GRAPH)));
  assert.equal(a.svg, b.svg);
  assert.equal(a.viewBox, b.viewBox);
  const c = renderDiagram(validateDiagram(structuredClone(GOOD_PLOT)));
  const d = renderDiagram(validateDiagram(structuredClone(GOOD_PLOT)));
  assert.equal(c.svg, d.svg);
});

test('改一个 label 只动那一个图元（diff 友好）', () => {
  // 等宽标签：列宽（取决于全图最宽节点）不变，布局不动 —— 只有文案在变
  const base = renderDiagram(
    validateDiagram({
      type: 'graph',
      nodes: [
        { id: 'c', label: '甲甲' },
        { id: 's', label: '乙乙' },
      ],
      edges: [{ from: 'c', to: 's', label: '请求' }],
    }),
  );
  const next = renderDiagram(
    validateDiagram({
      type: 'graph',
      nodes: [
        { id: 'c', label: '丙丙' },
        { id: 's', label: '乙乙' },
      ],
      edges: [{ from: 'c', to: 's', label: '请求' }],
    }),
  );
  const same = (k) => shapeOf(base, k).svg === shapeOf(next, k).svg;
  assert.ok(!same('node:c'), '改过的节点必须变');
  assert.ok(same('node:s'), '没改的节点必须一字不动');
  assert.ok(same('edge:0'), '连线不该被无关改动波及');
});

test('标签变宽会撑开列宽、兄弟节点平移（已知取舍，≤10 节点的图可接受）', () => {
  const mk = (label) =>
    renderDiagram(
      validateDiagram({
        type: 'graph',
        nodes: [
          { id: 'c', label: '甲' },
          { id: 's', label },
        ],
        edges: [{ from: 'c', to: 's' }],
      }),
    );
  const before = mk('乙');
  const after = mk('乙乙乙乙乙乙');
  assert.ok(
    shapeOf(before, 'node:c').svg !== shapeOf(after, 'node:c').svg,
    '最宽标签变化时列宽重算，兄弟节点随之平移（流式画布静默更新，不重播动画）',
  );
});

test('文本转义：label 里的 <script> / 引号 / & 原样变成文字', () => {
  const doc = validateDiagram({
    type: 'graph',
    nodes: [{ id: 'a', label: `<script>&"'` }],
  });
  const out = renderDiagram(doc);
  assert.ok(!/<script/i.test(out.svg), '输出里不允许出现未转义的 <script');
  assert.ok(out.svg.includes('&lt;script&gt;'), '尖括号必须被转义');
  assert.ok(out.svg.includes('&amp;'), '& 必须被转义');
  assert.ok(out.svg.includes('&quot;') && out.svg.includes('&#39;'), '引号必须被转义');
  const p = renderDiagram(
    validateDiagram({ type: 'plot', x: [-1, 1], labels: [{ at: [0, 0], text: 'a < b & c' }] }),
  );
  assert.ok(p.svg.includes('a &lt; b &amp; c'));
});

// ───────────────────────────────────────────────────────────────────────────────
// 5. graph 布局
// ───────────────────────────────────────────────────────────────────────────────

test('Dagre 默认 TB：链 a→b→c 占三行，y 递增', () => {
  const r = renderDiagram(
    validateDiagram({
      type: 'graph',
      nodes: [
        { id: 'a', label: '甲' },
        { id: 'b', label: '乙' },
        { id: 'c', label: '丙' },
      ],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
      ],
    }),
  );
  // box 形状是 rect：读 x（层号越大越靠右）
  const y = (k) => Number(/ y="([\d.]+)"/.exec(shapeOf(r, k).svg)[1]);
  assert.ok(y('node:a') < y('node:b') && y('node:b') < y('node:c'), 'TB 应从上到下排开');
  assert.equal(r.shapes.at(-1).key, 'edge:1', '边在节点之后（z 序：节点压住线）');
});

test('流式稳定性：往新层追加节点不挪动已落位的节点', () => {
  const mk = (extra) => ({
    type: 'graph',
    nodes: [{ id: 'a', label: '甲' }, { id: 'b', label: '乙' }, ...(extra ? [{ id: 'c', label: '丙' }] : [])],
    edges: [{ from: 'a', to: 'b' }, ...(extra ? [{ from: 'b', to: 'c' }] : [])],
  });
  const before = renderDiagram(validateDiagram(mk(false)));
  const after = renderDiagram(validateDiagram(mk(true)));
  assert.equal(shapeOf(before, 'node:a').svg, shapeOf(after, 'node:a').svg, '先落位的节点不因新节点挪位');
  assert.equal(shapeOf(before, 'node:b').svg, shapeOf(after, 'node:b').svg);
});

test('边只画两端都存在的；环不死循环且结果确定', () => {
  const r = renderDiagram(
    validateDiagram({
      type: 'graph',
      nodes: [
        { id: 'a', label: '甲' },
        { id: 'b', label: '乙' },
      ],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' },
      ],
    }),
  );
  assert.equal(r.shapes.filter((s) => s.key.startsWith('edge:')).length, 2);
  const again = renderDiagram(
    validateDiagram({
      type: 'graph',
      nodes: [
        { id: 'a', label: '甲' },
        { id: 'b', label: '乙' },
      ],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' },
      ],
    }),
  );
  assert.equal(r.svg, again.svg, '有环时布局仍确定');
});

test('direction LR 转置：层向纵向展开', () => {
  const nodes = [
    { id: 'a', label: '甲' },
    { id: 'b', label: '乙' },
    { id: 'c', label: '丙' },
  ];
  const edges = [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c' },
  ];
  const tb = renderDiagram(validateDiagram({ type: 'graph', nodes, edges }));
  const lr = renderDiagram(validateDiagram({ type: 'graph', direction: 'LR', nodes, edges }));
  // box 是 rect：读 y（TB 下同层节点 y 相同；LR 下层向纵向展开）
  const y = (r, k) => Number(/ y="([\d.]+)"/.exec(shapeOf(r, k).svg)[1]);
  assert.equal(y(lr, 'node:a'), y(lr, 'node:c'), 'LR 下链上节点横向同排');
  assert.ok(y(tb, 'node:a') < y(tb, 'node:b') && y(tb, 'node:b') < y(tb, 'node:c'), 'TB 下层向纵向展开');
  const x = (r, k) => Number(/ x="([\d.]+)"/.exec(shapeOf(r, k).svg)[1]);
  assert.ok(x(lr, 'node:a') < x(lr, 'node:c'), 'LR 从左到右');
});

test('schema 按图种拒绝混入字段，图表校验数据与范围', () => {
  assert.throws(() => validateDiagram({ ...GOOD_GRAPH, curves: [] }), /不认识的字段/);
  assert.throws(() => validateDiagram({ ...GOOD_PLOT, nodes: [] }), /不认识的字段/);
  for (const data of [[], [{ label: 'a', value: Infinity }], [{ label: 'a', value: 1, color: 'red' }]]) {
    assert.throws(() => validateDiagram({ type: 'chart', kind: 'bar', data }));
  }
  assert.throws(() => validateDiagram({ type: 'chart', kind: 'pie', data: [{ label: 'a', value: -1 }] }));
  assert.throws(() => validateDiagram({ type: 'chart', kind: 'pie', data: [{ label: 'a', value: 0 }] }));
  assert.throws(() => validateDiagram({ type: 'chart', kind: 'bar', y: [0, 1], data: [{ label: 'a', value: 2 }] }));
});

test('柱/折/饼每字符流式收敛，安全转义与极值几何', () => {
  for (const kind of ['bar', 'line', 'pie']) {
    const raw = JSON.stringify({ type: 'chart', kind, data: [{ label: '<script>', value: 2 }, { label: '乙', value: 4 }] });
    let keys = [];
    for (let i = 1; i <= raw.length; i++) {
      const progress = peekDiagramProgress(raw.slice(0, i));
      if (!progress) continue;
      const next = progress.shapes.map(s => s.key);
      assert.ok(keys.every(key => next.includes(key)));
      keys = next;
    }
    const rendered = renderDiagram(validateDiagram(JSON.parse(raw)));
    assert.deepEqual(peekDiagramProgress(raw).shapes, rendered.shapes);
    assert.equal(renderDiagram(validateDiagram(JSON.parse(raw))).svg, rendered.svg);
    assert.ok(!rendered.svg.includes('<script>'));
    const extreme = renderDiagram(validateDiagram({ type: 'chart', kind, data: [{ label: '大', value: 1e308 }, { label: '小', value: kind === 'pie' ? 0 : -1e308 }] }));
    assert.ok(!/NaN|Infinity/.test(extreme.svg));
  }
});

// ───────────────────────────────────────────────────────────────────────────────
// 6. plot 渲染
// ───────────────────────────────────────────────────────────────────────────────

test('曲线采样：x^2 的 path 点数足够、无 NaN/Infinity', () => {
  const r = renderDiagram(validateDiagram({ type: 'plot', x: [-3, 3], y: [-1, 9], curves: [{ fn: 'x^2' }] }));
  const d = /d="([^"]+)"/.exec(shapeOf(r, 'curve:0').svg)[1];
  assert.ok(!/NaN|Infinity/.test(d), 'path 里不允许出现 NaN / Infinity');
  const moves = (d.match(/M/g) ?? []).length;
  assert.equal(moves, 1, '连续曲线应当只有一段');
  const pts = (d.match(/[ML]/g) ?? []).length;
  assert.ok(pts > 100, `采样点应足够密（实得 ${pts}）`);
});

test('渐近线断条：1/x 在 x=0 处断开，不画连接 ±∞ 的竖线', () => {
  const r = renderDiagram(validateDiagram({ type: 'plot', x: [-4, 4], y: [-8, 8], curves: [{ fn: '1/x' }] }));
  const d = /d="([^"]+)"/.exec(shapeOf(r, 'curve:0').svg)[1];
  const moves = (d.match(/M/g) ?? []).length;
  assert.ok(moves >= 2, `渐近线两侧应断开成多段（实得 ${moves} 段）`);
  assert.ok(!/NaN|Infinity/.test(d));
});

test('自动 y 范围：只有几何图元时按外延取，轴线过原点', () => {
  const r = renderDiagram(
    validateDiagram({
      type: 'plot',
      x: [-1, 5],
      segments: [
        { from: [0, 0], to: [4, 3] },
        { from: [4, 3], to: [0, 3] },
      ],
    }),
  );
  // y 外延 [0,3] → 留 8% 边距 → [-0.24, 3.24]；0 在范围内 → x 轴过原点（像素 267.38），
  // 而不是贴底（底边在 286）
  const axes = shapeOf(r, 'axes').svg;
  assert.match(axes, /<line[^>]*y1="267/, 'x 轴应落在 y=0 处');
  assert.ok(axes.includes('>O<'), '原点要标 O');
  assert.ok(axes.includes('>x<') && axes.includes('>y<'), '轴名 x / y 要在');
});

test('刻度取 nice 数：[-10,10] 出 5 的倍数刻度', () => {
  const r = renderDiagram(validateDiagram({ type: 'plot', x: [-10, 10], y: [-10, 10] }));
  const axes = shapeOf(r, 'axes').svg;
  for (const t of ['-10', '-5', '5', '10']) {
    assert.ok(axes.includes(`>${t}<`), `应有刻度 ${t}`);
  }
  assert.ok(!axes.includes('>3.333333<'), '刻度必须是 nice 数');
});

test('圆按两轴缩放分别换算（x/y 单位长度不同 → 椭圆）', () => {
  const r = renderDiagram(
    validateDiagram({ type: 'plot', x: [-10, 10], y: [-5, 5], circles: [{ center: [0, 0], r: 2 }] }),
  );
  const m = /rx="([\d.]+)" ry="([\d.]+)"/.exec(shapeOf(r, 'circle:0').svg);
  assert.ok(m, '圆应渲染成椭圆（两轴缩放不同）');
  assert.ok(Number(m[2]) > Number(m[1]), 'y 跨度只有 x 的一半，ry 应大于 rx');
});

test('有 label 的曲线才画图例；axes:false 时不出坐标系', () => {
  const withLegend = renderDiagram(
    validateDiagram({ type: 'plot', x: [-1, 1], curves: [{ fn: 'x', label: 'y=x' }] }),
  );
  assert.ok(withLegend.shapes.some((s) => s.key === 'legend'));
  const noLegend = renderDiagram(validateDiagram({ type: 'plot', x: [-1, 1], curves: [{ fn: 'x' }] }));
  assert.ok(!noLegend.shapes.some((s) => s.key === 'legend'));
  const noAxes = renderDiagram(validateDiagram({ type: 'plot', x: [-1, 1], axes: false, curves: [{ fn: 'x' }] }));
  assert.ok(!noAxes.shapes.some((s) => s.key === 'axes'), 'axes:false 不出坐标系');
});

test('坏 fn 在完整渲染时抛错（带字符位置），预览期跳过该曲线', () => {
  assert.throws(
    () => renderDiagram(validateDiagram({ type: 'plot', x: [-1, 1], curves: [{ fn: 'sinn(x)' }] })),
    /第 \d+ 字符附近/,
  );
  const p = peekDiagramProgress('{"type":"plot","x":[-1,1],"curves":[{"fn":"sinn(x)"}]}');
  assert.ok(p, '预览期不该被一项坏曲线堵死');
  assert.ok(!p.shapes.some((s) => s.key.startsWith('curve:')), '坏曲线不出现在预览里');
});

// ───────────────────────────────────────────────────────────────────────────────
// 7. 流式不变量（peekDiagramProgress）
// ───────────────────────────────────────────────────────────────────────────────

const FULL_PLOT_JSON = JSON.stringify({
  type: 'plot',
  x: [-6, 6],
  y: [-2, 2],
  curves: [
    { fn: 'sin(x)', label: 'y=sin x' },
    { fn: 'cos(x)', label: 'y=cos x' },
  ],
  points: [{ at: [0, 0], label: 'O' }],
  labels: [{ at: [3, 1.5], text: '交点' }],
});

test('没到落画的时候返回 null（无 { / type 没写完 / type 不合法）', () => {
  assert.equal(peekDiagramProgress(''), null);
  assert.equal(peekDiagramProgress('这是抛物线：'), null);
  assert.equal(peekDiagramProgress('{"ty'), null);
  assert.equal(peekDiagramProgress('{"type":"flowchart"'), null, '非法 type 等终态报错，预览不猜');
});

test('type 一到就铺画布：plot 先出坐标系', () => {
  const p = peekDiagramProgress('{"type":"plot"');
  assert.ok(p, 'type 完整后就该有落画快照');
  assert.deepEqual(p.shapes.map((s) => s.key), ['axes']);
  assert.match(p.viewBox, /^0 0 494 314$/);
});

test('★ 逐字符喂入：key 只增不减，最后一拍 === 完整渲染', () => {
  const final = renderDiagram(validateDiagram(JSON.parse(FULL_PLOT_JSON)));
  let seen = [];
  for (let i = 1; i <= FULL_PLOT_JSON.length; i++) {
    const p = peekDiagramProgress(FULL_PLOT_JSON.slice(0, i));
    if (!p) continue;
    const keys = p.shapes.map((s) => s.key);
    for (const k of keys) assert.ok(seen.includes(k) || !seen.includes(k), '');
    // 只增不减：上一拍出现过的 key 这一拍必须还在
    for (const k of seen) assert.ok(keys.includes(k), `key「${k}」在 ${i} 字符处消失了`);
    seen = keys;
  }
  assert.deepEqual(seen, final.shapes.map((s) => s.key), '最后一拍的 key 集合应与终态一致');
  const last = peekDiagramProgress(FULL_PLOT_JSON);
  assert.deepEqual(last.shapes, final.shapes, '最后一拍的内容应与完整渲染逐字节一致');
});

test('半截字符串 / 截断数字不落画：宁可晚几个字符', () => {
  // label 写到一半（闭引号没到）→ 这个点不画，但坐标系照画
  const p = peekDiagramProgress('{"type":"plot","x":[-2,2],"points":[{"at":[0,0],"label":"顶');
  assert.ok(p && p.shapes.some((s) => s.key === 'axes'));
  assert.ok(!p.shapes.some((s) => s.key.startsWith('point:')), '半截标签的点不该上屏');
  // 引号补齐后立刻出现
  const q = peekDiagramProgress('{"type":"plot","x":[-2,2],"points":[{"at":[0,0],"label":"顶点"}]}');
  assert.ok(q.shapes.some((s) => s.key === 'point:0'));
});

test('截断的数字范围被忽略（"-1" 下一字符可能是 "2"）', () => {
  const p = peekDiagramProgress('{"type":"plot","x":[-1');
  assert.ok(p, '范围没写完不影响坐标系先用默认值铺画布');
  assert.ok(p.shapes.some((s) => s.key === 'axes'));
});

test('数组元素逐项落画：曲线 / 点 / 标签按完成顺序出现', () => {
  const steps = [
    ['{"type":"plot","x":[-2,2],"curves":[', ['axes']],
    ['{"type":"plot","x":[-2,2],"curves":[{"fn":"x^2"}', ['axes', 'curve:0']],
    ['{"type":"plot","x":[-2,2],"curves":[{"fn":"x^2"},', ['axes', 'curve:0']],
    ['{"type":"plot","x":[-2,2],"curves":[{"fn":"x^2"},{"fn":"x', ['axes', 'curve:0']],
    ['{"type":"plot","x":[-2,2],"curves":[{"fn":"x^2"},{"fn":"x"}', ['axes', 'curve:0', 'curve:1']],
    ['{"type":"plot","x":[-2,2],"curves":[{"fn":"x^2"},{"fn":"x"}],"points":[{"at":[1,1]}]}', ['axes', 'curve:0', 'curve:1', 'point:0']],
  ];
  for (const [src, want] of steps) {
    const p = peekDiagramProgress(src);
    assert.deepEqual(p ? p.shapes.map((s) => s.key) : null, [...want], `片段 ${src.slice(-24)}…`);
  }
});

test('graph 流式：节点逐个出现，边等两端到齐才画', () => {
  const a = peekDiagramProgress('{"type":"graph","nodes":[{"id":"a","label":"甲"}');
  assert.deepEqual(a.shapes.map((s) => s.key), ['node:a']);
  const b = peekDiagramProgress('{"type":"graph","nodes":[{"id":"a","label":"甲"},{"id":"b","label":"乙"}],"edges":[{"from":"a","to":"b"');
  assert.deepEqual(b.shapes.map((s) => s.key), ['node:a', 'node:b'], '边没写完不画');
  // 边一写完整，箭头 marker 的 defs 与边一起出现（defs 在最前，z 序最低）
  const c = peekDiagramProgress('{"type":"graph","nodes":[{"id":"a","label":"甲"},{"id":"b","label":"乙"}],"edges":[{"from":"a","to":"b"}]}');
  assert.deepEqual(c.shapes.map((s) => s.key), ['defs', 'node:a', 'node:b', 'edge:0'], '边写完整才出现');
  // 端点还没到：预览不出这条边（终态由校验报「不存在的节点」）
  const d = peekDiagramProgress('{"type":"graph","nodes":[{"id":"a","label":"甲"}],"edges":[{"from":"a","to":"z"}]}');
  assert.ok(!d.shapes.some((s) => s.key.startsWith('edge:')));
});

test('半截数据里的重复 id 只收第一个（画布按 key 合并会互顶）', () => {
  const p = peekDiagramProgress('{"type":"graph","nodes":[{"id":"a","label":"甲"},{"id":"a","label":"乙"}]}');
  assert.equal(p.shapes.filter((s) => s.key === 'node:a').length, 1);
  assert.ok(p.shapes.find((s) => s.key === 'node:a').svg.includes('甲'), '先到者赢');
});

test('闭合后的正文 / 多行 pretty JSON 都不影响解析', () => {
  const pretty = `{\n  "type": "plot",\n  "x": [-2, 2],\n  "curves": [\n    { "fn": "x^2" }\n  ]\n}\n（横轴为 x）`;
  const p = peekDiagramProgress(pretty);
  assert.ok(p && p.shapes.some((s) => s.key === 'curve:0'));
});

test('★ graph 流式收敛：最后一拍与完整渲染逐字节一致', () => {
  const src = JSON.stringify({
    type: 'graph',
    direction: 'TB',
    nodes: [
      { id: 'a', label: '客户端' },
      { id: 'b', label: '服务端' },
      { id: 'c', label: '数据库' },
    ],
    edges: [
      { from: 'a', to: 'b', label: '请求' },
      { from: 'b', to: 'c' },
    ],
  });
  const final = renderDiagram(validateDiagram(JSON.parse(src)));
  const last = peekDiagramProgress(src);
  assert.deepEqual(last.shapes, final.shapes);
  assert.equal(last.viewBox, final.viewBox);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
