/**
 * 工具调用的「人话层」：工具名 → 一句动作短语，参数 → 这次在对谁做，结果 → 一行摘要。
 *
 * 为什么单独一个纯函数模块（同 `utils/chatSources.ts` 的思路）：同一张翻译表有**三个**
 * 消费者 ——
 *
 * 1. 流式中的状态行（`ChatPanel` 与 `store/courseChat` 的 `hint`，「正在检索：傅里叶」）；
 * 2. 会话里的工具链（`components/ToolTrace` 每一行）；
 * 3. 落库后的历史回放（历史消息也要说同样的话）。
 *
 * 判据放在组件里，第 3 条就只能靠把文案**存进库里**才能对齐 —— 那等于把展示层文案写进
 * 数据库，改一次文案就要迁移一次老数据。放在这里，三处都只存 `name` + `args`，文案随时可改。
 *
 * 这里**只做翻译，不做业务**：不认识的工具名原样返回，不抛错、不猜。
 */

import type { ChatToolCall } from '../store/db';

/** Track invocations rather than tool names: identical tools may finish out of order. */
export class ToolTraceLedger {
  readonly calls: ChatToolCall[] = [];
  private readonly active = new Map<string, { index: number; started: number; hint: string }>();

  start(id: string, name: string, args: string, reasoningOffset?: number): void {
    this.active.set(id, { index: this.calls.length, started: Date.now(), hint: toolHint(name, args) });
    this.calls.push({ id, name, detail: toolDetail(name, args), status: 'running', ...(reasoningOffset !== undefined ? { reasoningOffset } : {}) });
  }
  finish(id: string, result: string): void {
    const entry = this.active.get(id);
    if (!entry) return;
    this.calls[entry.index] = { ...this.calls[entry.index], status: isToolFailure(result) ? 'error' : 'done', result: summarizeToolResult(result), ms: Date.now() - entry.started };
    this.active.delete(id);
  }
  get running(): number { return this.active.size; }
  get hint(): string | undefined {
    return this.active.size > 1 ? `正在并行调用 ${this.active.size} 个工具…` : this.active.values().next().value?.hint;
  }
  clear(): void { this.calls.length = 0; this.active.clear(); }
}

/** 工具名 → 动作短语。全部来自 `harness/tools.ts` 与 `harness/libraryAssistant.ts` 的工具注册表 */
const TOOL_LABELS: Record<string, string> = {
  grep: '检索正文',
  read: '读取资源',
  edit: '修改材料正文',
  // ── 课程问答（视频 / 阅读材料）──
  search_transcript: '检索字幕',
  search_material: '检索材料',
  get_transcript_range: '查看字幕原文',
  get_material_range: '查看材料原文',
  list_frames: '查看课程画面',
  present_quiz: '出题',
  show_widget: '画图',
  edit_markdown: '修改材料正文',
  // ── 两边共用 ──
  use_skill: '加载技能',
  read_skill_reference: '查阅技能参考',
  // ── 课程库助手 ──
  search_course_library: '跨课程检索',
  list_courses: '整理课程清单',
  get_learning_overview: '汇总学习记录',
  get_course_details: '读取课程详情',
  set_course_context: '选择相关课程',
  ask_user: '向你确认',
  list_folders: '查看现有分类',
  propose_folder_plan: '整理分类方案',
};

/**
 * 每个工具「这次在对谁做」的那个参数名。
 *
 * 只挑一个：工具链一行里放不下第二个参数，而绝大部分工具都只有一个有信息量的入参。
 * 没登记的（`list_frames` / `present_quiz` 这类无参数工具）就没有detail，标题只报动作。
 */
const DETAIL_KEYS: Record<string, string> = {
  grep: 'query',
  read: 'path',
  edit: 'path',
  search_transcript: 'query',
  search_material: 'query',
  search_course_library: 'query',
  set_course_context: 'query',
  use_skill: 'name',
  read_skill_reference: 'name',
  get_transcript_range: 'start',
  get_material_range: 'from',
};

/** 工具名 → 动作短语。不认识的工具原样返回名字（宁可显示 `foo_bar` 也不要显示空白） */
export function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name;
}

/** 只解码展示文字，不回写工具参数；坏转义也不能让历史消息渲染失败。 */
function readablePath(path: string): string {
  return path.replace(/(?:%[0-9a-f]{2})+/gi, (part) => {
    try { return decodeURIComponent(part); } catch { return part; }
  });
}

/** 实时状态与历史工具行共用。先按原始路径分段，避免名称里的 %2F 被误当成目录。 */
export function toolDisplay(name: string, detail?: string): { label: string; detail?: string } {
  if (name === 'read' && detail) {
    const parts = detail.split('/');
    if (parts[0] === '' && parts[1] === 'skills') {
      if (parts.length === 2) return { label: '查看可用技能' };
      const skill = readablePath(parts[2]);
      if (skill && parts.length === 3) return { label: '加载技能', detail: clip(skill, 40) };
      if (skill && parts[3] === 'references' && parts.length >= 5) {
        return { label: '查阅技能参考', detail: clip(`${skill} · ${readablePath(parts.slice(4).join('/'))}`, 80) };
      }
    }
    return { label: toolLabel(name), detail: clip(readablePath(detail), 40) };
  }
  return { label: toolLabel(name), detail: name === 'edit' && detail ? clip(readablePath(detail), 40) : detail };
}

