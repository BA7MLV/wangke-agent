/**
 * md 所见即所得编辑面的 React 外壳。
 *
 * 这个文件只干三件事，其余都已经拆出去了：
 *   - 把 EditorView 的生命周期绑到 React 上（建 / 毁）；
 *   - 把「预览 ⇄ 源码」这个开关翻译成一次 Compartment 重配；
 *   - 把 docChanged 变成一个回调，交给上层接落盘管线（下一个任务）。
 * 「某个语法符号该不该藏」在 ./hideRanges.ts（纯函数 + 单测），
 * 「md 内容该长什么样」在 ./theme.ts，这里一概不重复那些判断。
 *
 * ── 为什么单独一个文件（而不是把 EditorView 直接塞进 MdReader）──────────────
 * CodeMirror 连同语言包约 120KB gzip，而 **MdReader 在每一份 md 材料上都会加载**。
 * 留在静态 import 图里就等于让「只读材料」的用户为首屏付这 120KB。
 * 隔离成独立文件之后，MdReader 才能用 React.lazy 把整棵依赖图切成按需 chunk
 * （见 MdReader.tsx 里那段注释）。
 */
import { useEffect, useRef, useState } from 'react';
import { basicSetup } from 'codemirror';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { useMduiEvent } from '../ui';
import { livePreview } from './livePreview';
import { mdEditorTheme } from './theme';

export interface MdEditorProps {
  /**
   * 编辑面的初始全文。**只在挂载那一刻读一次**（见组件里的 `useState(() => new Text(...))`）。
   * 上层负责在「退出编辑」时把结果接回去 —— 编辑器自己不持有「退出」这个概念。
   */
  initialText: string;
  /**
   * 文档每次变化都回调一次，**未防抖**。
   * 防抖/落盘是下一个任务（src/md-editor/save.ts）的事，这里保持直通，
   * 好让那个任务不必先拆一层已经打乱的中间态。
   */
  onDirty?: (text: string) => void;
}

