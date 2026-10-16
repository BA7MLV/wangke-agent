#!/usr/bin/env node
/**
 * 问答画面引用契约测试：
 * - linkifyFrames 把 [图@mm:ss] 转成 #frame- 协议的 markdown 图片（供自定义 img 组件渲染）
 * - linkifyTimestamps 既有行为不变，且与 linkifyFrames 组合后不互相干扰
 * - formatFrameList 生成 list_frames 工具输出的画面清单
 * - PROMPTS.qaSystem 按 hasFrames 注入画面引用规则
 * 运行：node scripts/test-chat-frames.mjs
 */
import assert from 'node:assert/strict';
import { linkifyFrames, linkifyTimestamps, formatFrameList } from '../src/utils/linkify.ts';
import { PROMPTS } from '../src/harness/prompts.ts';
import { diagramKindOf, fenceTitleOf, MAX_FENCE_TITLE } from '../src/components/mermaid/fence.ts';

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

test('linkifyFrames 转换 [图@mm:ss] 为 #frame- 图片', () => {
  const out = linkifyFrames('对比见 [图@03:25] 所示。');
  assert.equal(out, '对比见 ![课程画面 03:25](#frame-205) 所示。');
});

test('linkifyFrames 支持 h:mm:ss', () => {
  const out = linkifyFrames('[图@1:02:03]');
  assert.equal(out, '![课程画面 1:02:03](#frame-3723)');
});

test('linkifyFrames 不动普通文本与普通时间戳', () => {
  const s = '没有标记 [03:25] 和 [图@] 残次标记';
  assert.equal(linkifyFrames(s), s);
});

test('linkifyTimestamps 既有行为：转 #seek- 链接', () => {
  assert.equal(linkifyTimestamps('见 [03:25]'), '见 [[03:25]](#seek-205)');
});

test('组合转换：画面标记成图片、普通时间戳成跳转链接，互不干扰', () => {
  const out = linkifyTimestamps(linkifyFrames('在 [03:25] 讲了定义，画面见 [图@04:10]。'));
  assert.ok(out.includes('[[03:25]](#seek-205)'), `缺 seek 链接：${out}`);
  assert.ok(out.includes('![课程画面 04:10](#frame-250)'), `缺画面图片：${out}`);
  assert.ok(!out.includes('[图@'), `残留原始标记：${out}`);
});

test('formatFrameList 输出按时间排序的 [mm:ss] 描述清单', () => {
  const out = formatFrameList([
    { ts: 250, caption: '第二章标题页' },
    { ts: 30.4, caption: '课程封面与学习目标' },
  ]);
  assert.equal(out, '[0:30] 课程封面与学习目标\n[4:10] 第二章标题页');
});

test('formatFrameList 空清单给出兜底文案', () => {
  assert.match(formatFrameList([]), /暂无可用画面/);
});

test('formatFrameList 缺 caption 时有占位描述', () => {
  assert.match(formatFrameList([{ ts: 65 }]), /\[1:05\] （无画面描述）/);
});

test('qaSystem 默认不含画面引用规则', () => {
  const p = PROMPTS.qaSystem('测试课程');
  assert.ok(!p.includes('/courses/current/frames'), '不应出现画面资源路径');
  assert.ok(!p.includes('[图@'), '不应出现画面标记');
});

test('qaSystem hasFrames=true 时注入 read frames 与 [图@mm:ss] 规则', () => {
  const p = PROMPTS.qaSystem('测试课程', undefined, true);
  assert.match(p, /read \/courses\/current\/frames/);
  assert.match(p, /\[图@mm:ss\]/);
});

test('qaSystem 技能与画面规则可共存且编号连续', () => {
  const p = PROMPTS.qaSystem('测试课程', '技能A：用途A', true);
  assert.match(p, /7\. .*present_quiz/);
  assert.match(p, /8\. 可用的技能/);
  assert.match(p, /9\. .*read \/courses\/current\/frames/);
});

// —— 2026-09-10 新增：代码块内的标记不得被改写（否则 mermaid / 普通代码源码被破坏） ——

test('linkifyTimestamps 跳过围栏代码块', () => {
  const md = '说明 [03:25] 见下：\n\n```mermaid\ngraph TD\n  A[03:25] --> B[结束]\n```\n\n结束 [04:10]';
  const out = linkifyTimestamps(md);
  assert.ok(out.includes('[[03:25]](#seek-205)'), `正文时间戳应被转换：${out}`);
  assert.ok(out.includes('A[03:25] --> B[结束]'), `围栏内应原样保留：${out}`);
  assert.ok(out.includes('[[04:10]](#seek-250)'), `围栏后的正文应恢复转换：${out}`);
});

