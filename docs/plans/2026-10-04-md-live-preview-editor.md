# .md 所见即所得编辑 + Agent 共编辑 · 实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让 `.md` 阅读材料可在 CodeMirror 6 里「所见即所得」地编辑，并让问答 agent 通过 `edit_markdown` 工具改同一份文档（diff 高亮 + 一键撤销）。

**Architecture:** 文档模型始终是纯 markdown 文本。CodeMirror 的 `doc` 是唯一真相；「所见即所得」靠 `Decoration.replace` 隐藏语法符号实现（纯装饰，不进文档）。装饰规则抽成无 DOM 的纯函数，因此能在 node 里单测。agent 通过模块级注册表 `materialId → controller` 触达编辑器，工具层不依赖 React。

**Tech Stack:** CodeMirror 6（`codemirror` / `@codemirror/lang-markdown` / `@codemirror/commands` / `@lezer/markdown`）、React 19、Dexie、OPFS、Playwright

**设计文档：** `docs/plans/2026-10-04-md-live-preview-editor-design.md`

---

## 已核实的事实（不要重新踩）

- `@lezer/markdown` 导出的 `parser` 是纯 JS，**可在 node 里跑** → 装饰规则能进一层单测
- `@codemirror/state` 无 DOM 依赖 → `ChangeSet` 构造能进一层单测
- `isolateHistory` 是 `@codemirror/commands` 里的 `Annotation.define()`，用法 `isolateHistory.of('full')`
- `syntaxTree(state)` 来自 `@codemirror/language`；`atomicRanges` 是 `@codemirror/view` 的 facet
- lezer-markdown 节点名（已逐一核对）：`ATXHeading1..6` / `SetextHeading1..2` / `HeaderMark` /
  `QuoteMark` / `ListMark` / `EmphasisMark` / `CodeMark` / `LinkMark` / `InlineCode` /
  `CodeText` / `CodeInfo` / `FencedCode` / `CodeBlock` / `BulletList` / `OrderedList` / `ListItem`
- `src/materials/parse.ts` **静态 import `./pdf.ts`（pdfjs-dist）** → 从编辑器链路 import 它会把 pdfjs 拖进来，必须绕开（Task 6）
- `ChatPanel` 只拿到 `materialKind`，**拿不到 `materialFormat`** → 需要 `Player.tsx` 多传一个 prop（Task 9）
- `scripts/e2e-all.mjs` 有守门员：磁盘上有、但 `META` 里没登记的脚本会让跑分变红 →
  **两个单测脚本和一个 e2e 脚本都要登记**（Task 3 / 7 / 11）
- 跑 `preview` 档 e2e 前必须 `npm run build`，否则验的是旧 `dist/`

---

### Task 1: 装依赖

**Files:**
- Modify: `package.json`

**Step 1: 安装**

```bash
npm install codemirror@6 @codemirror/lang-markdown@6 @codemirror/commands@6 @lezer/markdown@1
```

**Step 2: 确认装到了、且 view 层不进 node 单测路径**

```bash
ls node_modules/@codemirror node_modules/@lezer/markdown
```

**Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "build: 引入 CodeMirror 6（md 所见即所得编辑）"
```

---

### Task 2: 装饰规则纯函数 `hideRanges.ts`

**Files:**
- Create: `src/md-editor/hideRanges.ts`
- Test: `scripts/test-md-live-preview.mjs`

**Step 1: 写失败的测试**

`scripts/test-md-live-preview.mjs`：

```js
#!/usr/bin/env node
/**
 * md 编辑态装饰规则的单元测试（无需 API key / 无需起服务）。
 * 运行：node scripts/test-md-live-preview.mjs
 *
 * @lezer/markdown 是纯 JS，可在 node 里解析，因此「语法符号该不该藏」
 * 这条最容易写错的规则能被直接断言。
 */
import assert from 'node:assert/strict';
import { parser } from '@lezer/markdown';
import { planDecorations } from '../src/md-editor/hideRanges.ts';

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push({ name, e }); console.log(`  FAIL - ${name}\n    ${e.message}`); }
}

/** 光标落在一个位置上（编辑器里 selection 是这样表示的） */
const cursor = (pos) => [{ from: pos, to: pos }];
/** 不在任何位置（等价于「没有焦点」） */
const idle = [];
/** 从 text 里找子串位置，断言用 */
const at = (text, sub) => {
  const i = text.indexOf(sub);
  assert.notEqual(i, -1, `测试样本里找不到 ${JSON.stringify(sub)}`);
  return i;
};
const kindsAt = (specs, from, to) =>
  specs.filter((s) => s.from === from && s.to === to).map((s) => s.kind);

// ── 标题：# 要藏 ─────────────────────────────────────────────────────────
test('ATX 标题的 # 在无光标时隐藏', () => {
  const src = '# 标题\n';
  const specs = planDecorations(parser.parse(src), src, idle);
  assert.deepEqual(kindsAt(specs, 0, 1), ['hide']);
});

test('光标落在标题行内时 # 必须露出', () => {
  const src = '# 标题\n';
  const specs = planDecorations(parser.parse(src), src, cursor(3));
  assert.deepEqual(kindsAt(specs, 0, 1), [], '光标在标题里时 # 不能被藏');
});

test('光标在另一段时标题 # 照藏', () => {
  const src = '# 标题\n\n正文。\n';
  const body = at(src, '正文');
  const specs = planDecorations(parser.parse(src), src, cursor(body));
  assert.deepEqual(kindsAt(specs, 0, 1), ['hide'], '光标不在标题里，# 该藏');
});

// ── 行内强调 ────────────────────────────────────────────────────────────
test('非光标处的 ** 被隐藏', () => {
  const src = '这是**粗体**文字\n';
  const s1 = at(src, '**');
  const specs = planDecorations(parser.parse(src), src, idle);
  assert.deepEqual(kindsAt(specs, s1, s1 + 2), ['hide']);
});

