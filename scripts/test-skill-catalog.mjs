#!/usr/bin/env node
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { createServer } from 'vite';

// Exercise production TS/raw imports against a process-local, disposable database.
// Never use a browser database, persisted settings, or a real model endpoint.
const originalFetch = globalThis.fetch;
let fetchAttempts = 0;
globalThis.fetch = async () => {
  fetchAttempts++;
  throw new Error('Skill catalog regression: network deliberately blocked');
};
const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
let db;
let failures = 0;
let passed = 0;
async function check(name, run) {
  try {
    await run();
    passed++;
    console.log(`PASS: ${name}`);
  } catch (error) {
    failures++;
    console.error(`FAIL: ${name}\n${error.stack ?? error}`);
  }
}
const ids = (metas) => metas.map((s) => s.id).sort((a, b) => a - b);
const names = (metas) => metas.map((s) => s.name).sort();
try {
  ({ db } = await server.ssrLoadModule('/src/store/db.ts'));
  const { BUILTIN_SKILLS, LEGACY_HANDOUT_SKILLS } = await server.ssrLoadModule('/src/skills/builtin.ts');
  const { COURSE_HANDOUT_SKILL, LEGACY_HANDOUT_TOPICS, isLegacyHandoutSkill } = await server.ssrLoadModule('/src/skills/catalog.ts');
  const { ensureBuiltinSkills, loadEnabledSkillMeta, loadSessionSkillMeta } = await server.ssrLoadModule('/src/skills/store.ts');
  const { createResourceExecutor, skillPath } = await server.ssrLoadModule('/src/harness/resources.ts');
  const { routeHandoutSkills } = await server.ssrLoadModule('/src/skills/router.ts');
  const { useSettings } = await server.ssrLoadModule('/src/store/settings.ts');
  const specs = [...LEGACY_HANDOUT_SKILLS, ...BUILTIN_SKILLS];
  const expectedRefs = ['writing', 'math-writing', 'coding-writing', 'gongkao-xingce', 'gongkao-shenlun'].map((s) => `references/${s}.md`).sort();
  const handoutSpec = BUILTIN_SKILLS.find((s) => s.name === COURSE_HANDOUT_SKILL);
  const refPath = (name, path) => `${skillPath(name)}/references/${path.split('/').map(encodeURIComponent).join('/')}`;
  const read = createResourceExecutor();

  // Simulate the six previously shipped builtin rows, not a freshly initialized app.
  const oldIds = [];
  for (const [index, spec] of LEGACY_HANDOUT_SKILLS.entries()) {
    const id = 100 + index;
    oldIds.push(id);
    await db.skills.add({ id, name: spec.name, description: 'pre-upgrade description', body: 'PRE_UPGRADE_IR', builtin: 1, enabled: index === 1 ? 0 : 1, updatedAt: 1 });
    for (const ref of spec.refs ?? []) await db.skillRefs.add({ skillId: id, path: ref.path, body: 'PRE_UPGRADE_REFERENCE' });
  }
  const override = { pin: [oldIds[0]], drop: [oldIds[2]] };
  await db.videos.add({ id: 'catalog-course', name: '集成回归课程', createdAt: 1, skillOverride: override });
  const customId = await db.skills.add({ name: '用户专用技能', description: 'custom', body: 'CUSTOM_BODY', enabled: 1, builtin: 0, updatedAt: 1 });

  await check('five chat entries, six legacy specifications and five on-demand handout refs', async () => {
    assert.equal(BUILTIN_SKILLS.length, 5);
    assert.equal(LEGACY_HANDOUT_SKILLS.length, 6);
    assert.equal(new Set(specs.map((s) => s.name)).size, 11);
    assert.deepEqual(handoutSpec.refs.map((r) => r.path).sort(), expectedRefs);
    assert.ok(handoutSpec.refs.every((r) => r.body.trim().length > 0));
    assert.match(handoutSpec.body, /Markdown/);
  });

  await check('concurrent upgrade preserves IDs, disabled state, overrides and ref identities', async () => {
    const refsBefore = await db.skillRefs.toArray();
    await Promise.all(Array.from({ length: 12 }, () => ensureBuiltinSkills()));
    await ensureBuiltinSkills();
    const rows = await db.skills.toArray();
    assert.equal(rows.filter((s) => s.builtin).length, 11);
    for (const [index, spec] of LEGACY_HANDOUT_SKILLS.entries()) {
      const row = await db.skills.get(oldIds[index]);
      assert.equal(row.name, spec.name);
      assert.equal(row.enabled, index === 1 ? 0 : 1, `${spec.name}: upgrade must preserve disabled state`);
      assert.equal(row.body, spec.body);
      assert.equal(row.description, spec.description);
    }
    for (const spec of specs) {
      const matching = rows.filter((s) => s.builtin && s.name === spec.name);
      assert.equal(matching.length, 1, `${spec.name}: concurrent ensure created duplicates`);
      const refs = await db.skillRefs.where('skillId').equals(matching[0].id).toArray();
      assert.equal(refs.length, spec.refs?.length ?? 0);
      assert.equal(new Set(refs.map((r) => r.path)).size, refs.length);
      for (const ref of spec.refs ?? []) assert.equal(refs.find((r) => r.path === ref.path)?.body, ref.body);
    }
    for (const ref of refsBefore) assert.equal((await db.skillRefs.get(ref.id)).skillId, ref.skillId);
    assert.deepEqual((await db.videos.get('catalog-course')).skillOverride, override);
    assert.equal((await db.skills.get(customId)).body, 'CUSTOM_BODY');
  });

  // Later groups are independently useful even when an earlier assertion fails.
  await ensureBuiltinSkills();
  const handout = await db.skills.filter((s) => !!s.builtin && s.name === COURSE_HANDOUT_SKILL).first();
  await check('chat/legacy discovery and /skills expose the same enabled boundary', async () => {
    const chat = await loadEnabledSkillMeta();
    const legacy = await loadEnabledSkillMeta('legacy-handout');
    assert.deepEqual(names(chat), [...BUILTIN_SKILLS.map((s) => s.name), '用户专用技能'].sort());
    assert.deepEqual(names(legacy), [...LEGACY_HANDOUT_SKILLS.filter((_, i) => i !== 1).map((s) => s.name), '用户专用技能'].sort());
    assert.deepEqual(chat.find((s) => s.id === handout.id).legacyIds.sort((a, b) => a - b), oldIds.filter((_, i) => i !== 1));
    const listing = await read('read', { path: '/skills' });
    assert.deepEqual(listing.split('\n').sort(), chat.map((s) => `${skillPath(s.name)} — ${s.name}`).sort());
    assert.deepEqual(ids(await loadSessionSkillMeta()), ids(chat));
    assert.deepEqual(await loadSessionSkillMeta([]), []);
    assert.equal(await createResourceExecutor({ allowedSkillIds: [] })('read', { path: '/skills' }), '本次会话没有可用技能。');
  });

  await check('enabled old IDs alias only course-handout; disabled IDs and empty scope cannot bypass', async () => {
    for (const id of oldIds.filter((_, i) => i !== 1)) assert.deepEqual(ids(await loadSessionSkillMeta([id])), [handout.id]);
    assert.deepEqual(await loadSessionSkillMeta([oldIds[1]]), []);
    assert.deepEqual(await loadSessionSkillMeta([-1]), []);
    assert.deepEqual(ids(await loadSessionSkillMeta([oldIds[0], handout.id, customId])), [customId, handout.id].sort((a, b) => a - b));
    const scoped = createResourceExecutor({ allowedSkillIds: [oldIds[0]] });
    assert.equal(await scoped('read', { path: '/skills' }), `${skillPath(handout.name)} — ${handout.name}`);
    await db.skills.update(handout.id, { enabled: 0 });
    try {
      assert.deepEqual(await loadSessionSkillMeta([oldIds[0], handout.id]), []);
      assert.match(await scoped('read', { path: skillPath(LEGACY_HANDOUT_SKILLS[0].name) }), /未找到已启用/);
    } finally { await db.skills.update(handout.id, { enabled: 1 }); }
  });

  await check('real read of old paths returns Markdown workflow and canonical reference paths', async () => {
    for (const [index, spec] of LEGACY_HANDOUT_SKILLS.entries()) {
      if (index === 1) continue;
      const output = await read('read', { path: skillPath(spec.name) });
      assert.ok(output.includes(handoutSpec.body), `${spec.name}: must return canonical Markdown body, not old IR`);
      assert.ok(!output.includes(spec.body), `${spec.name}: old IR body leaked`);
      assert.deepEqual(output.split('\n').filter((line) => line.startsWith('- /skills/')).sort(), handoutSpec.refs.map((ref) => `- ${refPath(handout.name, ref.path)}`).sort());
      for (const ref of handoutSpec.refs) assert.equal(await read('read', { path: refPath(handout.name, ref.path) }), ref.body);
    }
    assert.match(await read('read', { path: skillPath(LEGACY_HANDOUT_SKILLS[1].name) }), /未找到已启用/);
    const denied = createResourceExecutor({ allowedSkillIds: [] });
    const unrelated = createResourceExecutor({ allowedSkillIds: [customId] });
    for (const executor of [denied, unrelated]) {
      for (const path of [skillPath(handout.name), skillPath(LEGACY_HANDOUT_SKILLS[0].name), refPath(handout.name, expectedRefs[0])]) {
        assert.match(await executor('read', { path }), /不在本次会话/);
      }
    }
  });

  await check('only known old reference paths map to canonical refs; whitelist applies to refs', async () => {
    // Include the previously disabled format skill to cover its old gbt9704 reference.
    await db.skills.update(oldIds[1], { enabled: 1 });
    try {
      for (const [index, spec] of LEGACY_HANDOUT_SKILLS.entries()) {
        const executor = createResourceExecutor({ allowedSkillIds: [oldIds[index]] });
        for (const ref of spec.refs ?? []) {
          const canonical = handoutSpec.refs.find((r) => r.path === LEGACY_HANDOUT_TOPICS[spec.name]);
          assert.equal(await executor('read', { path: refPath(spec.name, ref.path) }), canonical.body, `${spec.name}/${ref.path}`);
          assert.match(await createResourceExecutor({ allowedSkillIds: [] })('read', { path: refPath(spec.name, ref.path) }), /不在本次会话/);
        }
        assert.match(await executor('read', { path: refPath(spec.name, 'references/not-a-real-reference.md') }), /未找到参考文档/);
      }
    } finally { await db.skills.update(oldIds[1], { enabled: 0 }); }
  });

  await check('legacy API-failure fallback respects old IDs, pin/drop and never injects chat skills', async () => {
    // Missing credentials force the catch branch before an HTTP request; fetch also
    // throws globally as a second safety barrier against accidental live requests.
    const previous = useSettings.getState();
    useSettings.setState({ providers: [], jev: { skillRouting: false, contextCompression: false } });
    try {
      const candidates = await loadEnabledSkillMeta('legacy-handout');
      const routed = await routeHandoutSkills('catalog-course', '测试数学课程', '数学课程样本');
      assert.deepEqual(ids(routed.selected), ids(candidates).filter((id) => !override.drop.includes(id)));
      assert.ok(routed.selected.some((s) => s.id === override.pin[0]));
      assert.ok(!routed.selected.some((s) => s.id === override.drop[0]));
      assert.ok(!routed.selected.some((s) => BUILTIN_SKILLS.some((b) => b.name === s.name)));
      const rows = await db.skills.where('id').anyOf(ids(routed.selected)).sortBy('id');
      assert.equal(routed.block, rows.map((s) => s.body.trim()).filter(Boolean).join('\n\n---\n\n').slice(0, 6000));
      // Pins do not resurrect disabled skills or cross the legacy candidate boundary;
      // dropping an ID wins even if it was also explicitly pinned.
      await db.videos.update('catalog-course', { skillOverride: { pin: [oldIds[0], oldIds[1], handout.id], drop: [oldIds[0]] } });
      const overridden = await routeHandoutSkills('catalog-course', '测试课程', '样本');
      assert.deepEqual(ids(overridden.selected), ids(candidates).filter((id) => id !== oldIds[0]));
      assert.deepEqual((await db.videos.get('catalog-course')).skillOverride, { pin: [oldIds[0], oldIds[1], handout.id], drop: [oldIds[0]] });
    } finally {
      useSettings.setState(previous);
      await db.videos.update('catalog-course', { skillOverride: override });
    }
  });

  await check('same-name user copies stay visible, unchanged and are never legacy-rewritten', async () => {
    const spec = LEGACY_HANDOUT_SKILLS[2];
    const builtinId = oldIds[2];
    // Put the user copy first in the name index to exercise actual name-based read.
    // ensure must recreate the missing builtin without treating this row as builtin.
    await db.skills.delete(builtinId);
    await db.skillRefs.where('skillId').equals(builtinId).delete();
    const copyId = await db.skills.add({ name: spec.name, body: 'SAME_NAME_USER_BODY', description: 'user copy', enabled: 1, builtin: 0, updatedAt: 7 });
    await db.skillRefs.add({ skillId: copyId, path: 'references/math-writing.md', body: 'SAME_NAME_USER_REF' });
    await Promise.all([ensureBuiltinSkills(), ensureBuiltinSkills()]);
    const copy = await db.skills.get(copyId);
    assert.equal(isLegacyHandoutSkill(copy), false);
    assert.equal(isLegacyHandoutSkill({ name: spec.name, builtin: 1 }), true);
    assert.equal(isLegacyHandoutSkill({ name: spec.name }), false);
    assert.equal(copy.body, 'SAME_NAME_USER_BODY');
    assert.equal(copy.updatedAt, 7);
    for (const scope of [undefined, 'legacy-handout']) assert.ok((await loadEnabledSkillMeta(scope)).some((s) => s.id === copyId));
    assert.deepEqual(ids(await loadSessionSkillMeta([copyId])), [copyId]);
    const scoped = createResourceExecutor({ allowedSkillIds: [copyId] });
    assert.ok((await scoped('read', { path: '/skills' })).includes(skillPath(spec.name)));
    const body = await scoped('read', { path: skillPath(spec.name) });
    assert.match(body, /SAME_NAME_USER_BODY/);
    assert.ok(!body.includes(handoutSpec.body));
    assert.equal(await scoped('read', { path: refPath(spec.name, 'references/math-writing.md') }), 'SAME_NAME_USER_REF');
    assert.equal(await db.skills.filter((s) => !!s.builtin && s.name === spec.name).count(), 1);
  });
} catch (error) {
  failures++;
  console.error(`FAIL: regression setup/module loading\n${error.stack ?? error}`);
} finally {
  if (db) await db.delete();
  await server.close();
  globalThis.fetch = originalFetch;
}
console.log(`Skill catalog integration: ${passed} passed, ${failures} failed; ${fetchAttempts} network attempts blocked; fake IndexedDB deleted.`);
if (failures) process.exitCode = 1;
