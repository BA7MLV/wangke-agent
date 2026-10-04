/**
 * agent 工具层与 md 编辑面之间**唯一**的耦合点。
 *
 * ── 为什么是模块级注册表，而不是 React 上下文 ────────────────────────────────
 * src/harness/tools.ts 是纯 TS（它得能被单测直接 import，也得能进 node），
 * 让它认识 React 就等于把它拖进整棵组件树。所以两边只通过
 * 「materialId → 一个窄接口（MdEditorController）」打交道：
 * 工具层 import 的只有本文件，而本文件 import 的只有 @codemirror 与 ./edits、./agentDiff，
 * 没有任何 React。这条边界比省下的那几行样板值钱。
 *
 * ── 为什么必须注销 ──────────────────────────────────────────────────────────
 * 拿到**已销毁**的 EditorView 去 dispatch 会抛（它要摸已经被置空的 docView）。
 * 那正是「用户关掉材料页、agent 还在改」的现场。所以阅读器卸载时
 * 必须调用 registerMdEditor 返回的注销函数：工具层查不到控制器，
 * 就该回一句「这份材料现在没有打开编辑面」，而不是碰一个死对象把整轮打断。
 *
 * 本文件自己不碰 React，也不碰 DOM API。但它 import 的 ./agentDiff 会在**运行时**装载
 * @codemirror/view（要 DOM），所以整个 bridge 进不了 node —— 撤销的坐标逻辑只能在浏览器里验。
 * 这一点特意写出来：否则下一个人会照着 scripts/test-md-edit-tool.mjs 的样子
 * 写一个 node 单测 import 本文件，然后在 import 那一行就炸。
 */
import { isolateHistory } from '@codemirror/commands';
import type { Text } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { planAgentEdits, type AgentEdit } from './edits';
import { applyDiff, clearDiff } from './agentDiff';

/** 工具层的回执：要么说清改了几处，要么把诊断原样带回给模型 */
export type ApplyEditsResult = { ok: true; changed: number } | { ok: false; error: string };

/**
 * 撤销的回执。**为什么不回一个 boolean**：「撤不掉」有三种截然不同的原因，
 * 而它们对用户是完全不同的三件事（重新点一次 / 关掉页面再打开 / 先手动处理一下冲突）。
 * 只回 false 的话，UI 唯一能做的就是静默什么都不做 —— 用户点了按钮、屏幕毫无反应，
 * 既不知道是「没有可撤的」还是「你的改动和它冲突了」，也不知道该怎么办。
 * 这是**给人看的文案**，所以写成能直接展示的句子。
 */
export type UndoResult = { ok: true } | { ok: false; error: string };

/**
 * 编辑面愿意暴露给 agent 的全部能力。**故意只有这三个方法** ——
 * 工具层要的是「把这段改了」和「撤回去」，不该拿到 EditorView 去 dispatch 任意事务
 * （那等于给模型一把万能钥匙：它可以顺手把光标、乱序、选区全改掉）。
 */
export interface MdEditorController {
  /**
   * 应用一批改动并挂上高亮。edits 就是工具收到的 { old_string, new_string } 数组。
   *
   * 失败时 error 是**写给模型看的诊断**（edits.ts 的产出），原样透传，
   * 不要在外面包一层「编辑失败」把细节吞掉。
   */
  applyEdits(edits: AgentEdit[]): ApplyEditsResult;
  /**
   * 撤掉**最近一次** applyEdits 留下的全部改动（含纯删除）。
   * 撤不掉时不动文档，并给一句能直接展示的原因（见 UndoResult）。
   */
  undoAgentBatch(): UndoResult;
  /** 现在有没有一批可撤的改动。撤销按钮据此决定亮不亮 */
  hasAgentBatch(): boolean;
}

/** 编辑面已经不在了。写成一句能指导下一步的话，而不是「未知错误」 */
const EDITOR_GONE =
  '这份材料当前没有打开编辑面（编辑面不在时改动会写进没人看的副本）。请先点开它的「编辑」再试一次。';

/**
 * 一次调用留下的撤销凭据。坐标是**改动后**的文档坐标。
 *
 * 之所以要自己存一份而不靠 history：用户在 agent 改完之后又打了几字，
 * 此时 Ctrl+Z 退掉的是**他自己的输入**，不是 agent 的那一次。
 * 「按一次退掉整次调用」用 isolateHistory 解决（见 applyEdits），
 * 「按钮精确撤掉那一次」只能靠这份快照。
 */
interface UndoSpec {
  from: number;
  to: number;
  /** 要写回去的原文。纯删除时非空 —— 那正是纯删除仍然可撤销的原因 */
  insert: string;
  /**
   * 撤销前这段**应该**还是的内容（= agent 当时写上去的 new_string）。
   * 纯靠坐标不够：坐标会因为用户之后的输入而漂移，漂了就可能撤到无关的字上。
   * 见 stillIntact。
   */
  expect: string;
}

