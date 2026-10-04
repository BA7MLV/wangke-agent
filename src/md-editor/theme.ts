/**
 * md 编辑态样式。颜色全部走 MD3 令牌：面层 `rgb(var(--mdui-color-surface-*))`，
 * 文字 `--mdui-color-on-*`，主色 `primary`；深色模式由 `html.mdui-theme-dark`
 * 自动切换，这里不写任何媒体查询（口径与 src/cards.css 头部一致）。
 *
 * 不引 @codemirror/theme-one-dark 之类的成品主题：那些主题自带一套硬编码的
 * 灰色阶和 `!important`，会和 Material You 的动态取色打架（也跟本项目「颜色
 * 一律走令牌、不自造颜色」的约定冲突）。CodeMirror 的 baseTheme 已经给了
 * 足够的编辑器骨架样式（光标、选区、滚动条、.cm-line 的盒模型），这里只补
 * 「这个项目的 md 内容该长什么样」那一层。
 */
import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';

/**
 * ── 为什么标题的上下留白用 line-height，而不是 margin / display:block ──────
 *
 * hideRanges.ts 给标题打的样式是 `Decoration.mark`，区间是**整行**。它在 DOM 上
 * 渲染成包裹该行文字的 `<span class="cm-md-hN">`，而这个 span 是 `.cm-line` 的
 * **行内**子元素。由此有两条硬约束：
 *
 * 1. **margin-block 对行内盒无效**（只对块级盒生效）。实测标题行高与不加 margin
 *    时完全一样（26 → 26），margin 被浏览器直接丢弃。
 * 2. **display:block 会炸**。它确实能把 span 撑成块级盒并让 margin 生效（实测
 *    标题行 26 → 73，标题上下真的出现了空隙），但代价是行盒模型被破坏：
 *    - 标题行高从 26px 暴涨到 73px，且这个高度**依赖该行标题被切成了几段**。
 *      「标题里含行内代码」时行内样式必须让开，标题就被切成 3 段
 *      （实测那一行直接涨到 164px，是普通标题的 2 倍多），同一篇文档里
 *      标题的上下留白会随着内容而变。
 *    - CodeMirror 用 `.cm-line` 的位置推算滚动与光标坐标，把行内盒改成块级盒
 *      会让「行」不再是原来那一行的自然高度，长文档里的定位会偏。
 *
 * 所以选 **line-height**：它是唯一既能改变行盒高度、又不改变盒模型(display)的
 * 手段。代价是留白**对称且不可分别调节** —— 上下留白由 font-size × line-height
 * 共同决定，标题上下的空气一样多，无法做成「阅读视图里 h1 上方 2em、下方 1em」
 * 那种非对称节奏。编辑态换来的是行高稳定、缩放正确、光标定位可靠；
 * 真要非对称留白，只能改成 CodeMirror 的 `Decoration.line`（打在整行上，
 * 由 CodeMirror 管理行盒），那是 hideRanges.ts 的输出契约变更，不在本任务范围。
 *
 * 字号一律用 `em`：用户缩放（或系统字号设置）时标题跟着正文一起放大，
 * 写死 px 会出现「大标题比正文小」的怪象。
 */
