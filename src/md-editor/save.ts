/**
 * md 编辑态的落盘：写 OPFS blob + 重新分块。
 *
 * ── 为什么必须重新分块（不能只写 blob）─────────────────────────────────────────
 * 问答检索读的是 `materialBlocks` 表，不是 blob。只写 blob 的话，
 * 用户看到「已保存」、重新打开也是新内容，但问「刚才改的那句」检索到的还是旧块 ——
 * 这比「不能编辑」更坏（看起来生效了，其实没有）。设计文档不变量 4。
 *
 * ── 为什么 debounce 1.2s ──────────────────────────────────────────────────────
 * CM6 每敲一个键都派发一次 `docChanged`。而每次保存都是**全量**动作：
 * 整篇重写 blob + 整篇重新分块（5 万字文档的分块是几百毫秒的同步计算，
 * 还要连带删旧块、加新块、跑一个 IndexedDB 事务）。逐键执行等于让输入随时卡住。
 * 1.2s 是「停顿感」与「及时」的折中：短到用户不会觉得「我改的东西怎么还没存」
 * （停手一两秒后切走页面最常见），长到连续打字期间一次都不会跑。
 *
 * ── 为什么落盘失败必须留痕 ────────────────────────────────────────────────────
 * 三步里任何一步失败都不能静默：最坏的一种是「blob 写成功、重新分块失败」——
 * 数据在、检索是旧的，两者对不上且用户不知道。所以每一步失败都带着**走到哪一步**
 * 抛出去（`MdSaveError.stage`），文案也分开写。设计文档不变量 5。
 *
 * 依赖 `materials/reindex.ts` 而不是 `materials/parse.ts`：后者静态 import 了 pdfjs，
 * 那 2MB+ 不能为了一篇 md 拖进编辑器链路（见 reindex.ts 开头的理由）。
 */

import { db } from '../store/db';
import { saveMaterialFile } from '../store/fileStore';
import { extractMdUnits, MD_MIME } from '../materials/md';
import { reindexMaterial, type MaterialParseResult } from '../materials/reindex';

/** 停止输入多久后落盘。见文件开头：CM6 逐键回调 + 全量重建，不能逐键执行 */
export const MD_SAVE_DEBOUNCE_MS = 1200;

/** 一次保存走到哪一步 */
export type MdSaveStage = 'blob' | 'blocks' | 'pos';

export interface MdSaveState {
  /** 有还没落盘的文本（含正在写的那一份） */
  dirty: boolean;
  /** 正在写 blob / 重建块 */
  saving: boolean;
  /** 最近一次成功落盘的时刻；null = 这次编辑会话还没成功过 */
  savedAt: number | null;
  /**
   * 最近一次失败的完整说明（可直接展示），成功后清空。
   *
   * **只有成功才清**：用户接着打字不代表上一次的失败消失了 ——
   * 尤其「原文已存、检索还是旧的」那种，编辑行为完全掩盖不了它。
   */
  error: string | null;
}

export interface MdSaverOptions {
  /** 状态变化回调（UI 拿它 setState）。每次变化都带一份新快照 */
  onState?: (state: MdSaveState) => void;
  /** 防抖毫秒，默认 MD_SAVE_DEBOUNCE_MS。留给测试缩短 */
  debounceMs?: number;
}

export interface MdSaver {
  /** 收到新文本，排一次防抖保存。不 await —— 保存是自驱的 */
  schedule(text: string): void;
  /**
   * 立刻落盘并等到「这一版确实在盘上」（退出编辑、切走页面时用）。
   *
   * 会跳过防抖，但**不会**跳过尚未开始的那一次：有文本就写，写完（含重新分块）才 resolve。
   * 两种会抛错的情形都不是「凭空成功」：上一次失败而无内容可写（照实抛出上次的错）、
   * 以及保存器已 dispose（已经没人负责落盘了）。
   */
  flush(): Promise<void>;
  /** 卸掉防抖定时器并停止接活。**组件卸载时必须调** */
  dispose(): void;
  getState(): MdSaveState;
}

/**
 * 落盘失败。分三步是为了让文案说清「到底哪一步没成」——
 * 三种失败的后果完全不同，用户能采取的动作也不同。
 */
export class MdSaveError extends Error {
  readonly stage: MdSaveStage;
  readonly cause: unknown;

  constructor(stage: MdSaveStage, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      stage === 'blob'
        ? `保存失败：原文没有写下去（${detail}）。你的修改还在编辑器里，别关页面。`
        : stage === 'blocks'
          // 这一条是设计文档点名要求显式告知的情况：数据在、检索是旧的。
          ? `原文已存下，但问答检索到的还是编辑前的旧内容（重新分块失败：${detail}）。` +
            `先别用问答验证这次修改；退出编辑后对这份材料「重新解析」一次即可对齐。`
          : `内容与检索索引都已更新，但阅读位置没能重置（${detail}）。段号已经变了，` +
            `下次打开这份材料可能落在别的段落上，属预期内。`,
    );
    this.name = 'MdSaveError';
    this.stage = stage;
    this.cause = cause;
  }
}

