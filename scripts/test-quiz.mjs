#!/usr/bin/env node
/**
 * present_quiz 题卡校验的单元测试。
 * 运行：node scripts/test-quiz.mjs
 * Node ≥22.18 原生运行 TS（类型擦除），无需额外依赖。
 */
import assert from 'node:assert/strict';
import { validateQuiz } from '../src/harness/quiz.ts';

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

const GOOD_Q = {
  stem: '  进程与线程的区别是什么？  ',
  options: [' A ', 'B', 'C', 'D'],
  answer: 2,
  explanation: ' 进程是资源分配单位 [03:25] ',
  time: '03:25',
};

test('合法单题通过并清洗（trim）', () => {
  const r = validateQuiz({ questions: [GOOD_Q] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.quiz.questions[0], {
    stem: '进程与线程的区别是什么？',
    options: ['A', 'B', 'C', 'D'],
    answer: 2,
    explanation: '进程是资源分配单位 [03:25]',
    time: '03:25',
  });
});

test('合法多题通过；无 time 字段则不输出 time', () => {
  const q2 = { ...GOOD_Q };
  delete q2.time;
  const r = validateQuiz({ questions: [GOOD_Q, q2] });
  assert.equal(r.ok, true);
  assert.equal(r.quiz.questions.length, 2);
  assert.equal('time' in r.quiz.questions[1], false);
});

test('questions 缺失/非数组/空数组均失败', () => {
  for (const raw of [{}, { questions: 'x' }, { questions: [] }, null]) {
    assert.equal(validateQuiz(raw).ok, false);
  }
});

test('超过 5 题失败', () => {
  const r = validateQuiz({ questions: Array(6).fill(GOOD_Q) });
  assert.equal(r.ok, false);
});

test('题干为空失败', () => {
  assert.equal(validateQuiz({ questions: [{ ...GOOD_Q, stem: '  ' }] }).ok, false);
  const noStem = { ...GOOD_Q };
  delete noStem.stem;
  assert.equal(validateQuiz({ questions: [noStem] }).ok, false);
});

test('选项必须恰好 4 个', () => {
  assert.equal(validateQuiz({ questions: [{ ...GOOD_Q, options: ['A', 'B', 'C'] }] }).ok, false);
  assert.equal(validateQuiz({ questions: [{ ...GOOD_Q, options: ['A', 'B', 'C', 'D', 'E'] }] }).ok, false);
  assert.equal(validateQuiz({ questions: [{ ...GOOD_Q, options: 'ABCD' }] }).ok, false);
});

test('选项不能为空或重复', () => {
  assert.equal(validateQuiz({ questions: [{ ...GOOD_Q, options: ['A', ' ', 'C', 'D'] }] }).ok, false);
  assert.equal(validateQuiz({ questions: [{ ...GOOD_Q, options: ['A', 'A', 'C', 'D'] }] }).ok, false);
});

test('answer 必须是 0~3 整数', () => {
  for (const answer of [-1, 4, 1.5, '2', null]) {
    assert.equal(validateQuiz({ questions: [{ ...GOOD_Q, answer }] }).ok, false, `answer=${answer}`);
  }
});

test('解析为空失败', () => {
  assert.equal(validateQuiz({ questions: [{ ...GOOD_Q, explanation: '' }] }).ok, false);
});

test('time 格式非法时静默丢弃（不报错）', () => {
  const r = validateQuiz({ questions: [{ ...GOOD_Q, time: '3分25秒' }] });
  assert.equal(r.ok, true);
  assert.equal('time' in r.quiz.questions[0], false);
});

test('h:mm:ss 时间戳合法保留', () => {
  const r = validateQuiz({ questions: [{ ...GOOD_Q, time: '1:03:25' }] });
  assert.equal(r.ok, true);
  assert.equal(r.quiz.questions[0].time, '1:03:25');
});

test('多余字段被忽略', () => {
  const r = validateQuiz({ questions: [{ ...GOOD_Q, foo: 1 }], bar: 2 });
  assert.equal(r.ok, true);
  assert.equal('foo' in r.quiz.questions[0], false);
});

// ── 组件契约：判定图标槽位必须常驻 ───────────────────────────────────────────
// 点完选项整块 UI 会跳一下的根因之一，就是「图标只在作答那一刻才插进行内」：
// 实测行高 40→42（min-height:40 减掉 padding 后内容盒只有 22px，装不下 24px 图标），
// 长选项还会被挤成第二行、把下面的选项整行顶下去 20px。
// 这里 SSR 渲染真实组件，守住「未作答时槽位也在」这条不变量。
{
  const { build } = await import('esbuild');
  const { mkdirSync, rmSync, writeFileSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath, pathToFileURL } = await import('node:url');
  const here = dirname(fileURLToPath(import.meta.url));

  const testAsync = async (name, fn) => {
    try {
      await fn();
      passed++;
      console.log(`  ok - ${name}`);
    } catch (e) {
      failures.push({ name, e });
      console.log(`  FAIL - ${name}\n    ${e.message}`);
    }
  };

  // 产物必须落在**项目内**（scripts/.cache）：react / react-dom 走 external 不打包，
  // 由 Node 在运行时按产物所在目录往上找 node_modules 解析；
  // 放系统临时目录会解析不到 bare import，而把它们打进包又会撞上 CJS 的 dynamic require。
  const dir = join(here, '.cache');
  mkdirSync(dir, { recursive: true });
  const entry = join(dir, 'quiz-dom-entry.tsx');
  const outfile = join(dir, 'quiz-dom-bundle.mjs');
  // 组件是 .tsx：Node 的类型擦除不处理 JSX，先 esbuild 打成一个包再 import
  writeFileSync(
    entry,
    `import { renderToStaticMarkup } from 'react-dom/server';
import QuizCard from ${JSON.stringify(join(here, '../src/components/QuizCard.tsx'))};
const quiz = { questions: [
  { stem: '题干一', options: ['甲', '乙', '丙', '丁'], answer: 1, explanation: '解析一' },
  { stem: '题干二', options: ['甲', '乙', '丙', '丁'], answer: 2, explanation: '解析二' },
] };
export const render = (picks) => renderToStaticMarkup(<QuizCard quiz={quiz} picks={picks} onAnswer={() => {}} />);
`,
  );
  await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    packages: 'external', // react / react-dom / jsx-runtime 交给运行时解析
    outfile,
    logLevel: 'silent',
  });
  const { render } = await import(pathToFileURL(outfile).href);

  // 后面必须紧跟空格（状态类）或引号：否则 `quiz-options` 容器、`quiz-option__letter` 都会被误算
  const OPTION_RE = /class="quiz-option(?=[ "])/g;
  const SLOT_RE = /class="quiz-option__mark(?=[ "])/g;
  const count = (s, re) => (s.match(re) ?? []).length;

  await testAsync('未作答时每个选项也带判定槽位（作答不再改变盒模型）', () => {
    const html = render([-1, -1]);
    assert.equal(count(html, OPTION_RE), 8, '选项数应为 8');
    assert.equal(count(html, SLOT_RE), 8, '槽位数应与选项数相等');
    assert.equal(html.includes('mdui-sym-check'), false, '未作答不该出现判定图标');
    assert.equal(html.includes('mdui-sym-close'), false, '未作答不该出现判定图标');
  });

  await testAsync('作答后槽位数不变，只多出图标', () => {
    // 第 1 题答案下标 1，故意选 3：一行吃到「答对」图标，一行吃到「错选」图标
    const html = render([3, -1]);
    assert.equal(count(html, OPTION_RE), 8);
    assert.equal(count(html, SLOT_RE), 8, '作答不得改变槽位数');
    assert.equal(html.includes('mdui-sym-check'), true, '应出现「答对」图标');
    assert.equal(html.includes('mdui-sym-close'), true, '应出现「错选」图标');
    assert.equal(html.includes('正确答案：B'), true, '应提示正确答案');
  });

  rmSync(entry, { force: true });
  rmSync(outfile, { force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
