/**
 * md 所见即所得编辑面的 React 外壳。
 *
 * 这个文件只干三件事，其余都已经拆出去了：
 *   - 把 EditorView 的生命周期绑到 React 上（建 / 毁）；
 *   - 把「预览 ⇄ 源码」这个开关翻译成一次 Compartment 重配；
 *   - 把 docChanged 接成「防抖落盘」（./save.ts），并把这个编辑面注册进 agent 桥（./bridge.ts）。
 * 「某个语法符号该不该藏」在 ./hideRanges.ts（纯函数 + 单测），
 * 「md 内容该长什么样」在 ./theme.ts，这里一概不重复那些判断。
 *
 * ── 为什么单独一个文件（而不是把 EditorView 直接塞进 MdReader）──────────────
 * CodeMirror 连同语言包约 120KB gzip，而 **MdReader 在每一份 md 材料上都会加载**。
 * 留在静态 import 图里就等于让「只读材料」的用户为首屏付这 120KB。
 * 隔离成独立文件之后，MdReader 才能用 React.lazy 把整棵依赖图切成按需 chunk
 * （见 MdReader.tsx 里那段注释）。
 *
 * ⚠️ 反过来也有一条硬约束：**这个文件只能被 MdReader 用 lazy 引进来**。
 * bridge 静态依赖 CodeMirror，MdReader 若静态 import 它的类型以外的任何东西，
 * 那 120KB 就又回到主 chunk 里了（tools.ts 里 mdEditorOpen 那段量化了这个代价）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { basicSetup } from 'codemirror';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { useMduiEvent } from '../ui';
import { agentDiff } from './agentDiff';
import { createMdEditorController, registerMdEditor, type MdEditorController } from './bridge';
import { livePreview } from './livePreview';
import { createMdSaver, mdSaveLabel, type MdSaveState } from './save';
import { mdEditorTheme } from './theme';

/**
 * 落盘器交给上层的唯一能力。
 *
 * 「完成」这个动作的按钮在 MdReader 的工具条上（它和「编辑」是同一个按钮的两态），
 * 而 flush 只能由持有 saver 的这个组件发起 —— 所以上层拿到的就只是这一个方法，
 * 契约只有一条：**没落成必须 reject**，上层据此决定要不要退出编辑态。
 * 写成「尽力而为」的 void 就会让上层以为已经存好了（那就是丢字）。
 */
export interface MdEditorHandle {
  flush(): Promise<void>;
}

export interface MdEditorProps {
  /**
   * 编辑面的初始全文。**只在挂载那一刻读一次**（见组件里的 `useState(() => ...)`）。
   * 上层负责在「退出编辑」时把结果接回去 —— 编辑器自己不持有「退出」这个概念。
   */
  initialText: string;
  /**
   * 这份材料的 id。两个用途：落盘的目标文件、agent 桥的注册键。
   * **不能省**：注册表按 id 索引，没有它 agent 就改不到用户正在看的这一份。
   */
  materialId: string;
  /**
   * 文档每次变化都回调一次，**未防抖**。
   * 它现在只服务上层自己的草稿（退出编辑那一瞬要把内容接回来）；
   * 落盘不经过它 —— 落盘走 saver.schedule，两条路各管各的。
   */
  onDirty?: (text: string) => void;
  /** 每次**成功**落盘后回调一次，参数是 save.ts 的 savedAt（「块集换过了」的信号）。失败不调 */
  onSaved?: (savedAt: number) => void;
  /** 把 flush 交给上层（点「完成」时由它来 await）；卸载时回调 null，上层据此丢掉过期句柄 */
  onHandle?: (handle: MdEditorHandle | null) => void;
  /**
   * 落盘防抖毫秒。不传就用 save.ts 的默认（MD_SAVE_DEBOUNCE_MS = 1.2s）——
   * 那个数字的取舍写在 save.ts 文件开头，这里不重复第二份，只留给测试缩短。
   */
  debounceMs?: number;
}

