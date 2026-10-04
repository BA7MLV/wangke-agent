/**
 * agent 改动的高亮装饰：把 ./edits.ts 产出的高亮区间画成绿色的「这块被改过」。
 *
 * ── 为什么是 StateField 而不是 ViewPlugin ─────────────────────────────────────
 * 与 ./livePreview.ts 结论一致，但**理由不同**，别照抄那段话：那里被迫用 StateField 是因为
 * block 装饰不能从插件提供（`RangeError: Block decorations may not be specified via plugins`）。
 * 本文件的装饰全是行内 mark，ViewPlugin 完全可以带。所以真正的理由是：
 * 本文件的核心能力是「装饰要随文档改动一起平移」，而这条逻辑**只能写在 StateField.update 里** ——
 * `value.map(tr.changes)` 一行就够，换成 ViewPlugin 就得自己在 update(tr) 里存一份 tr.changes
 * 再手动 map，是同一件事的手写版（多一处能写错的地方：忘了 map）。
 *
 * ── 为什么不塞进 livePreview 那个 Compartment ───────────────────────────────
 * MdEditor 的 Compartment 切的是「预览 ⇄ 源码」（挂/不挂 livePreview）。
 * 高亮必须**两种视图下都在**：用户在源码视图里同样要看得见 agent 改了什么。
 * 而且挂在 Compartment 里还有第二个问题 —— Compartment 一旦被重配，里面的 field
 * 是被移除再重建的（重建走的是 create()，即 Decoration.none），
 * 于是「点一下源码」顺手就把高亮清空了。field 的值只存在于 state 里，
 * 扩展被摘掉的那一刻就没了。所以 agentDiff() 要作为顶层扩展单独挂。
 */