/**
 * 为一个 EditorView 建控制器。**一个 view 一个**（撤销凭据是 per-view 的）。
 *
 * 生命周期归调用方：view 销毁时控制器也就没有意义了，
 * 由 MdEditor 在卸载时顺手 registerMdEditor 的注销函数一并作废。
 */
export function createMdEditorController(view: EditorView): MdEditorController {
  /** 最近一次 applyEdits 的撤销凭据；null = 现在没有可撤的 */
  let batch: UndoSpec[] | null = null;

  function applyEdits(edits: AgentEdit[]): ApplyEditsResult {
    if (isGone(view)) return { ok: false, error: EDITOR_GONE };
    const src = view.state.doc.toString();
    const plan = planAgentEdits(src, edits);
    // 失败原样透传：edits.ts 的报错就是写给模型看的（它点名第几条 edit、命中几处、下一步怎么改）
    if (!plan.ok) return plan;

    /**
     * `changes` 是**调用时**的旧文档坐标，已经按 from 升序排好，
     * CodeMirror 的 ChangeSet.of 会自己处理多区间（不要手动降序拼字符串）。
     *
     * `isolateHistory.of('full')` —— **一次工具调用 = 一个撤销单元**，两侧都断。
     * 不加它，这次插入会按 newGroupDelay（默认 500ms）与 joinToEvent
     * 和前后的事务并成一组，后果是**双向**的：
     * 按一次 Ctrl+Z 会连带退掉用户自己刚敲的字（退多了），
     * 而 agent 的多处改动也可能被拆进两个撤销步（退少了）。
     */
    view.dispatch({ changes: plan.changes, annotations: isolateHistory.of('full') });
    // 高亮在**改动后**的坐标上，所以只能在这之后派发（详见 agentDiff.ts 里 applyDiff 的注释）
    applyDiff(view, plan.highlights);

    /**
     * 存逆向 spec。注意 plan.changes 与 plan.highlights 是**平行数组**：
     * edits.ts 在同一个循环里 push，所以 changes[i] 与 highlights[i] 说的是同一处改动
     * （scripts/test-md-edit-tool.mjs 的 undo() 也依赖这条）。
     * 于是 changes[i].insert 正好就是 highlights[i] 那段现在该有的内容 —— expect 从它来。
     */
    batch = plan.highlights.map((h, i) => ({
      from: h.from,
      to: h.to,
      insert: h.removed,
      expect: plan.changes[i].insert,
    }));

    /**
     * changed 是**区间数**，不是 edit 条数：一条 replace_all 的 edit 命中 5 处就是 5。
     * 回执里说「改了 5 处」比说「改了 1 条 edit」有用，而且它与用户看到的绿色高亮条数一致。
     * 恒 ≥ 1 —— planAgentEdits 对空 edits 是直接报错的。
     */
    return { ok: true, changed: plan.changes.length };
  }

  function undoAgentBatch(): UndoResult {
    if (batch === null || batch.length === 0) {
      return { ok: false, error: '没有可撤销的改动（agent 还没改过这份材料，或刚才那次已经撤过了）。' };
    }
    if (isGone(view)) {
      return { ok: false, error: '编辑面已经关掉了，无法撤销。' };
    }
    // 校验不过就**什么都不做**：返回失败而不是「尽力撤一点」。
    // 撤销的位置一旦偏了就是静默丢字（见 stillIntact），那比撤不了糟糕得多。
    if (!stillIntact(view.state.doc, batch)) {
      return {
        ok: false,
        error:
          '撤不掉了：agent 改的那几处（或它们前面的内容）在之后被你编辑过，原文已经对不上。' +
          '为了不覆盖你写的内容，这里没有强行撤销。你可以手动改回，或者关掉编辑面重新打开。',
      };
    }

    // ⚠️ 降序，理由见 undoOrder —— 按升序撤会吃掉已经还原回去的内容
    const changes = [...batch].sort(undoOrder);
    // 同样带 isolateHistory：撤销本身也必须是一整格，
    // 否则紧接着的 Ctrl+Z 会把「撤销」和用户之后的输入并成一组，重做时一起回来。
    view.dispatch({ changes, annotations: isolateHistory.of('full') });

    clearDiff(view);
    batch = null;
    return { ok: true };
  }

  return {
    applyEdits,
    undoAgentBatch,
    // 刻意**不**在 hasAgentBatch 里做校验：这个问句只回答「有没有可撤的」，
    // 让撤销按钮亮着、点了却撤销不了（附一句原因）比灰着更容易排查。
    hasAgentBatch: () => batch !== null && batch.length > 0,
  };
}

