/**
 * guest 侧的未确认操作暂存（outbox）：断链时把写 op 排队，重连后按序补发。
 *
 * 对应设计不变量 4「断链不丢写」。链路会断，而 iPad 上的操作不能因为一次 socket 抖动
 * 消失 —— 但**落点仍只有 host 的 Dexie 库**（不变量 2），所以 guest 自己一个字都不写，
 * 只是把「打算让 host 写什么」暂存在 localStorage 里，等一条链路过来了再倒给它。
 *
 * ## 两条策略，以及为什么它们不对称
 *
 * **1. 失败分终态与暂态，只有 internal 可重试。**
 *   - `not-found` / `gone` / `bad-args` / `unknown-op` 是**终态**：重试多少次都不会变
 *     （课程被删了、卡重新生成换了自增 id、参数本身是脏的、op 名是旧版/新版对不上）。
 *     留着它不只是白试，还会**堵住队首**，把后面本来能送达的 op 一起卡住（补发是按序
 *     逐条来的，前面不动后面就不发）。
 *   - `internal` 是**暂态**：host 落库失败多半是临时的（配额满、库被另一个标签页短暂占用）。
 *     静默丢掉一条 `study.add` 就是静默丢用户数据 —— 那几秒不会出现在任何界面上，热力图
 *     只是浅一格。所以留着重试，直到配额用尽。
 *   配额默认 5 次的来由：host 单队列串行，同一条 op 连续失败 5 次基本不是抖动而是真的
 *   写不进去（库被关掉了、字段不兼容）；再重试只是让队首多堵一会儿，也让用户多等一会儿
 *   才看到「这条没补上」。
 *
 * **2. `position.set` 禁止入队（它抛错，不是默默排队）。**
 *   进度是**最后写入胜出**语义：第 5 分钟拖到 40:00，第 40 分钟又拖到 41:30，只有最后
 *   那条有意义。攒队列会让「拖到 40 分钟然后关页面」把 41:30 那条一起丢掉 —— 而拖到一半
 *   关页面是**最常见的用法**，不是边缘情形。掉链时 iPad 上的进度条立刻不动了，比少记
 *   一分钟严重得多。所以进度改由 guest 在内存里留一条 pending，`pagehide` 时尽力发一次，
 *   之后有机会再补；见 guest.ts 接线。
 *   这里选择**抛错**而不是静默忽略：进度塞进 outbox 看起来完全可行（类型是同一个
 *   OpName），后来者顺手就塞了，而后果是断链时进度彻底不更新 —— 一条没人发现的静默故障。
 *   抛错会当场断在测试里。
 *
 * ## 落盘的两条纪律
 *
 * - **每次变更整份重写**（JSON 一个数组）。队列量级是几十条（每条 ~100 字节），做增量
 *   更新只会换来「写了一半的 JSON」这种更难恢复的状态；localStorage 本来就是同步内存写。
 * - **读出来解析失败就当空表**：这份数据可能被用户手改、被别的脚本写坏、被老版本写成了
 *   别的形状。待发队列是**缓存不是数据**（真正的数据在 host 的库里），所以宁可丢掉整份
 *   队列，也不能让一次 JSON.parse 的异常把页面打不开 —— 用户看到的是「来宾页白屏」，
 *   而他刚做的事只是没同步而已。逐条筛掉坏记录是同一个判断的细粒度版本。
 *
 * ## 为什么 pendingCount 要能被外面读到
 *
 * 待补发的操作**卡在别人的机器上**，用户在 iPad 上看不到任何异常：滑过去的卡片没进库、
 * 记的时长没上主机，界面却一切正常。共享条上显式写「N 条操作待补发」是唯一的信号 ——
 * 不显示的话，队列堵住和队列为空在用户眼里长得一模一样（都是「好像没生效」）。
 */

import type { ApplyReason, OpName } from './ops.ts';
import { uuid } from '../utils/uuid.ts';

/** 落盘用的 localStorage key。设计 §3.4 定下的名字，换了就与旧队列失联（老队列读不出来）。 */
export const OUTBOX_STORAGE_KEY = 'wangke-livelink-outbox';

/** 一条待发的 op。`args` 原样保存，发出去时不做任何加工（加工是 host 侧 dispatch 的事）。 */
export interface OutboxRecord {
  /** guest 生成的 clientOpId：ack 原样回它，也是 host 侧 study.add 的去重键 */
  clientOpId: string;
  op: OpName;
  args: unknown;
  /** 入队时刻（毫秒）。排查「这条卡了多久」用，不参与任何判定 */
  enqueuedAt: number;
  /** 已经回过几次 internal。**只在 internal 时累加**，其它原因不配加重试计数 */
  attempts: number;
}

