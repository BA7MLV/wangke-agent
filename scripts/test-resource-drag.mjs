import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { canDropResourceInto, createFolderSpringLoader } from '../apps/web/src/utils/resourceDrag.ts';
import { FOLDER_SPRING_OPEN_MS } from '../apps/web/src/ui/interactionTiming.ts';

const source = (patch = {}) => ({ projectId: 'a', path: 'parent/file.txt', name: 'file.txt', kind: 'file', ...patch });

test('resource moves reject no-ops, scopes and missing files', () => {
  assert.equal(canDropResourceInto(source(), 'a', 'parent'), false);
  assert.equal(canDropResourceInto(source({ path: 'file.txt' }), 'a', ''), false);
  assert.equal(canDropResourceInto(source({ scope: {} }), 'b', ''), false);
  assert.equal(canDropResourceInto(source({ missing: true }), 'b', ''), false);
  assert.equal(canDropResourceInto(source({ path: '' }), 'b', ''), false);
  assert.equal(canDropResourceInto(source(), 'a', 'other'), true);
  assert.equal(canDropResourceInto(source(), 'b', 'parent'), true);
});

test('folders cannot enter themselves or descendants, but similar prefixes are safe', () => {
  const folder = source({ kind: 'directory', path: 'parent/docs', name: 'docs' });
  assert.equal(canDropResourceInto(folder, 'a', 'parent/docs'), false);
  assert.equal(canDropResourceInto(folder, 'a', 'parent/docs/nested'), false);
  assert.equal(canDropResourceInto(folder, 'a', 'parent/docs-other'), true);
  assert.equal(canDropResourceInto(folder, 'b', 'parent/docs'), true);
});

test('spring loader waits for the shared delay and does not restart on dragover', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const loader = createFolderSpringLoader();
  const opened = [];
  loader.schedule('a', () => opened.push('a'));
  t.mock.timers.tick(FOLDER_SPRING_OPEN_MS - 1);
  loader.schedule('a', () => opened.push('restarted'));
  assert.deepEqual(opened, []);
  t.mock.timers.tick(1);
  assert.deepEqual(opened, ['a']);
  t.mock.timers.tick(FOLDER_SPRING_OPEN_MS);
  assert.deepEqual(opened, ['a']);
});

test('crossing another folder restarts the wait, leaving the old row cannot cancel the new one', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const loader = createFolderSpringLoader();
  const opened = [];
  loader.schedule('a', () => opened.push('a'));
  t.mock.timers.tick(FOLDER_SPRING_OPEN_MS - 1);
  loader.schedule('b', () => opened.push('b'));
  loader.cancel('a');
  t.mock.timers.tick(FOLDER_SPRING_OPEN_MS - 1);
  assert.deepEqual(opened, []);
  t.mock.timers.tick(1);
  assert.deepEqual(opened, ['b']);
});

test('leave, drop, cancel and unmount can clear pending spring opens', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const loader = createFolderSpringLoader();
  let count = 0;
  loader.schedule('a', () => count++);
  loader.cancel('a');
  t.mock.timers.tick(FOLDER_SPRING_OPEN_MS);
  loader.schedule('a', () => count++);
  loader.cancel();
  t.mock.timers.tick(FOLDER_SPRING_OPEN_MS);
  assert.equal(count, 0);
  loader.schedule('a', () => count++);
  t.mock.timers.tick(FOLDER_SPRING_OPEN_MS);
  assert.equal(count, 1);
});

test('global motion durations have one definition, independent of CSS import order', () => {
  const styles = ['theme.css', 'transitions.css'].map(name => fs.readFileSync(new URL(`../apps/web/src/${name}`, import.meta.url), 'utf8')).join('\n');
  for (const token of ['quick', 'slow']) {
    assert.equal([...styles.matchAll(new RegExp(`--duration-${token}\\s*:`, 'g'))].length, 1, token);
  }
});
