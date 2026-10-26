import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { consumeBootstrapLink, readBootstrapLink } from '../src/cloud/bootstrapLink.ts';

const origin = 'https://learn.example.com';
const secret = 'a+b/c=d_-';
const link = `${origin}/#/setup?${new URLSearchParams({ secret })}`;
assert.equal(new URL(link).search, '', 'the HTTP query must not contain the credential');
assert.deepEqual(readBootstrapLink(link), { secret, cleanHref: `${origin}/#/setup` });
assert.deepEqual(readBootstrapLink(`${origin}/?cloud-worker=1#/setup?secret=abc&lang=zh`), {
  secret: 'abc', cleanHref: `${origin}/?cloud-worker=1#/setup?lang=zh`,
});
assert.deepEqual(readBootstrapLink(`${origin}/#/setup?secret=abc&secret=def`), {
  secret: 'abc', cleanHref: `${origin}/#/setup`,
});
assert.deepEqual(readBootstrapLink(`${origin}/#/setup?secret=`), { secret: '', cleanHref: `${origin}/#/setup` });
for (const href of [`${origin}/#/setup`, `${origin}/#/chat?secret=abc`, `${origin}/?secret=abc#/setup`]) {
  assert.deepEqual(readBootstrapLink(href), { secret: '', cleanHref: href });
}
assert.equal(readBootstrapLink(readBootstrapLink(link).cleanHref).secret, '', 'cleanup consumes the link only once');
const location = { href: link };
const history = { state: { retained: true }, replaceState(state, _title, href) { assert.equal(state.retained, true); location.href = href; } };
assert.equal(consumeBootstrapLink(location, history), secret);
assert.equal(consumeBootstrapLink(location, history), '', 'StrictMode and later reads do not reuse a URL credential');

// Exercise the exact Node snippet run by the installer, without Docker or real credentials.
const install = fs.readFileSync(new URL('../install.sh', import.meta.url), 'utf8');
const snippet = install.match(/exec -T app node -e '([\s\S]*?)\n  ' "\$\{url/)[1];
for (const status of [
  { initialized: false, bootstrapAvailable: true, expiresAt: '2026-01-01T00:15:00Z' },
  { initialized: false, bootstrapAvailable: false },
  { initialized: true, bootstrapAvailable: false },
]) {
  const lines = [];
  await vm.runInNewContext(snippet, {
    URL, URLSearchParams,
    require: () => ({ readFileSync: () => { assert.equal(status.bootstrapAvailable, true); return `${secret}\n`; } }),
    fetch: async () => ({ json: async () => status }),
    process: { argv: ['node', origin], env: {} },
    console: { log: line => lines.push(line), error: message => { throw new Error(message); } },
  });
  if (status.bootstrapAvailable) {
    const printed = lines[0].slice(lines[0].indexOf('https://'));
    assert.equal(readBootstrapLink(printed).secret, secret, 'installer emits a usable encoded setup URL');
    assert.ok(lines[1].includes(status.expiresAt));
  } else {
    assert.ok(lines.every(line => !line.includes('secret=') && !line.includes(secret)), 'no expired or consumed secret is printed');
  }
}
console.log('Bootstrap fragment autofill, URL encoding, credential cleanup and installer output checks passed');