/**
 * 落盘后端。抽成接口只有一个理由：让 outbox 在 Node 里可测（本仓库的测试脚本直接
 * import .ts，不该为了测一个纯逻辑而先把 localStorage 装出来）。生产用
 * `createLocalStorageOutbox()`。
 */
export interface OutboxStorage {
  read(): string | null;
  write(s: string): void;
}

export interface OutboxOptions {
  /** internal 重试配额。用尽即丢弃，默认 5（理由见文件头） */
  maxAttempts?: number;
  /** 时钟注入源，测试用 */
  now?: () => number;
}

const DEFAULT_MAX_ATTEMPTS = 5;

/** 终态原因：重试不会改变结果，白试且堵队首。映射成 false = 不重试，见 fail()。 */
const TERMINAL_REASONS: ReadonlySet<string> = new Set<ApplyReason>(['not-found', 'gone', 'bad-args', 'unknown-op']);

/**
 * clientOpId 生成。`o-` 前缀是为了在 host 的日志与去重表里一眼认出「这是链路上的 op」，
 * 后面跟的就是标准 UUID —— 算法在 utils/uuid.ts，本仓库只有那一份（原来这里是第三份
 * 拷贝，改一处忘另一处的后果是某处 id 变短或不再唯一，而症状是 host 去重表把两条不同的
 * op 当成同一条：一条时长被静默合并掉）。
 */
function newClientOpId(): string {
  return `o-${uuid()}`;
}

/** 记录副本：list()/next() 交出去的不能是内部对象，否则调用方改一下就绕过了去重与落盘。 */
function copy(r: OutboxRecord): OutboxRecord {
  return { clientOpId: r.clientOpId, op: r.op, args: r.args, enqueuedAt: r.enqueuedAt, attempts: r.attempts };
}

/** 落盘里的一条记录是否可用（逐条筛，坏记录不许连累合法的那几条） */
function usable(x: unknown): x is OutboxRecord {
  if (typeof x !== 'object' || x === null) return false;
  const r = x as Record<string, unknown>;
  return typeof r.clientOpId === 'string' && typeof r.op === 'string' && Number.isFinite(r.enqueuedAt);
}

/**
 * guest 侧未确认操作队列。线程模型上只有一个调用方（guest.ts），没有并发问题；
 * 每次增删改都同步落盘，所以刷新页面 / 被 iOS 杀掉重来时队列还在。
 */
export class Outbox {
  /** 队列本体。数组顺序 = 入队序，补发顺序与去重语义都靠它 */
  private records: OutboxRecord[];
  private storage: OutboxStorage;
  private maxAttempts: number;
  private now: () => number;

