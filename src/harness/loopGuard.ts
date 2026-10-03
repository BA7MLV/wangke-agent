/**
 * agent 循环的「护栏」：什么时候停、以及怎么认出它在原地打转。
 *
 * 纯模块（零 import），所以 Node 可以直接单测 —— `agent.ts` 本身带运行时依赖
 * （api / store），进不了 `node scripts/test-*.mjs` 那条路。**所以策略常量也放这里**，
 * 否则「轮次档位翻译」这类纯逻辑会被困在不可测的文件里。
 */

/** 设置里「不限制」用的哨兵值（`agentRounds = 0`）。用 0 而不加布尔字段：两个字段迟早漂移 */
export const UNLIMITED_ROUNDS = 0;

/** 把设置里的档位翻译成 `runAgentLoop` 的 maxRounds。负数也当「不限」：手改成 -1 时不该变成 0 轮死循环 */
export function resolveMaxRounds(agentRounds: number): number {
  return agentRounds > 0 ? agentRounds : Infinity;
}

/** 输出上限未知时的假定值（与 modelMeta 拉取元数据时的缺省一致，别让两处漂移） */
const ASSUMED_OUTPUT_LIMIT = 8192;

/**
 * 给输入与系统开销留的缓冲（tokens）。官方明确建议 reserve ~10k。
 *
 * 导出是因为 `agent.ts` 的 token 闸也要留同样的余量 —— 两处各写一个数，
 * 漂移一次的表现是「工具结果刚好堆到窗口边缘，回答被挤成一句话」。
 */
export const CONTEXT_BUFFER = 10_000;

/** 再窄也要留的额度：0 会被服务端当成「不限制」，负数直接报错 */
const MIN_OUTPUT_TOKENS = 256;

/**
 * 每轮的 `max_tokens`：**给到模型自己的输出上限**。
 *
 * `max_tokens` 是**天花板不是预留** —— 按实际输出计费，给足不花钱，却能根除截断。
 * 截断的代价是实打实的：`show_widget` 的 html 形态能到 6 万字符（约 42k token），
 * 额度不够就停在半个标签上，界面上是一坨源码（实测停在 `#44`）。
 *
 * 所以只受两条真实约束：
 *   - **模型输出上限** `outputLimit`：超了网关直接拒（DeepSeek-V4-Pro 是 384k，
 *     多数模型 65k~262k，见 models.dev）
 *   - **窗口剩余** `contextWindow − 当前输入 − 缓冲`：官方明确要求 reserve ~10k，
 *     `输入 + max_tokens > 窗口` 会截断
 *
 * ⚠️ `outputLimit` 与 `contextWindow` **不是一回事**：后者是输入+输出的总容量，
 * 前者只管输出那一半。所以也**不能**直接取窗口 —— 那正是官方说要留缓冲的原因。
 *
 * **每轮都要重算**：`out` 只增不减（工具结果一路堆进来），输入变大则余量变小。
 * 窗口未知（`contextWindow` / `inputTokens` 传 null）时只按模型上限 clamp，
 * 不去算一个可能是错的剩余量。
 */
export function roundMaxTokens(
  outputLimit?: number | null,
  contextWindow?: number | null,
  inputTokens?: number | null,
): number {
  const cap = outputLimit && outputLimit > 0 ? outputLimit : ASSUMED_OUTPUT_LIMIT;
  let room = Infinity;
  if (contextWindow != null && contextWindow > 0 && inputTokens != null && inputTokens >= 0) {
    room = contextWindow - inputTokens - CONTEXT_BUFFER;
  }
  // 取**小者**，不是大者：余量小于上限时说明输入已经吃掉窗口大半，此时给满上限会
  // 让 `输入 + max_tokens > 窗口`，服务端直接截断（官方明确要求 reserve buffer）。
  // 常态下上限才是那个小者（384k 上限 vs 1M 窗口），所以「按最高来」= 给到 `cap`。
  return Math.max(MIN_OUTPUT_TOKENS, Math.min(cap, room));
}

/**
 * token 闸要给输出留多少（`agent.ts` 累积工具结果时用）。
 *
 * **必须是 `缓冲 + 想要的输出`**，而不是单看输出：`roundMaxTokens` 算剩余时又扣了一次
 * `CONTEXT_BUFFER`，闸这里只留 `输出` 的话，实际能用的只剩 `输出 − 缓冲`。
 * 小窗口上这会归零（32k 窗口：留 10k、再扣 10k → 只剩最小额度），回答被我们自己挤没。
 *
 * 输出部分取窗口的 1/4：够放一个 html 图形卡（约 42k token）的一半以上，
 * 又不会把检索空间吃掉太多。
 */
export function answerReserve(contextWindow?: number | null): number {
  const win = contextWindow != null && contextWindow > 0 ? contextWindow : 131072;
  return CONTEXT_BUFFER + Math.round(win / 4);
}

/** 调用指纹：工具名 + **规范化**后的参数 */
export function callKey(name: string, argsJson: string): string {
  let normalized = argsJson;
  try {
    const args = JSON.parse(argsJson || '{}') as Record<string, unknown>;
    // 键排序：模型两次调用 `{a,b}` 与 `{b,a}` 是同一件事，不该被判成「在换花样重试」
    normalized = JSON.stringify(args, Object.keys(args).sort());
  } catch {
    // 参数不是合法 JSON：原样存（这类调用本身就该被记成指纹的一部分）
  }
  return `${name}:${normalized}`;
}

/**
 * 指纹集合：判断「这个调用这一轮里是不是已经做过」。
 *
 * 只判**完全相同**的调用是刻意的：同一工具换参数是正常的多轮检索（`search_material` 换关键词
 * 是有意为之），只有「同样的工具、一样的参数」才是原地打转的信号 —— 那时再查一遍拿到的
 * 结果必然一模一样，循环不会自己结束。
 */
export class CallLedger {
  private readonly seen = new Set<string>();

  /** 记一次调用；返回 true = 这一轮里已经做过一模一样的调用 */
  record(name: string, argsJson: string): boolean {
    const key = callKey(name, argsJson);
    if (this.seen.has(key)) return true;
    this.seen.add(key);
    return false;
  }
}