test('光标在粗体内部时 ** 露出（否则没法编辑）', () => {
  const src = '这是**粗体**文字\n';
  const inside = at(src, '粗体') + 1;
  const specs = planDecorations(parser.parse(src), src, cursor(inside));
  assert.equal(kindsAt(specs, at(src, '**'), at(src, '**') + 2).length, 0);
});

test('行内代码加样式类 CodeMark 且光标处露出', () => {
  const src = '调用 `foo()` 完成\n';
  const b = at(src, '`');
  const specs = planDecorations(parser.parse(src), src, idle);
  assert.deepEqual(kindsAt(specs, b, b + 1), ['hide']);
  const inner = planDecorations(parser.parse(src), src, cursor(b + 2));
  assert.equal(kindsAt(inner, b, b + 1).length, 0);
});

// ── 列表：有序列表的序号是信息，必须保留 ────────────────────────────────
test('无序列表符号隐藏、有序列表序号保留', () => {
  const src = '- 甲\n- 乙\n\n1. 丙\n2. 丁\n';
  const bullet = at(src, '- ');
  const specs = planDecorations(parser.parse(src), src, idle);
  assert.deepEqual(kindsAt(specs, bullet, bullet + 1), ['hide'], '无序符号该藏');
  const one = at(src, '1.');
  assert.deepEqual(kindsAt(specs, one, one + 2), [], '有序序号不能藏，藏了就不知道是第几项');
});

// ── 引用 ────────────────────────────────────────────────────────────────
test('引用块 > 隐藏', () => {
  const src = '> 引用一句话\n';
  const specs = planDecorations(parser.parse(src), src, idle);
  assert.deepEqual(kindsAt(specs, 0, 1), ['hide']);
});

// ── 围栏：首尾 ``` 行折叠，正文行加类 ─────────────────────────────────
test('围栏代码块首尾行折叠、正文行加代码块样式', () => {
  const src = '```js\nconst a = 1;\n```\n';
  const specs = planDecorations(parser.parse(src), src, idle);
  const collapse = specs.filter((s) => s.kind === 'collapse').map((s) => [s.from, s.to]);
  assert.deepEqual(collapse, [
    [0, 5],
    [src.indexOf('```', 6), src.indexOf('```', 6) + 3],
  ], '首尾两行都要折叠，且要正好是 ``` 那一行');
  const codeLine = at(src, 'const');
  assert.ok(
    specs.some((s) => s.kind === 'mark' && s.cls === 'cm-md-codeblock' && s.from === codeLine),
    '代码正文所在行要加 cm-md-codeblock',
  );
});

test('光标在围栏内时首尾行不折叠（否则进不去编辑）', () => {
  const src = '```js\nconst a = 1;\n```\n';
  const inside = at(src, 'const') + 6;
  const specs = planDecorations(parser.parse(src), src, cursor(inside));
  assert.equal(specs.filter((s) => s.kind === 'collapse').length, 0);
});

// ── 输出契约 ────────────────────────────────────────────────────────────
test('结果按 from 升序且无重叠（RangeSetBuilder 的硬要求）', () => {
  const src = '# 标题\n\n- 甲\n\n> 引用 `code` 与**粗体**\n\n```\nx\n```\n';
  for (const active of [idle, cursor(5), cursor(at(src, '粗体'))]) {
    const specs = planDecorations(parser.parse(src), src, active);
    for (let i = 1; i < specs.length; i++) {
      assert.ok(
        specs[i - 1].to <= specs[i].from,
        `第 ${i} 项与前一项重叠：${JSON.stringify(specs.slice(i - 1, i + 1))}`,
      );
    }
  }
});

test('空文档不炸', () => {
  const specs = planDecorations(parser.parse(''), '', idle);
  assert.ok(Array.isArray(specs));
});

if (failures.length) {
  console.error(`\n${failures.length} 个用例失败（共 ${passed + failures.length} 个）`);
  process.exit(1);
}
console.log(`\n全部通过：${passed} 个用例`);
```

**Step 2: 跑测试确认失败**

```bash
node scripts/test-md-live-preview.mjs
```

Expected: `Error [ERR_MODULE_NOT_FOUND]` 或 `Cannot find module '../src/md-editor/hideRanges.ts'`

**Step 3: 写实现**

`src/md-editor/hideRanges.ts`：

```ts
/**
 * md 编辑态的装饰计算。**纯函数**：只吃语法树 + 文档字符串 + 光标区间，不碰 DOM。
 *
 * 为什么要拆出来：CodeMirror 的 ViewPlugin 依赖 @codemirror/view（在 node 里跑不起来），
 * 而「某个语法符号该不该藏」是本功能最容易写错、也最影响可用性的一条规则
 * —— 藏过头编辑器就难用，藏少了就不是所见即所得。把决策抽到这里，
 * 就能用 @lezer/markdown（纯 JS 解析器）在一层单测里直接断言，见 scripts/test-md-live-preview.mjs。
 *
 * 输出是一串**按 from 升序、互不重叠**的 spec，直接喂给 CodeMirror 的 RangeSetBuilder
 * （它要求严格有序，重叠会抛）。这个契约有单测守着。
 *
 * ── v1 的取舍（哪些不藏，是刻意的）────────────────────────────────────
 * - **有序列表的序号不藏**：藏了用户就不知道自己在改第几项，那是信息不是语法。
 * - **链接的 `[` `]` `(` `)` 不藏**：藏掉链接地址等于让用户没法核对跳到哪里，
 *   而链接本身渲染出来也就是那串文字，藏了收益很小、风险很大。
 * - **表格 / 图片不特殊处理**：lezer-markdown 的表格来自 GFM mixin，节点边界最容易出 bug，
 *   v1 按源码原样显示，等 v1 稳了再单独做。
 * 这几条是「v1 明确不覆盖」，不是遗漏 —— 见设计文档的风险一节。
 */