export default function MdEditor({ initialText, onDirty }: MdEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  /**
   * livePreview 的扩展实例 + 承载它的 Compartment，**在挂载时创建一次**。
   *
   * 放 ref 而不是 useMemo：useMemo 只是「没有依赖变化就复用」的约定，
   * React 随时可以丢弃并重算。这里 identity 一旦变了，Compartment 里那个
   * StateField 就换了另一个 field，等于把整个装饰层重建一遍。
   * 放 ref 则由挂载/卸载严格配对，identity 在这个 view 的生命周期内必然稳定。
   */
  const slotRef = useRef<{ slot: Compartment; live: Extension } | null>(null);
  /** 「预览 ⇄ 源码」开关有没有被真正拨过一次（用来跳过挂载后的空跑一趟）。 */
  const toggledRef = useRef(false);

  const [showSource, setShowSource] = useState(false);
  const [dirty, setDirty] = useState(false);

  /**
   * 初始文档**只取一次**。
   *
   * 不能写成 `useState(new Text(initialText))`（那样每次渲染都会重建一次），
   * 也不能在每次渲染重建 EditorState —— 那会把用户已经敲进去的字冲掉，
   * 连带撤销栈、选区、滚动位置一起归零。
   *
   * ⚠️ 这里存的是**字符串**而不是 Text，计划里写的 `new Text(initialText)`
   * 是错的：@codemirror/state 的 Text 是**抽象类**，`new Text(...)` 直接编译不过
   * （TS2511: Cannot create an instance of an abstract class）。
   * 唯一能直接构造的入口 `Text.of()` 要的是**已经按行切开的数组** ——
   * TextLeaf 内部存的就是行数组，而「按行切开」这一步（splitLines）没有公开导出。
   * `Text.of(["a\nb"])` 会得到一个声称只有 1 行、行内却带换行的怪文档。
   * 所以正确做法就是把字符串交给 `EditorState.create({ doc })`，
   * 它内部会做 `Text.of(doc.split(lineSeparator))`（见 @codemirror/state 的 EditorState.create）。
   *
   * 于是 `initialText` 是**只读的初值**：上层想更新内容就换 key 重挂
   * （当前上层是退出再进入，见 MdReader.tsx 的 exitEdit）。
   */
  const [initial] = useState(initialText);

  /**
   * onDirty 每次父组件重渲染都是新闭包。用 latest-ref 喂给 updateListener，
   * 这样**回调变了不必重建 EditorView** —— 重建的代价不只是丢字，
   * 还会丢选区、丢撤销栈、把滚动位置弹回顶部。
   */
  const onDirtyRef = useRef(onDirty);
  useEffect(() => {
    onDirtyRef.current = onDirty;
  }, [onDirty]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const slot = new Compartment();
    const live = livePreview();
    slotRef.current = { slot, live };
    toggledRef.current = false;

    const view = new EditorView({
      /**
       * ⚠️ `root: document` 不是默认值，**去掉它这个编辑器会完全没有样式**。
       *
       * CodeMirror 默认用 `getRoot(parent)` 决定把主题样式挂到哪：它沿
       * `assignedSlot` 往上走，返回遇到的第一个 document 或 ShadowRoot。
       * 而本应用的播放页整棵 DOM 是**被 slot 进 `<mdui-layout-main>` 的 shadow root** 的
       * （实测：`.page-inner` → `<slot>` → `<mdui-layout-main>` 的 shadowRoot），
       * 于是 CodeMirror 把 baseTheme + mdEditorTheme 全挂进了那个 shadow root 的
       * adoptedStyleSheets —— 而编辑器本身是**光 DOM**，压根不在那棵 shadow 树里，
       * 于是所有 `.cm-*` 规则一条都命不中。
       *
       * 症状极具迷惑性（看起来像「主题没生效」，其实是一条 CSS 都没有）：
       *   - `.cm-editor` display 变回 block、`height:100%` 失效 → 编辑器不被容器约束，
       *     `.cm-scroller` 高 1687px（内容全高），于是 scrollHeight === clientHeight，
       *     **整个编辑器根本滚不动**；
       *   - `.cm-content` 的 `white-space: pre` 没了（实测 computed = normal），
       *     所有空白被折叠；`.cm-lineWrapping` 的 break-spaces 同样失效；
       *   - mdEditorTheme 的字号/行高/宽度上限/代码块底色全部不生效。
       *
       * 显式给 document 之后，样式进 `document.head`（style-mod 插在 head.firstChild，
       * 即**所有应用 CSS 之前**），所以同特异度时应用自己的规则仍然赢 ——
       * 这正是 `.mr-edit-wrap .cm-scroller` 那条覆盖能生效的前提。
       */
      root: document,
      parent: host,
      state: EditorState.create({
        doc: initial,
        extensions: [
          basicSetup,
          markdown(),
          // livePreview 与 markdown() **必须同时挂**：前者读 syntaxTree(state)，
          // 没有语言扩展时那棵树恒为 Tree.empty，等于什么都不藏（详见 ./livePreview.ts）。
          slot.of(live),
          mdEditorTheme,
          // 「按宽度折行」不是可选项：baseTheme 的 .cm-content 是 white-space: pre，
          // 而 md 的正文天然是一整段长行 —— 不折行的话编辑器会横向滚，
          // 所见即所得就变成了「所见即一条横着的窄带」。
          // .cm-lineWrapping 用 break-spaces 而不是 pre-wrap：前者在折行处保留
          // 续行的前导空格，列表缩进 / 代码围栏里的对齐才不会在换行时被吃掉。
          EditorView.lineWrapping,
          /**
           * history / defaultKeymap / historyKeymap 其实 basicSetup 里已经有了
           * （见 node_modules/codemirror/dist/index.js 的 basicSetup 定义）。
           * 这里仍然显式再挂一遍，理由是**它是本功能唯一的编辑历史来源**：
           * 将来若把 basicSetup 换成更轻的 minimalSetup（md 正文其实不需要
           * 搜索面板与矩形选择），撤销/重做不会跟着静默消失。
           * 重复挂载的代价是每次按键多匹配一遍 keymap 前缀，量级可以忽略。
           */
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.updateListener.of((u) => {
            // 只认 docChanged：切换预览/源码会派发一个只带 reconfigure effect 的事务，
            // 那是**视图切换不是内容变化**，把它算成「有修改」会让状态文案说谎。
            if (!u.docChanged) return;
            setDirty(true);
            onDirtyRef.current?.(u.state.doc.toString());
          }),
        ],
      }),
    });
    viewRef.current = view;

    /**
     * 进来就聚焦：用户刚点了「编辑」，预期是直接开始打字。
     *
     * ⚠️ iOS 上这一步大概率**弹不出软键盘** —— 挂载发生在 React.lazy 的 chunk
     * 落地之后，已经不在用户手势的同步调用栈里了，而 Safari 要求聚焦
     * contenteditable 必须发生在手势内。实测不了（本机没有 iOS 设备），
     * 但这是已知限制；退路是用户点一下正文，软键盘会正常升起，
     * 所以不做「聚焦失败就不管」的额外处理。
     */
    view.focus();

    return () => {
      /**
       * 必须 destroy，不能只置空 ref：EditorView 自己挂着 MutationObserver
       * （测量行高）、document 上的 selectionchange 监听、以及 basicSetup 里
       * autocompletion / 搜索面板的全局监听。漏掉 destroy 的话，
       * 「编辑 → 完成 → 编辑」几次之后，同一份文档上会叠着好几套观察器，
       * 而且它们还持有已经被移除的 DOM。
       */
      view.destroy();
      viewRef.current = null;
      slotRef.current = null;
    };
    // 依赖只有 initial，而 initial 是 useState 的初值 —— 整个 view 的生命周期里
    // 只会是同一个字符串，所以这个 effect 实质上只在挂载时跑一次。
  }, [initial]);

  /**
   * 「预览 ⇄ 源码」：用 Compartment.reconfigure 重挂 livePreview。
   *
   * 这是 CodeMirror 6 换扩展的标准做法，**不要**改写成「把 state 重建一遍」——
   * 重建会丢选区、撤销栈和滚动位置，而这里恰恰是「切视图最不该丢编辑」的地方：
   * 两种视图共用同一个 EditorState，变的只是装饰层，文档一个字都没动。
   * 源码视图就是「不挂 livePreview()」：没有装饰 = 原始语法符号全都露出来。
   */
  useEffect(() => {
    const s = slotRef.current;
    const view = viewRef.current;
    if (!s || !view) return;
    // 首帧跳过：EditorState 创建时已经把 live 挂进 slot 了，
    // 再派发一次一模一样的 reconfigure 是白跑一趟，还会凭空多一个事务。
    if (!toggledRef.current) {
      toggledRef.current = true;
      return;
    }
    view.dispatch({ effects: s.slot.reconfigure(showSource ? [] : s.live) });
  }, [showSource]);

  const viewGroupRef = useMduiEvent('mdui-segmented-button-group', 'change', (_e, el) => {
    // **只认这两个字面量**，不写 `setShowSource(el.value === 'source')`：
    // 分段按钮组初始化时会带一次空 value 的 change，那会让「源码」视图
    // 刚被点开就被悄悄切回「预览」，而界面上还亮着「源码」——很难查。
    if (el.value === 'source') setShowSource(true);
    else if (el.value === 'preview') setShowSource(false);
  });

  return (
    <>
      <div className="mr-edit-bar">
        {/* 状态文案。这一阶段**还没有落盘管线**（下一个任务才有），
            所以措辞刻意是「状态」而不是「承诺」：
            说「已保存」会撒谎（其实什么都没存），说「未保存」像是在承诺稍后会自动存。
            「未修改 / 有未保存的修改」只陈述事实。 */}
        <span
          className={dirty ? 'mr-edit-state mr-edit-state--dirty' : 'mr-edit-state'}
          data-testid="md-edit-state"
        >
          {dirty ? '有未保存的修改' : '未修改'}
        </span>
        <div className="mr-bar__spacer" />
        <mdui-segmented-button-group
          ref={viewGroupRef}
          selects="single"
          value={showSource ? 'source' : 'preview'}
          data-testid="md-source-view"
        >
          <mdui-segmented-button value="preview">预览</mdui-segmented-button>
          <mdui-segmented-button value="source">源码</mdui-segmented-button>
        </mdui-segmented-button-group>
      </div>
      {/*
        编辑面本体。**刻意不套 .mr-scroll**：那条规则带 12px/24px 内边距，
        而 CodeMirror 的 .cm-editor 是 height:100% 的定高盒 —— 父级带 padding 时
        它的 100% 按内容盒算，编辑器上方会凭空多出一截内边距、滚动条也比内容短。
        滚动由 CodeMirror 自己的 .cm-scroller 负责（理由见 material-reader.css）。
      */}
      <div className="mr-edit-wrap" ref={hostRef} data-testid="md-editor" />
    </>
  );
}