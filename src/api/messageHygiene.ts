/**
 * 消息卫生：发请求前的**唯一收口点**（对齐 pi-mono 的 `packages/ai/src/api/transform-messages.ts`）。
 *
 * ## 为什么要一个收口点
 *
 * OpenAI 兼容协议对历史有两条硬约束，而本仓库的 `out`（agent 循环的消息列表）**天然会违反**它们：
 *
 * | 约束 | 网关的原话 | 本仓库怎么违反的 |
 * |---|---|---|
 * | assistant 必须有正文或 tool_calls | `Invalid assistant message: content or tool_calls must be set` | 模型只吐思考、正文空、也没调工具时（`chatStream` 给出 `content: null`），这条消息仍留在 `out` 里 |
 * | tool_calls 必须有人应答 | `An assistant message with 'tool_calls' must be followed by tool messages…` | 循环检测 / 轮次闸在**执行之前**停下，那批 tool_calls 就没有配对的 tool 消息 |
 *
 * 两条都只在**下一次请求**才暴露，而那时用户已经等了好几轮 —— 报出来的是一个和界面上
 * 现象毫无关系的 400。pi 的做法是把这层放在请求边界（`transformMessages`）而**不是**
 * 禁止脏历史产生，它的注释写得很直白：手搓的历史、旧 session 文件、自定义工具返回 null，
 * **都会**破坏类型契约，所以收口点必须「刻意宽松」（intentionally lax）。
 *
 * 本仓库同理，所以**刻意不在落库处堵**：题卡 / 提问卡那条消息正文本来就该是空的
 * （正文空，UI 才只渲染卡片），落库时补一句占位文案只会污染模型看到的对话。
 * 脏历史允许留在库里，请求边界再洗干净 —— 这就是 pi 的分工。
 *
 * ## 与 pi 的两处**有意**不同
 *
 * 1. **空 assistant 是「丢弃」而不是「归一化成空数组」**。pi 的归一化产出 `content: []`，
 *    OpenAI / Anthropic 都接受；硅基流动这类严格 OpenAI 兼容网关直接 400（本 bug 的现场）。
 *    归一化成 `''` 也一样会被拒 —— 唯一能过的是「这条消息根本不存在」。
 * 2. **判据用 `finish_reason`**：pi 内部叫 `stopReason`，那是同一个东西的线格式名字。
 *    语义照抄：`error` / `aborted` 的轮次不重放，`length` 的 tool_calls 一律判失败。
 *
 * ## 不变量（`messageDefects` 就是这两条，`assertRequestSafe` 拿它当断言）
 *
 * 1. 每条 `assistant` 要么有非空正文，要么有 `tool_calls`；
 * 2. 每条 `assistant.tool_calls[].id` 都有配对的 `tool` 消息，反之亦然。
 *
 * 纯模块（只有 type import），所以 Node 能直接单测 —— 与 `loopGuard.ts` 同一路理由。
 */

import type { ChatMessage } from './siliconflow';

/** 正文是否「空」：null / 纯空白 / 数组里没有非空 text 段（图片不算正文） */
function isBlank(content: ChatMessage['content']): boolean {
  if (content == null) return true;
  if (typeof content === 'string') return content.trim() === '';
  for (const part of content) {
    if (part.type === 'text' && part.text.trim() !== '') return false;
  }
  return true;
}

/** 这一轮的输出是否**不完整到不能重放**（pi：`stopReason === 'error' | 'aborted'`） */
export function isUnreplayable(finishReason?: string | null): boolean {
  return finishReason === 'error' || finishReason === 'aborted';
}

/**
 * 孤儿 tool_call 的合成结果正文（pi 的 `"No result provided"` 的中文版）。
 *
 * 多写一句「不要再调用它」是故意的：这些调用是因为**我们**的护栏停下才没执行的，
 * 不告诉模型的话它会换个说法再调一遍 —— 那正是循环检测要拦的东西。
 */
export function syntheticToolResult(name: string): string {
  return `工具「${name}」没有执行：这次检索在到达条件前就被停止了，没有返回结果。` +
    `请不要再调用它，直接根据已经拿到的信息回答。`;
}

