/** The toolbar can be portaled outside its source block while sticky. */
export async function openCodeMenu(page, block) {
  const id = await block.getAttribute('data-code-block-id');
  await block.scrollIntoViewIfNeeded();
  const button = page.locator(`[data-testid="code-block-more"][data-code-owner="${id}"]`);
  await button.click();
  const buttonId = await button.getAttribute('id');
  const menu = page.locator(`[role="menu"][aria-labelledby~="${buttonId}"]`);
  await menu.waitFor();
  return menu;
}

/** Open authorized works through the same source-first menu as the reader. */
export async function openWidgetPreviews(page) {
  const blocks = page.locator('[data-testid="code-block"][data-language="html"]');
  for (const block of await blocks.all()) {
    if (await block.getAttribute('data-view') === 'preview') continue;
    const menu = await openCodeMenu(page, block);
    const preview = menu.getByRole('menuitem', { name: '预览', exact: true });
    if (await preview.count()) await preview.click();
    else await page.keyboard.press('Escape'); // Ordinary HTML examples remain inert.
  }
}
