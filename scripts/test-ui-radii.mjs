import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import postcss from 'postcss';

const root = path.resolve('apps/web/src');
async function sources(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory()
    ? sources(path.join(directory, entry.name))
    : /\.(css|tsx)$/.test(entry.name) ? [path.join(directory, entry.name)] : []))).flat();
}

test('all application radii and static spacing use the 4px grid', async () => {
  const issues = [];
  for (const file of await sources(root)) {
    const source = await readFile(file, 'utf8');
    if (file.endsWith('.tsx')) {
      for (const match of source.matchAll(/\b(?:p[xytrblse]?|gap(?:-[xy])?)-(\d+(?:\.\d+)?)(?![\w.])/g)) {
        if ((Number(match[1]) * 4) % 4) issues.push(`${file}: ${match[0]}`);
      }
      continue;
    }
    postcss.parse(source, { from: file }).walkDecls(decl => {
      const radius = /radius$/.test(decl.prop);
      if (!radius && !/^(?:padding(?:-[\w-]+)?|(?:row-|column-)?gap|--heat-gap)$/.test(decl.prop)) return;
      // Dynamic viewport geometry and safe-area insets aren't fixed design spacing.
      let value = decl.value;
      while (/[\w-]+\([^()]*\)/.test(value)) value = value.replace(/[\w-]+\([^()]*\)/g, '');
      for (const match of value.matchAll(/(?<![\w.-])(\d*\.?\d+)(px|rem)/g)) {
        const px = Number(match[1]) * (match[2] === 'rem' ? 16 : 1);
        if (radius && px >= 999) continue; // Pills are deliberately unbounded.
        if (px % 4 || (radius && px > 0 && px < 4)) issues.push(`${file}:${decl.source.start.line}: ${decl}`);
      }
    });
  }
  assert.deepEqual(issues, []);
});

test('continuous corners are progressive and range-thumb exceptions stay isolated', async () => {
  const css = await readFile(path.join(root, 'theme.css'), 'utf8');
  const ast = postcss.parse(css);
  const enhancement = ast.nodes.find(node => node.type === 'atrule'
    && node.name === 'supports' && node.params === '(corner-shape: superellipse(1.25))');
  assert.ok(enhancement);
  assert.ok(enhancement.nodes.some(rule => rule.selector === ':where(*, *::before, *::after)'));
  for (const pseudo of ['::-webkit-slider-thumb', '::-moz-range-thumb']) {
    const rule = enhancement.nodes.find(node => node.selector?.includes(pseudo));
    assert.ok(rule && !rule.selector.includes(','));
    assert.ok(rule.nodes.some(decl => decl.prop === 'corner-shape' && decl.value === 'round'));
  }
  for (const name of ['components/reasoning-chain.css', 'pages/course-chat.css']) {
    assert.doesNotMatch(await readFile(path.join(root, name), 'utf8'), /corner-shape:\s*squircle/);
  }
});
