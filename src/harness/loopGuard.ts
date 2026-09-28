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