/**
 * 这次调用在对谁做（检索词 / 技能名 / 起始位置），没有就是 `undefined`。
 *
 * 参数 JSON 可能是半截的（流式拼装）或被模型写坏，解析失败一律当「没有 detail」，
 * **不抛错** —— 工具名本身已经够用户看懂发生了什么，为一个副标题让整条消息渲染失败不值得。
 */
export function toolDetail(name: string, argsJson?: string): string | undefined {
  const key = DETAIL_KEYS[name];
  if (!key) return undefined;
  try {
    const args = JSON.parse(argsJson || '{}') as Record<string, unknown>;
    const raw = args[key];
    if (raw == null) return undefined;
    /**
     * 时间类参数（`get_transcript_range.start`）转成 mm:ss —— 用户脑子里的时间轴是
     * 「1:23」而不是「83」。这是唯一一处工具参数需要翻译的地方，所以就近写在这里，
     * 不引 `utils/vtt.ts`（那个模块会带进整个时间轴工具集，而这里只用一个格式化）。
     */
    if (key === 'start' && typeof raw === 'number') {
      const total = Math.max(0, Math.round(raw));
      const m = Math.floor(total / 60);
      const s = total % 60;
      return `${m}:${String(s).padStart(2, '0')}`;
    }
    const text = String(raw).trim();
    // 路径先完整保留，展示时再解码、识别技能并截断；否则中文名会截在 % 转义中间。
    if (name === 'read' || name === 'edit') return text || undefined;
    return text ? clip(text, 40) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 状态行文案（流式期间转圈那一行）：「正在检索字幕：傅里叶」。
 *
 * `fallback` 由调用方给：视频课与材料课的兜底说法不同（「正在处理…」/「正在读取课程库…」），
 * 而那是**页面语境**不是工具语义，不该硬编码在这个模块里。
 */
export function toolHint(name: string, argsJson?: string, fallback = '正在处理…'): string {
  if (name.startsWith('MCP · ')) return name;
  // 提问卡不是「正在做什么」，它把选择权交回用户：文案要换成等待口吻，否则会读成系统还在忙
  if (name === 'ask_user') return '等待你的回答';
  /**
   * 未登记的工具（新加了工具却忘了加标签）走兜底。
   *
   * 与 `toolLabel` 的「原样返回名字」**刻意不一致**：状态行是一句给用户读的话，
   * 塞一个 `brand_new_tool` 进去读不通；工具链是一张清单，原样显示英文名才排查得了。
   * 同一份数据、两种读法，各自的取舍不同 —— 这不是漏改。
   */
  if (!(name in TOOL_LABELS)) return fallback;
  const { label, detail } = toolDisplay(name, toolDetail(name, argsJson));
  return detail ? `正在${label}：${detail}` : `正在${label}…`;
}

/**
 * 工具结果 → 一行摘要，用于工具链每行的结果提示与落库。
 *
 * ⚠️ **落库存的就是这个摘要，不是全文**：一次字幕检索的结果可能上千字，
 * 一条回答调五六次工具就是几千字 —— 存全文换来的「历史里能展开看原始工具返回」
 * 对用户没有价值（他要看的是回答），却会让每条历史消息凭空胖一圈
 * （同 `ChatRow.widget` 那条注释的取舍）。
 */
export function summarizeToolResult(raw: string, max = 160): string {
  const one = raw
    .replace(/\s+/g, ' ')
    /**
     * 工具结果里的课程链接（`[《高等数学（上）》](#/player/c-math)`）是**给模型看的**：
     * 它要据此原样抄进回答里。直接铺到界面上是一串方括号加锚点，读起来像坏了。
     * 只留可读的那一半 —— 这是本模块唯一一处「为了好看而动字」的地方，所以只动链接语法本身。
     */
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim();
  if (!one) return '';
  return clip(one, max);
}

/**
 * 这次工具调用算不算失败。
 *
 * 判据只有一条：`harness/agent.ts` 在执行器**抛错**时包的那句前缀
 * （「工具执行失败：…」）。工具自己返回的软失败（「未检索到相关字幕内容。」）
 * **不算** —— 那是正常结论，标成红色只会让每一次空检索都像出了故障。
 *
 * 字符串耦合在这里收口：agent.ts 改前缀时，`test-tool-trace.mjs` 会跟着红。
 */
export function isToolFailure(result: string): boolean {
  return result.startsWith('工具执行失败') || result.startsWith('Error:');
}

/** 单行截断：超长补省略号。所有摘要共用一种「截法」，长短不一的行看起来才是一套 */
function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
