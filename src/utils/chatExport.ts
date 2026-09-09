// 注：本文件被 node 测试脚本直接 import（type stripping），相对导入必须带 .ts 扩展名
import type { QuizData } from '../harness/quiz.ts';

/** 导出所需的最小消息形状（ChatPanel 的 ChatMsg / db 的 ChatRow 均可映射而来） */
export interface ExportMessage {
  role: 'user' | 'assistant';
  content: string;
  /** 思考过程（推理模型），折叠进 <details> */
  reasoning?: string;
  /** 答题卡（含用户作答） */
  quiz?: { data: QuizData; picks: number[] };
}

export interface SessionExportInput {
  title: string;
  videoName: string;
  messages: ExportMessage[];
  /** 导出时间（毫秒）；默认当前时间，测试可固定 */
  now?: number;
}

const LETTERS = ['A', 'B', 'C', 'D'];

/** 本地时间 yyyy-MM-dd HH:mm（不引 dayjs，便于 node 直测） */
export function fmtDateTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 答题卡 → Markdown：题干/选项/答案与解析；答案与解析折叠，已作答的标出对错 */
function quizToMarkdown(quiz: { data: QuizData; picks: number[] }): string {
  return quiz.data.questions
    .map((q, qi) => {
      const blocks: string[] = [];
      blocks.push(`### 第 ${qi + 1} 题`);
      blocks.push(q.stem + (q.time ? ` [${q.time}]` : ''));
      blocks.push(q.options.map((o, oi) => `- ${LETTERS[oi]}. ${o}`).join('\n'));

      const answer: string[] = [`**正确答案：${LETTERS[q.answer]}**`];
      const pick = quiz.picks[qi] ?? -1;
      if (pick >= 0) answer.push(`我的作答：${LETTERS[pick]}（${pick === q.answer ? '正确' : '错误'}）`);
      answer.push(`解析：${q.explanation}`);
      blocks.push(`<details>\n<summary>查看答案与解析</summary>\n\n${answer.join('\n\n')}\n\n</details>`);
      return blocks.join('\n\n');
    })
    .join('\n\n');
}

/**
 * 整个会话 → Markdown。
 * 结构：# 会话标题 → 课程/导出时间元信息 → 逐轮「## 我 / ## 助手」。
 * 思考过程与题卡答案用 <details> 折叠；正文原样保留（含 [mm:ss] 时间戳、[图@mm:ss] 画面标记、代码块空行）。
 */
export function buildSessionMarkdown({ title, videoName, messages, now = Date.now() }: SessionExportInput): string {
  const blocks: string[] = [];
  blocks.push(`# ${title.trim() || '新会话'}`);
  blocks.push(
    [
      `- 课程：${videoName.trim() || '（未知）'}`,
      `- 导出时间：${fmtDateTime(now)}`,
      `- 消息：${messages.length} 条`,
    ].join('\n'),
  );

  for (const m of messages) {
    const parts = [`## ${m.role === 'user' ? '我' : '助手'}`];
    const content = m.content.trim();
    if (content) parts.push(content);
    if (m.quiz) parts.push(quizToMarkdown(m.quiz));
    const reasoning = m.reasoning?.trim();
    if (reasoning) parts.push(`<details>\n<summary>思考过程</summary>\n\n${reasoning}\n\n</details>`);
    blocks.push(parts.join('\n\n'));
  }

  return `${blocks.join('\n\n')}\n`;
}

/** 导出文件名：课程名（去扩展名）+ 会话标题，剔除文件系统非法字符并限长 */
export function exportFileName(videoName: string, title: string): string {
  const clean = (s: string) => s.replace(/[\\/:*?"<>|\n\r\t]+/g, '-').replace(/\s+/g, ' ').trim();
  const base = clean(videoName.replace(/\.[a-z0-9]{1,5}$/i, '')) || '课程';
  const t = clean(title) || '会话';
  return `${`${base}-${t}`.slice(0, 80).trim()}.md`;
}
