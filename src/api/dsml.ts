/**
 * DeepSeek DSML 泄漏的客户端兜底还原。
 *
 * ## 问题是什么
 *
 * DeepSeek V4 系把工具调用写成 DSML 标记：
 *
 * ```
 * <｜DSML｜tool_calls>
 * <｜DSML｜invoke name="read_skill_reference">
 * <｜DSML｜parameter name="path" string="true">references/diagram.md</｜DSML｜parameter>
 * </｜DSML｜invoke>
 * </｜DSML｜tool_calls>
 * ```
 *
 * 由**服务端**翻译成 OpenAI 的 `tool_calls` 再返回。翻译没发生时（网关的解析器
 * 在长上下文或 auto+stream 下漏判），整段标记就作为纯文本落进 `content`。
 *
 * 对本仓库的后果有两层，缺一不可：
 *
 * 1. 标记被原样显示 —— `chatStream` 把每个 `delta.content` 直接喂进气泡；
 * 2. **工具调用被静默丢弃** —— `tool_calls` 只从 `delta.tool_calls` 拼，于是
 *    `agent.ts` 那条「有正文 = 模型答完了，正常收工」的分支成立，循环直接结束。
 *
 * 第 2 层比第 1 层严重：界面上的脏字符只是难看，agent 以为自己想清楚了才是真的坏。
 * 这也是为什么这里要做**还原**而不是**过滤**。
 *
 * ## 为什么只认 `invoke`，不认外层 wrapper
 *
 * 常见做法是枚举 `<…DSML…tool_calls>` 这类外层标签再配对收尾。实测这个名单
 * 不完整：模型会用 `tool_calls` / `tool_call` / `function_calls` / `calls` /
 * `toolcalls` / `tool` 等多种 kind，V4.1 还改成了带空格的方言
 * （`<｜DSML｜ calls>`，见 vLLM 的 `deepseek_v41.py`）。OpenClaw 就因为名单漏了
 * `calls` 而至今挂着一个 P1（openclaw#159665）。
 *
 * 所以这里**不认外层 wrapper**，只认 `invoke` —— 无论它被什么包着、外面那层是
 * 哪个 kind、甚至外面那层根本没有（vLLM #48931 报的就是模型漏掉 START token），
 * 都能还原。外层与其余结构标签一律静默吞掉。
 *
 * ## 代价与它的边界
 *
 * 还原是「按 `<MARKER invoke` 触发」的，理论上正文里字面出现这串标记会被吞掉。
 * 因此**只在真的声明了 tools 时才装这个还原器**（见 siliconflow.ts）—— 没给工具时
 * 模型没有理由吐 DSML，那时的尖括号更可能是正文（比如讲义里的 HTML 片段）。
 */

/**
 * 观察到的四种竖线写法：半角单/双、全角单/双。
 *
 * 单横线是 DeepSeek 官方与 vLLM 的写法；双横线是第三方网关实际吐出过的形态
 * （本项目在硅基流动上撞到的就是全角双横线 + 带空格方言）。
 */
const MARKERS = ['|DSML|', '||DSML||', '｜DSML｜', '｜｜DSML｜｜'] as const;

/**
 * 单个标签的合理长度上限。
 *
 * `invoke` / `parameter` 的属性只有 name 与 string，几百字符绰绰有余。
 * 这个上限是**性能护栏**：没有它，「流里出现一个没有 `>` 的 `<`」会让每个 chunk
 * 都重扫整个缓冲区，正文里一段没闭合的 HTML 能把流式解析拖成 O(n²)。
 */
const MAX_TAG_LEN = 256;

/** 单次 invoke 的合理上限：show_widget 的 html 实测能到 6 万字符，留足余量。 */
const MAX_INVOKE_LEN = 4 * 1024 * 1024;

/** 已还原出的一次工具调用（`function.arguments` 是 JSON 字符串，与 OpenAI 同形） */
export interface DsmlToolCall {
  name: string;
  arguments: string;
}

