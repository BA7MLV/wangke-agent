/**
 * agent 编辑工具的**纯逻辑**一半：把 agent 提出的 { old_string, new_string }
 * 变成具体改哪几个坐标。不碰 CodeMirror、不碰 DOM。
 *
 * ── 为什么用精确字符串匹配，不用行号 ─────────────────────────────────────────
 * 行号对模型极易过期：它看到的是**上一次检索时**的文档，而这份文档可能刚被用户
 * 或前一次工具调用改过。行号不会「过期后报错」，只会静默地写到错的位置上 ——
 * 那等于让模型改坏用户的笔记。`old_string` 自带定位信息：过期时会**明确匹配失败**，
 * 失败比写坏强。设计文档的核心取舍。
 *
 * ── 失败诊断是这个模块的主要产出 ─────────────────────────────────────────────
 * 报错是回给模型的。一句含糊的「未找到」会让它换个说法、把同样的调用再试一遍，
 * 白烧一整轮工具调用。所以每条失败都带三样东西：**第几条 edit**（点名到 index）、
 * **命中了几处 / 各自的区间**（事实）、**下一步该怎么改**（出路）。
 * 下面的 test 直接断言文案内容，不只是 `ok === false`。
 *
 * ── 坐标两套，别混用 ─────────────────────────────────────────────────────────
 * - `changes` 基于**调用时**的文档（= 编辑器现在的状态），接进去直接 dispatch；
 * - `highlights` 基于**改动后**的新文档，因为它是拿新文档去画装饰。
 * 前一条编辑多插入 N 个字符，后面那些编辑的位置就整体后移 N —— 直接拿旧坐标画，
 * 绿高亮会落在无关的字上，而且这种错在屏幕上只表现为「偏了几格」，极难归因。
 *
 * ── 纯删除为什么要留一条**零宽**高亮 ─────────────────────────────────────────
 * 纯删除没有 new_string 可高亮（画出来什么都没有），但它**仍然必须能被撤销**，
 * 撤销靠的正是 `highlights[].removed`。于是纯删除产出一条 `{from: 插入点, to: 插入点,
 * removed: 被删的原文}`：区间为空，内容挂在 removed 上。这是本模块唯一一处
 * 「区间为空却仍有内容要还原」的形状，撤销端不能因此跳过它。
 */

export interface AgentEdit {
  old_string: string;
  new_string: string;
  /** 同一段出现多次时是否全部替换；默认 false（要求唯一命中） */
  replace_all?: boolean;
}

/** 改动区间，坐标基于**调用时的文档** */
export interface EditChange { from: number; to: number; insert: string }

/** 高亮区间，坐标基于**改动后的新文档** */
export interface AgentHighlight { from: number; to: number; removed: string }

export type PlanResult =
  | { ok: true; changes: EditChange[]; highlights: AgentHighlight[] }
  | { ok: false; error: string };

/** 报错里回显 old_string 时的长度上限。整段几百字塞进报错只会挤占上下文，不解决定位问题 */
const QUOTE_MAX = 120;

/**
 * 报错里描述一个值的样子：`number（123）`。
 *
 * 把**值本身**也带出来而不只是类型名：模型传 `old_string: 123` 时，
 * 只说「类型不对」它多半会原样再传一次。
 * 「缺失」那句话由调用方自己补 —— 在这里塞进去的话，外层会出现
 * 「不是数组（实际拿到 undefined（字段没传））」这种套娃。
 */
function describeValue(v: unknown): string {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (typeof v === 'string') return `string（${JSON.stringify(v.length > 40 ? v.slice(0, 40) + '…' : v)}）`;
  if (typeof v === 'number' || typeof v === 'boolean') return `${typeof v}（${String(v)}）`;
  return typeof v;
}

/** 回显一段原文用于报错，超长截断 */
function quote(s: string): string {
  return `「${s.length > QUOTE_MAX ? s.slice(0, QUOTE_MAX) + '…' : s}」`;
}

const fail = (error: string): PlanResult => ({ ok: false, error });

