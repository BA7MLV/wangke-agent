import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { buildWidgetDocument, WIDGET_MSG } from '../apps/web/src/harness/widgetRuntime.ts';
import { readWidgetDiagnostic, MAX_WIDGET_DIAGNOSTICS } from '../apps/web/src/harness/widgetDiagnostics.ts';
import { htmlFenceContentType } from '../apps/web/src/utils/htmlContent.ts';
import { splitAssistantContent } from '../apps/web/src/utils/streamingHtml.ts';
import { replaceArtifactFence } from '../apps/web/src/utils/artifactEdit.ts';

// Protocol unit tests: no browser, pointer, touch, or model requests.
const doc = await buildWidgetDocument({ html: '<button onclick="work()">run</button><script>work()</script>' }, { instance: 'run-1' });
assert.match(doc, /connect-src 'none'/);
assert.match(doc, /script-src 'unsafe-inline'/);
assert.doesNotMatch(doc, /unsafe-eval|allow-same-origin/);
assert.match(doc, /onclick="work\(\)"/);
const full = await buildWidgetDocument({ html: '<!doctype html>\n<html><head><script>window.work = 1</script></head><body class="work" onload="start()">full work</body></html>' }, { instance: 'full' });
assert.ok(full.indexOf('Content-Security-Policy') < full.indexOf('window.work = 1'));
assert.ok(full.indexOf('var initial =') < full.indexOf('window.work = 1'));
assert.match(full, /<body class="work" onload="start\(\)">/);
const bootstrap = doc.match(/<script>([\s\S]*?)<\/script>/)[1];
const messages = [], handlers = new Map();
const listen = (type, fn) => {
  const list = handlers.get(type) ?? [];
  list.push(fn); handlers.set(type, list);
};
let attributes = 0;
const parent = { postMessage: data => messages.push(data) };
const context = {
  parent, document: { body: null, documentElement: { style: { setProperty() {} }, setAttribute() { attributes++; } }, addEventListener: listen },
  ResizeObserver: class { observe() {} }, MutationObserver: class { observe() {} },
  CustomEvent: class {}, requestAnimationFrame: () => 1, setTimeout, clearTimeout,
  window: { addEventListener: listen, dispatchEvent() {} }, navigator: {},
};
vm.runInNewContext(bootstrap, context);
const emit = (type, event) => handlers.get(type)?.forEach(fn => fn(event));
emit('error', { target: context.window, message: 'initialization broke' });
emit('error', { target: context.window, message: 'initialization broke' });
emit('unhandledrejection', { reason: new Error('async broke') });
emit('error', { target: { tagName: 'SCRIPT' } });
emit('securitypolicyviolation', { disposition: 'report', effectiveDirective: 'script-src' });
emit('securitypolicyviolation', { disposition: 'enforce', effectiveDirective: 'unsupported-directive' });
assert.equal(messages.length, 3, 'duplicates and non-enforced/unknown CSP reports ignored');
emit('securitypolicyviolation', { disposition: 'enforce', effectiveDirective: 'connect-src' });
for (let i = 0; i < 30; i++) emit('error', { message: `${i}`.repeat(600) });
assert.equal(messages.length, MAX_WIDGET_DIAGNOSTICS);
for (const message of messages) {
  assert.equal(message.__wbw, WIDGET_MSG.diagnostic);
  assert.equal(message.instance, 'run-1');
  assert.ok(readWidgetDiagnostic(message.payload));
}
assert.equal(readWidgetDiagnostic({ kind: 'script', message: 'x'.repeat(501) }), null);
assert.equal(readWidgetDiagnostic({ kind: 'tool', message: 'run me' }), null);
assert.equal(readWidgetDiagnostic({ kind: ['script'], message: 'wrong type' }), null);
assert.equal(readWidgetDiagnostic({ kind: 'script', message: {} }), null);
const before = attributes;
emit('message', { source: parent, data: { __wbw: WIDGET_MSG.theme, instance: 'old-run', payload: true } });
emit('message', { source: {}, data: { __wbw: WIDGET_MSG.theme, instance: 'run-1', payload: true } });
assert.equal(attributes, before, 'stale runs and foreign sources cannot update runtime');
emit('message', { source: parent, data: { __wbw: WIDGET_MSG.theme, instance: 'run-1', payload: true } });
assert.equal(attributes, before + 1);
assert.equal(htmlFenceContentType('html interactive'), 'interactive');
assert.equal(htmlFenceContentType('html interactive-example'), 'example');
assert.equal(htmlFenceContentType('html'), 'example');
assert.equal(splitAssistantContent('```html interactive\n<button>run</button>\n```')[0].htmlContentType, 'interactive');
assert.equal(splitAssistantContent('```html\n<button>example</button>\n```')[0].htmlContentType, 'example');
assert.equal(splitAssistantContent('<div>work</div>')[0].htmlContentType, 'interactive');
const fragment = '<style>button{color:red}</style><div><button>run</button></div><script>work()</script>\n\n说明';
assert.equal(splitAssistantContent(fragment)[0].source, fragment.slice(0, fragment.indexOf('\n')));
const saved = replaceArtifactFence('```html interactive\n<div>old</div>\n```', 'html', '<div>old</div>', '<div>new</div>');
assert.equal(splitAssistantContent(saved)[0].htmlContentType, 'interactive', 'edits preserve persisted execution semantics');
assert.equal(splitAssistantContent(saved)[0].source, '<div>new</div>');
assert.equal(splitAssistantContent('```text\n```html interactive\n<button>example</button>\n```\n```')[0].kind, 'markdown');
const shell = readFileSync(new URL('../apps/web/src/components/WidgetBlock.tsx', import.meta.url), 'utf8');
assert.match(shell, /e\.origin !== 'null'/);
assert.match(shell, /e\.source !== frameRef\.current\.contentWindow/);
assert.match(shell, /d\.instance !== instance/);
assert.match(shell, /sandbox="allow-scripts"/);
assert.doesNotMatch(shell, /onLoad=.*setReady/);
console.log('PASS: runtime diagnostics (dedupe/bounds/CSP), instance binding, content semantics and sandbox invariants');
