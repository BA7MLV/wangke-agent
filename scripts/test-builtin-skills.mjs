#!/usr/bin/env node
/**
 * 内置 skill 资产 sanity 检查：frontmatter 可解析、正文非空、预算受控、references 存在。
 * 运行：node scripts/test-builtin-skills.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { parseSkillMarkdown } from '../src/skills/types.ts';

const DIR = 'src/skills/builtin';
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

// 目录结构：每个子目录一个 SKILL.md，references/ 可选
const dirs = readdirSync(DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
const skills = dirs.map((d) => {
  const mdPath = `${DIR}/${d}/SKILL.md`;
  const skill = parseSkillMarkdown('SKILL.md', readFileSync(mdPath, 'utf8'));
  const refsDir = `${DIR}/${d}/references`;
  const refs = existsSync(refsDir)
    ? readdirSync(refsDir).filter((f) => /\.(md|txt)$/i.test(f)).map((f) => ({
        path: `references/${f}`,
        body: readFileSync(`${refsDir}/${f}`, 'utf8').trim(),
      }))
    : [];
  return { dir: d, ...skill, refs };
});

test('恰好 7 个内置 skill', () => {
  assert.equal(skills.length, 7);
});

test('每个 skill 有 name + description（路由依赖 description）', () => {
  for (const s of skills) {
    assert.ok(s.name, `${s.dir} 缺 name`);
    assert.ok(s.description.length >= 10, `${s.name} description 太短（路由要靠它判断适用场景）`);
  }
});

test('包含必备的六个：公文讲义写作 / 公文版式规格 / 学科样例 / 公考行测 / 公考申论 / 讲解配图', () => {
  const names = skills.map((s) => s.name);
  assert.ok(names.includes('公文讲义写作'));
  assert.ok(names.includes('公文版式规格'));
  assert.ok(names.some((n) => /数学|编程/.test(n)));
  assert.ok(names.includes('公考行测讲义'));
  assert.ok(names.includes('公考申论讲义'));
  assert.ok(names.includes('讲解配图'));
});

test('「讲解配图」写死两种围栏名、五类图种、节点上限，并划清不用于讲义', () => {
  const s = skills.find((x) => x.name === '讲解配图');
  assert.ok(s, '缺讲解配图');
  // 围栏名是「提示词 ↔ 渲染层」的硬契约（components/mermaid/fence.ts 只认这两个）
  for (const kw of ['```mermaid', '```svg']) assert.ok(s.body.includes(kw), `缺围栏名：${kw}`);
  // 前端不认的围栏名要明确列为反例
  for (const kw of ['dot', 'plantuml']) assert.ok(s.body.includes(kw), `缺反例围栏名：${kw}`);
  // 五类图种
  for (const kw of ['flowchart', 'sequenceDiagram', 'stateDiagram-v2', 'mindmap', 'pie']) {
    assert.ok(s.body.includes(kw), `缺图种：${kw}`);
  }
  // 数量上限与防滥画
  assert.match(s.body, /不超过 10 个节点/);
  assert.match(s.body, /不超过 10 个字/);
  // 安全面：svg 不能带脚本与外部引用
  for (const kw of ['<script>', 'onclick', '<foreignObject>']) {
    assert.ok(s.body.includes(kw), `svg 安全约束缺：${kw}`);
  }
  // 讲义走公文 IR、不渲染图表围栏，技能必须自己说清适用范围
  assert.match(s.body, /讲义/);
});

test('「讲解配图」的 description 点明适用范围（路由靠它决定选不选）', () => {
  const s = skills.find((x) => x.name === '讲解配图');
  assert.match(s.description, /问答|解析/);
  assert.match(s.description, /讲义/);
});

test('「公文讲义写作」含四步流程、负面清单、自检清单、IR 范文', () => {
  const s = skills.find((x) => x.name === '公文讲义写作');
  assert.match(s.body, /工作流程/);
  assert.match(s.body, /禁止/);
  assert.match(s.body, /自检清单/);
  assert.match(s.body, /"blocks"/);
});

test('「公文版式规格」含全部 7 种块的使用策略', () => {
  const s = skills.find((x) => x.name === '公文版式规格');
  for (const t of ['lead', 'para', 'h2', 'list', 'table', 'figure', 'note']) {
    assert.ok(s.body.includes(t), `缺 ${t} 策略`);
  }
});

test('「公考行测讲义」覆盖五大模块与广东特色题型、含例题结构', () => {
  const s = skills.find((x) => x.name === '公考行测讲义');
  assert.ok(s, '缺公考行测讲义');
  for (const kw of ['言语理解', '判断推理', '数量关系', '资料分析', '常识判断', '科学推理', '数字推理', '例题']) {
    assert.ok(s.body.includes(kw), `行测缺关键词：${kw}`);
  }
});

test('「公考申论讲义」覆盖五类题型与广东考情、含大作文结构', () => {
  const s = skills.find((x) => x.name === '公考申论讲义');
  assert.ok(s, '缺公考申论讲义');
  for (const kw of ['归纳概括', '综合分析', '提出对策', '贯彻执行', '申发论述', '县级', '乡镇', '粤港澳大湾区']) {
    assert.ok(s.body.includes(kw), `申论缺关键词：${kw}`);
  }
});

test('注入预算：写作+版式 ≤4000 字，单个 skill ≤3000 字（总预算 6000 内留给学科）', () => {
  for (const s of skills) assert.ok(s.body.length <= 3000, `${s.name} 正文 ${s.body.length} 字超 3000`);
  const core = skills.filter((x) => ['公文讲义写作', '公文版式规格'].includes(x.name));
  const total = core.reduce((n, x) => n + x.body.length, 0);
  assert.ok(total <= 4000, `核心两个 skill 共 ${total} 字超 4000`);
});

test('references 非空且路径规范（references/ 前缀）', () => {
  for (const s of skills) {
    for (const r of s.refs) {
      assert.match(r.path, /^references\//);
      assert.ok(r.body.length > 50, `${s.name} 的 ${r.path} 内容过短`);
    }
  }
  // 版式规格必须带 GB/T 9704 样式表参考
  const fmt = skills.find((x) => x.name === '公文版式规格');
  assert.ok(fmt.refs.length >= 1, '公文版式规格应有样式表参考文档');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