import type { Tree } from '@lezer/common';

/** 文档里的一段。`from === to` 表示一个光标位置（不覆盖任何字符）。 */
export interface DocRange {
  from: number;
  to: number;
}

export type DecorSpec =
  /** 藏掉这段语法符号（装饰层用 `Decoration.replace({})`，无 widget） */
  | { kind: 'hide'; from: number; to: number }
  /** 把这一整行折叠掉（围栏的 ``` 行）：行本身还在文档里，只是高度为 0 */
  | { kind: 'collapse'; from: number; to: number }
  /** 加样式类 */
  | { kind: 'mark'; from: number; to: number; cls: string };

/** 这些是「纯语法符号」，藏了不丢信息 */
const MARK_NODES = new Set(['HeaderMark', 'QuoteMark', 'EmphasisMark', 'CodeMark']);

/** 标题节点名 → 级别数字 */
function headingLevel(name: string): number | null {
  const atx = /^ATXHeading([1-6])$/.exec(name);
  if (atx) return Number(atx[1]);
  if (name === 'SetextHeading1') return 1;
  if (name === 'SetextHeading2') return 2;
  return null;
}

/**
 * 语法符号是否要露出：它碰到任一「活跃区间」就不藏。
 *
 * 两侧都是闭区间 —— 光标是 `from === to` 的零宽区间，用半开区间判定会漏掉
 * 「光标正好停在 `**` 前面」这一种，而那恰恰是最常见的位置。
 */
function revealed(mark: DocRange, active: readonly DocRange[]): boolean {
  return active.some((a) => mark.from <= a.to && a.from <= mark.to);
}

/** 覆盖 `pos` 那一行的行范围（不含换行符）。越界安全。 */
function lineAt(doc: string, pos: number): DocRange {
  const p = Math.max(0, Math.min(pos, doc.length));
  const from = doc.lastIndexOf('\n', p - 1) + 1;
  const nl = doc.indexOf('\n', p);
  return { from, to: nl < 0 ? doc.length : nl };
}

/** 把 [from,to) 展开成若干整行 */
function linesOf(doc: string, from: number, to: number): DocRange[] {
  const out: DocRange[] = [];
  let cur = lineAt(doc, from);
  while (cur.from < to) {
    out.push(cur);
    if (cur.to >= doc.length) break;
    cur = lineAt(doc, cur.to + 1);
  }
  return out;
}

/**
 * 算出这份文档当前该有的装饰。
 *
 * @param tree  `syntaxTree(state)` 或 `parser.parse(src)`（两者同源）
 * @param doc  文档全文。**必须与 tree 解析时的文本一致**，否则坐标全错
 * @param active 光标 / 选区。传 `[]` 表示「没有焦点，全按渲染态处理」
 */
export function planDecorations(tree: Tree, doc: string, active: readonly DocRange[]): DecorSpec[] {
  const specs: DecorSpec[] = [];
  const push = (s: DecorSpec) => specs.push(s);

  /** 当前所处的列表类型栈：`['bullet'|'ordered']`，ListMark 用栈顶判断 */
  const listStack: ('bullet' | 'ordered')[] = [];

  tree.iterate({
    enter(node) {
      const name = node.type.name;
      const range: DocRange = { from: node.from, to: node.to };

      if (name === 'BulletList' || name === 'OrderedList') {
        listStack.push(name === 'BulletList' ? 'bullet' : 'ordered');
        return;
      }

      if (MARK_NODES.has(name)) {
        if (!revealed(range, active)) push({ kind: 'hide', from: node.from, to: node.to });
        return false; // 叶节点，往下没有可处理的
      }

      const level = headingLevel(name);
      if (level !== null) {
        for (const l of linesOf(doc, node.from, node.to)) {
          push({ kind: 'mark', from: l.from, to: l.to, cls: `cm-md-h${level}` });
        }
        return; // 标题里的行内标记交给下面正常处理（行内标记也要藏）
      }

      if (name === 'InlineCode') {
        push({ kind: 'mark', from: node.from, to: node.to, cls: 'cm-md-inlinecode' });
        return false; // 里面的 CodeMark 已被上面藏掉，别重复
      }

      if (name === 'ListMark') {
        // 有序列表的序号是信息不是语法：只藏无序符号
        if (listStack[listStack.length - 1] === 'bullet' && !revealed(range, active)) {
          push({ kind: 'hide', from: node.from, to: node.to });
        }
        return false;
      }

      if (name === 'FencedCode') {
        const open = lineAt(doc, node.from);
        const close = lineAt(doc, node.to - 1);
        // 光标在块内时一行都不折叠 —— 折叠掉就再也点不进去了
        const inside = revealed({ from: node.from, to: node.to }, active);
        if (!inside) {
          push({ kind: 'collapse', from: open.from, to: open.to });
          if (close.from !== open.from) push({ kind: 'collapse', from: close.from, to: close.to });
        }
        for (const l of linesOf(doc, open.to + 1, close.from)) {
          push({ kind: 'mark', from: l.from, to: l.to, cls: 'cm-md-codeblock' });
        }
        return false; // 里面的 CodeText 不用再处理
      }

      if (name === 'CodeBlock') {
        for (const l of linesOf(doc, node.from, node.to)) {
          push({ kind: 'mark', from: l.from, to: l.to, cls: 'cm-md-codeblock' });
        }
        return false;
      }

      if (name === 'HTMLBlock') {
        for (const l of linesOf(doc, node.from, node.to)) {
          push({ kind: 'mark', from: l.from, to: l.to, cls: 'cm-md-codeblock' });
        }
        return false;
      }
    },
    leave(node) {
      const name = node.type.name;
      if (name === 'BulletList' || name === 'OrderedList') listStack.pop();
    },
  });

  // 排序是 RangeSetBuilder 的硬要求，顺带消掉同类里 push 顺序的偶然性
  specs.sort((a, b) => a.from - b.from || a.to - b.to);

  // 去掉被包含的冗余项：同一段既被整体 collapse 又被当标题标行（不该发生，但要保证不重叠）
  const out: DecorSpec[] = [];
  for (const s of specs) {
    const prev = out[out.length - 1];
    if (prev && s.from < prev.to) continue;
    out.push(s);
  }
  return out;
}
```

**Step 4: 跑测试确认通过**

```bash
node scripts/test-md-live-preview.mjs
```

Expected: 全部 `ok`，最后 `全部通过：N 个用例`

如果「结果按 from 升序且无重叠」失败，说明有区间重叠 —— 修 `planDecorations`，**不要改测试**。

**Step 5: Commit**

```bash
git add src/md-editor/hideRanges.ts scripts/test-md-live-preview.mjs
git commit -m "feat(md-editor): 语法符号隐藏规则（纯函数 + 单测）"
```

---

### Task 3: 单测脚本登记进跑分编排

**Files:**
- Modify: `scripts/e2e-all.mjs`

**Step 1: 登记**

在 `META` 的「纯 Node」段（`'test-lexical'` 附近）加一行：

```js
  // md 编辑态装饰规则：语法符号该不该藏（重点是光标落在符号内时必须露出）。
  // 纯逻辑：@lezer/markdown 是纯 JS 解析器，node 里能跑。
  'test-md-live-preview': { service: 'none', antd: false, timeout: 120 },
