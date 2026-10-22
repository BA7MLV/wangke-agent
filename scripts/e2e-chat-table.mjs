import assert from 'node:assert/strict';
import { chromium } from 'playwright';

/**
 * 流式表格 e2e：
 *   - 逐字符流：任何时刻都不出现少列的半行；流式期间没有展开按钮；
 *   - 流结束：默认只露 6 行，展开 / 收起可用，复制 Markdown 内容正确；
 *   - 手机：入口变成 Bottom Sheet，完整表在 Sheet 里，半屏 → 全屏 → 关闭；
 *   - 短表不出现折叠入口。
 *
 * 页面内自跑逐字符循环（同 e2e-svg-stream 的理由）：整段流只有一两秒，
 * 跨进程逐字符往返会漏掉大部分中间态，也把测试拖成几分钟。
 */
const base = process.env.BASE_URL || 'http://localhost:5173';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1100, height: 900 },
    hasTouch: true,
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto(base);
  await page.waitForSelector('#root > *');

  await page.evaluate(async () => {
    const reactModule = await import('/node_modules/.vite/deps/react.js');
    const React = reactModule.default || reactModule;
    const client = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { createRoot } = client.default || client;
    const { Markdown } = await import('/src/components/markdown/Markdown.tsx');
    const { MarkdownTable } = await import('/src/components/MdTable.tsx');

    const host = document.createElement('div');
    host.id = 'markdown-table-test';
    host.style.cssText =
      'position:fixed;inset:0;background:var(--surface);padding:16px;overflow:auto;z-index:99999';
    document.body.append(host);
    const root = createRoot(host);
    window.renderTable = (content, streaming) =>
      root.render(
        React.createElement(Markdown, {
          content,
          components: { table: MarkdownTable },
          streaming: { hasNextChunk: streaming, tail: false },
        }),
      );
  });

  const header = '| 课程 | 时长 | 进度 |\n| --- | ---: | ---: |\n';
  const rows = Array.from({ length: 12 }, (_, i) => {
    const n = i + 1;
    // 最后一行带链接 / 行内代码：复制回 Markdown 时要能还原这两种行内结构
    if (n === 12) return '| [高数 第12讲](https://example.com) `L12` | 52 | 40% |\n';
    return `| 高数 第${n}讲 | ${40 + n} | ${100 - n * 5}% |\n`;
  });
  const content = header + rows.join('');

  // ── 逐字符流：完整行 / 无交互 ─────────────────────────────────────────────
  const stream = await page.evaluate(async ({ content }) => {
    const violations = [];
    let lastRows = 0;
    let sawTable = false;
    let sawProgress = false;

    for (let end = 1; end <= content.length; end++) {
      window.renderTable(content.slice(0, end), true);
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );

      const table = document.querySelector('#markdown-table-test [data-testid="md-table"]');
      if (!table) continue;
      sawTable = true;

      const rows = [...table.querySelectorAll('tr[data-md-row="body"]')];
      const bad = rows.filter((row) => row.querySelectorAll('td').length !== 3);
      if (bad.length > 0) {
        violations.push(`char ${end}: ${bad.length} incomplete row(s)`);
      }
      if (table.querySelector('.md-table-expand')) {
        violations.push(`char ${end}: expand button visible while streaming`);
      }
      if (table.querySelector('.md-table-progress')) sawProgress = true;
      if (rows.length < lastRows) {
        violations.push(`char ${end}: rows shrank ${lastRows} → ${rows.length}`);
      }
      lastRows = rows.length;
      if (rows.length > 6) {
        violations.push(`char ${end}: streaming preview exposed ${rows.length} rows`);
      }
    }

    return { violations, sawTable, sawProgress, lastRows };
  }, { content });

  assert.deepEqual(stream.violations, []);
  assert.equal(stream.sawTable, true, 'table should appear before the stream ends');
  assert.equal(stream.sawProgress, true, 'long stream should show the non-interactive progress note');
  assert.equal(stream.lastRows, 6, 'streaming preview is capped at 6 rows');

  // ── 流结束：默认折叠 + 展开 / 收起 + 复制 ────────────────────────────────
  await page.evaluate((content) => window.renderTable(content, false), content);
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );

  const tableRoot = page.locator('#markdown-table-test [data-testid="md-table"]');
  await tableRoot.waitFor();
  assert.equal(await tableRoot.locator('tr[data-md-row="body"]').count(), 6);
  assert.equal(await tableRoot.getAttribute('data-streaming'), null);
  const expand = tableRoot.locator('.md-table-expand');
  assert.equal(await expand.count(), 1);
  assert.match(await expand.innerText(), /查看完整表格/);

  await expand.click();
  assert.equal(await tableRoot.locator('tr[data-md-row="body"]').count(), 12);
  assert.equal(await expand.getAttribute('aria-expanded'), 'true');
  assert.match(await expand.innerText(), /收起/);

  await expand.click();
  assert.equal(await tableRoot.locator('tr[data-md-row="body"]').count(), 6);
  assert.equal(await expand.getAttribute('aria-expanded'), 'false');

  const copyMarkdown = tableRoot.getByRole('button', { name: '复制为 Markdown' });
  await copyMarkdown.click();
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('#markdown-table-test .md-table-copy')].some(
        (el) => el.textContent?.includes('已复制'),
      ),
  );
  const clipboard = await page.evaluate(async () => {
    try {
      return await navigator.clipboard.readText();
    } catch {
      return null;
    }
  });
  if (clipboard !== null) {
    assert.ok(clipboard.startsWith('| 课程 | 时长 | 进度 |'), clipboard);
    assert.ok(clipboard.includes('| --- | ---: | ---: |'), clipboard);
    assert.equal(clipboard.split('\n').length, 14, 'header + separator + 12 rows');
    assert.ok(
      clipboard.includes(
        '| [高数 第12讲](https://example.com) `L12` | 52 | 40% |',
      ),
      clipboard,
    );
  }

  // ── 短表：不出现折叠入口 ─────────────────────────────────────────────────
  await page.evaluate(
    () => window.renderTable('| a | b |\n| --- | --- |\n| 1 | 2 |', false),
  );
  await page.waitForTimeout(100);
  assert.equal(
    await page.locator('#markdown-table-test [data-testid="md-table"] .md-table-expand').count(),
    0,
  );

  // ── 单列表：8 行也全部露出来，不给「展开」（它更像一列清单）─────────────
  const oneColumn = `| 条目 |\n| --- |\n${Array.from(
    { length: 8 },
    (_, i) => `| 第 ${i + 1} 项 |`,
  ).join('\n')}`;
  await page.evaluate((oneColumn) => window.renderTable(oneColumn, false), oneColumn);
  await page.waitForTimeout(100);
  const oneColumnRoot = page.locator('#markdown-table-test [data-testid="md-table"]');
  assert.equal(await oneColumnRoot.locator('tr[data-md-row="body"]').count(), 8);
  assert.equal(await oneColumnRoot.locator('.md-table-expand').count(), 0);

  // ── 宽而短的表：桌面不出现「展开」（横向滚动已经够用），但复制入口要在 ──
  const wide = [
    '| very_long_column_header_a | very_long_column_header_b | very_long_column_header_c | very_long_column_header_d | very_long_column_header_e | very_long_column_header_f | very_long_column_header_g | very_long_column_header_h |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    '| value_a | value_b | value_c | value_d | value_e | value_f | value_g | value_h |',
    '| value_i | value_j | value_k | value_l | value_m | value_n | value_o | value_p |',
  ].join('\n');
  await page.evaluate((wide) => window.renderTable(wide, false), wide);
  await page.waitForTimeout(200);
  const wideRoot = page.locator('#markdown-table-test [data-testid="md-table"]');
  assert.equal(await wideRoot.locator('tr[data-md-row="body"]').count(), 2);
  assert.equal(await wideRoot.locator('.md-table-expand').count(), 0);
  assert.equal(await wideRoot.locator('.md-table-copy').count(), 2);

  // ── 手机：Bottom Sheet ───────────────────────────────────────────────────
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(150);
  const mobileContent = wide.split('\n').slice(0, 2).join('\n') + '\n' +
    Array.from({ length: 40 }, (_, i) =>
      `| row_${i} | value_b | value_c | value_d | value_e | value_f | value_g | value_h |`,
    ).join('\n');
  await page.evaluate((content) => window.renderTable(content, false), mobileContent);
  await page.waitForTimeout(150);

  const mobileExpand = page.locator('#markdown-table-test .md-table-expand');
  assert.match(await mobileExpand.innerText(), /查看完整表格/);
  await mobileExpand.click();

  const sheet = page.getByTestId('md-table-sheet');
  await sheet.waitFor();
  assert.equal(await sheet.getAttribute('data-snap'), 'half');
  assert.equal(await sheet.locator('tr[data-md-row="body"]').count(), 40);
  assert.equal(await sheet.locator('table').count(), 1);
  assert.equal(await sheet.locator('thead th').count(), 8);

  // 从真实表格内容起滑，而不是赋 scrollTop（后者无法发现手势被截住）。
  const cdp = await context.newCDPSession(page);
  const swipeTable = async (dx, dy) => {
    const box = await sheet.locator('.md-table-sheet__body').boundingBox();
    assert.ok(box);
    const x = box.x + box.width * 0.8;
    const y = box.y + box.height * 0.8;
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart', touchPoints: [{ x, y }],
    });
    for (let i = 1; i <= 12; i++) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove', touchPoints: [{ x: x + dx * i / 12, y: y + dy * i / 12 }],
      });
      await page.waitForTimeout(16);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  const waitForScroll = (axis) => page.waitForFunction((axis) =>
    document.querySelector('.md-table-sheet__body')?.[axis] > 40, axis,
  );
  await page.waitForTimeout(400);
  await swipeTable(0, -120);
  await waitForScroll('scrollTop');
  await swipeTable(-180, 0);
  await waitForScroll('scrollLeft');
  assert.equal(await sheet.getAttribute('data-snap'), 'half', 'scrolling must not drag the sheet');

  await sheet.getByRole('button', { name: '展开表格' }).click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="md-table-sheet"]')?.getAttribute('data-snap') === 'full',
  );
  await page.waitForTimeout(400);
  await sheet.locator('.md-table-sheet__body').evaluate((el) => {
    el.scrollTop = 0;
    el.scrollLeft = 0;
  });
  await swipeTable(0, -180);
  await waitForScroll('scrollTop');
  await swipeTable(-180, 0);
  await waitForScroll('scrollLeft');

  await sheet.getByRole('button', { name: '关闭表格' }).click();
  await sheet.waitFor({ state: 'detached' });

  // ── 手机流式：列宽有 px 下限，表头不被压成竖排 ───────────────────────────
  await page.evaluate((content) => window.renderTable(content, true), content);
  await page.waitForTimeout(200);
  const streamingHeaderWidths = await page.evaluate(() =>
    [...document.querySelectorAll('#markdown-table-test thead th')].map(
      (th) => th.getBoundingClientRect().width,
    ),
  );
  assert.equal(streamingHeaderWidths.length, 3);
  assert.ok(
    streamingHeaderWidths.every((width) => width >= 60),
    `streaming header columns too narrow: ${JSON.stringify(streamingHeaderWidths)}`,
  );

  assert.deepEqual(errors, []);
  console.log(
    'PASS streaming rows stay complete, 6-row preview, expand/collapse, Markdown copy, short table, mobile sheet touch scroll in both axes at both snaps/close',
  );
} finally {
  await browser.close();
}
