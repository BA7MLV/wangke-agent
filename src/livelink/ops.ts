/**
 * host 侧的写 op：四个 apply 函数 + 一条串行队列。
 *
 * P1 里 guest 只读，所有帧都是 host→guest 的取数。P2 补上反方向：来宾在 iPad 上做的
 * 动作（拖进度、记时长、审核卡片、停生成）以 op 帧回传，**落点仍只有一处 —— host 的
 * Dexie 库**。guest 自己一个字都不写（设计 §3.4），于是 Mac 上打开看到的就是唯一真相。
 *
 * ## 一条硬规矩：apply 与本地写库共用同一个函数
 *
 * 「guest 写一条」和「本机写一条」如果各写各的，同一件事就有两种行为，迟早漂移，且漂移
 * 的表现是数据静默错乱（不是报错，是两边开始不一致）。所以进度 / 时长 / 制卡审核都走
 * 这里导出的 apply，播放页与卡片面板改为调用它们（Player.setTime 的两行 update 就是
 * applyPosition 的原样）。改口径只改一处，两边一起变。
 *
 * ## 为什么 host 侧要单队列串行（并发上限就是 1）
 *
 * 不是吞吐取舍，是正确性要求：`study.add` 与本机的 `studyTime.flush` 都是**读改写**
 * 同一行（`seconds += delta`），两者同时打同一天就是 lost update —— 丢的那几秒在任何
 * 界面上都看不出来，只是热力图浅了一格。串行是唯一不用引入版本号/冲突解决就正确的做法。
 * 顺带得到一个好处：apply 的执行顺序 = 入队顺序，来宾那边重发的 op 也就有个确定的语义。
 *
 * ## 去重表的边界（动这块之前先读完）
 *
 * `study.add` 是四条 op 里唯一**不幂等**的：`seconds += delta` 重放一次就多记一段，
 * 而界面完全看不出异常。所以去重表是它的**准入条件**，不是优化（设计 §不变量 3）。
 *
 * 去重表**只在内存**（宿主重启即失忆）。残余风险：「host 重启 + guest 恰好重放一条未
 * ack 的 study.add」会双倍累加一次。真实概率低（两者要同时在线才可能撞上），代价是
 * 几分钟时长。要更严就得把去重表持久化（一张 opId 序的表，或随库迁移），按 YAGNI 先
 * 不做 —— 下一个需要更严的人，接口留在这里：`DedupStore` 只有 has/add 两个方法，换成
 * 读写 IndexedDB 的实现即可，调用方一行都不用改。
 */

import { db } from '../store/db.ts';
import { round1 } from '../utils/studyLog.ts';

/** P2 的四个 op 名。与 protocol.ts 的帧字段是同一份清单，改一处必须改两处。 */
export type OpName = 'position.set' | 'study.add' | 'card.decide' | 'chat.stop';

/**
 * 失败原因。**都不可重试** —— guest 收到 ack ok:0 就从 outbox 里丢弃（不变量 4：
 * 断链才留着重发，收到回执就算送达了）。
 *
 * `internal` 是唯一一个重试也许有用的情况（落库失败多半是临时的，如配额满）。host
 * 接线时若要按原因区分重试，只对 internal 重试；其余三个重试多少次都不会变（课程没了、
 * 卡片过期了、参数是坏的）。
 */
export type ApplyReason = 'not-found' | 'gone' | 'bad-args' | 'unknown-op' | 'internal';

/**
 * apply 的结果。`ok:false` 一律带 reason —— host 据此回 ack 帧，来宾据此显示
 * 「这节课已被删除」之类的明说，而不是把失败当成「已送达」悄悄丢掉。
 * `rowId` 是被动到的行的键（日期 / 视频 id / 卡片 id），只用于回执与排查。
 */
export type ApplyResult = { ok: true; rowId?: number | string } | { ok: false; reason: ApplyReason };

/** study.add 的去重表。只有 has / add 两个方法：需要持久化时换实现即可，见文件头。 */
export interface DedupStore {
  has(opId: string): boolean;
  add(opId: string): void;
}