```

**Step 2: 验证守门员不报漏登记**

```bash
node scripts/e2e-all.mjs --only=test-md-live-preview
```

Expected: 该项 `pass`。若报「磁盘上有但未登记」，说明名字拼错了。

**Step 3: Commit**

```bash
git add scripts/e2e-all.mjs
git commit -m "test: 登记 test-md-live-preview"
```

---

### Task 4: 装饰层 `livePreview.ts` + 样式

**Files:**
- Create: `src/md-editor/livePreview.ts`
- Create: `src/md-editor/theme.ts`

**Step 1: 实现**

`src/md-editor/livePreview.ts`：

```ts
/**
 * 把 planDecorations 的结果包成 CodeMirror 装饰。**薄适配层**：所有决策都在
 * ./hideRanges.ts 的纯函数里，这里只负责翻译 + 一处必要的实时性处理。
 */
import { EditorView, Decoration, ViewPlugin, WidgetType, type DecorationSet } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { RangeSetBuilder, type Extension } from '@codemirror/state';
import { planDecorations, type DecorSpec, type DocRange } from './hideRanges';

/** 折叠一整行：行仍在文档里，只是渲染成零高度（因此还能点进去展开编辑） */
class CollapsedLine extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    return document.createTextNode('');
  }
  ignoreEvent() {
    // 必须返回 false：否则光标事件被吃掉，用户点不到这一行、也就无法展开
    return false;
  }
}

function buildDecorations(view: EditorView): DecorationSet {
  const doc = view.state.doc;
  const src = doc.toString();
  const active: DocRange[] = view.state.selection.ranges.map((r) => ({ from: r.from, to: r.to }));
  const specs: DecorSpec[] = planDecorations(syntaxTree(view.state), src, active);

  const builder = new RangeSetBuilder<Decoration>();
  for (const s of specs) {
    if (s.kind === 'hide') builder.add(s.from, s.to, Decoration.replace({}));
    else if (s.kind === 'collapse') {
      builder.add(s.from, s.to, Decoration.replace({ widget: new CollapsedLine(), block: true }));
    } else builder.add(s.from, s.to, Decoration.mark({ class: s.cls }));
  }
  return builder.finish();
}

