/**
 * 提问卡（助手反问用户）数据结构 + 校验。纯模块无运行时依赖，Node 下可直接单测。
 *
 * 与 `quiz.ts` 的分工：题卡是**展示**（`present_quiz` 立即返回，卡片另存，用户不答也能继续），
 * 提问卡是**答案的来源**（工具要等用户点选才把结果喂回 agent 循环）。所以这里多一个
 * `allowCustom`（「这几个都不对，我自己说」），并且没有正确答案 —— 选哪条都是有效输入。
 */

export interface AskUserData {
  /** 题面：一句话说清需要用户决定什么 */
  question: string;
  /** 2~5 个候选方案，单选 */
  options: string[];
  /** 是否提供「我自己说」入口（默认给：模型判断不了用户处境时，这比让用户在选项里硬选诚实） */
  allowCustom?: boolean;
}

export type AskUserValidation = { ok: true; ask: AskUserData } | { ok: false; error: string };

/** 选项条数上下限。少于 2 条不构成选择，多于 5 条用户读不完（这是 UI 约束，不是模型能力约束） */
export const MIN_ASK_OPTIONS = 2;
export const MAX_ASK_OPTIONS = 5;
/** 单个选项字数上限：卡片里一行要放得下，超了模型应该改写成更短的方案名 */
const MAX_OPTION_CHARS = 60;

function clean(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((o) => (typeof o === 'string' ? o.trim().replace(/\s+/g, ' ') : ''));
}

/**
 * 校验并清洗模型输出的提问卡参数；任何字段非法返回错误描述（供模型修正重试）。
 *
 * 错误文案要**具体到怎么改**（`quiz.ts` 的同一条理由）：模型收到「参数不合法」会换个说法重试，
 * 收到「第 2 个选项超过 60 字」才会真的去改。
 */
export function validateAskUser(raw: unknown): AskUserValidation {
  const ask = (raw as Partial<AskUserData> | null) ?? {};

  const question = typeof ask.question === 'string' ? ask.question.trim() : '';
  if (!question) return { ok: false, error: 'question（题面）不能为空' };
  if (question.length > 200) return { ok: false, error: 'question 超过 200 字，请改成一句话' };

  const options = clean(ask.options);
  if (options.length < MIN_ASK_OPTIONS || options.length > MAX_ASK_OPTIONS) {
    return { ok: false, error: `options 必须有 ${MIN_ASK_OPTIONS}~${MAX_ASK_OPTIONS} 个选项（收到 ${options.length} 个）` };
  }
  if (options.some((o) => !o)) return { ok: false, error: '选项不能为空' };
  if (new Set(options).size !== options.length) return { ok: false, error: '选项不能重复' };
  const tooLong = options.findIndex((o) => o.length > MAX_OPTION_CHARS);
  if (tooLong >= 0) {
    return { ok: false, error: `第 ${tooLong + 1} 个选项超过 ${MAX_OPTION_CHARS} 字，请改写成更短的方案名` };
  }

  return { ok: true, ask: { question, options, allowCustom: ask.allowCustom !== false } };
}
