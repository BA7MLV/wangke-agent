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

test('continuous corners are progressive, explicit and do not affect user content', async () => {
  const css = await readFile(path.join(root, 'theme.css'), 'utf8');
  const ast = postcss.parse(css);
  const enhancement = ast.nodes.find(node => node.type === 'atrule'
    && node.name === 'supports' && node.params === '(corner-shape: superellipse(1.25))');
  assert.ok(enhancement);
  assert.equal(enhancement.nodes.length, 1);
  assert.equal(enhancement.nodes[0].selector, ':where(.ui-smooth)');
  assert.ok(enhancement.nodes[0].nodes.some(decl => decl.prop === 'corner-shape' && decl.value === 'superellipse(1.25)'));
  assert.doesNotMatch(await readFile(path.join(root, 'harness/widgetStyles.ts'), 'utf8'), /corner-shape/);
  for (const name of ['components/reasoning-chain.css', 'pages/course-chat.css']) {
    assert.doesNotMatch(await readFile(path.join(root, name), 'utf8'), /corner-shape:\s*squircle/);
  }
});

test('semantic radii keep dimension compatibility and map into Tailwind', async () => {
  const css = await readFile(path.join(root, 'theme.css'), 'utf8');
  const ast = postcss.parse(css);
  const tokens = ast.nodes.find(node => node.selector === ':root');
  const values = Object.fromEntries(tokens.nodes.filter(node => node.type === 'decl').map(node => [node.prop, node.value]));
  assert.equal(values['--radius-control'], 'var(--radius-lg)');
  assert.equal(values['--radius-panel'], 'var(--radius-xl)');
  assert.equal(values['--radius-dialog'], 'var(--radius-2xl)');
  assert.equal(values['--corner-20'], '1.25rem');
  assert.equal(values['--corner-3xl'], '2rem');
  const mapping = ast.nodes.find(node => node.name === 'theme');
  for (const name of ['control', 'panel', 'dialog']) assert.ok(mapping.nodes.some(node => node.prop === `--radius-${name}`));
  assert.match(css, /\.button--icon-only/);
  assert.match(css, /\.modal__dialog:not\(\.modal__dialog--full\)/);
});