/**
 * 数 `needle` 在 `hay` 里**不重叠**出现的次数，返回每次的起点。
 *
 * 不重叠推进（而不是 `index + 1`）是刻意的：重叠计数会在 `old_string: 'aa'`
 * 对上 `'aaa'` 时报「2 处命中」，但 replace_all 实际只能改其中 1 处 ——
 * 报的数和会改的数对不上，比报错本身更误导。
 *
 * 代价是「`aa` 在 `aaa` 里唯一」会被当作唯一命中并改掉第一处。这不丢信息：
 * 该位置后面那一个 `a` 仍在文档里，模型下一轮就能看到。
 */
function occurrences(hay: string, needle: string): number[] {
  const hits: number[] = [];
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) {
    hits.push(i);
  }
  return hits;
}

/** 区间给人看的写法，直接拼进报错 */
const span = (c: EditChange) => `[${c.from},${c.to})`;

/** 一次命中解出来的改动：区间 + 它来自第几条 edit（报错要能点名是哪两条撞上了） */
interface Resolved { change: EditChange; editIndex: number }

export function planAgentEdits(doc: string, edits: AgentEdit[]): PlanResult {
  if (typeof doc !== 'string') return fail(`文档内容不是字符串（实际拿到 ${describeValue(doc)}），无法定位改动。`);
  if (!Array.isArray(edits)) {
    return fail(
      `没有可执行的改动：edits 不是数组（实际拿到 ${describeValue(edits)}）。\n` +
      `要修改文档，请传至少一条 { "old_string": "原文", "new_string": "改后的文字" }。`,
    );
  }
  if (edits.length === 0) {
    return fail(
      `没有可执行的改动：edits 是空数组。\n` +
      `要修改文档，请传至少一条 { "old_string": "原文", "new_string": "改后的文字" }；` +
      `不需要改动就不要调用这个工具。`,
    );
  }

  const resolved: Resolved[] = [];
  // 按**调用顺序**逐条解：先撞到的那条最可能是模型真正搞错的那条，
  // 报它比报后面那条更有用。一次只报一个错 —— 一次甩十条会让模型不知道先改哪个。
  for (let i = 0; i < edits.length; i++) {
    const n = i + 1;
    const edit: unknown = edits[i];

    if (typeof edit !== 'object' || edit === null || Array.isArray(edit)) {
      return fail(
        `第 ${n} 条 edit 无法解析：它不是对象（实际拿到 ${describeValue(edit)}）。\n` +
        `每条 edit 必须是一个对象：{ "old_string": "原文", "new_string": "改后的文字", "replace_all": false }\n` +
        `注意 new_string 传空字符串 "" 表示删除这段，别用 null 或省略代替。`,
      );
    }

    const { old_string: oldRaw, new_string: newRaw, replace_all: allRaw } = edit as Record<string, unknown>;
    // 两个字段**都**要报出来。只报第一个的话，模型修好 old_string 再调一次，
    // 撞上 new_string 的同一个错，白烧一轮 —— 而它俩经常是一起漏的。
    const problems: string[] = [];
    if (oldRaw === undefined) problems.push(`- old_string：缺失，必须是字符串`);
    else if (typeof oldRaw !== 'string') problems.push(`- old_string：必须是字符串，实际拿到 ${describeValue(oldRaw)}`);
    if (newRaw === undefined) problems.push(`- new_string：缺失，必须是字符串（要删除这段就传空字符串 ""）`);
    else if (typeof newRaw !== 'string') problems.push(`- new_string：必须是字符串，实际拿到 ${describeValue(newRaw)}`);
    if (problems.length > 0) {
      return fail(
        `第 ${n} 条 edit 的字段不合法：\n${problems.join('\n')}\n` +
        `请只传字符串，不要传数字/布尔/null，也不要省略字段；new_string 传 "" 表示删除 old_string。`,
      );
    }

    const old = oldRaw as string;
    const next = newRaw as string;

    // 空串必须挡在匹配之前：`''.indexOf` 会命中 0，`indexOf` 空串返回 0，
    // 循环推进 `i + 0` 会死循环，而更糟的是「碰巧成功」时把整篇文档替换掉。
    if (old.length === 0) {
      return fail(
        `第 ${n} 条 edit 的 old_string 是空字符串，无法使用。\n` +
        `空串在文档的**每一个位置**都算命中，照此执行会把整篇文档删光。\n` +
        `请改成一段能在当前文档里找到的原文，并带上前后几个字保证它唯一。`,
      );
    }

    // replace_all 只认布尔真值，不做真值转换：模型传字符串 "false" 时，
    // 若按真值处理就会**全部替换** —— 那是不可逆的意外破坏。
    // 忽略掉它、退化成「要求唯一命中」，最坏是多报一次错让模型重来，代价小得多。
    const replaceAll = allRaw === true;

    const hits = occurrences(doc, old);
    if (hits.length === 0) {
      return fail(
        `第 ${n} 条 edit 未命中：old_string ${quote(old)} 在当前文档里找不到（文档共 ${doc.length} 字）。\n` +
        `可能的原因：文档在你上次读取之后已经变了；或 old_string 与原文有出入（空格、换行、全半角、标点）。\n` +
        `请重新读一遍文档的相关部分，用从原文里逐字复制的片段作为 old_string 再试一次。`,
      );
    }
    if (hits.length > 1 && !replaceAll) {
      return fail(
        `第 ${n} 条 edit 命中了 ${hits.length} 处，无法确定要改哪一处 —— 没有 replace_all 时只接受唯一命中，` +
        `不会替你挑第一个（挑错了就是在改用户没让你碰的地方）。\n` +
        `两条出路（选一条）：\n` +
        `1) 补充上下文：把这一处特有的相邻文字或整行一起写进 old_string，让它在文档里唯一；\n` +
        `2) 确实想全部替换：加上 "replace_all": true（将改动这 ${hits.length} 处）。\n` +
        `old_string：${quote(old)}`,
      );
    }

    for (const from of hits) {
      resolved.push({ change: { from, to: from + old.length, insert: next }, editIndex: i });
    }
  }

  // 排序必须在重叠判定**之前**：模型给的两条 edit 可能命中同一段，
  // 这时后一条的 from 落在前一条的 to 之内，不排序根本看不出来。
  // 排好序顺带也是接线的契约：CM6 的多区间 dispatch 要求严格升序。
  resolved.sort((a, b) => a.change.from - b.change.from || a.change.to - b.change.to);

  for (let i = 1; i < resolved.length; i++) {
    const prev = resolved[i - 1];
    const cur = resolved[i];
    // 半开区间：首尾相接（prev.to === cur.from）是合法的两次改动，不算重叠
    if (cur.change.from < prev.change.to) {
      return fail(
        `第 ${prev.editIndex + 1} 条与第 ${cur.editIndex + 1} 条 edit 的替换区间重叠` +
        `（第 ${prev.editIndex + 1} 条 ${span(prev.change)}，第 ${cur.editIndex + 1} 条 ${span(cur.change)}），无法同时应用。\n` +
        `同一次调用里的改动区间必须互不重叠。\n` +
        `请把它们合并成一条 edit、去掉其中一条，或调整 old_string 让两个区间不再相交。`,
      );
    }
  }

  const changes = resolved.map((r) => r.change);
  const highlights: AgentHighlight[] = [];
  // shift 累计前面所有改动带来的净长度变化。纯删除是负数（后面的坐标往前收），
  // 插入是正数。insert 为空时 to === from，高亮自然退化成零宽，
  // 但 removed 仍带着原文，撤销端照样能把它插回去。
  let shift = 0;
  for (const { change } of resolved) {
    const from = change.from + shift;
    highlights.push({ from, to: from + change.insert.length, removed: doc.slice(change.from, change.to) });
    shift += change.insert.length - (change.to - change.from);
  }

  return { ok: true, changes, highlights };
}