#!/usr/bin/env node
/**
 * skill frontmatter 解析：YAML 块标量。
 *
 * 为什么这道守卫必须有：外部 skill（Claude / Code 那一系）写多行 description 的
 * 常规写法就是 `description: >-`，仓库里 8 个内置 skill 全是单行，所以一直没暴露。
 * 一旦解析器只按「逐行 key: value」扫，值会被读成**字面量 `>-`**，
 * 真正的描述被静默丢弃 —— 界面上看不出来，表现为 Level 1 清单里渲染成
 * `- visualizer-svg：>-`，路由器拿不到任何用途信息，于是这个技能**永远选不中**。
 *
 * 这是典型的静默错账：导入成功、能选中、就是永远不生效，所以必须挡住。
 *
 * 运行：node scripts/test-skill-parse.mjs
 */
import assert from 'node:assert/strict';
import { parseSkillMarkdown, serializeSkillMarkdown } from '../src/skills/types.ts';

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

const wrap = (frontmatter, body = '正文') => `---\n${frontmatter}\n---\n\n${body}\n`;

test('折叠标量 >- 的多行描述被完整读出', () => {
  const s = parseSkillMarkdown(
    'visualizer-svg.md',
    wrap('name: visualizer-svg\ndescription: >-\n  第一行内容\n  第二行内容'),
  );
  assert.equal(s.name, 'visualizer-svg');
  assert.equal(s.description, '第一行内容 第二行内容');
});

test('各种块标量写法都能认：> >- >2- |- |2 |+', () => {
  // 显式缩进数字与 chomping 的顺序在 YAML 里是任意的，两种都要覆盖
  for (const ind of ['>', '>-', '>+', '>2', '>2-', '>-2', '|', '|-', '|2', '|2-']) {
    const s = parseSkillMarkdown(
      'a.md',
      wrap(`name: a\ndescription: ${ind}\n    甲\n    乙`),
    );
    assert.equal(s.description, '甲 乙', `写法 ${ind} 没解析对，得到 ${JSON.stringify(s.description)}`);
  }
});

test('description 不含换行 —— skillMetaBlock 是按行拼的', () => {
  // 描述里带换行会把一条技能劈成两行、让路由器按行误读，所以块标量一律折成空格
  const s = parseSkillMarkdown('a.md', wrap('name: a\ndescription: |-\n  甲\n  乙\n  丙'));
  assert.ok(!s.description.includes('\n'), `description 混进了换行：${JSON.stringify(s.description)}`);
  assert.equal(s.description, '甲 乙 丙');
});

test('块标量之后的同级键不被吞进描述', () => {
  // 逐行正则的老毛病：续行没被消费干净，后面的键就跟着漂进描述里
  const s = parseSkillMarkdown(
    'a.md',
    wrap('name: a\ndescription: >-\n  甲\n  乙\nother_key: keepme', '正文'),
  );
  assert.equal(s.description, '甲 乙');
  assert.ok(!s.description.includes('keepme'), '同级键被吞进了 description');
});

test('块标量是最后一个键时正常收尾', () => {
  const s = parseSkillMarkdown('a.md', wrap('name: a\ndescription: >-\n  唯一描述'));
  assert.equal(s.description, '唯一描述');
  assert.equal(s.body, '正文');
});

test('空块标量得到空描述，不留字面量', () => {
  const s = parseSkillMarkdown('a.md', wrap('name: a\ndescription: >-'));
  assert.equal(s.description, '');
  assert.equal(s.name, 'a', 'name 仍应正常读出');
});

test('块标量里缩进不一致时，以首个缩进为准', () => {
  const s = parseSkillMarkdown('a.md', wrap('name: a\ndescription: >-\n    甲\n      乙\n  丙'));
  assert.equal(s.description, '甲 乙');
});

test('传统单行写法不受影响（含引号包裹）', () => {
  const plain = parseSkillMarkdown('a.md', wrap('name: a\ndescription: 单行描述'));
  assert.equal(plain.description, '单行描述');

  const quoted = parseSkillMarkdown('a.md', wrap('name: a\ndescription: "带引号的描述"'));
  assert.equal(quoted.description, '带引号的描述');
});

test('正文不被 frontmatter 污染', () => {
  const s = parseSkillMarkdown('a.md', wrap('name: a\ndescription: >-\n  甲', '# 标题\n\n正文'));
  assert.equal(s.body, '# 标题\n\n正文');
  assert.ok(!s.body.startsWith('---'), '正文开头残留了 frontmatter 分隔线');
});

test('无 frontmatter 时用文件名当名称', () => {
  const s = parseSkillMarkdown('我的技能.md', '就是一段正文');
  assert.equal(s.name, '我的技能');
  assert.equal(s.description, '');
  assert.equal(s.body, '就是一段正文');
});

test('往返稳定：serialize 出来的再 parse，描述不变', () => {
  const orig = parseSkillMarkdown(
    'a.md',
    wrap('name: a\ndescription: >-\n  甲\n  乙\n  丙', '正文'),
  );
  const round = parseSkillMarkdown('a.md', serializeSkillMarkdown(orig));
  assert.equal(round.name, orig.name);
  assert.equal(round.description, orig.description);
  assert.equal(round.body, orig.body);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);