/** 日期主键的形状。写坏键会造出一行热力图永远看不见、清空记录也删不掉的脏数据。 */
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 写播放位置（秒）。`finished` 为真时顺带置「本轮看完」标记。
 *
 * 赋值语义，**天然幂等**：重放同一条 op 得到同一行状态。这也是它敢进链路的原因。
 * 字段形状与 Player.tsx 的 `resumeStorage.setTime` 逐字一致（`lastPosition` 永远写真实
 * 位置、播完也不归零，「播完后再打开从头来」由 `finished` + getTime 翻译）。
 *
 * **not-found 的判据用 update 的返回值（受影响行数），不先 get 再 update**：
 * 一次往返就够，也没有「判完到写之间课程被删掉」的窗口 —— 那是先读后写独有的 TOCTOU，
 * 表现是「ack 说写成功了，其实一行没动」。Dexie 的 update 即使值没变也返回 1（照写），
 * 所以重复到达照样回 ok。
 * 不用 put 兜底：put 会凭空造出一行只有 id 的课程，主页立刻多出一个 0 秒的幽灵条目。
 */
export async function applyPosition(videoId: string, position: number, finished: boolean): Promise<ApplyResult> {
  // 来自远端帧的参数不完全可信，而这里写坏值的代价是永久的：NaN 进度会让主页那根条
  // 永远算成 NaN。宁可不写、回 bad-args 让来宾看见，也不写一行坏数据。
  if (!videoId) return { ok: false, reason: 'bad-args' };
  if (!Number.isFinite(position) || position < 0) return { ok: false, reason: 'bad-args' };
  const hit = await db.videos.update(videoId, finished ? { lastPosition: position, finished: 1 } : { lastPosition: position });
  if (hit === 0) return { ok: false, reason: 'not-found' };
  return { ok: true, rowId: videoId };
}

/**
 * 累加一天的学习时长（秒）。**四条 op 里唯一不幂等的**，去重表是准入条件，见文件头。
 *
 * `opId` 是这条 op 的去重键（guest 生成的 clientOpId）：见过就直接回 ok 且**不写**，
 * 没见过才累加，然后登记。登记放在写成功之后 —— 反过来的话，一次配额失败的写入就把
 * opId 消耗掉了，之后重放会被当成「已经记过了」，那几秒永远补不回来。
 *
 * 读改写包在同一个 rw 事务里：本地 `studyTime.flush` 与来宾 op 可能同时打同一天，
 * 不在一个事务里就是 lost update（丢的那几秒没有任何症状）。
 * `round1` 复用 studyLog 的口径而不是就地取整：本地与链路必须是同一个精度，否则同一天
 * 的两笔账会出现 0.05 秒的差，且差在哪儿看不出来。
 */
export async function applyStudyAdd(
  date: string,
  seconds: number,
  opId: string,
  dedup: DedupStore,
): Promise<ApplyResult> {
  if (!DATE_KEY_RE.test(date)) return { ok: false, reason: 'bad-args' };
  if (!Number.isFinite(seconds) || seconds < 0) return { ok: false, reason: 'bad-args' };
  if (dedup.has(opId)) return { ok: true, rowId: date };
  const now = Date.now();
  await db.transaction('rw', db.studyDays, async () => {
    const row = await db.studyDays.get(date);
    if (row) await db.studyDays.update(date, { seconds: round1(row.seconds + seconds), updatedAt: now });
    else await db.studyDays.put({ date, seconds: round1(seconds), updatedAt: now });
  });
  dedup.add(opId);
  return { ok: true, rowId: date };
}

/**
 * 写一条候选卡的审核结果（1 保留 / 2 丢弃 / 0 撤回）。赋值语义，重放幂等。
 *
 * **gone 的两种成因，一种成色更糟**：卡片重新生成（pipelines/cards.ts 的 delete +
 * bulkAdd）会换掉自增 id，于是 ① 老 cardId 指向的行已经没了；② 参数错配 —— guest 传了
 * 另一门课的 cardId，或一帧被串到了别的来宾。只判 ① 会让 ② 照写下去：把别门课刚生成
 * 的卡静默改成「丢弃」，而来宾那边滑得一切正常。
 * 两者一律 gone：重试不会有结果（那张卡不会回来），来宾收到就丢弃（设计 §3.2）。
 *
 * cardId 先消毒再 get：`db.cards.get(NaN)` 抛 DataError，抛出去只会变成一条看不懂的
 * internal，而它本来就是个坏参数。
 */