/**
 * 落盘状态的初值，与 createMdSaver 起步的那一份逐字相同。
 * 模块级常量：它是「还没存过任何东西」这个事实，不是每次渲染的新快照。
 */
const NO_SAVED_YET: MdSaveState = { dirty: false, saving: false, savedAt: null, error: null };

export default function MdEditor({
  initialText,
  materialId,
  onDirty,
  onSaved,
  onHandle,
  debounceMs,
}: MdEditorProps) {
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
  /** 当前注册进 agent 桥的那个控制器：撤销按钮要用它；卸载时置空 */
  const ctlRef = useRef<MdEditorController | null>(null);
  /**
   * 这次挂载还活着吗。落盘是异步的，它回来时组件可能已经卸载
   * （见下面 cleanup 里那次「补写的落盘」）。
   */
  const aliveRef = useRef(true);

  const [showSource, setShowSource] = useState(false);
  /**
   * 落盘状态。
   *
   * 刻意**不在本地再记一个 dirty**：save.ts 已经是这套状态机的唯一实现
   * （它把 dirty 跟着 pending 一起定稿，见 pump 里那段注释），
   * 这里平行记一份必然会与它漂移，而文案是直接照着状态显示的。
   */
  const [saveState, setSaveState] = useState<MdSaveState>(NO_SAVED_YET);
  /** 现在有没有一批 agent 改动可撤 —— 撤销按钮据此亮不亮 */
  const [hasAgentBatch, setHasAgentBatch] = useState(false);
  /** 撤销失败的原因。bridge 特意把它写成能直接展示的句子（见 UndoResult） */
  const [undoError, setUndoError] = useState<string | null>(null);

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
   * 这几个 prop 每次父组件重渲染都是新闭包。用 latest-ref 喂给挂载 effect 与 updateListener，
   * 这样它们变了不必重建 EditorView —— 重建的代价不只是丢字，
   * 还会丢选区、丢撤销栈、把滚动位置弹回顶部。
   *
   * 依赖数组刻意留空：这里做的是「把最新的值抄进 ref」，漏掉一个依赖的后果
   * 是永远读到第一次渲染时的旧闭包，而那不会报错、只会安静地不生效。
   */
  const onDirtyRef = useRef(onDirty);
  const onSavedRef = useRef(onSaved);
  const onHandleRef = useRef(onHandle);
  const debounceRef = useRef(debounceMs);
  useEffect(() => {
    onDirtyRef.current = onDirty;
    onSavedRef.current = onSaved;
    onHandleRef.current = onHandle;
    debounceRef.current = debounceMs;
  });

  /**
   * 「落盘成功了」→ 通知上层一次。
   *
   * 直接拿 save.ts 的 `savedAt` 当依赖项，而不是在 onState 里比对前后值：
   * 它「每次成功保存必变」（save.ts 里明写了这个契约），于是「值变了」与
   * 「存成了一版」是一回事，effect 只可能由后者触发。失败不改变它，所以失败不会误报。
   */
  useEffect(() => {
    if (saveState.savedAt === null) return;
    onSavedRef.current?.(saveState.savedAt);
  }, [saveState.savedAt]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    aliveRef.current = true;

    const slot = new Compartment();
    const live = livePreview();
    slotRef.current = { slot, live };
    toggledRef.current = false;

    /**
     * 落盘器在**挂载时**建一次，跟着这个 effect 的 cleanup 一起作废。
     *
     * 「放 ref 不放 useMemo」听着只差一行，后果完全不同：useMemo 的初值是在 render 阶段算的，
     * 而 StrictMode 会把「挂载 → 卸载 → 再挂载」跑一遍（本项目确实开着，见 main.tsx）。
     * 那样建出来的保存器会被第一次 cleanup 的 dispose 掉，第二次挂载拿到的是一个
     * 已 disposed 的保存器：schedule 直接丢弃、flush 直接抛「保存器已销毁」。
     * 症状是「怎么改都不保存」，且只在开发模式下出现、极难归因。
     * 建在 effect 里，每次挂载都是干净的，cleanup 销毁的也一定是这一次建的那一个。
     */
    const saver = createMdSaver(materialId, {
      // 不传就是 save.ts 的默认 1.2s
      debounceMs: debounceRef.current,
      onState: (s) => {
        // 卸载后仍在飞的那次落盘不该再驱动界面（React 19 不再警告，但那是浪费一次渲染）
        if (aliveRef.current) setSaveState(s);
      },
    });

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
          /**
           * agent 改动的高亮**必须是顶层扩展，不能塞进上面那个 Compartment**。
           * Compartment 一旦被重配，里面的 field 是移除再重建的（重建走 create()，
           * 也就是 Decoration.none），于是用户点一下「源码」就把高亮清空了；
           * 而用户在源码视图里同样需要看得见 agent 改了什么。
           * 完整理由见 ./agentDiff.ts 文件开头那一节。
           */
          agentDiff(),
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
            const text = u.state.doc.toString();
            // 防抖、串行、失败留痕全在 saver 里，这里只管把每一版原文递进去
            saver.schedule(text);
            onDirtyRef.current?.(text);
            /**
             * 撤销按钮的亮灭问的是 bridge 里那份撤销凭据，而凭据是**在事务派发完之后
             * 才被写进去的**：bridge.applyEdits 的顺序是「先 view.dispatch、后 batch = …」，
             * 所以在 updateListener 里同步问 hasAgentBatch() 必然问不到 agent 那一批
             * （撤销成功那一路则相反，会问到一个刚被撤掉的凭据）。
             * 推到微任务末尾再问，问到的才是凭据定稿之后的状态。
             *
             * 顺带清掉「撤销失败」提示：那份校验（stillIntact）只在点击那一刻成立，
             * 用户接着改内容就已经作废了 —— 留一条再也不成立的红色横幅比没有更糟。
             */
            queueMicrotask(() => {
              const ctl = ctlRef.current;
              if (!aliveRef.current || !ctl) return;
              setHasAgentBatch(ctl.hasAgentBatch());
              setUndoError(null);
            });
          }),
        ],
      }),
    });
    viewRef.current = view;

    /**
     * agent 控制器：一个 view 一个（撤销凭据是 per-view 的，见 bridge.ts）。
     *
     * 必须在拿到 view **之后**建、并且在**同一个 effect 的 cleanup** 里注销 ——
     * 两者错开，注册表里就会躺着一个已销毁的 EditorView，那正是 bridge.ts
     * 文件开头描述的现场（工具层要么去改没人看的副本，要么直接抛）。
     */
    const ctl = createMdEditorController(view);
    ctlRef.current = ctl;
    // 注销函数自带判等，StrictMode 的双挂载下旧 cleanup 不会误删新注册的那份（见 registerMdEditor）
    const unregister = registerMdEditor(materialId, ctl);
    onHandleRef.current?.({ flush: () => saver.flush() });

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
      aliveRef.current = false;
      onHandleRef.current?.(null);
      unregister();
      ctlRef.current = null;
      /**
       * dispose 之前先补一次 flush。
       *
       * dispose 会把**还没开始写**的那一版直接作废（save.ts 里 pending = null），
       * 而它恰恰是「打完字 1 秒内切走页面」时用户写的那几个字 —— 什么都不做就是丢字。
       * flush 在当前这个同步块里就把写入启动起来（pump 是同步进 body 的），
       * 随后的 dispose 只拒收「比在途那次还新」的等待者，所以这一次写入一定会跑完。
       *
       * catch 掉是因为页面正在拆：这时已经没有界面可以讲这件事，而真正的失败
       * 在编辑期间就已经被 state.error 报过一轮（那才是用户看得见的那次）。
       */
      void saver.flush().catch(() => {});
      saver.dispose();
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
    // 依赖只有 initial 与 materialId：initial 是 useState 的初值（整个生命周期里同一个字符串），
    // materialId 变了就是另一份文档，编辑面必须整个重建。
    // debounceMs / onDirty / onSaved / onHandle 刻意**不在**这里 —— 它们走 latest-ref，
    // 而它们的变化绝不该以「重建 EditorView」为代价（那会丢字、丢选区、丢撤销栈）。
  }, [initial, materialId]);

  /**
   * 「预览 ⇄ 源码」：用 Compartment.reconfigure 重挂 livePreview。
   *
   * 这是 CodeMirror 6 换扩展的标准做法，**不要**改写成「把 state 重建一遍」——
   * 重建会丢选区、撤销栈和滚动位置，而这里恰恰是「切视图最不该丢编辑」的地方：
   * 两种视图共用同一个 EditorState，变的只是装饰层，文档一个字都没动。
   * 源码视图就是「不挂 livePreview()」：没有装饰 = 原始语法符号全都露出来。
   *
   * ⚠️ 这个 Compartment **只管 livePreview**。agentDiff() 在上面是顶层挂的，
   * 所以切视图既不会把它清空、也不会让它跟着重新创建一遍（理由见 agentDiff.ts 开头）。
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

  /**
   * 「撤销本次 agent 改动」。
   *
   * 失败必须把 bridge 给的句子显示出来：`UndoResult` 特意改成了 `{ok, error}` 就是为此 ——
   * 「撤不掉」有三种完全不同的原因（没有可撤的 / 编辑面没了 / 用户动过那几处），
   * 对用户是三件不同的事。而点下去屏幕毫无反应的话，用户既不知道出了什么事，
   * 也不知道该不该手动改回去。高亮与撤销凭据都在 bridge 里，这里不碰装饰。
   */
  const onUndoAgentBatch = useCallback(() => {
    const ctl = ctlRef.current;
    if (!ctl) return;
    const r = ctl.undoAgentBatch();
    setUndoError(r.ok ? null : r.error);
  }, []);

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
        {/* 状态文案直接用 save.ts 的 mdSaveLabel：判断（「保存中/已保存/保存失败/
            有未保存的修改」）属于状态机，抄一份到组件里必然与它漂移。
            className 那三态分的是**颜色语义**：error 是出了故障，dirty/saving 只是
            「还没存 / 正在存」，用主色不用 error 色（见 material-reader.css）。 */}
        <span
          className={
            saveState.error
              ? 'mr-edit-state mr-edit-state--error'
              : saveState.dirty || saveState.saving
                ? 'mr-edit-state mr-edit-state--dirty'
                : 'mr-edit-state'
          }
          data-testid="md-edit-state"
        >
          {mdSaveLabel(saveState)}
        </span>
        <div className="mr-bar__spacer" />
        {/* 灰着而不是藏起来：位置固定，用户才会认得「这里有个可以撤的东西」；
            而且 agent 改完之后按钮突然出现会把右边的分段开关顶走。 */}
        <mdui-button
          className="mr-edit-undo"
          variant="text"
          disabled={!hasAgentBatch}
          onClick={onUndoAgentBatch}
          data-testid="md-agent-undo"
          title="撤销 agent 刚才对这份材料的改动"
        >
          <mdui-sym-undo slot="icon" />
          撤销本次
        </mdui-button>
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
      {/* 两条提示都不做「短文案 + 悬停看全文」：这两种失败都不会自己好起来，
          用户必须一眼读到「到哪一步没成、接下来该做什么」——
          save.ts 的 state.error 与 bridge 的 UndoResult.error 已经是写好的整句话。 */}
      {saveState.error && (
        <div className="mr-hint" data-testid="md-save-error">
          <mdui-sym-error />
          <span>{saveState.error}</span>
        </div>
      )}
      {undoError && (
        <div className="mr-hint" data-testid="md-undo-error">
          <mdui-sym-error />
          <span>{undoError}</span>
        </div>
      )}
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