/** 列出生效不了的所有缺陷（空数组 = 可以发）。给测试与排障用，措辞面向开发者。 */
export function messageDefects(messages: readonly ChatMessage[]): string[] {
  const defects: string[] = [];
  const calls = messages.flatMap((m) => (m.role === 'assistant' ? (m.tool_calls ?? []) : []));
  const declared = new Set(calls.map((c) => c?.id).filter((id): id is string => Boolean(id)));
  const answered = new Set(
    messages
      .filter((m) => m.role === 'tool')
      .map((m) => m.tool_call_id)
      .filter((id): id is string => Boolean(id)),
  );

  messages.forEach((m, i) => {
    if (m.role === 'assistant') {
      if (!m.tool_calls?.length && isBlank(m.content)) {
        defects.push(`#${i} assistant 既没有正文也没有 tool_calls`);
      }
      for (const c of m.tool_calls ?? []) {
        if (!c?.id) defects.push(`#${i} tool_call 缺 id（永远无法被应答）`);
        else if (!answered.has(c.id)) defects.push(`#${i} tool_call ${c.id}（${c.function?.name}）没有配对的 tool 消息`);
      }
      return;
    }
    if (m.role !== 'tool') return;
    if (!m.tool_call_id) defects.push(`#${i} tool 消息缺 tool_call_id`);
    else if (!declared.has(m.tool_call_id)) defects.push(`#${i} tool 消息的 tool_call_id=${m.tool_call_id} 没有对应的调用`);
  });
  return defects;
}

/** 不变量断言：`sanitizeMessages` 的输出永远过这一关；脏历史直接抛错（pi 的 `throw new Error`） */
export function assertRequestSafe(messages: readonly ChatMessage[]): void {
  const defects = messageDefects(messages);
  if (defects.length > 0) {
    throw new Error(`消息历史不合法（${defects.length} 处）：\n${defects.map((d) => `  - ${d}`).join('\n')}`);
  }
}

/** 一条消息的紧凑形状（排障用）：`#3 assistant · 正文 0 字 · 工具调用 2 个` */
export function describeMessage(msg: ChatMessage, index: number): string {
  if (msg.role === 'assistant') {
    const chars = textLength(msg.content);
    const calls = msg.tool_calls?.length ?? 0;
    return `#${index} assistant · 正文 ${chars} 字 · 工具调用 ${calls} 个${calls > 0 ? `（${(msg.tool_calls ?? []).map((c) => c.function?.name ?? '?').join('、')}）` : ''}`;
  }
  if (msg.role === 'tool') return `#${index} tool · 应答 ${msg.name ?? msg.tool_call_id ?? '?'}`;
  return `#${index} ${msg.role} · ${textLength(msg.content)} 字`;
}

/** 正文长度（数组形态只算 text 段；与 `isBlank` 同一套口径） */
export function textLength(content: ChatMessage['content']): number {
  if (content == null) return 0;
  if (typeof content === 'string') return content.trim().length;
  let n = 0;
  for (const part of content) if (part.type === 'text') n += part.text.trim().length;
  return n;
}

/**
 * 洗干净一份历史，返回**可发送**的副本（不改入参）。
 *
 * 幂等：`sanitizeMessages(sanitizeMessages(x))` 与 `sanitizeMessages(x)` 逐字相同
 * —— 第二遍补不出任何东西（该补的第一遍补完了），所以收口点可以每轮都调。
 */