export async function applyCardDecide(
  videoId: string,
  cardId: number,
  status: 0 | 1 | 2,
): Promise<ApplyResult> {
  if (!Number.isInteger(cardId) || cardId <= 0) return { ok: false, reason: 'bad-args' };
  if (status !== 0 && status !== 1 && status !== 2) return { ok: false, reason: 'bad-args' };
  const row = await db.cards.get(cardId);
  if (!row || row.videoId !== videoId) return { ok: false, reason: 'gone' };
  await db.cards.update(cardId, { status });
  return { ok: true, rowId: cardId };
}

/**
 * 停掉一轮问答生成。
 *
 * controller 由 host 侧按 turnId 查表传入（那一轮 agent loop 的 AbortController，注册表
 * 跟着 qaRunner 走，Task 3 接线）。**找不到 controller 也回 ok**：停一个已经结束的轮次
 * 是幂等的成功，回 false 会让来宾把用户的「停止」当成失败。`abort()` 本身幂等，
 * 重放同一条 op 没有副作用。
 *
 * 这一侧只负责「喊停」；abort 后保留已流出内容、追加「已停止生成」再照常落库，是
 * qaRunner 内部的活，不在这里重复一遍。
 */
export async function applyChatStop(turnId: string, abort?: AbortController): Promise<ApplyResult> {
  abort?.abort();
  return { ok: true, rowId: turnId };
}

/**
 * 内存 LRU 去重表（默认 512 条）。边界与残余风险见文件头。
 *
 * `Set` 自带插入序 = 热度序，淘汰从头取就是淘汰最旧的，不需要另维护访问时间戳。
 * 重复 `add` 会把该 opId 提到最新（delete + add）—— 在 study.add 这条路径上每个 opId
 * 只会被登记一次（见过就提前返回了），所以这一步是为将来复用这个表的 op 留的。
 *
 * 512 的来由：来宾每 5s 一条进度 op 而进度**不进**去重表（它天然幂等），真正占名额的
 * 只有 study.add（一分钟量级）与 card.decide。按 512 算，够记一整天还余量，而内存占用
 * 是几百个短字符串。宁可让极端情况下（来宾离线攒了几千条时长）老 opId 被淘汰后重放
 * 多记一次，也不要为它做持久化。
 */
export function createLruDedup(limit = 512): DedupStore {
  const seen = new Set<string>();
  return {
    has: (opId) => seen.has(opId),
    add(opId) {
      seen.delete(opId);
      seen.add(opId);
      if (seen.size > limit) {
        const oldest = seen.values().next().value;
        if (oldest !== undefined) seen.delete(oldest);
      }
    },
  };
}

/** 入队的一条 op。`args` 是远端帧里的参数，跑 dispatch 前一律当不可信数据处理。 */
export interface OpRequest {
  /** guest 生成的 clientOpId：ack 原样回它，也是 study.add 的去重键 */
  clientOpId: string;
  name: OpName;
  args: unknown;
}

export interface OpQueueDeps {
  /** study.add 的去重表。不给就自带一张内存 LRU（见 createLruDedup 的边界注释）。 */
  dedup?: DedupStore;
  /** chat.stop：按 turnId 找那一轮的 AbortController；找不到（已结束）视为幂等成功。 */
  turnAbort?: (turnId: string) => AbortController | undefined;
}

/**
 * 写 op 的串行队列：单链，任何一条没跑完，下一条不开始。
 *
 * 写法与 `studyTime.flush` 的 `flushChain` 同构（那是被实战验证过的）：链尾只记日志、
 * 永不 reject，一条 op 失败不许把后面的全带走 —— 表现是「后面每一条都在等一个已经
 * reject 的 promise」，一次配额写失败就静默冻死整条链路，比单条丢失严重得多。
 *
 * host 侧不节流（设计 §3.2）：节流是来宾的活，host 只管按序应用。
 */
