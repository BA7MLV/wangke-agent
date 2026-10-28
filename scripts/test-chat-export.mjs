#!/usr/bin/env node
/**
 * 会话导出契约测试：
 * - buildSessionMarkdown：标题/元信息/逐轮「我-助手」结构，正文原样保留（时间戳/画面标记/代码块空行）
 * - 思考过程与题卡答案折叠进 <details>，作答过时标出对错
 * - 空内容消息不产生悬挂段落，导出以单个换行结尾
 * - exportFileName：去扩展名、剔除非法字符、空值兜底
 * 运行：node scripts/test-chat-export.mjs
 */
import assert from 'node:assert/strict';
import { buildSessionMarkdown, exportFileName, markdownToPlainText } from '../apps/web/src/utils/chatExport.ts';

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (e) {
    failures.push({ name, e });
    console.log(`  FAIL - ${name}\n    ${e.message}`);
  }
}

const NOW = new Date(2026, 8, 8, 16, 30).getTime(); // 本地时间 2026-09-08 16:30

test('头部含会话标题、课程名、导出时间与消息数', () => {
  const md = buildSessionMarkdown({ title: '极限的定义', videoName: '高数-第3讲.mp4', messages: [], now: NOW });
  assert.ok(md.startsWith('# 极限的定义\n'), md);
  assert.ok(md.includes('- 课程：高数-第3讲.mp4'), md);
  assert.ok(md.includes('- 导出时间：2026-09-08 16:30'), md);
  assert.ok(md.includes('- 消息：0 条'), md);
});

test('空标题兜底为「新会话」', () => {
  const md = buildSessionMarkdown({ title: '   ', videoName: 'x', messages: [], now: NOW });
  assert.ok(md.startsWith('# 新会话\n'), md);
});

test('逐轮问答使用 ## 我 / ## 助手，正文原样保留', () => {
  const md = buildSessionMarkdown({
    title: 'T',
    videoName: 'V',
    now: NOW,
    messages: [
      { role: 'user', content: '[截图@01:05]这道题怎么做？' },
      { role: 'assistant', content: '见 [03:25] 的定义，画面 [图@04:10]。\n\n- 要点一\n- 要点二' },
    ],
  });
  assert.ok(md.includes('## 我\n\n[截图@01:05]这道题怎么做？'), md);
  assert.ok(md.includes('## 助手\n\n见 [03:25] 的定义，画面 [图@04:10]。'), md);
  assert.ok(md.includes('- 要点一\n- 要点二'), md);
});

test('代码块内连续空行不被压缩（正文不做全局换行规整）', () => {
  const code = '```js\nconst a = 1;\n\n\nconst b = 2;\n```';
  const md = buildSessionMarkdown({ title: 'T', videoName: 'V', now: NOW, messages: [{ role: 'assistant', content: code }] });
  assert.ok(md.includes('const a = 1;\n\n\nconst b = 2;'), md);
});

test('思考过程折叠进 details，排在正文之后', () => {
  const md = buildSessionMarkdown({
    title: 'T',
    videoName: 'V',
    now: NOW,
    messages: [{ role: 'assistant', content: '答案', reasoning: '先想 A，再想 B' }],
  });
  const body = md.slice(md.indexOf('## 助手'));
  assert.ok(body.indexOf('答案') < body.indexOf('思考过程'), body);
  assert.ok(body.includes('<details>\n<summary>思考过程</summary>\n\n先想 A，再想 B\n\n</details>'), body);
});

test('答题卡：题干/考点时间/ABCD 选项/答案折叠/解析', () => {
  const md = buildSessionMarkdown({
    title: 'T',
    videoName: 'V',
    now: NOW,
    messages: [
      {
        role: 'assistant',
        content: '来做几道题：',
        quiz: {
          data: {
            questions: [
              {
                stem: '极限存在的充要条件是？',
                options: ['左右极限存在', '左右极限存在且相等', '函数连续', '函数有界'],
                answer: 1,
                explanation: '见 [02:10] 的定理。',
                time: '02:10',
              },
            ],
          },
          picks: [-1],
        },
      },
    ],
  });
  assert.ok(md.includes('### 第 1 题\n\n极限存在的充要条件是？ [02:10]'), md);
  assert.ok(md.includes('- A. 左右极限存在\n- B. 左右极限存在且相等\n- C. 函数连续\n- D. 函数有界'), md);
  assert.ok(md.includes('**正确答案：B**'), md);
  assert.ok(md.includes('解析：见 [02:10] 的定理。'), md);
  assert.ok(md.includes('<summary>查看答案与解析</summary>'), md);
  assert.ok(!md.includes('我的作答'), '未作答不应输出作答行');
});