/** md 编辑态的所见即所得。挂到 EditorView 的 extensions 里即可。 */
export function livePreview(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildDecorations(view);
      }
      update(u: { view: EditorView; docChanged: boolean; selectionSet: boolean; viewportChanged: boolean }) {
        // IME 组合期间**不重算**：此时文档与选区处于不一致的中间态，
        // 重算会让装饰整体错位，表现为「中文打字时光标乱跳 / 字消失」。
        // composition 结束时必然带来一次 docChanged 或 selectionSet，那一次会补上。
        if (u.view.composing) return;
        if (u.docChanged || u.selectionSet || u.viewportChanged) {
          this.decorations = buildDecorations(u.view);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}
```

`src/md-editor/theme.ts`：导出 `mdEditorTheme: Extension`，包含 `EditorView.theme`（编辑面底色/字号）与 `EditorView.baseTheme` 之外的样式类（`.cm-md-h1..h6` / `.cm-md-inlinecode` / `.cm-md-codeblock` / `.cm-md-diffadd`）。

**硬要求**：颜色与间距一律取 `src/theme.css` 已有的 MD3 令牌，**不自造颜色**；不要引 `@codemirror/theme-one-dark` 之类的成品主题（会和 Material You 打架）。

**Step 2: 类型检查**

```bash
npx tsc -b
```

Expected: 0 error

**Step 3: Commit**

```bash
git add src/md-editor/livePreview.ts src/md-editor/theme.ts
git commit -m "feat(md-editor): Decoration 装饰层 + 编辑态样式"
```

---

### Task 5: 编辑态外壳 `MdEditor.tsx` + 阅读器入口

**Files:**
- Create: `src/md-editor/MdEditor.tsx`
- Modify: `src/components/MdReader.tsx`（工具条加「编辑」入口 + 挂载）

**Step 1: 实现 `MdEditor.tsx`**

要点（照抄 `DocxReader` / `PdfReader` 的既有结构，别自造一套）：

- `basicSetup` + `markdown()` + `livePreview()` + `mdEditorTheme` + `history()` + `keymap.of([...defaultKeymap, ...historyKeymap])`
- **必须在 `useEffect` 里建 / 销毁 `EditorView`**，不要在 render 里建
- 初始 doc 用 `useState(() => new Text(initialText))` 拿一次，**不要每次 render 重建**
- `onChange` 里 `updateListener` 拿到 `state.doc.toString()` → 交给 `onDirty`（debounce 保存在 Task 7）
- 工具条：`保存状态` / `看源码`（切 `EditorState` 的 tabSize？**不**，切一个 `showSource` state，false 时不挂 `livePreview()`）/ `撤销本次 agent 改动`（Task 9 接上）
- 卸载时 `view.destroy()`

**Step 2: 阅读器入口**

`MdReader.tsx`：在 `mr-bar` 里加一个按钮切 `editing` state；`editing` 时用 **动态 import** 渲染 MdEditor：

```ts
const MdEditor = lazy(() => import('../md-editor/MdEditor'));
```

**为什么必须动态 import**：CodeMirror 约 120KB gzip，不进主包 —— 绝大多数用户只看材料不编辑，不该为它付首屏。

**Step 3: 类型检查 + 构建**

```bash
npx tsc -b && npm run build
```

Expected: 0 error；`dist/assets` 里 CodeMirror 应落在**独立 chunk**（`ls -S dist/assets | head` 能看到一个大 js）

**Step 4: Commit**

```bash
git add src/md-editor/MdEditor.tsx src/components/MdReader.tsx
git commit -m "feat(md): 阅读器接入所见即所得编辑面"
```

---

### Task 6: 保存 + 重新分块（绕开 pdfjs）

**Files:**
- Create: `src/materials/reindex.ts`
- Modify: `src/materials/parse.ts`
- Create: `src/md-editor/save.ts`

**Step 1: 先看清要抽什么**

`parseMaterial`（`src/materials/parse.ts:142` 起）的尾巴是 DOM 无关的：
`chunkUnits` → `countChars` → `judgeMaterialText` → 事务重建 `materialBlocks` + 更新 `videos`。
把它整段搬进新文件，`parse.ts` 改为调用它。

**Step 2: 新建 `src/materials/reindex.ts`**

把上面那段原样搬过来，签名：

```ts
export async function reindexMaterial(
  materialId: string,
  format: MaterialFormat,
  units: RawUnit[],
  declaredUnits: number | null,
): Promise<MaterialParseResult>
```

`format` / `MaterialFormat` / `MaterialParseResult` 从 `./parse.ts` import 会成环 —— 改成把这三个**类型**声明也搬进 `reindex.ts`，`parse.ts` 再 `export type { ... } from './reindex'`（保持对外 API 不变，别去改一堆调用点）。

**Step 3: 改 `parse.ts`**

`parseMaterial` 解析完 `units` 后直接 `return reindexMaterial(materialId, format, units, declaredUnits)`，删掉被搬走的那段。

**Step 4: 验证没把 pdfjs 带进来**

```bash
npm run build 2>&1 | tail -20
```

然后确认 `reindex.ts` 的依赖链里没有 `pdf`：

```bash
grep -n "^import" src/materials/reindex.ts
```

Expected: 看不到 `./pdf`

**Step 5: 新建 `src/md-editor/save.ts`**

```ts
/**
 * md 编辑态的落盘：写 OPFS blob + 重新分块。
 *
 * debounce 的理由：CM6 每敲一个键都来一次，全量重写 blob + 全量重建块
 * 会把主线程占住。1.2s 是「停顿」与「及时」之间的折中。
 * 保存失败要 reject —— UI 据此显式留痕，不能静默吞掉（设计文档不变量 5）。
 */
```

导出 `createMdSaver(materialId, opts)`，内部 `setTimeout` debounce，`flush()` / `dispose()`；写完调 `reindexMaterial(materialId, 'md', extractMdUnits(text), null)`，并 `db.videos.update(materialId, { lastUnit: undefined })`（段号漂移了，阅读位置语义已变，见设计文档）。

**Step 6: 类型检查 + Commit**

```bash
npx tsc -b
git add src/materials/reindex.ts src/materials/parse.ts src/md-editor/save.ts
git commit -m "feat(md): 编辑落盘 + 重新分块（绕开 pdfjs 依赖链）"
```

---

### Task 7: agent 编辑的纯逻辑 + 单测

**Files:**
- Create: `src/md-editor/edits.ts`
- Test: `scripts/test-md-edit-tool.mjs`
- Modify: `scripts/e2e-all.mjs`

**Step 1: 写失败的测试**

`scripts/test-md-edit-tool.mjs`（结构照抄 `scripts/test-lexical.mjs`）：

```js
#!/usr/bin/env node
/**
 * agent 编辑 .md 的纯逻辑单元测试（无需 API key / 无需起服务）。
 * 运行：node scripts/test-md-edit-tool.mjs
 *
 * 守的是「模型给错 old_string 时能不能得到可操作的诊断」——
 * 诊断含糊 = 模型白烧一轮工具调用。
 */
import assert from 'node:assert/strict';
import { planAgentEdits } from '../src/md-editor/edits.ts';
```

用例（逐条实现）：

1. 唯一命中 → 成功，`changes` 长度 1，坐标正确
2. `old_string` 不存在 → `ok:false`，`error` 里出现该 `old_string` 的内容（模型据此知道是哪一条错了）
3. 命中多处且没给 `replace_all` → `ok:false`，`error` 含命中次数
4. 命中多处且给了 `replace_all` → 成功，`changes` 长度 = 命中次数
5. 多条编辑互不重叠 → 成功，`changes` 长度 = 编辑条数
6. 两条编辑区间重叠 → `ok:false`，`error` 提到「重叠」
7. `old_string` 为空串 → `ok:false`（空串会匹配到每个位置，必须挡住）
8. `edits` 为空数组 → `ok:false`，`error` 说清是空指令
9. **`highlights` 是新文档坐标**：一条在 offset 10 插入 5 字符后，紧随其后的第二条编辑的 `highlights.from` 已经平移了 —— 这条最容易写错（拿旧坐标去高亮会错位）
10. 纯删除（`new_string` 为空）→ `highlights` 里不出现它（没东西可高亮），但 `changes` 里有

**Step 2: 跑测试确认失败**

```bash
node scripts/test-md-edit-tool.mjs
```

Expected: 模块找不到

**Step 3: 实现 `src/md-editor/edits.ts`**

```ts
/**
 * agent 编辑请求 → 具体改动坐标。**纯函数**，不碰 CodeMirror。
 *
 * 为什么用精确字符串匹配而不是行号：行号对模型极易过期 —— 它看到的是上一次
 * 检索时的文档，而文档可能刚被用户或前一次工具调用改过。`old_string` 自带定位信息，
 * 过期时会**明确匹配失败**，而不是往错的位置上写。
 *
 * 诊断文案是这个函数的主要产出：含糊的报错会让模型换个说法再试一遍、白烧一轮，
 * 所以每条失败都要点名是哪一条 edit、命中了几处、该怎么改。
 */

export interface AgentEdit {
  old_string: string;
  new_string: string;
  /** 同一段出现多次时是否全部替换；默认 false（要求唯一命中） */
  replace_all?: boolean;
}

/** 改动区间，坐标基于**调用时的文档** */
export interface EditChange {
  from: number;
  to: number;
  insert: string;
}

export interface AgentHighlight {
  /** 新文档坐标：插入内容落在哪里 */
  from: number;
  to: number;
  /** 旧文本（用于「删了 N 字」这类提示） */
  removed: string;
}

export type PlanResult =
  | { ok: true; changes: EditChange[]; highlights: AgentHighlight[] }
  | { ok: false; error: string };

function countOf(doc: string, needle: string): number {
  let n = 0;
  let i = doc.indexOf(needle);
  while (i !== -1) {
    n++;
    i = doc.indexOf(needle, i + needle.length);
  }
  return n;
}

const brief = (s: string, n = 40): string => {
  const one = s.replace(/\s+/g, ' ');
  return one.length > n ? `${one.slice(0, n)}…` : one;
};

export function planAgentEdits(doc: string, edits: AgentEdit[]): PlanResult {
  if (!Array.isArray(edits) || edits.length === 0) {
    return { ok: false, error: 'edits 为空：没有任何要改的内容。请给出 old_string / new_string。' };
  }

  const found: { change: EditChange; highlight: AgentHighlight | null; i: number }[] = [];

  for (let i = 0; i < edits.length; i++) {
    const e = edits[i] ?? ({} as AgentEdit);
    const oldStr = typeof e.old_string === 'string' ? e.old_string : '';
    const newStr = typeof e.new_string === 'string' ? e.new_string : '';
    if (!oldStr) {
      return {
        ok: false,
        error: `第 ${i + 1} 条编辑的 old_string 是空的。old_string 必须是从文档里原样复制的片段（至少一个字），否则无法定位。`,
      };
    }
    const hits = countOf(doc, oldStr);
    if (hits === 0) {
      return {
        ok: false,
        error: `第 ${i + 1} 条编辑没找到 old_string「${brief(oldStr)}」。文档可能已被改动，请先用 get_material_range 重新读取该处原文，再照原样复制。`,
      };
    }
    if (hits > 1 && !e.replace_all) {
      return {
        ok: false,
        error: `第 ${i + 1} 条编辑的 old_string「${brief(oldStr)}」在文档中出现了 ${hits} 处，无法确定改哪一处。请补充上下文让它唯一，或给 replace_all: true 表示全部替换。`,
      };
    }
    let from = doc.indexOf(oldStr);
    do {
      found.push({
        change: { from, to: from + oldStr.length, insert: newStr },
        highlight: newStr ? null : { from, to: from, removed: oldStr },
        i,
      });
      const next = doc.indexOf(oldStr, from + oldStr.length);
      if (next === -1) break;
      from = next;
    } while (e.replace_all);
  }

  found.sort((a, b) => a.change.from - b.change.from);

  // 重叠判定必须在排序后做：两条编辑命中同一段时，后一条的 from 会落在前一条的 to 之内
  for (let k = 1; k < found.length; k++) {
    const prev = found[k - 1];
    const cur = found[k];
    if (cur.change.from < prev.change.to) {
      return {
        ok: false,
        error: `第 ${prev.i + 1} 条与第 ${cur.i + 1} 条编辑的区间重叠（都命中了「${brief(doc.slice(cur.change.from, prev.change.to))}」）。请把它们合成一条，或调整 old_string 让区间不重叠。`,
      };
    }
  }

  const changes = found.map((f) => f.change);

  // 高亮坐标要换算到**新文档**：前面每插入 N 个字符，后面的位置就整体后移 N。
  // 直接拿旧坐标去 dispatch 后画装饰，结果是绿色高亮落在无关的字上。
  let shift = 0;
  const highlights: AgentHighlight[] = [];
  for (const f of found) {
    if (f.highlight) {
      highlights.push({ ...f.highlight, from: f.highlight.from + shift, to: f.highlight.to + shift });
    } else if (f.change.insert) {
      highlights.push({ from: f.change.from + shift, to: f.change.from + shift + f.change.insert.length, removed: '' });
    }
    shift += f.change.insert.length - (f.change.to - f.change.from);
  }

  return { ok: true, changes, highlights };
}
```

**Step 4: 跑测试确认通过**

```bash
node scripts/test-md-edit-tool.mjs
```

Expected: 全部 ok

**Step 5: 登记进 META 并验证**

在 `scripts/e2e-all.mjs` 的纯 Node 段加：

```js
  // agent 编辑 .md 的匹配逻辑：唯一命中 / 未命中 / 多处命中 / 区间重叠的诊断文案，
  // 以及高亮坐标从「旧文档」换算到「新文档」的平移。纯逻辑。
  'test-md-edit-tool': { service: 'none', antd: false, timeout: 120 },
```

```bash
node scripts/e2e-all.mjs --only=test-md-edit-tool
```

Expected: `pass`

**Step 6: Commit**

```bash
git add src/md-editor/edits.ts scripts/test-md-edit-tool.mjs scripts/e2e-all.mjs
git commit -m "feat(md-editor): agent 编辑的匹配与诊断逻辑 + 单测"
```

---

### Task 8: 编辑器桥接 `bridge.ts`（dispatch / diff / 撤销）

**Files:**
- Create: `src/md-editor/agentDiff.ts`
- Create: `src/md-editor/bridge.ts`

**Step 1: `agentDiff.ts` —— 高亮装饰的 StateField**

标准 StateField 模式（CodeMirror 文档里的写法）：

```ts
const setAgentDiff = StateEffect.define<DecorationSet>();
export const agentDiffField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    // 先随文档改动平移，再叠加本次事务带来的新装饰 —— 顺序反了会错位
    value = value.map(tr.changes);
    for (const e of tr.effects) if (e.is(setAgentDiff)) value = e.value;
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});
```

导出 `applyDiff(editor, highlights)`：构造 `Decoration.mark({ class: 'cm-md-diffadd' })` 的 RangeSet，作为 `setAgentDiff` effect 派发。

**Step 2: `bridge.ts` —— 模块级注册表**

```ts
/**
 * 编辑器与 agent 工具之间的桥。**刻意不用 React 上下文**：
 * harness/tools.ts 是纯 TS，不该认识 React；两边只通过
 * 「materialId → 一个窄接口」耦合。
 *
 * 注册表在阅读器卸载时注销 —— 拿到已销毁的 EditorView 会抛，
 * 那正是「用户关掉材料页后 agent 还在改」的场景。
 */

