/**
 * 把 planDecorations 的结果包成 CodeMirror 装饰。**薄适配层**：所有决策都在
 * ./hideRanges.ts 的纯函数里，这里只负责翻译 + 一处必要的实时性处理。
 *
 * 为什么单独一层：@codemirror/view 需要 DOM，没法进 node 单测；
 * 而「该不该藏」的决策已经在 hideRanges.ts 里被 14 条用例守着了。
 *
 * ── 为什么是 StateField 而不是 ViewPlugin ─────────────────────────────────
 * 原计划用 `ViewPlugin.fromClass(..., { decorations: v => v.decorations })`，
 * 实测**跑不起来**：CodeMirror 明确禁止「由插件提供的装饰」携带 block 语义。
 * 打开一个含围栏代码块的文档就会抛：
 *
 *     RangeError: Block decorations may not be specified via plugins
 *
 * 源码位置 @codemirror/view dist/index.js 的 TileUpdate.emit：
 * `if (this.disallowBlockEffectsFor[index]) { if (deco.block) throw ... }`。
 * disallowBlockEffectsFor 恰好标记了所有「函数形式」的装饰源，而插件的
 * decorations 回调就是函数（见 ViewPlugin.define 里的 `decorations.of(view => ...)`）。
 * 文档里也写了这条规矩（EditorView.decorations 的注释）：
 * "Only decoration sets provided directly are allowed to influence the editor's
 *  vertical layout structure."
 *
 * 围栏的折叠**必须**是 block 的 —— 用内联 widget 替掉 ``` 那一行只会把 ``` 抹掉，
 * 行还在、行高还在，围栏等于没折（实测 8 行 → 8 行，高度 154 → 154）。
 * 而 block 装饰只能走「直接提供」的静态装饰源，也就是 StateField +
 * EditorView.decorations.from(field)。这条没有绕过去的写法。
 */
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { RangeSetBuilder, StateField, type EditorState, type Extension } from '@codemirror/state';
import { planDecorations, type DecorSpec } from './hideRanges';

/**
 * 折叠一整行：行仍在文档里，只是渲染成零高度（因此还能点进去展开编辑）。
 *
 * toDOM 必须返回**元素**，不能返回 Text 节点：CodeMirror 的高度测量会直接对
 * widget 的 dom 调 getBoundingClientRect，而 Text 节点上没有这个方法，
 * 实测会抛 `TypeError: child.dom.getBoundingClientRect is not a function`。
 * 空 span 在这里是零高度的（无内容、无 padding/margin），正好等于「折叠」。
 */
class CollapsedLine extends WidgetType {
  eq() {
    // 所有实例等价：这一层不携带任何状态，塌不塌只取决于装饰在不在。
    // 返回 true 让 CodeMirror 复用已有 DOM，省掉每次重算的重建开销。
    return true;
  }
  toDOM() {
    return document.createElement('span');
  }
  ignoreEvent() {
    // 必须返回 false（WidgetType 的默认是 true）：返回 true 会吃掉这一行的
    // 光标事件，用户就再也点不进去、也就删不掉那两行 ``` 了。
    return false;
  }
}

function buildDecorations(state: EditorState): DecorationSet {
  const src = state.doc.toString();
  const active = state.selection.ranges.map((r) => ({ from: r.from, to: r.to }));
  const specs: DecorSpec[] = planDecorations(syntaxTree(state), src, active);

  // 依赖 hideRanges.ts 的契约：specs 按 from 升序且互不重叠。
  // 顺序乱了或重叠了，RangeSetBuilder 会当场抛，而不是悄悄渲染错。
  const builder = new RangeSetBuilder<Decoration>();
  for (const s of specs) {
    if (s.kind === 'hide') {
      // 不传 widget 就是纯隐藏：这段字符不画，但仍在文档里。
      builder.add(s.from, s.to, Decoration.replace({}));
    } else if (s.kind === 'collapse') {
      builder.add(s.from, s.to, Decoration.replace({ widget: new CollapsedLine(), block: true }));
    } else {
      builder.add(s.from, s.to, Decoration.mark({ class: s.cls }));
    }
  }
  return builder.finish();
}

/**
 * 上一次用来算装饰的语法树。用来发现「树变了但文档没变」。
 *
 * 为什么要单独记：lezer 的解析是**异步**的。打开一个大文档时，state 里的
 * 语法树只覆盖了前面一小段，剩下的在后台慢慢补。每次补完 CodeMirror 会派发
 * 一个**只带 Language.setState effect** 的事务 —— 它既不是 docChanged 也不是
 * selectionSet，于是「只盯这两个标志」的写法会一直停在残缺的树上。
 *
 * 实测（1500 节、5.6 万字符的文档）：只认 docChanged/selection 时，
 * 树已经完整（56669/56669）而装饰只有 624 条；加上树变化这一条后是 10499 条。
 * 少的那一万条就是「标题的 # 该藏没藏、该加粗没加粗」。
 *
 * 用引用比较而不是比长度：Tree 是不可变的，补完解析会产生新对象，
 * 而 `syntaxTree(state)` 在没有语言扩展时返回同一个 Tree.empty，天然不会误触发。
 */
let lastTree: unknown = null;

/** md 编辑态的所见即所得。挂到 EditorView 的 extensions 里即可（需同时挂 markdown()）。 */
export function livePreview(): Extension {
  const field = StateField.define<DecorationSet>({
    create: (state) => {
      lastTree = syntaxTree(state);
      return buildDecorations(state);
    },
    update: (value, tr) => {
      const tree = syntaxTree(tr.state);
      const treeGrew = tree !== lastTree;
      lastTree = tree;

      // 刻意**没有**「组合期间不算」这类守卫 —— 见文件末尾那段关于 IME 的实测。
      if (tr.docChanged || tr.selection || treeGrew) return buildDecorations(tr.state);
      return value;
    },
  });
  // field 本身**必须**和 from(field) 一起返回：`Facet.from` 只是声明「我依赖这个
  // 字段」，不会把它装进 state。少写 field 会抛
  // `RangeError: Field is not present in this state`（实测）。
  return [field, EditorView.decorations.from(field)];
}

/**
 * ── 关于 IME：本文件刻意没有「组合期间不重算」的守卫 ─────────────────────
 *
 * 直觉上，组合（拼音输入）期间文档与选区处于不一致的中间态，重算会让装饰错位。
 * 实测（Chromium + CDP Input.imeSetComposition 逐步喂 n/ni/nih/nihao）结论相反：
 *
 *   带守卫（组合期间 return）：行内代码的反引号位置在组合过程中被打乱 ——
 *     "和 `cod`。" / "和 `coe`。" / "和 `cde`。" / "和 code`。"
 *   不带守卫：全程稳定，commit 后与文档一致。
 *
 * 原因：CodeMirror 在组合期间的每一次按键都会派发带 docChanged 的事务，
 * 文档是**逐步真实增长**的（实测 docLength 27 → 28 → 29）。此时若跳过重算，
 * 装饰就停留在旧长度上；CodeMirror 只能把旧装饰**映射**到新文档，
 * 而映射是按「插入点在哪」猜的，落在结构化区间（行内代码、强调）内部时就错位。
 * 也就是说，守卫本身才是错位的来源。
 *
 * 「组合结束时必然会有一次 docChanged 或 selectionSet 会补上」这个假设也不成立：
 * 错位是在组合**过程中**就已经画在屏幕上了，补救得太晚，用户看得见。
 *
 * 所以这里的选择是：始终按当前 state 重算。这也让整段逻辑保持成一个纯函数
 * （state → 装饰），不需要 view，也就没有 composing 这个状态可言。
 */