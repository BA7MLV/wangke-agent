#!/usr/bin/env node
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { createServer } from 'vite';

// Vite resolves the same TS and asset imports as the app; all data stays in fake IndexedDB.
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
try {
  const { db } = await server.ssrLoadModule('/src/store/db.ts');
  const { createResourceExecutor, courseResourceTools, libraryResourceTools, parseResource, skillPath } = await server.ssrLoadModule('/src/harness/resources.ts');
  const { libraryAssistantSystemPrompt } = await server.ssrLoadModule('/src/harness/libraryAssistant.ts');
  await db.videos.bulkAdd([
    { id: 'v', name: '视频', createdAt: 3, duration: 100 },
    { id: 'm', name: '材料', createdAt: 2, kind: 'material', materialFormat: 'pdf' },
    { id: 'md', name: '笔记', createdAt: 1, kind: 'material', materialFormat: 'md' },
  ]);
  await db.segments.bulkAdd([
    { videoId: 'v', idx: 0, start: 0, end: 0, status: 1, text: '贝叶斯 起点' },
    { videoId: 'v', idx: 1, start: 20, end: 30, status: 1, text: '贝叶斯 后续' },
    { videoId: 'v', idx: 2, start: 900, end: 910, status: 1, text: '远处内容' },
  ]);
  await db.materialBlocks.bulkAdd([
    { materialId: 'm', idx: 0, unit: 3, text: '贝叶斯 第三页' },
    { materialId: 'm', idx: 1, unit: 30, text: '远处页' },
  ]);
  const skillId = await db.skills.add({ name: '测试/技能', enabled: 1, body: '技能正文', description: '', updatedAt: 1 });
  await db.skillRefs.add({ skillId, path: 'references/说明.md', body: '参考正文' });
  const local = createResourceExecutor({ courseId: 'v' });
  const material = createResourceExecutor({ courseId: 'm', kind: 'page' });
  let selected;
  const library = createResourceExecutor({ library: { onContextChange: (c) => { selected = c; } } });
  const names = new Set([...courseResourceTools(true), ...libraryResourceTools(true)].map((t) => t.function.name));
  const readSchema = courseResourceTools().find((t) => t.function.name === 'read').function.parameters;
  assert.equal(readSchema.properties.range, undefined);
  assert.equal(readSchema.properties.unit, undefined);
  assert.equal(readSchema.properties.start.type, 'number');
  assert.equal(readSchema.properties.end.type, 'number');
  assert.deepEqual([...names].sort(), ['ask_user', 'edit', 'grep', 'present_quiz', 'propose_folder_plan', 'read', 'set_course_context', 'show_widget'].sort());
  assert.equal(libraryResourceTools(false).length, 3);
  assert.match(libraryAssistantSystemPrompt(undefined, [], false), /show_widget\(format="html"/);
  assert.match(libraryAssistantSystemPrompt(undefined, [], true), /show_widget\(format="html"/);
  assert.equal(courseResourceTools().length, 4);
  assert.equal(parseResource('/courses/%ZZ/info'), undefined);
  assert.equal(parseResource('/courses/%2e%2e/info'), undefined);
  assert.equal(parseResource('/courses/v/unknown'), undefined);
  assert.match(await local('grep', { query: '贝叶斯', limit: 1 }), /path=\/courses\/v\/transcript/);
  assert.equal((await local('grep', { query: '贝叶斯', limit: 1 })).split('\n').length, 3);
  assert.match(await local('read', { path: '/courses/current/transcript', range: { unit: 'seconds', start: 0, end: 0 } }), /起点/);
  assert.doesNotMatch(await local('read', { path: '/courses/current/transcript', range: { unit: 'seconds', start: 0, end: 0 } }), /后续/);
  assert.doesNotMatch(await local('read', { path: '/courses/current/transcript', range: { unit: 'seconds', start: 0, end: 1000 } }), /远处内容/);
  assert.match(await local('read', { path: '/courses/current/transcript', start: 0, end: 0 }), /起点/);
  assert.doesNotMatch(await local('read', { path: '/courses/current/transcript', start: 0, end: 0 }), /后续/);
  assert.match(await local('read', { path: '/courses/current/transcript', start: 0, end: 1000 }), /截断至 600/);
  assert.match(await local('read', { path: '/courses/current/transcript', start: 0 }), /同时提供 start 和 end/);
  assert.match(await local('read', { path: '/courses/current/transcript', end: 10 }), /同时提供 start 和 end/);
  for (const [start, end] of [[-1, 1], [2, 1], ['0', 1], [0, Infinity], [NaN, 1], [null, 1]]) {
    assert.match(await local('read', { path: '/courses/current/transcript', start, end }), /范围无效/);
  }
  assert.match(await local('read', { path: '/courses/current/transcript', range: 'unit=seconds,start=0,end=60' }), /改用顶层 start 和 end/);
  assert.match(await local('read', { path: '/courses/current/material' }), /请 read \/courses\/v\/transcript/);
  assert.match(await local('read', { path: '/courses/m/material' }), /只能访问当前课程/);
  assert.match(await local('read', { path: '/courses/current/material' }), /没有该类型/);
  assert.match(await material('read', { path: '/courses/current/material', range: { unit: 'seconds', start: 1, end: 3 } }), /必须是 pages/);
  assert.match(await material('read', { path: '/courses/current/material', range: { unit: 'pages', start: 3, end: 3 } }), /第三页/);
  assert.doesNotMatch(await material('read', { path: '/courses/current/material', range: { unit: 'pages', start: 1, end: 100 } }), /远处页/);
  assert.match(await material('read', { path: '/courses/current/material', start: 3, end: 3 }), /第三页/);
  assert.match(await material('read', { path: '/courses/current/material', start: 1, end: 100 }), /截断至 20/);
  assert.match(await material('read', { path: '/courses/current/material', start: 0, end: 1 }), /范围无效/);
  assert.match(await material('read', { path: '/courses/current/material', start: 1.5, end: 3 }), /范围无效/);
  await db.materialBlocks.add({ materialId: 'md', idx: 0, unit: 3, text: '第三段正文' });
  assert.match(await library('read', { path: '/courses/md/material', start: 3, end: 3 }), /第三段正文/);
  assert.match(await library('read', { path: '/courses/m/transcript' }), /请 read \/courses\/m\/material/);
  assert.match(await library('read', { path: '/courses', limit: 1 }), /offset=1/);
  assert.match(await library('read', { path: '/courses', limit: 1, offset: 1 }), /courseId=m/);
  await library('set_course_context', { courseIds: ['v'] });
  assert.equal(selected[0].id, 'v');
  assert.doesNotMatch(await library('grep', { query: '贝叶斯' }), /courseId=m/);
  const results = await library('grep', { path: '/courses', query: '贝叶斯' });
  assert.match(results, /path=\/courses\/m\/material/);
  assert.match(results, /start\/end 单位：页码/);
  assert.doesNotMatch(results, /range\.unit/);
  assert.doesNotMatch(await library('read', { path: '/courses/v/info' }), /range\.unit/);
  assert.match(await library('read', { path: '/courses/m/material', range: { unit: 'pages', start: 3, end: 3 } }), /第三页/);
  const loaded = await library('read', { path: skillPath('测试/技能') });
  assert.match(loaded, /技能正文/);
  const widgets = [];
  const libraryWithWidget = createResourceExecutor({ onWidget: (value) => { widgets.push(value); } });
  assert.match(await libraryWithWidget('show_widget', { format: 'html', code: '<button>继续</button>' }), /wbw-widget/);
  assert.match(await libraryWithWidget('show_widget', { format: 'html', code: '<button>第二张</button>' }), /wbw-widget/);
  assert.ok(widgets.every((widget) => typeof widget.id === 'string' && widget.id.length > 0));
  assert.notEqual(widgets[0].id, widgets[1].id, 'each generated widget has a host-owned ID');
  assert.ok(widgets.every((widget) => widget.ref === widget.id));
  assert.deepEqual(widgets.map(({ id, ref, ...payload }) => payload), [
    { html: '<button>继续</button>', libs: undefined },
    { html: '<button>第二张</button>', libs: undefined },
  ]);
  const { ensureBuiltinSkills } = await server.ssrLoadModule('/src/skills/store.ts');
  await ensureBuiltinSkills();
  const interactive = await library('read', { path: skillPath('交互式讲解') });
  assert.match(interactive, /调参/);
  const apiPath = interactive.split('\n').find((line) => line.startsWith('- /skills/') && line.includes('runtime.md')).slice(2);
  assert.match(await library('read', { path: apiPath }), /setWidgetState/);
  const refPath = loaded.split('\n').find((line) => line.startsWith('- /skills/')).slice(2);
  assert.equal(await library('read', { path: refPath }), '参考正文');
  const restricted = createResourceExecutor({ allowedSkillIds: [] });
  assert.match(await restricted('read', { path: apiPath }), /不在本次会话/);
  assert.match(await restricted('read', { path: skillPath('测试/技能') }), /不在本次会话/);
  assert.match(await restricted('read', { path: refPath }), /不在本次会话/);
  assert.doesNotMatch(await restricted('read', { path: '/skills' }), /测试/);
  await db.skills.update(skillId, { enabled: 0 });
  assert.match(await library('read', { path: refPath }), /未找到已启用/);
  assert.match(await library('edit', { path: '/courses/md/material', edits: [] }), /仅支持修改当前/);
  assert.match(await createResourceExecutor({ courseId: 'md', kind: 'para' })('edit', { path: '/courses/current/material', edits: [] }), /仅支持修改当前/);
  const { registerMdEditor } = await server.ssrLoadModule('/src/md-editor/bridge.ts');
  const editable = createResourceExecutor({ courseId: 'md', kind: 'para', editable: true });
  const edits = [{ old_string: '原文', new_string: '新文' }];
  let applied;
  const unregister = registerMdEditor('md', {
    applyEdits: (value) => { applied = value; return { ok: true, changed: 1 }; },
    undoAgentBatch: () => ({ ok: true }), hasAgentBatch: () => true,
  });
  assert.match(await editable('edit', { path: '/courses/current/material', edits }), /已修改 1 处/);
  assert.deepEqual(applied, edits);
  unregister();
  assert.match(await editable('edit', { path: '/courses/current/material', edits }), /没有打开编辑面/);
  assert.match(await local('search_transcript', { query: '贝叶斯' }), /未知工具/);
  await db.delete();
  console.log('Resource tools: registration, routing, search/read, pagination, ranges, context and permissions passed.');
} finally {
  await server.close();
}