export interface MdEditorController {
  applyEdits(edits: AgentEdit[]): { ok: true; changed: number } | { ok: false; error: string };
  undoAgentBatch(): boolean;
  hasAgentBatch(): boolean;
}

const registry = new Map<string, MdEditorController>();
export function registerMdEditor(materialId: string, c: MdEditorController): () => void
export function getMdEditor(materialId: string): MdEditorController | undefined
```

`applyEdits` 实现要点：

```ts
const src = view.state.doc.toString();
const plan = planAgentEdits(src, edits);
if (!plan.ok) return plan;
view.dispatch({
  changes: plan.changes,
  // 一次工具调用 = 一个撤销单元。用户按一次 Ctrl+Z 退掉整次调用，
  // 不多退（会连带退掉用户自己的输入）也不少退。
  annotations: isolateHistory.of('full'),
});
applyDiff(view, plan.highlights);
// 记下**新文档坐标下的逆向 spec**，撤销按钮直接派发它 ——
// 不依赖 history 扩展，所以用户在这之后又打字了也照样能精确撤销这一次
lastBatch = {
  inverse: plan.highlights.map((h) => ({
    from: h.from,
    to: h.to,
    insert: h.removed,
  })),
};
```

**纯删除也要能撤销**：纯删除时 `highlights` 里 `removed` 有值但区间是空的，`inverse` 就是 `{from, to: from, insert: removed}`。这在上面的 map 里天然成立，不用额外分支 —— 但**要有单测或手工验证覆盖它**，因为它是唯一一处「区间为空却仍有内容要还原」的形状。

**Step 3: 类型检查 + Commit**

```bash
npx tsc -b
git add src/md-editor/agentDiff.ts src/md-editor/bridge.ts
git commit -m "feat(md-editor): 编辑器桥接（agent dispatch / diff 高亮 / 撤销）"
```

---

### Task 9: `edit_markdown` 工具

**Files:**
- Modify: `src/harness/tools.ts`
- Modify: `src/components/ChatPanel.tsx`
- Modify: `src/pages/Player.tsx`
- Modify: `src/harness/prompts.ts`

**Step 1: 加工具定义**（放进 `harness/tools.ts`，紧跟 `SHOW_WIDGET_TOOL` 之后）

```ts
const EDIT_MARKDOWN_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'edit_markdown',
    description:
      '直接修改当前打开的 Markdown 材料的正文。改动会立刻出现在用户正在看的那份文档里（并高亮出来），用户可以一键撤销。' +
      'edits 里的 old_string 必须从文档里**原样复制**（含标点与换行）；找不到或找到多处都会报错让你重来。',
    parameters: {
      type: 'object',
      properties: {
        edits: {
          type: 'array',
          description: '要做的改动，一次调用可含多条（区间不能重叠）',
          items: {
            type: 'object',
            properties: {
              old_string: { type: 'string', description: '要被替换的原文，必须在文档里唯一（除非 replace_all）' },
              new_string: { type: 'string', description: '替换成的新文本' },
              replace_all: { type: 'boolean', description: 'old_string 出现多次时是否全部替换；默认 false' },
            },
            required: ['old_string', 'new_string'],
          },
        },
      },
      required: ['edits'],
    },
  },
};
```

**Step 2: 执行分支**（在 `createToolExecutor` 返回的函数里，`show_widget` 分支之后）

```ts
    if (name === 'edit_markdown') {
      const edits = Array.isArray(args.edits) ? (args.edits as AgentEdit[]) : [];
      const ctl = getMdEditor(courseId);
      // 编辑器没开就是不可用：说清楚原因，别让模型反复重试
      if (!ctl) return '当前没有打开的 Markdown 编辑器，无法修改正文。请让用户先在材料页点「编辑」。';
      const r = ctl.applyEdits(edits);
      if (!r.ok) return `编辑未生效：${r.error}`;
      return `已修改 ${r.changed} 处。用户能看到改动并可一键撤销。接着用一两句话说明你改了什么。`;
    }