test('linkifyFrames 跳过围栏代码块（~~~ 亦可）', () => {
  const md = '正文 [图@01:00]\n~~~js\nconst t = "[图@02:00]";\n~~~\n';
  const out = linkifyFrames(md);
  assert.ok(out.includes('![课程画面 01:00](#frame-60)'), `正文应被转换：${out}`);
  assert.ok(out.includes('"[图@02:00]"'), `代码内应原样保留：${out}`);
});

test('linkify 跳过未闭合围栏（流式半截代码）', () => {
  const md = '正文 [01:00]\n```mermaid\ngraph TD\n  A[02:00] --> B';
  const out = linkifyTimestamps(md);
  assert.ok(out.includes('[[01:00]](#seek-60)'), `围栏前正文应转换：${out}`);
  assert.ok(out.includes('A[02:00] --> B'), `未闭合围栏内应原样保留：${out}`);
});

test('linkify 跳过行内 code', () => {
  const out = linkifyTimestamps('正文 [01:00]，行内 `[02:00]` 不算');
  assert.ok(out.includes('[[01:00]](#seek-60)'));
  assert.ok(out.includes('`[02:00]`'), `行内代码应保留：${out}`);
});

// —— 2026-09-10 新增：带截图提问时「以图为准」 ——

test('qaSystem shotCount>0 时注入「以截图为准」规则', () => {
  const p = PROMPTS.qaSystem('测试课程', undefined, false, 2);
  assert.match(p, /本轮用户附带了 2 张截图/);
  assert.match(p, /以截图为准/);
});

test('qaSystem 无截图时不注入该规则', () => {
  const p = PROMPTS.qaSystem('测试课程');
  assert.ok(!p.includes('以截图为准'), '不应出现截图规则');
});

test('qaSystem 截图规则与画面引用规则编号连续', () => {
  const p = PROMPTS.qaSystem('测试课程', '技能A：用途A', true, 1);
  assert.match(p, /4\. 本轮用户附带了 1 张截图/);
  assert.match(p, /10\. .*read \/courses\/current\/frames/);
});

// —— 2026-09-17 新增：讲不清就画图（问答正文与题卡解析共用同一句话术） ——
// 前端只认 mermaid / diagram / svg 三个语言标记（components/mermaid/fence.ts 的 LANG_RULES），
// 提示词里写错围栏名，模型就会输出一坨源码；节点上限那句是防模型画出手机屏放不下的大图。
// 2026-10-13 起：**新内容只教 mermaid 与 diagram 两种**（svg 围栏退场成历史数据兼容，
// 见 fence.ts 头部），所以这里的断言也从「点明 svg」换成了「点明 diagram、不再教 svg」。

test('qaSystem 注入出图规则（围栏名 + 节点上限 + 防滥画）', () => {
  const p = PROMPTS.qaSystem('测试课程');
  assert.match(p, /```mermaid 围栏/);
  assert.match(p, /```diagram 围栏/);
  assert.match(p, /不超过 10 个节点/);
  assert.match(p, /一句话能说清的就别画/);
});