/** 状态文案。UI 直接用，不必再判断一遍（判断散到组件里必然与状态机漂移） */
export function mdSaveLabel(s: MdSaveState): string {
  if (s.error) return '保存失败';
  if (s.saving) return '保存中…';
  if (s.dirty) return '有未保存的修改';
  if (s.savedAt !== null) return '已保存';
  return '未修改';
}

/**
 * 建一个 md 落盘器（一份材料一个，随编辑面挂载/卸载）。
 *
 * ── 连续保存的串行语义（与 `pipelines/handoutEdit.ts` 的 editQueues 的差别）─────
 * handout 那套是「任务被新任务取代时视作完成」：被取代的那次 promise 直接 resolve，
 * 因为重建 DOCX 是 (sections, summary) 的纯函数，新任务的内容完整包含旧任务的内容，
 * 旧任务本来就没东西可做。
 *
 * 这里**合并（coalesce）但不照抄那句「视作完成」**，理由是 flush 的契约：
 * 落盘必须**串行**（OPFS 对同一个文件只能有一个 writable，且重建块是
 * 「删旧 + 加新」的整表事务，两次并发会互相踩），但「完成」只能由一次
 * **真正跑完的写入**来宣告。设想 flush() 拿到第 6 版、紧接着用户又敲出第 7 版：
 * 按 handout 的语义，第 6 版被第 7 版取代时 flush 就 resolve 了 ——
 * 而那一刻盘上写的其实是第 5 版，UI 却已经宣布「已保存」并把编辑面关掉，
 * 用户丢字。反过来，第 7 版落盘完之后再放行 flush 是安全的：
 * 盘上是比调用方要的**更新**一版，它要的意图已经被满足。
 *
 * 所以实现上：待保存的文本只留**最新一份**（中间版本被合并掉，这是真的省掉了工作），
 * 每次落盘记一个修订号，`flush` 的等待者只在「跑完的修订号 ≥ 它等的那个」时才 resolve。
 */