```

**Step 3: 只在可编辑时注册**

`ChatPanel.tsx`：
- props 加 `materialFormat?: 'pdf' | 'docx' | 'md' | 'html'`（`Player.tsx:459` 那一带已经有 `video.materialFormat`，多传一个 prop 即可）
- `const canEditMd = materialFormat === 'md' && getMdEditor(videoId) !== undefined;`
- 工具集：`isMaterial ? (canEditMd ? [...MATERIAL_QA_TOOLS, EDIT_MARKDOWN_TOOL] : MATERIAL_QA_TOOLS) : ...`

> ⚠️ 这条判断依赖「编辑器此刻开着」。若在一次对话中途用户关掉编辑，回执会走上面的「请先点编辑」分支 —— 那是可接受的降级，且文案已说明。

**Step 4: 提示词**

`harness/prompts.ts` 的 `qaSystemMaterial` 增加一段：说明当前材料可编辑、工具契约、以及**改动要克制**（只改确实需要改的段落，不要顺手重写全文）。同时在「非目标」里记一笔：不给 markdown 引入新语法。

**Step 5: 类型检查 + Commit**

```bash
npx tsc -b
git add src/harness/tools.ts src/components/ChatPanel.tsx src/pages/Player.tsx src/harness/prompts.ts
git commit -m "feat(agent): edit_markdown 工具（与用户共编辑同一份文档）"
```

---

### Task 10: e2e（两层都要）

**Files:**
- Create: `scripts/e2e-md-editor.mjs`
- Modify: `scripts/e2e-all.mjs`

**Step 1: 无 key 那半：编辑 → 落盘 → 重新分块**

脚本自己造 fixture（`.md` 文本 + 播种 IndexedDB/OPFS），照抄 `scripts/e2e-import.mjs` 的播种与取 Dexie 实例的方式（注释里说得很清楚：要从模块 URL 拿应用同一份实例）。

断言链：

1. 打开材料 → 断言阅读视图出现
2. 点「编辑」→ 断言 `.cm-editor` 出现，且首行的 `#` **不在** `innerText` 里（隐藏生效）
3. 把光标放进第一行 → 断言 `#` **出现**了（露出生效 —— 这条是本功能的核心不变量）
4. 输入几个字 → 等 debounce → 从 OPFS 读回 blob → 断言新字在
5. 断言 `materialBlocks` 行数变了（重新分块生效）
6. 切回阅读视图 → 断言渲染结果包含新内容

