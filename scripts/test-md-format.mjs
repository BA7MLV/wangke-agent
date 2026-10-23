import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EditorState } from '@codemirror/state';
import { history, undo } from '@codemirror/commands';
import { formatMarkdown, MD_FORMAT_ACTIONS } from '../src/md-editor/format.ts';

function apply(doc, action, from = 0, to = doc.length) {
  const state = EditorState.create({ doc, selection: { anchor: from, head: to }, extensions: [history()] });
  return state.update(formatMarkdown(state, action)).state;
}

test('inline formatting retains selection and toggles off', () => {
  for (const [action, marker] of [['bold', '**'], ['italic', '*'], ['code', '`']]) {
    const formatted = apply('讲义内容', action);
    assert.equal(formatted.doc.toString(), `${marker}讲义内容${marker}`);
    assert.equal(formatted.sliceDoc(formatted.selection.main.from, formatted.selection.main.to), '讲义内容');
    assert.equal(formatted.update(formatMarkdown(formatted, action)).state.doc.toString(), '讲义内容');
  }
});

test('all actions work in an empty document', () => {
  for (const { id } of MD_FORMAT_ACTIONS) {
    const result = apply('', id);
    assert.ok(result.doc.length > 0, id);
    assert.ok(result.selection.main.to <= result.doc.length, id);
  }
});

test('line formatting handles multiple lines and excludes next line at selection boundary', () => {
  assert.equal(apply('甲\n乙\n丙', 'list', 0, 4).doc.toString(), '- 甲\n- 乙\n丙');
  assert.equal(apply('甲\n乙', 'ordered').doc.toString(), '1. 甲\n2. 乙');
  assert.equal(apply('- 甲\n- 乙', 'list').doc.toString(), '甲\n乙');
  assert.equal(apply('# 标题', 'heading').doc.toString(), '## 标题');
  assert.equal(apply('## 标题', 'heading').doc.toString(), '标题');
  assert.equal(apply('甲\n乙', 'quote').doc.toString(), '> 甲\n> 乙');
});

test('link selects URL for replacement, code block preserves line boundaries', () => {
  const link = apply('参考资料', 'link');
  assert.equal(link.doc.toString(), '[参考资料](https://)');
  assert.equal(link.sliceDoc(link.selection.main.from, link.selection.main.to), 'https://');
  assert.equal(apply('前代码后', 'codeblock', 1, 3).doc.toString(), '前\n```\n代码\n```\n后');
});

test('image insertion preserves alt text and selects image URL', () => {
  for (const [doc, expected] of [['', '![图片说明](https://)'], ['课堂截图', '![课堂截图](https://)'], ['图[1]\n说明', '![图\\[1\\] 说明](https://)']]) {
    const image = apply(doc, 'image');
    assert.equal(image.doc.toString(), expected);
    assert.equal(image.sliceDoc(image.selection.main.from, image.selection.main.to), 'https://');
    const replaced = image.update(image.replaceSelection('https://example.com/slide.png')).state;
    assert.ok(replaced.doc.toString().endsWith('](https://example.com/slide.png)'));
  }
});

test('format action is undoable as one transaction', () => {
  let state = apply('讲义内容', 'bold');
  assert.equal(undo({ state, dispatch: (transaction) => { state = transaction.state; } }), true);
  assert.equal(state.doc.toString(), '讲义内容');
});