import { RangeSetBuilder, StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
import type { AgentHighlight } from './edits';

/**
 * 高亮区间的样式类。
 *
 * 样式在 ./theme.ts 的 mdEditorTheme 里（绿底 + 左侧 success 色条，深浅色各一套）。
 * 这里**只引用类名、不定义颜色**：颜色方案是设计决定，
 * 而这个文件是适配层，让它自己挑颜色就会出现「编辑器里一套、应用里另一套」。
 */
export const AGENT_DIFF_CLASS = 'cm-md-diffadd';

/** 把整组高亮换掉。装在事务的 effects 里，与文档改动分开派发 */
const setAgentDiff = StateEffect.define<DecorationSet>();

/**
 * 当前这组高亮的存放处。挂上编辑器即可（用 agentDiff()）。
 *
 * 值只有一个 DecorationSet —— 高亮之间不需要相互引用，
 * 也就不需要任何额外的索引结构。
 */
export const agentDiffField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    /**
     * ⚠️ **先 map 再叠加 effect，顺序反了会错位。**
     *
     * map 在前，意思是「已有的高亮跟着文档一起平移」；effect 在后，意思是
     * 「这组新坐标的高亮取代前面所有的」。
     *
     * 反过来（先 effect 后 map）会把新坐标的高亮**再用本次 changes 平移一次**，
     * 而它描述的恰恰就是本次改动造成的新位置 —— 整组高亮于是往后再偏一段，
     * 屏幕上只表现为「绿底落在别的字上」，几乎无法归因。
     *
     * 当前 applyDiff 是**单独一次 dispatch**（不带 changes），所以这条今天咬不到；
     * 但 field 本身必须对「一个事务同时带 changes 和 effect」也是对的 ——
     * 那种写法其实更省（一次 update、一次上屏），迟早会有人用上。
     */
    value = value.map(tr.changes);
    for (const e of tr.effects) if (e.is(setAgentDiff)) value = e.value;
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/**
 * 挂上 agent 改动高亮的扩展（顶层挂，不要放进 livePreview 的 Compartment）。
 *
 * ⚠️ 这里**只挂 field 自己**，不要再补一句 `EditorView.decorations.from(agentDiffField)`。
 * 上面的 `provide` 已经做了那件事 —— 带 `provide` 的 StateField 本身就是
 * 「extension 提供者」，它一进 extensions 列表，`provide` 返回的东西就跟着装进 state
 * （见 @codemirror/state 里 StateField.define 处理 config.provide 的那段，
 * 以及 Extension 类型注释「state fields … are built-in extension-providing objects」）。
 * 再手写一次就是**同一个装饰源注册了两遍**，CodeMirror 会老老实实画两层：
 * 实测同一条高亮渲染成 `<span class="cm-md-diffadd"><span class="cm-md-diffadd">…</span></span>`。
 *
 * （对照 ./livePreview.ts：它的 field **没有** provide，所以那里必须显式写 from(field)，
 * 而且 file 与 from(field) 要一起返回 —— 那是另一种组合，不是这一行的反面教材。）
 */
export function agentDiff(): Extension {
  return agentDiffField;
}

/**
 * ── 纯删除的零宽区间：刻意**不画** ─────────────────────────────────────────────
 *
 * edits.ts 给纯删除产出的高亮是 `{from: 插入点, to: 插入点, removed: 被删的原文}` ——
 * 区间为空，内容全挂在 removed 上（它仍然要进撤销凭据，那条在 bridge.ts 里）。
 *
 * 先把「零宽 mark 到底行不行」的三条实测摆出来，因为其中任何一条都足够让人
 * 以为它**能**画而顺手加回去：
 *   1. RangeSetBuilder **收**零宽区间：add / finish / between 全部正常，
 *      between 照样报出 `[2,2)`（所以「加了不报错」不能作为该加的理由）；
 *   2. 但显式 `Decoration.mark({...}).range(2, 2)` 会抛
 *      `RangeError: Mark decorations may not be empty`
 *      （@codemirror/view 里 MarkDecoration.range 的 `if (from >= to) throw`）——
 *      也就是说这条路径**根本没有公开入口**；
 *   3. 真把一组**含**零宽 mark 的装饰挂上去渲染，它会被**整个忽略**：
 *      与「同组里不放那条零宽」相比，contentDOM.innerHTML 一字不差
 *      （既没有多出节点，也没有把旁边那条的范围带偏）。
 * 所以跳过它不是「少画一点」，是**画不出来**。
 *
 * 想让用户看见「这里少了 3 个字」只有一个办法：Decoration.widget 插一段真 DOM。
 * 不做的理由（任何一条都够）：
 *   - 那段字**不在文档里**。它落在 .cm-content 中间，用户拖选复制就会把它一起带走，
 *     而 md 正文是用户自己的笔记 —— 往里塞合成字符比不画更糟；
 *   - inline widget 与 livePreview 的逐行 mark（.cm-md-codeblock 等）挤在同一条行盒上，
 *     会把行高与底色的连续面切开（插在围栏代码块里，底色会断成两截）；
 *   - 语义无处安放。现有的 .cm-md-diffadd 一个类说的是「agent **加**了这段（绿）」，
 *     删除要不要画成红色删除线是**设计决定**，得先在 theme.ts 里定一个类出来；
 *     适配层不该替设计做这个决定。
 *
 * 最后，「画不画」与「能不能撤销」是两件事：纯删除靠 removed 非空照样能一键还原
 * （见 bridge.ts），而删除本身也是看得见的证据 —— 一段话短了/没了。
 */

/**
 * 把一组高亮挂上去，取代此前挂过的全部高亮。
 *
 * 坐标是**改动后**的文档坐标（edits.ts 已算好），所以调用点在文档改动**之后**。
 * 单独一次 dispatch（不带 changes）不会多上屏一次：两次 dispatch 在同一个同步任务里跑完，
 * 浏览器还没轮到绘制，屏幕上只可能出现最终状态。
 */
export function applyDiff(view: EditorView, highlights: readonly AgentHighlight[]): void {
  view.dispatch({ effects: setAgentDiff.of(buildDiff(highlights)) });
}

/** 清掉所有高亮（撤销之后用：那些区间已经不对应任何东西了） */
export function clearDiff(view: EditorView): void {
  view.dispatch({ effects: setAgentDiff.of(Decoration.none) });
}

/**
 * 一组高亮 → 装饰集合。
 *
 * 依赖 ./edits.ts 的契约：highlights 按 from 升序且互不重叠。
 * 顺序错了或重叠了，RangeSetBuilder 会当场抛（而不是悄悄渲染错）——
 * 与 livePreview.ts 里 buildDecorations 依赖 hideRanges.ts 契约的做法一致。
 */
function buildDiff(highlights: readonly AgentHighlight[]): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const h of highlights) {
    // 零宽 = 纯删除，见上面那段实测。跳过它不是图省事，是画不出来。
    if (h.from === h.to) continue;
    builder.add(h.from, h.to, Decoration.mark({ class: AGENT_DIFF_CLASS }));
  }
  return builder.finish();
}