export type DsmlPart = { kind: 'text'; text: string } | ({ kind: 'toolCall' } & DsmlToolCall);

/** 一个已解析的 DSML 标签 */
interface DsmlTag {
  marker: string;
  /** V4.1 在 marker 与 kind 之间插一个空格；开闭标签必须一致，否则不算配对 */
  spaced: boolean;
  kind: string;
  attrs: string;
  /** 是否闭标签（`</…>`） */
  isClose: boolean;
  /** 整个标签（含首尾尖括号）的长度 */
  length: number;
}

/** `null` = 确定不是 DSML 标签；`'incomplete'` = 还要等下一个 chunk */
type TagRead = DsmlTag | 'incomplete' | null;

/**
 * 从 `start`（必须指向 `<`）读一个 DSML 标签。
 *
 * 认不出来的普通 `<` 返回 `null`，由调用方当正文处理 —— 这是「宁可漏也不吞正文」。
 */
function readDsmlTag(text: string, start: number): TagRead {
  if (text[start] !== '<') return null;
  const isClose = text[start + 1] === '/';
  const bodyStart = start + (isClose ? 2 : 1);
  // 只在有界范围里找闭合尖括号：超长的不是标签（正文里的 HTML），也不是「被切断」
  const head = text.slice(bodyStart, bodyStart + MAX_TAG_LEN);

  let marker: string | undefined;
  for (const m of MARKERS) {
    if (head.startsWith(m)) {
      marker = m;
      break;
    }
  }
  if (marker === undefined) {
    // 标记本身可能被 SSE 切在两个 chunk 之间（`<`、`<｜`、`<｜DSML` …）。
    // 是某标记的真前缀才等下一块，否则就是普通正文里的尖括号。
    return MARKERS.some((m) => m.startsWith(head)) ? 'incomplete' : null;
  }

  let p = bodyStart + marker.length;
  let spaced = false;
  if (text[p] === ' ') {
    spaced = true;
    p++;
  }
  const gt = text.indexOf('>', p);
  if (gt === -1) return text.length - p < MAX_TAG_LEN ? 'incomplete' : null;
  if (gt - p > MAX_TAG_LEN) return null;

  const tail = text.slice(p, gt);
  if (tail.includes('<')) return null;
  const gap = tail.search(/\s/);
  const kind = gap === -1 ? tail : tail.slice(0, gap);
  // `<｜DSML｜>` 这种后面没跟 kind 的，不归我们管，交给上层当正文
  if (!kind) return null;
  return { marker, spaced, kind, attrs: gap === -1 ? '' : tail.slice(gap + 1), isClose, length: gt + 1 - start };
}

