#!/usr/bin/env node
/**
 * present_quiz 题卡校验的单元测试。
 * 运行：node scripts/test-quiz.mjs
 * Node ≥22.18 原生运行 TS（类型擦除），无需额外依赖。
 */
import assert from 'node:assert/strict';
import { validateQuiz } from '../src/harness/quiz.ts';
import { linkifyTimestamps } from '../src/utils/linkify.ts';

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

// ── 解析支持 Markdown / mermaid 围栏（2026-09-17） ───────────────────────────
// 校验层不做任何 markdown 解析，只要求**原样保留**：围栏换行被吃掉、反引号被转义，
// 解析里那张图就没了（渲染层认的是完整的三反引号围栏）。

const FENCED_EXPLANATION = [
  '进程与线程的区别在于资源归属 [03:25]。',
  '',
  '```mermaid',
  'flowchart LR',
  '  A[进程：资源分配单位] --> B[线程：调度单位]',
  '```',
  '',
  '所以选 B。',
].join('\n');

test('解析含 mermaid 围栏：换行与反引号原样保留', () => {
  const r = validateQuiz({ questions: [{ ...GOOD_Q, explanation: FENCED_EXPLANATION }] });
  assert.equal(r.ok, true);
  assert.equal(r.quiz.questions[0].explanation, FENCED_EXPLANATION, '解析内容必须逐字保留');
  assert.match(r.quiz.questions[0].explanation, /\n```mermaid\n/, '围栏标记与前后换行都必须在');
});

test('解析里的时间戳：围栏外可跳转、围栏内原样（图源码不被 linkify 破坏）', () => {
  const md = [
    '先看 [00:10] 这段。',
    '```mermaid',
    'flowchart LR',
    '  A[00:10] --> B[结束]',
    '```',
    '再看 [01:20]。',
  ].join('\n');
  const out = linkifyTimestamps(md);
  assert.ok(out.includes('[[00:10]](#seek-10)'), `围栏外应转成可跳转链接：${out}`);
  assert.ok(out.includes('[[01:20]](#seek-80)'), `围栏后正文应恢复转换：${out}`);
  assert.ok(out.includes('A[00:10] --> B[结束]'), `围栏内必须原样：${out}`);
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
  /**
   * SSR 下把「浏览器专用渲染件」换成替身。两级原因都躲不掉：
   * 1. XMarkdown 的 CJS 构建（lib/）顶层 `require('./DebugPanel.css')`，Node 拿 CSS 当 JS 解析直接 SyntaxError；
   *    就算绕开，它的 processHtml 依赖 DOMPurify + window，无 window 时 `sanitize` 不是函数，
   *    走的是「SSR 先不渲染、交给客户端 hydrate」分支 —— 也就是 SSR 下它本来就不产出内容。
   * 2. 题卡用的 mermaid 套件（components/mermaid/）会把 mdui 的自定义元素链拉进来，
   *    那套模块在 Node 里连 import 都过不去（`window is not defined` / 未注册的 customElements）。
   *
   * 于是 SSR 只守 QuizCard **自己**那部分契约：解析容器何时出现、交给渲染器的文本有没有先 linkify、
   * 材料模式下跳转有没有关掉。markdown 与 mermaid 的真实渲染由浏览器 e2e 守
   * （scripts/e2e-quiz-mermaid.mjs）—— 那是唯一能真跑 DOMPurify + mermaid 的地方。
   */
  const mdStub = join(dir, 'x-markdown-stub.mjs');
  const mermaidKitStub = join(dir, 'mermaid-kit-stub.mjs');
  writeFileSync(
    mdStub,
    `import { createElement } from 'react';
export const XMarkdown = ({ content }) => createElement('div', { 'data-md-stub': '' }, String(content ?? ''));
`,
  );
  writeFileSync(
    mermaidKitStub,
    `export const MarkdownCode = () => null;
export const MarkdownPre = () => null;
`,
  );
  // 组件是 .tsx：Node 的类型擦除不处理 JSX，先 esbuild 打成一个包再 import
  writeFileSync(
    entry,
    `import { renderToStaticMarkup } from 'react-dom/server';
import QuizCard from ${JSON.stringify(join(here, '../src/components/QuizCard.tsx'))};
const quiz = { questions: [
  { stem: '题干一', options: ['甲', '乙', '丙', '丁'], answer: 1, explanation: '解析一 [03:25]', time: '03:25' },
  { stem: '题干二', options: ['甲', '乙', '丙', '丁'], answer: 2, explanation: '解析二' },
] };
export const render = (picks, seekable = true, withSeek = false) => renderToStaticMarkup(
  <QuizCard quiz={quiz} picks={picks} onAnswer={() => {}} onSeek={withSeek ? () => {} : undefined} seekable={seekable} />,
);
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
    plugins: [
      {
        name: 'stub-browser-only',
        setup(b) {
          // 裸包名与相对路径两种写法都要拦：filter 按「规格尾巴」匹配，免得写死去几层 ../
          b.onResolve({ filter: /^@ant-design\/x-markdown$/ }, () => ({ path: mdStub }));
          b.onResolve({ filter: /mermaid\/markdown$/ }, () => ({ path: mermaidKitStub }));
          // 样式同理：Node 既不能 import .css，也过不了 external
          b.onResolve({ filter: /\.css$/ }, (args) => ({ path: args.path, namespace: 'empty-stub' }));
          b.onLoad({ filter: /.*/, namespace: 'empty-stub' }, () => ({ contents: '', loader: 'js' }));
        },
      },
    ],
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

  // 解析正文现在走「先 linkify 再交给 markdown 渲染器」两步。这里靠替身把**交给渲染器的文本**
  // 捞出来看：XMarkdown 本体在 Node 下不产出内容（见上面的替身说明），
  // 所以渲染结果与出图交给浏览器 e2e（scripts/e2e-quiz-mermaid.mjs）。
  await testAsync('未作答不渲染解析，作答后解析容器出现', () => {
    const before = render([-1, -1]);
    assert.equal(before.includes('quiz-explain'), false, '未作答不该出现解析');
    const after = render([3, -1]);
    assert.ok(after.includes('data-testid="quiz-explain"'), '作答后应出现解析块');
    assert.ok(after.includes('data-testid="quiz-explain-md"'), '解析正文容器应在');
  });

  await testAsync('解析交给渲染器前已 linkify 时间戳', () => {
    const html = render([0, -1]); // 作答后解析才展开
    assert.ok(html.includes('[[03:25]](#seek-205)'), `解析里的时间戳应转成跳转链接：${html.slice(0, 300)}`);
  });

  await testAsync('材料模式（seekable=false）不产生跳转链接', () => {
    const html = render([0, -1], false);
    assert.ok(html.includes('[03:25]'), '时间戳应原样保留');
    assert.ok(!html.includes('#seek-'), '不该出现点了没反应的 #seek- 链接');
  });

  // 题干右上角的考点标记与解析里的时间戳是同一类死链，同受 seekable 管
  await testAsync('材料模式下题干考点标记也不渲染', () => {
    assert.ok(render([-1, -1], true, true).includes('quiz-ts--stem'), '视频模式应渲染考点标记');
    assert.ok(!render([-1, -1], false, true).includes('quiz-ts--stem'), '材料模式应隐藏考点标记');
  });

  rmSync(entry, { force: true });
  rmSync(outfile, { force: true });
  rmSync(mdStub, { force: true });
  rmSync(mermaidKitStub, { force: true });
  // esbuild 会把入口涉及的样式单独吐一个 .css（内容与断言无关），一并清掉
  rmSync(join(dir, 'quiz-dom-bundle.css'), { force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