export function createMdSaver(materialId: string, opts: MdSaverOptions = {}): MdSaver {
  const debounceMs = opts.debounceMs ?? MD_SAVE_DEBOUNCE_MS;
  const onState = opts.onState;

  // 状态一律「换新对象」而不是原地改：onState 的接收方多半直接 setState，
  // 原地改同一个引用会让他们按值比较时看不出变化。
  let state: MdSaveState = { dirty: false, saving: false, savedAt: null, error: null };
  /** 修订号：每次 schedule +1，落盘时带上它是哪一版 */
  let rev = 0;
  /** 还没开始写的文本。同一时刻最多一份：连续编辑就是覆盖它（这就是合并） */
  let pending: { rev: number; text: string } | null = null;
  let running = false;
  /** 正在跑的那次保存的修订号；-1 = 没在跑。dispose 靠它分辨「等的是在跑的那次」还是「等的是被丢掉的那次」 */
  let runningRev = -1;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  const waiters: { rev: number; resolve: () => void; reject: (e: Error) => void }[] = [];

  function setState(patch: Partial<MdSaveState>) {
    state = { ...state, ...patch };
    onState?.(state);
  }

  function arm() {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void pump();
    }, debounceMs);
  }

  /**
   * 串行执行 pending。**只有一处**会启动保存，所以「串行」不需要额外的锁 ——
   * running 在同一个同步块里置位，递归调用（finally 里接下一轮）也会被它挡在外面。
   */
  async function pump(): Promise<void> {
    if (running || disposed || !pending) return;
    const job = pending;
    pending = null;
    running = true;
    runningRev = job.rev;
    setState({ saving: true, dirty: true });
    try {
      // 结果（块数/字数）不入状态：UI 只需要「有没有存成」，
      // 块数对用户没有意义，反而多一个会被别处读歪的字段
      await persistMd(materialId, job.text);
      // savedAt 除了当「已保存」的时间戳，还是「块集换过了」的信号：
      // 阅读视图靠它判断要不要重查 materialBlocks（每次成功保存必变，够用）。
      //
      // dirty 在这里就要跟着 pending 一起定稿：**不能**留着 true 等 finally 再清 ——
      // 中间那一次回调会派发出「saving=false 但 dirty=true」的组合，
      // 文案于是变成「有未保存的修改」，而那一刻其实既没在存也没有待存的文本。
      // 状态机的每一次对外快照都得自洽，UI 是直接照着它显示的。
      setState({ saving: false, dirty: pending !== null, savedAt: Date.now(), error: null });
      settle(job.rev, null);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      setState({ saving: false, dirty: pending !== null, error: err.message });
      settle(job.rev, err);
    } finally {
      running = false;
      runningRev = -1;
      // 跑的这段时间里又攒了新文本：立刻接上，不再压一轮 debounce ——
      // 用户已经为这一版等过一次，再等只会让「已保存」慢半拍。
      // （disposed 时不接：pump 自己也会挡，这里只是省一次空转）
      if (pending && !disposed) void pump();
      // 定稿 dirty。pump 可能已经把 running 重新置真，所以照它算而不是无条件清 false
      const dirtyNow = running || pending !== null;
      // 值没变就不发快照：onState 的接收方多半直接 setState，
      // 多派发一次就是一次内容完全相同的渲染（顺带让「状态变化」日志失真）
      if (state.dirty !== dirtyNow) setState({ dirty: dirtyNow });
    }
  }

  /** 放行「等的版本 ≤ 刚落盘的版本」的等待者；失败一律 reject，不静默吞掉 */
  function settle(doneRev: number, err: Error | null) {
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i];
      if (doneRev < w.rev) continue;
      waiters.splice(i, 1);
      if (err) w.reject(err);
      else w.resolve();
    }
  }

  function schedule(text: string) {
    // 卸载之后不该再有 docChanged；真来了也不能写 —— 保存器的生命周期归调用方管
    if (disposed) return;
    // 与待保存的那份一字不差：没有新东西可存，也就不该把「已保存」拨回「有未保存的修改」
    if (pending?.text === text) return;
    rev += 1;
    pending = { rev, text };
    arm();
    // 刻意**不清** error，理由见 MdSaveState.error
    setState({ dirty: true });
  }

  async function flush(): Promise<void> {
    // 已 dispose：没有落盘能力了。必须在这里就抛，而不是让 flush 走到 pump 里
    // 被 `disposed` 挡回来 —— 那会留下一个永远不会 settle 的 promise，
    // 调用方（「退出编辑时 flush」）就永远等在 await 上，界面卡在「保存中」。
    if (disposed) throw new Error('保存器已销毁，这次修改不会落盘');
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending === null && !running) {
      if (state.error) throw new Error(state.error);
      return;
    }
    // 先挂等待者再启动 pump：flush 的承诺是「这一版在盘上」，
    // 不能出现「保存已完成而等待者还没入列」的时序缝。
    const needRev = rev;
    const done = new Promise<void>((resolve, reject) => {
      waiters.push({ rev: needRev, resolve, reject });
    });
    void pump();
    await done;
  }

  function dispose() {
    disposed = true;
    // 待保存的文本就此作废（pump 已经不会再接它了），顺手清掉：
    // 留着会让 dispose 之后的 flush 误判「还有东西要存」。
    pending = null;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    // 等「已经在写的那次」的等待者不动：在跑的保存会替它们收尾（dispose 不取消在途写入，
    // 那样「flush 完就关页面」会把还没落盘的内容留在半路）。
    // 只把文本还没开始写的那批显式 reject：让调用方拿到一个错误，
    // 好过 promise 永远挂着、他以为「还在保存」而把编辑面关掉。
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].rev <= runningRev) continue;
      const w = waiters.splice(i, 1)[0];
      w.reject(new Error('编辑器已关闭，这次修改没有落盘（内容只存在于编辑器里）'));
    }
  }

  return { schedule, flush, dispose, getState: () => state };
}

/**
 * 一次落盘 = 写 blob → 重建块 → 清阅读位置。
 *
 * 顺序是刻意的：**先写 blob 再重建块**，与导入路径相反（导入是先有 blob 才抽单元）。
 * 反过来（先重建块再写 blob）的话，块是按内存里的文本建的、blob 却可能写失败 ——
 * 那就变成「检索是新内容、文件是旧内容」，比现在这个方向更难解释。
 * 三步都以文本为准，最后一步失败也不回滚前两步：内容已经对上了，
 * 剩下的只是「阅读位置记的是哪一段」这个派生状态，标成失败提示用户即可。
 */
async function persistMd(materialId: string, text: string): Promise<MaterialParseResult> {
  let stage: MdSaveStage = 'blob';
  try {
    await saveMaterialFile(materialId, new Blob([text], { type: MD_MIME }));
    stage = 'blocks';
    const res = await reindexMaterial(materialId, 'md', extractMdUnits(text), null);
    stage = 'pos';
    /**
     * 清掉断点续读位置。**段号会漂移**：编辑后「第 12 段」可能指向完全不同的内容
     * （插入/删除一个空行就够），`lastUnit` 记的「第几段」在重建之后语义已变 ——
     * 留着会让下次打开直接跳到一段无关的文字上，看起来像阅读器坏了。
     * 交给阅读器回落（`initialUnit` 为空 → 从头读）比跳错位置诚实。
     */
    await db.videos.update(materialId, { lastUnit: undefined });
    return res;
  } catch (e) {
    throw new MdSaveError(stage, e);
  }
}