/** 取 `name="x"` / `string='x'` / `string=x` 三种写法里的值 */
function attr(attrs: string, key: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`).exec(attrs);
  const v = m?.[1] ?? m?.[2] ?? m?.[3];
  return v === undefined ? undefined : decodeEntities(v);
}

/** 标签里 & 开头的那几个实体。`&amp;` 必须最后换，否则 `&amp;lt;` 会被换两次 */
function decodeEntities(v: string): string {
  return v
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * 参数值的类型还原，与 DeepSeek 自己的 encoder 以及 vLLM 的
 * `_dsml_arg_converter` 一致：`string="true"` 是裸文本，其余按 JSON 解析、
 * 解析不了就当文本（模型偶尔会漏掉 `string` 属性）。
 */
function paramValue(raw: string, attrs: string): unknown {
  if (attr(attrs, 'string') === 'true') return decodeEntities(raw);
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return decodeEntities(raw);
  }
}

/** 正在收集中的 invoke */
interface PendingCall {
  marker: string;
  spaced: boolean;
  name: string;
  args: Record<string, unknown>;
}

/**
 * 增量 DSML 还原器。
 *
 * 用法与流式解析配套：`push` 每个 `delta.content`，`flush` 在流结束时调一次。
 * 输出的 `text` 才能拿去显示 —— 直接把原始 delta 显示出去就是那个 bug。
 */
export function createDsmlRecoverer(): {
  push: (chunk: string) => DsmlPart[];
  flush: () => DsmlPart[];
} {
  let buf = '';
  /** 不在 invoke 里时为 null */
  let call: PendingCall | null = null;
  /**
   * 体积超限后彻底放弃还原：本流剩下的内容一律当正文透传。
   *
   * 宁可让用户看见脏字符，也不能让一个没闭合的标记把内存吃光 —— 而真走到这个分支时，
   * 工具调用本来也已经不完整了。
   */
  let passthrough = false;
  /** 原始输入，用于「什么都没还原出来」时的兜底透传 */
  let raw = '';
  /** 已经发出去的正文，flush 时用来判断「是不是只剩空白了」 */
  let emitted = '';
  let callCount = 0;
  /**
   * 当前是否落在 DSML 结构块内部（见过一个 DSML 标签之后、遇到真正文之前）。
   * 用于丢弃标签之间的换行与缩进 —— 它们是标记语法的一部分。
   */
  let inBlock = false;

  const consume = (final: boolean): DsmlPart[] => {
    const out: DsmlPart[] = [];
    if (passthrough) {
      if (buf) {
        out.push({ kind: 'text', text: buf });
        emitted += buf;
      }
      buf = '';
      return out;
    }
    const emitText = (t: string) => {
      if (!t) return;
      emitted += t;
      out.push({ kind: 'text', text: t });
    };
    /**
     * emitText 的正文版：结构块**内部**的空白不是用户该看到的内容。
     *
     * DSML 块长这样（注意标签之间那些换行）：
     * ```
     * <｜DSML｜tool_calls>
     * <｜DSML｜invoke …>
     * ```
     * 进出标签之间的换行/缩进属于标记语法，发到界面上就是凭空多出来的空行。
     * 只有切到真正的正文（`inBlock` 转 false）之后，空白才算数。
     */
    const emitBody = (t: string) => {
      if (!t) return;
      if (t.trim()) inBlock = false;
      else if (inBlock) return;
      emitText(t);
    };
    const finishCall = (): DsmlPart => {
      const done = call as PendingCall;
      call = null;
      callCount++;
      return { kind: 'toolCall', name: done.name, arguments: JSON.stringify(done.args) };
    };

    let pos = 0;
    for (;;) {
      if (buf.length - pos > MAX_INVOKE_LEN) {
        passthrough = true;
        emitText(buf.slice(pos));
        pos = buf.length;
        break;
      }

      if (!call) {
        // ── 正文态 ──
        // 标签前面的正文必须在这里就发出去：等到循环末尾再发的话，中途 pos 一旦
        // 前移越过它，那段正文就被静默吞了（正文里一个普通 `<` 就能触发）。
        const i = buf.indexOf('<', pos);
        if (i === -1) {
          emitBody(buf.slice(pos));
          pos = buf.length;
          break;
        }
        const tag = readDsmlTag(buf, i);
        if (tag === 'incomplete') {
          // pos 留在 i 之前，本块留给下一个 chunk 再判
          if (final) {
            emitBody(buf.slice(pos));
            pos = buf.length;
          }
          break;
        }
        if (!tag) {
          emitBody(buf.slice(pos, i + 1)); // 普通尖括号是正文的一部分
          pos = i + 1;
          continue;
        }
        emitBody(buf.slice(pos, i));
        inBlock = true;
        pos = i + tag.length;
        if (!tag.isClose && tag.kind === 'invoke') {
          const name = attr(tag.attrs, 'name');
          // 没有 name 的 invoke 无法执行，连同外层标记一起丢掉
          if (name) call = { marker: tag.marker, spaced: tag.spaced, name, args: {} };
        }
        continue;
      }

      // ── invoke 体内：只认 parameter 开标签与 invoke 闭标签 ──
      // 此处不 emitText：invoke 内部的结构空白与换行不属于任何正文
      const i = buf.indexOf('<', pos);
      if (i === -1) {
        if (final) {
          out.push(finishCall());
          pos = buf.length;
        }
        break;
      }
      const tag = readDsmlTag(buf, i);
      if (tag === 'incomplete') {
        if (final) {
          out.push(finishCall());
          pos = buf.length;
        }
        break;
      }
      if (!tag) {
        pos = i + 1; // invoke 体内的杂字符，丢弃
        continue;
      }

      if (tag.kind === 'invoke' && tag.marker === call.marker && tag.spaced === call.spaced) {
        // 开标签重入（invoke 没写参数就闭合）也走这里：先把手上的收掉
        if (tag.isClose) out.push(finishCall());
        pos = i + tag.length;
        continue;
      }
      if (tag.kind === 'parameter' && !tag.isClose) {
        const gap = tag.spaced ? ' ' : '';
        // 开闭标签的空格偶尔不一致，两种都试一遍
        const close = [`</${tag.marker}${gap}parameter>`, `</${tag.marker}${tag.spaced ? '' : ' '}parameter>`];
        const at = close.map((c) => buf.indexOf(c, i + tag.length));
        const end = at[0] === -1 ? at[1] : at[0];
        const token = close[at[0] !== -1 ? 0 : 1];
        if (end === -1) {
          // 参数值还没到齐。不动 pos（含开标签一起留给下一块）。
          // final 时把已经收到的那截当作值收掉 —— 模型输出撞 max_tokens 时，
          // 丢掉整次调用会让 agent 误判成「模型什么都没说」。
          if (final) {
            const name = attr(tag.attrs, 'name');
            if (name) call.args[name] = paramValue(buf.slice(i + tag.length), tag.attrs);
            out.push(finishCall());
            pos = buf.length;
          }
          break;
        }
        const name = attr(tag.attrs, 'name');
        if (name) call.args[name] = paramValue(buf.slice(i + tag.length, end), tag.attrs);
        pos = end + token.length;
        continue;
      }
      pos = i + tag.length;
    }

    buf = pos >= buf.length ? '' : buf.slice(pos);
    return out;
  };

  return {
    push(chunk: string) {
      raw += chunk;
      buf += chunk;
      return consume(false);
    },
    flush() {
      const out = consume(true);
      /**
       * 兜底：**一次调用都没还原，且发出去的正文全是空白**，说明这串内容长得像 DSML
       * 但解析不出任何调用（模型吐了个残缺的壳）。这时必须把原文还给界面。
       *
       * 不这么做就会造出「正文空 + 无 tool_calls」—— `messageHygiene` 明确要拦的
       * 那种非法消息，下一轮请求直接 400，整个会话卡死。显示几行脏字符好得多。
       *
       * 判据用「trim 后为空」而不是「字符数为零」：invoke 之间的换行会被当正文正常
       * 发出去，只数字符会把「已经发过正文」当成成立，白白放弃兜底。
       */
      if (callCount === 0 && !emitted.trim() && raw.trim()) out.push({ kind: 'text', text: raw });
      return out;
    },
  };
}

/**
 * 一次性还原（非流式路径用）。
 *
 * 返回清洗后的正文与还原出的调用；没识别出任何东西时 calls 为空、text 原样返回。
 */
export function recoverDsmlText(content: string): { text: string; calls: DsmlToolCall[] } {
  const r = createDsmlRecoverer();
  const parts = [...r.push(content), ...r.flush()];
  const calls: DsmlToolCall[] = [];
  let text = '';
  for (const p of parts) {
    if (p.kind === 'text') text += p.text;
    else calls.push({ name: p.name, arguments: p.arguments });
  }
  return { text, calls };
}