test('已作答的题目标出「正确/错误」', () => {
  const quiz = {
    data: {
      questions: [
        { stem: 'Q1', options: ['a', 'b', 'c', 'd'], answer: 1, explanation: 'E1' },
        { stem: 'Q2', options: ['a', 'b', 'c', 'd'], answer: 0, explanation: 'E2' },
      ],
    },
    picks: [1, 2],
  };
  const md = buildSessionMarkdown({ title: 'T', videoName: 'V', now: NOW, messages: [{ role: 'assistant', content: '', quiz }] });
  assert.ok(md.includes('我的作答：B（正确）'), md);
  assert.ok(md.includes('我的作答：C（错误）'), md);
  assert.ok(md.includes('### 第 1 题') && md.includes('### 第 2 题'), md);
});

test('空内容消息只留标题，不产生悬挂空行；导出以单个换行结尾', () => {
  const md = buildSessionMarkdown({
    title: 'T',
    videoName: 'V',
    now: NOW,
    messages: [{ role: 'assistant', content: '   ' }],
  });
  assert.ok(md.endsWith('## 助手\n'), JSON.stringify(md));
  assert.ok(!md.endsWith('\n\n'), '结尾不应有多余空行');
});

test('exportFileName：去扩展名 + 拼接标题', () => {
  assert.equal(exportFileName('高数-第3讲.mp4', '极限的定义'), '高数-第3讲-极限的定义.md');
  assert.equal(exportFileName('lecture.webm', '新会话'), 'lecture-新会话.md');
});

test('exportFileName：剔除文件系统非法字符并限长', () => {
  assert.equal(exportFileName('a/b:c*d?', 'x\\y<z>|'), 'a-b-c-d--x-y-z-.md');
  const long = exportFileName('v'.repeat(100), 't'.repeat(100));
  assert.ok(long.length <= 83 && long.endsWith('.md'), long);
});

test('exportFileName：空值兜底', () => {
  assert.equal(exportFileName('', ''), '课程-会话.md');
  assert.equal(exportFileName('   ', '  '), '课程-会话.md');
});

// ── markdownToPlainText：给「复制纯文本」用的一次降级 ───────────────────────
test('plain：去掉加粗/斜体/行内代码/删除线的标记符，保留文字', () => {
  assert.equal(markdownToPlainText('这是**重点**，也是*强调*，`code` 与 ~~删掉~~。'), '这是重点，也是强调，code 与 删掉。');
});

test('plain：链接与图片只留可见文字', () => {
  assert.equal(markdownToPlainText('见 [《高等数学》](#/player/c1) 的第 3 页。'), '见 《高等数学》 的第 3 页。');
  assert.equal(markdownToPlainText('![图@03:12](blob:x)'), '图@03:12');
});

test('plain：行首标记去掉，但缩进与换行保持', () => {
  const md = '# 标题\n\n> 引用一句\n\n- 第一条\n- 第二条\n\n1. 有序\n';
  assert.equal(markdownToPlainText(md), '标题\n\n引用一句\n\n第一条\n第二条\n\n有序');
});

test('plain：代码围栏只去掉围栏行，内容原样', () => {
  const md = '看这段：\n\n```ts\nconst a = 1 * 2;\n```\n';
  assert.equal(markdownToPlainText(md), '看这段：\n\nconst a = 1 * 2;');
});

test('plain：不误伤正文里的星号与下划线', () => {
  // `2 * 3` 两侧有空格，不该被当成斜体标记
  assert.equal(markdownToPlainText('结果是 2 * 3 = 6。'), '结果是 2 * 3 = 6。');
  // 单下划线词（snake_case）不该被当成斜体
  assert.equal(markdownToPlainText('字段名是 user_name。'), '字段名是 user_name。');
});

test('plain：空输入与纯空白返回空串', () => {
  assert.equal(markdownToPlainText(''), '');
  assert.equal(markdownToPlainText('  \n\n  '), '');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
