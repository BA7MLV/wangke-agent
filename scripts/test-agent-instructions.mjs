import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { createServer } from 'vite';

const storage = new Map();
globalThis.localStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
  removeItem: key => storage.delete(key),
};
const server = await createServer({ root: new URL('../apps/web', import.meta.url).pathname, server: { middlewareMode: true }, appType: 'custom' });
globalThis.window = Object.assign(new EventTarget(), { localStorage: globalThis.localStorage });
try {
  const { normalizeAgentInstructions, withAgentInstructions } = await server.ssrLoadModule('/src/harness/agentInstructions.ts');
  const { PROMPTS, RUNTIME_CAPABILITY_RULE } = await server.ssrLoadModule('/src/harness/prompts.ts');
  const { libraryAssistantSystemPrompt } = await server.ssrLoadModule('/src/harness/libraryAssistant.ts');
  const { useSettings, getSettings, migrateSettings } = await server.ssrLoadModule('/src/store/settings.ts');
  const { pickSyncSettings } = await server.ssrLoadModule('/src/sync/units.ts');
  const { createResourceExecutor, parseResource } = await server.ssrLoadModule('/src/harness/resources.ts');
  const { db } = await server.ssrLoadModule('/src/store/db.ts');
  const { AGENT_INSTRUCTIONS_FILE_ID, getSystemMaterial } = await server.ssrLoadModule('/src/materials/systemFiles.ts');
  const { getMaterialFile } = await server.ssrLoadModule('/src/store/fileStore.ts');
  const { createMdSaver } = await server.ssrLoadModule('/src/md-editor/save.ts');
  const instructions = '# 回答偏好\n- Please answer in English.\n- 先举例，再推导。';

  assert.equal(getSettings().agentInstructions, '');
  for (const invalid of [null, undefined, 4, {}, []]) {
    assert.equal(normalizeAgentInstructions(invalid), '');
    assert.equal(withAgentInstructions('base', invalid), 'base');
  }
  assert.equal(withAgentInstructions('base', ' \n\t'), 'base');
  assert.equal(normalizeAgentInstructions(instructions), instructions);
  console.log('OK: empty and invalid instructions retain defaults; Markdown is preserved');

  const builders = [
    text => PROMPTS.qaSystem('测试视频', '技能清单', true, 1, 1, text),
    text => PROMPTS.qaSystemMaterial('测试 PDF', 'page', '技能清单', 1, 1, false, text),
    text => PROMPTS.qaSystemMaterial('测试 Markdown', 'para', '技能清单', 0, 0, true, text),
    text => libraryAssistantSystemPrompt('技能清单', [{ id: 'course-1', name: '测试课程' }], true, text),
    text => libraryAssistantSystemPrompt('技能清单', [], false, text),
  ];
  for (const build of builders) {
    const base = build();
    const custom = build(instructions);
    assert.equal(build(' \n'), base);
    assert.ok(custom.startsWith(base));
    assert.ok(custom.endsWith(instructions));
    assert.equal(custom.split(instructions).length, 2, 'instructions injected once');
    assert.ok(custom.includes(RUNTIME_CAPABILITY_RULE));
    assert.match(custom, /本轮用户的明确要求优先/);
    assert.match(custom, /回答语言、语气、详略和讲解方式优先/);
  }
  console.log('OK: video, PDF, Markdown, library and empty-library prompts include preferences without replacing contracts');

  const initial = getSettings();
  for (const version of [0, 1, 2, 4, 5]) {
    assert.equal(migrateSettings({ ...initial, agentInstructions: undefined }, version).agentInstructions, '');
    assert.equal(migrateSettings({ ...initial, agentInstructions: instructions }, version).agentInstructions, instructions);
    assert.equal(migrateSettings({ apiKey: 'keep', agentInstructions: instructions }, version).agentInstructions, instructions);
  }
  const { merge } = useSettings.persist.getOptions();
  assert.equal(merge({}, useSettings.getState()).agentInstructions, '');
  assert.equal(merge({ agentInstructions: {} }, useSettings.getState()).agentInstructions, '');
  assert.equal(merge({ agentInstructions: instructions }, useSettings.getState()).agentInstructions, instructions);
  useSettings.getState().update({ agentInstructions: instructions });
  assert.equal(getSettings().agentInstructions, instructions);
  assert.equal(JSON.parse(storage.get('wangke-settings')).state.agentInstructions, instructions);
  assert.equal(pickSyncSettings(getSettings()).agentInstructions, instructions);
  useSettings.getState().update({ agentInstructions: { invalid: true } });
  assert.equal(getSettings().agentInstructions, '');
  console.log('OK: migration, hydration, persistence, validation and sync');

  // Already-open conversations rebuild their prompt with the latest settings each send.
  useSettings.getState().update({ agentInstructions: instructions });
  assert.ok(libraryAssistantSystemPrompt(undefined, [], false, getSettings().agentInstructions).endsWith(instructions));
  useSettings.getState().update({ agentInstructions: '' });
  assert.equal(libraryAssistantSystemPrompt(undefined, [], false, getSettings().agentInstructions), libraryAssistantSystemPrompt(undefined, [], false));
  console.log('OK: resetting preferences returns to the unchanged built-in prompt');

  const library = createResourceExecutor();
  const course = createResourceExecutor({ courseId: 'test-course' });
  assert.deepEqual(parseResource('/system'), { type: 'system' });
  assert.deepEqual(parseResource('/system/AGENTS.md'), { type: 'system', leaf: 'AGENTS.md' });
  assert.deepEqual(parseResource('/system/mcp.json'), { type: 'system', leaf: 'mcp.json' });
  assert.equal(parseResource('/system/unknown.md'), undefined);
  assert.equal(parseResource('/system/../AGENTS.md'), undefined);
  assert.match(await library('read', { path: '/system' }), /\/system\/AGENTS\.md/);
  assert.match(await course('read', { path: '/system' }), /\/system\/AGENTS\.md/);
  assert.match(await library('read', { path: '/system', offset: 1 }), /\/system\/mcp\.json/);
  assert.match(await library('read', { path: '/system', offset: 2 }), /\/system\/memory/);
  assert.match(await library('read', { path: '/system', offset: 3 }), /末尾/);
  assert.match(await library('edit', { path: '/system', create: true, content: '禁止覆盖目录' }), /目录只支持 read/);
  // 旧路径仅作为兼容别名，输出始终指向新位置。
  assert.deepEqual(parseResource('/AGENTS.md'), { type: 'markdown', id: 'AGENTS.md' });
  assert.match(await library('read', { path: '/AGENTS.md' }), /path=\/system\/AGENTS\.md/);
  assert.match(await library('read', { path: '/system/AGENTS.md' }), /当前为空/);
  assert.match(await library('edit', { path: '/system/AGENTS.md', create: true, content: instructions }), /已保存/);
  assert.equal(getSettings().agentInstructions, instructions);
  assert.match(await course('read', { path: '/system/AGENTS.md', offset: 1, limit: 1 }), /2: - Please answer in English\./);
  assert.match(await library('grep', { path: '/system/AGENTS.md', query: '先举例', mode: 'literal' }), /先举例/);
  assert.match(await library('edit', { path: '/system/AGENTS.md', create: true, content: '不能覆盖' }), /不能覆盖/);
  assert.equal(getSettings().agentInstructions, instructions);
  assert.match(await course('edit', { path: '/system/AGENTS.md', edits: [{ old_string: '先举例', new_string: '先给结论' }] }), /已保存/);
  assert.ok(getSettings().agentInstructions.includes('先给结论'));
  const latest = getSettings().agentInstructions;
  assert.match(await library('edit', { path: '/system/AGENTS.md', edits: [{ old_string: '先举例', new_string: '过期改动' }] }), /未命中/);
  assert.equal(getSettings().agentInstructions, latest, 'stale edits cannot overwrite current settings');
  assert.match(await library('edit', { path: '/system/AGENTS.md', edits: [{ old_string: '先给结论', new_string: '先列步骤', regex: true }] }), /已保存/);
  assert.equal(pickSyncSettings(getSettings()).agentInstructions, getSettings().agentInstructions);
  assert.equal(await db.videos.count(), 0, 'the system file never creates a duplicate course/material record');
  useSettings.getState().update({ agentInstructions: '' });
  assert.match(await library('read', { path: '/system/AGENTS.md' }), /当前为空/);
  console.log('OK: /system listing, AGENTS.md read/grep/edit, legacy alias, live settings sync, stale-edit protection, no duplicate material');

  assert.equal(getSystemMaterial(AGENT_INSTRUCTIONS_FILE_ID).materialFormat, 'md');
  assert.equal(await (await getMaterialFile(AGENT_INSTRUCTIONS_FILE_ID)).text(), '');
  const saver = createMdSaver(AGENT_INSTRUCTIONS_FILE_ID, { initialText: '' });
  try {
    saver.schedule(instructions);
    await saver.flush();
    assert.equal(getSettings().agentInstructions, instructions);
    assert.equal(await (await getMaterialFile(AGENT_INSTRUCTIONS_FILE_ID)).text(), instructions);
    const systemChat = createResourceExecutor({ courseId: AGENT_INSTRUCTIONS_FILE_ID, kind: 'para' });
    assert.match(await systemChat('read', { path: '/courses/current/material' }), /path=\/system\/AGENTS\.md/);
    assert.match(await systemChat('grep', { query: '先举例' }), /先举例/);
    assert.match(await systemChat('edit', { path: '/courses/current/material', edits: [{ old_string: '先举例', new_string: '先列步骤' }] }), /已保存/);
    const updated = getSettings().agentInstructions;
    saver.schedule('过期编辑器里的草稿');
    await assert.rejects(saver.flush(), /文件已在其他页面更新/);
    assert.equal(getSettings().agentInstructions, updated);
    assert.equal(await db.videos.count(), 0);
    assert.equal(await db.files.count(), 0);
  } finally {
    saver.dispose();
  }
  const resetSaver = createMdSaver(AGENT_INSTRUCTIONS_FILE_ID, { initialText: getSettings().agentInstructions });
  try {
    resetSaver.schedule('');
    await resetSaver.flush();
    assert.equal(getSettings().agentInstructions, '');
  } finally {
    resetSaver.dispose();
  }
  console.log('OK: shared Markdown file loading, editor saves/resets, current-file tools, concurrent-edit protection, no duplicate storage');
} finally {
  await server.close();
}