export class OpQueue {
  /** 每条完成后回调，由 host 接线时注入去发 ack 帧 */
  onAck?: (opId: string, result: ApplyResult) => void;

  /** 链尾：等它 settle 即「队列排空」 */
  private chain: Promise<unknown> = Promise.resolve();
  /** 还没开始跑的条数 */
  private waiting = 0;
  /** 正在跑的那一条（至多 1 条，串行的定义） */
  private running = false;
  /** 注入的依赖（显式字段而非构造器参数属性：Node 的类型剥离不支持参数属性） */
  private deps: OpQueueDeps;
  /** 没注入 dedup 时自建一张（懒建：只跑进度 op 的队列不必付这个内存） */
  private dedupFallback?: DedupStore;

  constructor(deps: OpQueueDeps = {}) {
    this.deps = deps;
  }

  /** 排队的条数（不含正在跑的那条）。0 且 busy 为假 = 队列真的空了 */
  get depth(): number {
    return this.waiting;
  }

  /** 链上还有没跑完的（含正在跑的那条） */
  get busy(): boolean {
    return this.waiting > 0 || this.running;
  }

  /**
   * 入队一条 op，返回**它自己**的结果。`onAck` 在结果定下来之后、返回给调用方之前被调用，
   * 所以 ack 帧与调用方的 await 看到的是同一个结果，不存在「ack 说 ok 而 await 拿到别的」。
   */
  enqueue(op: OpRequest): Promise<ApplyResult> {
    this.waiting++;
    const run = this.chain.then(() => this.exec(op));
    // 链尾吞掉异常。exec 自己已经兜过一层（派发与 apply 都判过参数），这一下是兜底：
    // 链一旦 reject，后面所有 op 都跟着死在上面，且症状是「链路看着好好的，什么都不写了」。
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async exec(op: OpRequest): Promise<ApplyResult> {
    this.waiting--;
    this.running = true;
    let result: ApplyResult;
    try {
      result = await this.dispatch(op);
    } catch (err) {
      // 落库失败（配额满 / 库被关掉）是真会发生的，记一条 warn 就够：不升到链路状态，
      // 单条 op 的失败不是链路事件（沿用 host.ts 的同一判断）。
      console.warn('[live-ops] op 应用失败：', op.name, err);
      result = { ok: false, reason: 'internal' };
    } finally {
      this.running = false;
    }
    try {
      this.onAck?.(op.clientOpId, result);
    } catch (err) {
      // ack 是发帧，发不出去不该反过来卡住队列 —— 否则一次 socket 抖动会让队列越堵越长
      console.warn('[live-ops] ack 回调失败：', err);
    }
    return result;
  }

  /**
   * 派发到 apply。参数在这里做**形状**上的强转（String/Number），语义校验留给 apply：
   * apply 同时服务于本机调用方（Player、卡片面板），把校验放在里面才不必依赖「每个
   * 调用方都记得消毒」。switch 的是字符串而不是 op.name（类型上已穷尽），是为了让
   * default 分支在类型上可达 —— 未知 op 名来自旧版/新版来宾的帧，是真的会来的。
   */
  private async dispatch(op: OpRequest): Promise<ApplyResult> {
    const a = (op.args ?? {}) as Record<string, unknown>;
    const name = String(op.name);
    switch (name) {
      case 'position.set':
        // finished 收 1/0 与 true/false 两种写法：DB 口径是 1|0，帧里用哪个都不该由 host 挑
        return applyPosition(String(a.videoId ?? ''), Number(a.position), a.finished === true || a.finished === 1);
      case 'study.add':
        return applyStudyAdd(
          String(a.date ?? ''),
          Number(a.seconds),
          op.clientOpId,
          this.deps.dedup ?? (this.dedupFallback ??= createLruDedup()),
        );
      case 'card.decide':
        return applyCardDecide(String(a.videoId ?? ''), Number(a.cardId), Number(a.status) as 0 | 1 | 2);
      case 'chat.stop': {
        const turnId = String(a.turnId ?? '');
        return applyChatStop(turnId, this.deps.turnAbort?.(turnId));
      }
      default:
        return { ok: false, reason: 'unknown-op' };
    }
  }
}