**Step 2: 有 key 那半：agent 改 → diff → 撤销**（登记 `key: true`）

1. 打开 md 材料 + 点编辑
2. 用假 fetch 桩掉模型流（`addInitScript`，同 `e2e-chat` 的做法），让它调 `edit_markdown`
3. 断言 `.cm-md-diffadd` 出现
4. 点「撤销本次」→ 断言 diff 消失且文本复原

**Step 3: 登记 META（两半都要，漏了跑分就永远不跑）**

```js
  // md 所见即所得编辑：语法符号在无光标时隐藏、光标处露出；编辑落盘后重新分块。
  'e2e-md-editor': { service: 'preview', antd: true, timeout: 300 },
```

（agent 那一半若单独成脚本，则再加一条并标 `key: true`）

**Step 4: 跑**

```bash
npm run build
node scripts/e2e-all.mjs --only=e2e-md-editor
```

Expected: `pass`

> ⚠️ 不 `npm run build` 跑的就是旧 `dist/` —— 这是 README §4 明确警告过的坑。

**Step 5: Commit**

```bash
git add scripts/e2e-md-editor.mjs scripts/e2e-all.mjs
git commit -m "test: md 编辑器 e2e（隐藏/露出、落盘重分块、agent 撤销）"
```

---

### Task 11: README 与设计文档同步

**Files:**
- Modify: `README.md`
- Modify: `docs/plans/2026-10-04-md-live-preview-editor-design.md`

**Step 1: README**

- 功能一览表加一行：`.md` 可所见即所得编辑，agent 可共编辑（diff 高亮 + 一键撤销）
- 目录结构段加 `src/md-editor/`
- 测试命令段加两条 `test-md-*`
- 开发流程里的目录清单若提到 `src/materials/`，补 `reindex.ts`

**Step 2: 设计文档**

- 状态从「进行中（设计已定，实现未开始）」改成「已实现」
- 「涉及文件」表按**实际落地**修正：`src/materials/parse.ts` 是**拆分**出 `reindex.ts`（不是新增一条平行路径），`save.ts` 的段号漂移处理写进变更记录
- 变更记录追加：v1 有序列表序号 / 链接括号 / 表格**刻意不藏**，以及为什么

**Step 3: Commit**

```bash
git add README.md docs/plans/2026-10-04-md-live-preview-editor-design.md
git commit -m "docs: 补 README 与设计文档的实际落地差异"
```

---

## 交付前

```bash
npx tsc -b
npm run build
node scripts/e2e-all.mjs              # 无 key 全量
node scripts/test-md-live-preview.mjs
node scripts/test-md-edit-tool.mjs
```

## 已知不在 v1 范围（别顺手加）

- 有序列表序号隐藏（需要按 `ListItem` 序号算 widget 文案）
- 链接 `[]()` 隐藏
- 表格 / 图片的可视化编辑（GFM table mixin 的节点边界）
- 真正的富文本（图片上传、表格增删行列）
- PDF / Word / HTML 的可编辑
- 多人协同（CRDT）