export const mdEditorTheme: Extension = EditorView.theme({
  // ── 编辑面本体 ──────────────────────────────────────────────────────────
  '&': {
    fontSize: '15px',
    backgroundColor: 'rgb(var(--mdui-color-surface))',
    color: 'rgb(var(--mdui-color-on-surface))',
    height: '100%',
  },
  // 行高 1.7 是照着阅读视图 `.mr-md .x-markdown`
  // （src/materials/material-reader.css）抄的：两者一致，切换编辑/阅读时
  // 字号与行距不跳，是个体验细节。
  //
  // 必须写在 `.cm-scroller` / `.cm-content` 上而不是只写在 `&`（编辑器根）上：
  // CodeMirror 的 baseTheme 里有 `.cm-scroller { line-height: 1.4 }`，直接命中
  // 滚动容器，会盖掉从根继承下来的值（实测行高变成 21px 而非 25.5px）。
  //
  // 编辑面用等宽（源码本来就是纯文本，等宽让缩进和围栏对齐可见）。
  // 字体栈复用项目里已有的那一串（src/materials/material-reader.css 的
  // `.mr-html :is(pre, code)`、src/components/mermaid/mermaid.css 都用它）。
  '.cm-scroller': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    lineHeight: '1.7',
  },
  '.cm-content': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    lineHeight: '1.7',
    // 正文宽度上限与阅读视图的 .mr-md（max-width: 760px）对齐，
    // 免得编辑器里一行拉满整个屏幕、在手机上又窄得折行。
    maxWidth: '760px',
    margin: '0 auto',
    padding: '28px 32px 48px',
  },
  // CodeMirror 的 baseTheme 默认给编辑器外壳画了 `outline: 1px dotted #212121`
  //（硬编码深灰，浅色主题下很扎眼），并且硬塞了 `!important`（它的 `&` 规则带
  // `!important`，普通主题盖不住）。所以这里也得带 `!important` 才有效 ——
  // 实测加上之后 focus 环从 `rgb(0,0,0) none 3px` 变成主色的 2px 实线。
  // 焦点环是唯一的「必须盖掉 baseTheme」的地方，其余样式都不需要。
  '&.cm-focused': {
    outline: '2px solid rgba(var(--mdui-color-primary), 0.35) !important',
    outlineOffset: '-2px',
  },
  // 选区用主色的低透明度铺底，不用浏览器默认的 selection 蓝。
  //
  // 选择器必须写成和 baseTheme 一样的形状（`&.cm-focused > .cm-scroller >
  // .cm-selectionLayer .cm-selectionBackground`）：baseTheme 那条是 5 个 class
  // 的高特异性规则，简写成 `& .cm-selectionBackground`（2 个）会**输给它**，
  // 于是聚焦时选区又变回 CodeMirror 自带的 `rgb(215,212,240)` 硬编码紫。
  // 同样宽的选择器 + 位置靠后 → 我们的赢。
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'rgba(var(--mdui-color-primary), 0.18)',
  },
  // 选中行：极淡的面层色。用 on-surface 而不是 surface 变体，是为了让
  // 「深色下也仅仅是微微亮一点」——activeLine 是背景，不该抢内容的对比度。
  '.cm-activeLine': {
    backgroundColor: 'rgba(var(--mdui-color-on-surface), 0.04)',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'rgb(var(--mdui-color-primary))',
    borderLeftWidth: '2px',
  },

  // ── 标题 ───────────────────────────────────────────────────────────────
  // font-size 用 em（跟正文 15px 的比例），line-height 用无单位倍数。
  // 层级差按阅读视图 XMarkdown 的 h1 24px / h2 20px / h3 18px 折算成 em
  // （24/15 ≈ 1.6、20/15 ≈ 1.33、18/15 = 1.2），切换时标题大小接近。
  '.cm-md-h1': { fontSize: '1.6em', lineHeight: 1.6, fontWeight: 700 },
  '.cm-md-h2': { fontSize: '1.33em', lineHeight: 1.6, fontWeight: 700 },
  '.cm-md-h3': { fontSize: '1.2em', lineHeight: 1.6, fontWeight: 600 },
  '.cm-md-h4': { fontSize: '1.07em', lineHeight: 1.6, fontWeight: 600 },
  '.cm-md-h5': { fontSize: '1em', lineHeight: 1.6, fontWeight: 600 },
  '.cm-md-h6': { fontSize: '1em', lineHeight: 1.6, fontWeight: 600, color: 'rgb(var(--mdui-color-on-surface-variant))' },

  // ── 行内代码 ───────────────────────────────────────────────────────────
  // 等宽字体（编辑面本身已经是，这里显式写一遍是因为行内代码可能被标题的
  // font-size 继承，相对字号会跟着放大）。
  // 底色用 surface-container-high：比正文底色高一档，正好把代码从文字里托出来，
  // 且和行内代码的「小」字重不冲突（低对比底色 + 小字号在暗色模式下也不会糊）。
  '.cm-md-inlinecode': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: '0.94em',
    backgroundColor: 'rgb(var(--mdui-color-surface-container-high))',
    borderRadius: 'var(--mdui-shape-corner-extra-small)',
    // 只给横向 padding：纵向 padding 在行内盒上不改变行高，却会让底色
    // 溢出到上下相邻行的字面上（实测底色上下各多出 13px，压到邻居身上）。
    padding: '0 0.35em',
  },

  // ── 代码块 ─────────────────────────────────────────────────────────────
  // 用 background 而不是 box-shadow / 渐变：hideRanges.ts 是**逐行**打 mark 的，
  // 相邻两行是两个独立 span。box-shadow 会在每行都画一遍边线，接缝处出现双线；
  // background 是唯一能靠「画到行盒之外」自然连成一片的办法（见下面的 padding）。
  '.cm-md-codeblock': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    // 比行内代码低一档的底色：整块代码是「背景」，行内代码是「标记」，
    // 两者同色会分不清哪层更重要。
    backgroundColor: 'rgb(var(--mdui-color-surface-container))',
    // 纵向 padding 在行内盒上**不改变行高**，但会让底色画到行盒之外 —— 这正是
    // 代码块要的：没有它，相邻两行的底色之间会露出一条缝（实测行高 25.5px 而
    // 行内盒只有 18px，缝 7px），整块代码看起来是一堆断开的横条而不是一块面板。
    // 0.25em = 15px × 0.25 = 3.75px，正好补满上下各 3.75px 的差。
    // 代价：代码块第一行的底色会向上溢出、压到围栏那一行（那行已被折叠成零高度，
    // 所以溢出量落在代码块上方的空行/正文上，是一条 3.75px 的浅色边）。
    // 行内代码**不能**这么干：它上下都是正文，压上去就是脏色条。
    padding: '0.25em 0.5em',
    // 横向也要 padding + 负 margin 抵消，否则代码块的底色会紧贴左边距，
    // 看起来像「代码溢出了容器」。左边距来自 .cm-content 的 padding。
    marginLeft: '-0.5em',
  },

  // ── agent 改动高亮 ─────────────────────────────────────────────────────
  // 设计文档里定的语义是「绿」（设计稿 106 行「改动区间挂 diff 装饰（绿）」），
  // 但 MD3 规范里没有 success 色，本项目自己在 theme.css 补了
  // --app-color-success / --app-color-success-container 一对（深浅两套）。
  // 用这一对而不是 primary：primary 是「交互色」，拿来当「这块被人改过」的
  // 提示会和按钮、链接、focus 环混在一起，分不清是操作还是标记。
  // 底色用 container 那档（浅色主题下淡绿、深色下深绿），不刺眼但一眼可见；
  // 左侧色条用纯 success 那档，与底色同色系但更饱和。
  //
  // 实测切换 mdui-theme-dark 时这两个令牌都会跟着变（theme.css 把 dark 覆盖挂在
  // html 上，mdui 的 --mdui-color-* 同样如此），所以这里不需要媒体查询。
  '.cm-md-diffadd': {
    backgroundColor: 'rgb(var(--app-color-success-container))',
    borderRadius: 'var(--mdui-shape-corner-extra-small)',
    boxShadow: 'inset 3px 0 0 rgb(var(--app-color-success))',
    // 横向负 margin + padding 让底色从行首起、又不把文字推离左边距
    //（inset 阴影贴在盒子左边，所以盒子本身要盖住整行的左缘）。
    marginLeft: '-0.5em',
    paddingLeft: '0.5em',
    paddingRight: '0.25em',
  },
});