test('qaSystemMaterial 同样注入出图规则，且不引入时间戳口径', () => {
  const p = PROMPTS.qaSystemMaterial('阅读材料', 'page');
  assert.match(p, /```mermaid 围栏/);
  assert.ok(!p.includes('[mm:ss]'), '材料提示词不应出现时间戳口径');
});

// —— 2026-10-13 起：JSON 中间层上位，原生 svg 围栏退场（只剩渲染层兼容旧数据） ——
// 两条链路共用同一句话术，所以两处都要点到 diagram，否则问答能画、题卡不能。

test('出图规则点明 diagram 围栏，并写死「mermaid 优先、diagram 兜底」的分工', () => {
  for (const p of [PROMPTS.qaSystem('测试课程'), PROMPTS.qaSystemMaterial('阅读材料', 'page')]) {
    assert.match(p, /```diagram 围栏/, '必须点明 diagram 围栏名（前端只认这一个 JSON 标记）');
    // 分工不能省：不写「mermaid 画不出的才用 diagram」，模型会放着现成图种不用去手搓 JSON
    assert.match(p, /mermaid 画不出的[^。]*```diagram/);
    // JSON 中间层的全部意义：模型只描述结构，坐标/布局/采样由渲染器算
    assert.match(p, /你不要手算坐标/);
  }
});

test('出图规则点明标题写在围栏参数里（不是 JSON 字段）', () => {
  for (const p of [PROMPTS.qaSystem('测试课程'), PROMPTS.qaSystemMaterial('阅读材料', 'page')]) {
    // 不点明这个位置，模型只会把标题写成正文里的一句话，块头永远空着
    assert.match(p, /```diagram title="/, '必须给出围栏参数的写法（前端只认 fence.ts 的 fenceTitleOf）');
    assert.match(p, /```mermaid title="/, 'mermaid 是同一条口径，不能只教 diagram');
    assert.match(p, /不要把它塞进 JSON/);
  }
});

test('出图规则不再教 svg 围栏（历史数据兼容只留在渲染层，不进提示词）', () => {
  for (const p of [PROMPTS.qaSystem('测试课程'), PROMPTS.qaSystemMaterial('阅读材料', 'page')]) {
    assert.ok(!p.includes('```svg'), '提示词不该再教模型直出 SVG（围栏仍渲染，见 fence.ts）');
    assert.ok(!/不写 script/.test(p), 'svg 安全约束不该再占提示词篇幅');
  }
});

test('出题规则点明解析支持 markdown 与两种图表围栏', () => {
  for (const p of [PROMPTS.qaSystem('测试课程'), PROMPTS.qaSystemMaterial('阅读材料', 'para')]) {
    assert.match(p, /解析涉及流程[\s\S]*```mermaid 围栏/);
    assert.match(p, /```diagram 围栏/);
  }
});

test('技能路由排除出图类技能：讲义按 IR 渲染，不解析图表围栏', () => {
  const p = PROMPTS.routeSkills('测试课程', '字幕片段', '- 讲解配图：出图规范');
  assert.match(p, /不解析图表围栏/);
  assert.match(p, /出图类技能不要选/);
  // 输出契约仍在（新增规则不能把 JSON 那条挤掉）
  assert.match(p, /严格输出 JSON：\{"skills": \[/);
});

// —— 围栏判定：这是「提示词 ↔ 渲染层」的硬契约，写错一个字母模型就白画 ——
// 2026-10-13 起有三种：mermaid / diagram（新内容只教这两种）/ svg（历史数据兼容）。

test('diagramKindOf 只认 mermaid / diagram / svg 三种块级围栏', () => {
  assert.equal(diagramKindOf({ block: true, lang: 'mermaid' }), 'mermaid');
  assert.equal(diagramKindOf({ block: true, lang: 'diagram' }), 'diagram');
  assert.equal(diagramKindOf({ block: true, lang: 'svg' }), 'svg');
});

test('diagramKindOf 容忍围栏参数与前导空白（```mermaid title=xx / ```Diagram）', () => {
  assert.equal(diagramKindOf({ block: true, lang: 'mermaid title=架构图' }), 'mermaid');
  assert.equal(diagramKindOf({ block: true, lang: '  SVG  ' }), 'svg');
  assert.equal(diagramKindOf({ block: true, lang: 'Mermaid' }), 'mermaid');
  assert.equal(diagramKindOf({ block: true, lang: 'Diagram title=函数图像' }), 'diagram');
  assert.equal(diagramKindOf({ block: true, lang: '  diagram  ' }), 'diagram');
});

test('diagramKindOf 不吃前缀相近的语言名（svgb / mermaids / diagrams 都不是图表围栏）', () => {
  assert.equal(diagramKindOf({ block: true, lang: 'svgb' }), null);
  assert.equal(diagramKindOf({ block: true, lang: 'mermaids' }), null);
  assert.equal(diagramKindOf({ block: true, lang: 'diagrams' }), null);
});

test('diagramKindOf 不认其他画图语言：写 dot / plantuml 会落回普通代码块', () => {
  for (const lang of ['dot', 'graphviz', 'plantuml', 'js', 'jsx', 'ts', 'json', 'html', 'xml']) {
    assert.equal(diagramKindOf({ block: true, lang }), null, `${lang} 不该被当成图表围栏`);
  }
});

test('diagramKindOf 不认行内 code 与缺 lang 的围栏', () => {
  assert.equal(diagramKindOf({ block: false, lang: 'mermaid' }), null, '行内 code 不该建图块');
  assert.equal(diagramKindOf({ block: true }), null, '无 lang 的围栏是普通代码块');
  assert.equal(diagramKindOf({ block: true, lang: '' }), null);
  assert.equal(diagramKindOf({ block: true, lang: undefined }), null);
});

// —— 围栏标题：```diagram title="抛物线开口方向" ——
// 与 diagramKindOf 共用同一条 info string（XMarkdown 的 data-lang 是**完整** info string），
// 所以两者必须能在同一串上并存；提示词与 show_widget 回执都按这里的口径写 title=。

test('fenceTitleOf 认三种写法：双引号 / 单引号 / 裸值', () => {
  assert.equal(fenceTitleOf('diagram title="三次握手"'), '三次握手');
  assert.equal(fenceTitleOf('diagram title="抛物线 y=x² 的图像"'), '抛物线 y=x² 的图像', '引号里可以有空格');
  assert.equal(fenceTitleOf('diagram title="a=b 的关系"'), 'a=b 的关系', '引号里的 = 不是分隔符');
  assert.equal(fenceTitleOf("mermaid title='请求链路'"), '请求链路');
  assert.equal(fenceTitleOf('mermaid title=架构图'), '架构图', '裸值到空白为止');
  assert.equal(fenceTitleOf('svg title="自由图形"'), '自由图形');
});

test('fenceTitleOf 与 diagramKindOf 共用一条 info string', () => {
  const lang = 'diagram title="抛物线开口方向"';
  assert.equal(diagramKindOf({ block: true, lang }), 'diagram');
  assert.equal(fenceTitleOf(lang), '抛物线开口方向');
});

test('fenceTitleOf 认不出来的写法一律返回 null（调用方退回图种标签）', () => {
  assert.equal(fenceTitleOf('diagram'), null);
  assert.equal(fenceTitleOf(''), null);
  assert.equal(fenceTitleOf(undefined), null);
  assert.equal(fenceTitleOf('diagram title='), null, 'title= 后面什么都没有');
  assert.equal(fenceTitleOf('diagram title="   "'), null, '只有空白');
  assert.equal(fenceTitleOf('diagram subtitle=小标题'), null, 'subtitle 不是 title');
  assert.equal(fenceTitleOf('diagram mytitle=x'), null, '词中出现的 title 不算');
});

test('fenceTitleOf 大小写不敏感，且能跳过前面的其他参数', () => {
  assert.equal(fenceTitleOf('Diagram TITLE="函数图像"'), '函数图像');
  assert.equal(fenceTitleOf('mermaid  title = "三次握手" '), '三次握手');
  assert.equal(fenceTitleOf('diagram theme=dark title="对比"'), '对比');
});

test('fenceTitleOf 未闭合的引号也取（流式期间首行是逐 token 到的）', () => {
  // 宁可直接显示半截标题，也别让块头先空一下再蹦出来 —— 与 svg 围栏边生成边落画同一取向
  assert.equal(fenceTitleOf('diagram title="二次函数'), '二次函数');
  assert.equal(fenceTitleOf("diagram title='二次函数"), '二次函数');
  assert.equal(fenceTitleOf('diagram title='), null);
});

test('fenceTitleOf 超长截断到上限并加省略号（别因为标题长就整块不显示）', () => {
  const long = '函'.repeat(MAX_FENCE_TITLE + 5);
  const out = fenceTitleOf(`diagram title="${long}"`);
  assert.equal([...out].length, MAX_FENCE_TITLE + 1, '截断后长度 = 上限 + 省略号');
  assert.ok(out.endsWith('…'));
  const exact = '函'.repeat(MAX_FENCE_TITLE);
  assert.equal(fenceTitleOf(`diagram title="${exact}"`), exact, '恰好在上限上不动它');
});

test('fenceTitleOf 清掉控制字符（换行会串进文件名与无障碍名）', () => {
  assert.equal(fenceTitleOf('diagram title="三次\u0000握手"'), '三次握手');
});

test('shotDescribe 带上下文时声明「以画面为准」，不带上下文也可用', () => {
  const withCtx = PROMPTS.shotDescribe('这个公式怎么来的', '[01:00] 讲到了欧姆定律');
  assert.match(withCtx, /以画面为准/);
  assert.match(withCtx, /\[01:00\] 讲到了欧姆定律/);
  const noCtx = PROMPTS.shotDescribe('');
  assert.match(noCtx, /以画面为准/);
  assert.ok(!noCtx.includes('该时刻前后的课程字幕'), '无上下文时不应留空小节');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