export function sanitizeMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  // ── 第一遍：归一化 + 丢弃 ────────────────────────────────────────────────
  const kept: (ChatMessage | null)[] = [];
  /** 全历史**活下来**的 tool_call id：用来判「孤儿 tool 结果」 */
  const declared = new Set<string>();
  /**
   * tool 消息延后判定：它是不是孤儿，取决于声明它的那条 assistant 留没留下，
   * 而那个判断此刻还没做完（残缺轮次会被整条丢掉，它的调用声明随之作废）。
   * 用**占位**而不是先收起来 —— tool 必须紧跟它的 assistant，挪位置等于改变对话语义。
   */
  const toolSlots: number[] = [];

  for (const msg of messages) {
    if (msg.role === 'tool') {
      toolSlots.push(kept.length);
      kept.push(msg);
      continue;
    }
    if (msg.role === 'assistant') {
      // 残缺轮次不重放：可能带着「有 reasoning 没有正文」的半截状态，回放会触发 API 报错（pi 同款理由）
      if (isUnreplayable(msg.finish_reason)) continue;
      // 没有 id 的 tool_call 永远无法被应答，它和它的结果都留不得
      const calls = (msg.tool_calls ?? []).filter((c) => Boolean(c?.id));
      for (const c of calls) declared.add(c.id);
      const blank = isBlank(msg.content);
      // 空正文 + 有 tool_calls 是合法形态（模型纯调工具的常态），content 收敛成 null；
      // 空正文 + 没有 tool_calls 则是那个 400 的直接来源，只能靠「这条消息不存在」来过。
      if (blank && calls.length === 0) continue;
      // **只动需要动的字段**：重建出来的对象哪怕只多一个 `tool_calls: undefined` 键，
      // 也让「干净历史过一遍逐字不变」这条性质失效 —— 而它是最便宜的回归信号。
      const patch: Partial<ChatMessage> = {};
      if (blank) patch.content = null;
      if (calls.length !== (msg.tool_calls?.length ?? 0)) patch.tool_calls = calls.length ? calls : undefined;
      kept.push(Object.keys(patch).length > 0 ? { ...msg, ...patch } : msg);
      continue;
    }
    // system / user：空消息没有语义，且部分网关会拒
    if (!isBlank(msg.content)) kept.push(msg);
  }

  for (const i of toolSlots) {
    const slot = kept[i];
    if (!slot) continue;
    // 孤儿结果（声明它的 assistant 已被丢弃）留不得：模型会看到一段查无此事的记录
    if (!slot.tool_call_id || !declared.has(slot.tool_call_id)) kept[i] = null;
    // 模型要能分辨「工具什么都没给」和「工具没跑」，所以补一句可见的话而不是留空
    else if (isBlank(slot.content)) kept[i] = { ...slot, content: '（工具没有返回内容）' };
  }
  const normalized = kept.filter((m): m is ChatMessage => m !== null);

  // ── 第二遍：给孤儿 tool_call 补合成结果（pi 的 closePendingToolCalls）──────
  //
  // 补结果而不是丢掉那条 assistant：丢掉它模型就不知道自己「本来想调什么」，
  // 下一轮大概率换个说法再调一遍 —— 补一条失败结果它才知道这条路走不通。
  const out: ChatMessage[] = [];
  /** 上一条 assistant 要调、还没人应答的调用 */
  let pending: NonNullable<ChatMessage['tool_calls']> = [];
  let answered = new Set<string>();
  /** 夹在「调用」与「结果」之间的 system 消息：对 tool-call 记账透明，先扣下等结果补齐 */
  const heldSystem: ChatMessage[] = [];
  const closePending = () => {
    for (const call of pending) {
      if (answered.has(call.id)) continue;
      out.push({
        role: 'tool',
        tool_call_id: call.id,
        name: call.function?.name ?? 'unknown',
        content: syntheticToolResult(call.function?.name ?? 'unknown'),
      });
    }
    pending = [];
    answered = new Set();
    out.push(...heldSystem.splice(0));
  };

  for (const msg of normalized) {
    if (msg.role === 'assistant') {
      closePending(); // 下一个 assistant 打断了上一批调用 → 先给它们收尾
      const calls = msg.tool_calls ?? [];
      if (calls.length > 0) {
        pending = calls;
        answered = new Set();
      }
      out.push(msg);
    } else if (msg.role === 'tool') {
      if (msg.tool_call_id) answered.add(msg.tool_call_id);
      out.push(msg);
    } else if (msg.role === 'system' && pending.length > 0) {
      heldSystem.push(msg);
    } else {
      closePending(); // user 消息打断工具流（pi 同款）：先补齐悬空调用，再放行
      out.push(msg);
    }
  }
  closePending(); // 序列末尾的悬空调用：最常见的一种（护栏在执行前停下）
  return out;
}