  constructor(storage: OutboxStorage, opts: OutboxOptions = {}) {
    this.storage = storage;
    this.maxAttempts = Math.max(1, Math.floor(opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
    this.now = opts.now ?? Date.now;
    this.records = this.load();
  }

  /** 按入队序返回全部待发记录（副本）。 */
  list(): OutboxRecord[] {
    return this.records.map(copy);
  }

  /**
   * 入队一条 op，返回**它自己**的记录（含生成的 clientOpId）——调用方要拿这个 id 去发帧、
   * 去对 ack。同一 clientOpId 重复入队返回**已有那条**且不改写它（去重契约）：
   * host 靠 clientOpId 去重，重复入队 + 重放 = `study.add` 累加两次（不变量 3）。
   *
   * `position.set` 抛错（理由见文件头）：进度是最后写入胜出语义，攒队列会丢最后一条。
   */
  enqueue(op: OpName, args: unknown, clientOpId?: string): OutboxRecord {
    if (op === 'position.set') {
      throw new Error(
        'position.set 不进 outbox：进度是最后写入胜出语义，攒队列会让「拖到一半关页面」丢掉最后一条。' +
          '请改用 guest 内存里的 pending position（pagehide 时尽力发一次）。',
      );
    }
    if (clientOpId) {
      const existing = this.records.find((r) => r.clientOpId === clientOpId);
      if (existing) return copy(existing);
    }
    const id = this.freshId(clientOpId);
    const rec: OutboxRecord = { clientOpId: id, op, args, enqueuedAt: this.now(), attempts: 0 };
    this.records.push(rec);
    this.persist();
    return copy(rec);
  }

  /**
   * 送达回执：移除记录。opId 不存在时**安静返回**（不抛、不改落盘）：ack 与 fail 可能因
   * 重试时序错位到达（补发途中 host 回了上一轮的 ack；同一条 ack 也可能收到两次），
   * 那不是错误，是正常时序。
   */
  ack(clientOpId: string): void {
    const i = this.records.findIndex((r) => r.clientOpId === clientOpId);
    if (i < 0) return;
    this.records.splice(i, 1);
    this.persist();
  }

  /**
   * 失败回执：按原因决定丢弃还是重试，返回 `'dropped'` / `'retry'` 供调用方决定
   * 要不要继续发下一条。
   *
   * - 终态原因（not-found / gone / bad-args / unknown-op）→ 立即丢弃：重试不会变，
   *   留着还会堵住队首。
   * - `internal` → `attempts++` 并保留；`attempts` 达到配额才丢弃（配额用尽仍写不进去
   *   就不只是抖动，继续重试只是让用户干等）。
   * - opId 不存在 → 安静回 `'dropped'`（与 ack 同一理由）。
   */
  fail(clientOpId: string, reason: ApplyReason): 'dropped' | 'retry' {
    const i = this.records.findIndex((r) => r.clientOpId === clientOpId);
    if (i < 0) return 'dropped';
    if (TERMINAL_REASONS.has(reason)) {
      this.records.splice(i, 1);
      this.persist();
      return 'dropped';
    }
    // internal：attempts 数的是「已经失败过几次」，等于配额就是最后一次
    const rec = this.records[i];
    rec.attempts += 1;
    if (rec.attempts >= this.maxAttempts) {
      this.records.splice(i, 1);
      this.persist();
      return 'dropped';
    }
    this.persist();
    return 'retry';
  }

  /**
   * 按入队序取待发第一条（队首就是最早那条）。补发由调用方**逐条**做：取一条发一条，
   * 收到 ack 或 fail 再取下一条 —— 一次性全发出去会让「已确认送达」这件事失去边界，
   * 顺序也就无从保证。
   */
  next(): OutboxRecord | undefined {
    const head = this.records[0];
    return head ? copy(head) : undefined;
  }

  /**
   * 待发条数。给 UI 读的（共享条上「N 条操作待补发」）：队列堵住和队列为空在用户眼里
   * 长得一模一样 —— 都表现为「操作好像没生效」。不显示这个数，堵了就永远查不出来。
   */
  pendingCount(): number {
    return this.records.length;
  }

  // ── 内部 ─────────────────────────────────────────────────────────────────

  /**
   * 生成一个不与现有记录相撞的 clientOpId。随机碰撞概率小到可以忽略，但「忽略」不是
   * 「不会」：撞上意味着一条 op 被静默合并掉（host 去重表把它当成同一条），而这种故障
   * 在界面上完全看不出来。这里再兜一层。
   */
  private freshId(wanted?: string): string {
    if (wanted) return wanted;
    for (let i = 0; i < 8; i++) {
      const id = newClientOpId();
      if (!this.records.some((r) => r.clientOpId === id)) return id;
    }
    // 8 次都撞上（现实中不可能）：加随机后缀硬拼一个，仍然唯一（因为带随机量）
    return `${newClientOpId()}-${this.records.length}`;
  }

  /** 读落盘。坏 JSON / 非数组 → 空表；数组里混进坏记录 → 逐条筛掉（理由见文件头）。 */
  private load(): OutboxRecord[] {
    let raw: string | null = null;
    try {
      raw = this.storage.read();
    } catch {
      return [];
    }
    if (!raw) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(usable).map((r) => ({
      clientOpId: r.clientOpId,
      // op 名不按名单过滤：由 host 回 unknown-op，我们据此丢弃（同一条路径，不在这里猜名单）
      op: r.op as OpName,
      args: r.args ?? {},
      enqueuedAt: r.enqueuedAt,
      attempts: Number.isFinite(r.attempts) ? Math.max(0, Math.floor(r.attempts as number)) : 0,
    }));
  }

  /**
   * 整份重写落盘。写失败（配额满、Safari 隐私模式 setItem 抛错）只记一条 warn：
   * 记录还在内存里，本次会话照样能补发，丢的只是**刷新之后**的持久性 —— 为此让
   * 页面崩掉是更大的损失（同一个错误在 enqueue 的调用栈里往上炸，症状是「滑卡片时
   * 页面白了」，而真正的问题只是同步没成功）。
   */
  private persist(): void {
    try {
      this.storage.write(JSON.stringify(this.records));
    } catch (err) {
      console.warn('[live-outbox] 落盘失败（待发队列只留在内存里）：', err);
    }
  }
}

/**
 * 生产用的落盘后端。
 *
 * `read` 自己兜住异常：Cookie 被禁 / 无痕模式下访问 `localStorage` 本身就会抛，
 * 而读落盘失败只是「没有队列」，不该连累建连。
 * `write` 不重复 try —— 写失败统一由 Outbox.persist 兜（那里有唯一的 warn 出口，
 * 两处各兜一次就会安静两次，反而更难看出到底写没写成功）。
 */
export function createLocalStorageOutbox(key: string = OUTBOX_STORAGE_KEY): OutboxStorage {
  return {
    read: () => {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    write: (s: string) => window.localStorage.setItem(key, s),
  };
}