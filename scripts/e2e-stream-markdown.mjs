import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(process.env.BASE_URL || 'http://localhost:5188');
  await page.evaluate(async () => {
    const reactModule = await import('/node_modules/.vite/deps/react.js');
    const React = reactModule.default || reactModule;
    const client = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { createRoot } = client.default || client;
    const { Markdown } = await import('/src/components/markdown/Markdown.tsx');
    const host = document.createElement('div');
    host.id = 'markdown-test';
    host.style.cssText = 'position:fixed;inset:0;background:white;padding:16px;overflow:auto;z-index:99999';
    document.body.append(host);
    const root = createRoot(host);
    window.renderMarkdown = (content, streaming) => root.render(React.createElement(Markdown, {
      content, streaming: { hasNextChunk: streaming, tail: streaming },
    }));
  });
  const host = page.locator('#markdown-test');
  for (const source of ['$x_i^2$', '\\(x_i^2\\)', '$$\\frac{a}{b}$$', '\\[\\begin{aligned}a&=b\\\\c&=d\\end{aligned}\\]']) {
    for (let end = 1; end <= source.length; end++) {
      await page.evaluate(({ source, end }) => window.renderMarkdown(`公式：${source.slice(0, end)}`, true), { source, end });
      // Flush React and the library's streaming effect at each character boundary.
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      if (end < source.length) assert.equal(await host.locator('.katex').count(), 0);
    }
    await host.locator('.katex').waitFor();
    assert.equal(await host.locator('math').count(), 1, 'accessible MathML');
    await page.evaluate(source => window.renderMarkdown(`公式：${source}`, false), source);
    await host.locator('.katex').waitFor();
  }
  await page.evaluate(() => window.renderMarkdown('$\\notACommand{x}$', false));
  await host.locator('.md-math-error').waitFor();
  await page.evaluate(() => window.renderMarkdown('$x_i', false));
  await host.locator('.md-math-error').waitFor({ state: 'detached' });
  assert.match(await host.innerText(), /\$x_i/);
  await page.evaluate(() => window.renderMarkdown('| a | b |\n|---|---|\n| $x$ | **bold** |\n\n`$literal$`\n\n$20 and $30', false));
  await host.locator('table .katex').waitFor();
  assert.equal(await host.locator('strong').innerText(), 'bold');
  assert.equal(await host.locator('code').innerText(), '$literal$');
  assert.match(await host.innerText(), /\$20 and \$30/);
  for (const [source, selector, text] of [
    ['**正在输出', 'strong', '正在输出'],
    ['[参考资料](https://exam', 'span', '参考资料'],
    ['`const value', 'code', 'const value'],
  ]) {
    await page.evaluate(source => window.renderMarkdown(source, true), source);
    await page.waitForFunction(text => document.querySelector('#markdown-test')?.textContent?.includes(text), text);
    assert.ok(await host.locator(selector).count());
    assert.equal(await host.locator('a').count(), 0, 'no incomplete URL navigation');
  }
  assert.deepEqual(errors, []);
  console.log('Browser streaming Markdown: character splits, KaTeX, MathML, errors, stop, table and code passed.');
} finally {
  await browser.close();
}
