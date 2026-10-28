import test from 'node:test';
import assert from 'node:assert/strict';
import { isImeKeyEvent } from '../apps/web/src/utils/imeEnter.ts';

const key = (native) => ({ key: 'Enter', shiftKey: false, nativeEvent: { isComposing: false, keyCode: 13, ...native } });

test('plain Enter long after composition is a send', () => {
  assert.equal(isImeKeyEvent(key({}), false, performance.now() - 1000), false);
});

test('Chrome/Firefox: isComposing keydown is IME', () => {
  assert.equal(isImeKeyEvent(key({ isComposing: true }), false, -Infinity), true);
});

test('Android: keydown before compositionend is IME via tracked state', () => {
  assert.equal(isImeKeyEvent(key({}), true, -Infinity), true);
});

test('Safari: keydown after compositionend carries keyCode 229', () => {
  assert.equal(isImeKeyEvent(key({ keyCode: 229 }), false, -Infinity), true);
});

test('Safari: Enter in the same tick as compositionend is IME', () => {
  assert.equal(isImeKeyEvent(key({}), false, performance.now()), true);
});