/**
 * 撤销派发的顺序：**from 降序；from 相同时 to 降序**。
 *
 * 撤销凭据的语义是「把 [from,to) 这段换成 insert」，而 insert 往往**不是**空串
 * （被还原的原文就在里面）。于是每还原一段，后面的坐标都要整体前移（除非正好等长）。
 * 按升序还原，第一段插进去的内容会被下一段的 [from,to) 整个切掉 —— **静默丢字**：
 *
 *   文档 AAABBBCCC，agent 删掉 BBB 并把 CCC 换成 CCCCC → AAACCCCC
 *   升序还原 {from:3,to:3,insert:'BBB'} → AAABBBCCCC
 *   再还原 {from:3,to:8,insert:'CCC'} → AAACCCCCC     ← BBB 整段没了
 *   降序还原                                   → AAABBBCCC ✓
 *
 * 实测同一条数据（node，@codemirror/state + edits.ts）：升序 "AAACCCCCC"、降序 "AAABBBCCC"。
 * 注意这**不只**是「两条 from 相同」的边角：两处互不相邻的改动也一样 ——
 * {from:0,to:2,insert:'0'} 升序先还原会把后面所有坐标推后一格。
 *
 * from 相同的那条 tie-break 是另一种形状，也是 edits.ts 明确会产出的：
 * 纯删除的零宽 {from:3,to:3} 紧跟一处插入 {from:3,to:8}（纯删除 −3 把后面一处拉回同一个 from）。
 * 先撤零宽那条的话，刚插回去的 BBB 会被 to 更大的下一条吃掉 —— 所以先撤 to 大的。
 *
 * ⚠️ CM6 的 ChangeSet.of **两种顺序都吃**（它的 process() 遇到 from < pos 会 flush 并 compose，
 * 见 @codemirror/state dist/index.js 里 ChangeSet.of 的 process），所以按降序派发
 * **不是**为了让 dispatch 不出错，而是让派发顺序与上面这套「手工逆拼接」的代数一致 ——
 * 两种写法算出来的必须是同一个文档。（实测降序会多走一次 ChangeSet.compose，
 * 一次撤销只有几条区间，量级可以忽略。）
 */
function undoOrder(a: UndoSpec, b: UndoSpec): number {
  return b.from - a.from || b.to - a.to;
}

/**
 * 撤销前的校验：这段现在**还得是** agent 写上去的那段。
 *
 * 为什么不能省：撤销凭据存的是 apply 那一刻的坐标。用户在这之后又打字，
 * 坐标就漂了 —— 漂到前面的会把无关的字当成 agent 写的删掉（丢字，且屏幕上毫无异样）。
 * 与其那样，不如不撤：撤销返回失败并说明为什么（见 UndoResult），UI 把它讲给用户听。
 *
 * 为什么不改成「跟着文档改动映射坐标」：那需要给 view 挂一个 updateListener，
 * 而编辑器是在 MdEditor 里建出来的（扩展只能在创建时给），本模块拿不到那个口子。
 * 把校验留在撤销这一刻，是这里唯一能诚实做到的。
 *
 * 顺带说明代价：用户在**后面**打字（改动区间之后）完全不影响撤销 —— 坐标不动。
 * 校验只在用户动过 agent 写的那几段、或在它们**前面**插了字时才失败，
 * 那两种情况下「撤不了」本来就是比「撤错」更好的结果。
 *
 * 纯删除的凭据是**零宽**（from === to），派发它只会插入、不会删掉任何东西
 * （用户在这位置打的字只是被顶到后面去），所以它必然过这一关。
 * 真正把关的是替换类那几条 —— 也正是只有那几条会毁掉东西。
 */
function stillIntact(doc: Text, batch: readonly UndoSpec[]): boolean {
  return batch.every((s) => doc.sliceString(s.from, s.to) === s.expect);
}

/**
 * view 是不是已经销毁 / 被摘出 DOM 了。
 *
 * 用 `view.dom.isConnected` 而不是 `view.docView == null`：后者在类型里是 private，
 * 写它过不了 tsc。
 * 正常的路径是注册表注销（见文件开头），这里只是第二道 ——
 * 「已经关掉页面、agent 还在改」的现场不该变成一个未捕获异常把整轮工具调用打断。
 */
function isGone(view: EditorView): boolean {
  return !view.dom.isConnected;
}

/** materialId → 控制器。只放**确实活着**的编辑面 */
const registry = new Map<string, MdEditorController>();

/**
 * 注册一份编辑面，返回注销函数。
 *
 * ⚠️ 注销必须**判等号**，这是会真发生的 bug：同一个 materialId 会被注册两次
 * （React StrictMode 的双挂载、或换 key 重挂 EditorView），而第一次的 cleanup
 * 可能**晚于**第二次的注册执行 —— 不判等的话旧组件的 cleanup 会把新那份也删掉。
 * 表现是「编辑器明明开着，工具却说没打开」，且只在开发模式下偶发，极难查。
 * 判等之后，旧 cleanup 发现自己删不掉任何东西就什么都不做，这正是它该做的。
 *
 * 控制器对象本身不必缓存引用：注销函数闭包住自己注册时那个 c，判等永远成立。
 */
export function registerMdEditor(materialId: string, c: MdEditorController): () => void {
  registry.set(materialId, c);
  return () => {
    if (registry.get(materialId) === c) registry.delete(materialId);
  };
}

/** 取这份材料当前打开着的编辑面；没打开（没进编辑态、或已卸载）返回 undefined */
export function getMdEditor(materialId: string): MdEditorController | undefined {
  return registry.get(materialId);
}