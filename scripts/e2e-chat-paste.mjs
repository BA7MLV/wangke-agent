// BASE_URL=http://127.0.0.1:5191 node scripts/e2e-chat-paste.mjs
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.BASE_URL || 'http://127.0.0.1:5173';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // Isolated static-only storage; no uploads to the user's actual backend.
  await page.route('**/api/v1/**', (route) => route.fulfill({ status: 404, body: '' }));
  await page.goto(`${base}/#/chat`);
  const input = page.getByRole('textbox', { name: '给 AI 助手发送消息', exact: true });
  await input.waitFor();
  await page.waitForFunction(() => !document.querySelector('.course-chat__input')?.disabled);
  const paste = async (target, text) => {
    await page.evaluate((text) => navigator.clipboard.writeText(text), text);
    await target.focus();
    await target.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V');
  };
  const draftItems = () => page.evaluate(async () => {
    const { useChatAttachments } = await import('/src/store/chatAttachments.ts');
    return Promise.all(useChatAttachments.getState().items.map(async (item) => ({
      name: item.file.name, size: item.file.size, text: await item.file.text(), ready: !!item.value,
    })));
  });
  const clearAttachments = () => page.evaluate(async () => {
    const { useChatAttachments } = await import('/src/store/chatAttachments.ts');
    const store = useChatAttachments.getState();
    await store.discard(Number(store.sessionKey));
  });

  for (const text of ['短文本', 'a'.repeat(4000), '🙂'.repeat(1000)]) {
    await input.fill('前后');
    await input.evaluate((el) => el.setSelectionRange(1, 1));
    await paste(input, text);
    await page.waitForFunction((expected) => document.querySelector('.course-chat__input').value === expected, `前${text}后`);
    assert.deepEqual(await draftItems(), []);
  }
  console.log('✓ Native short/exactly-4000-byte paste inserts at the caret');

  for (const text of ['a'.repeat(4001), '中'.repeat(1334), '🙂'.repeat(1001)]) {
    await input.fill('保留原草稿');
    await paste(input, text);
    await page.locator('[data-testid="chat-attachment"][data-state="ready"]').waitFor();
    assert.equal(await input.inputValue(), '保留原草稿');
    const [item] = await draftItems();
    assert.match(item.name, /\.txt$/);
    assert.equal(item.size, Buffer.byteLength(text));
    assert.equal(item.text, text);
    await page.getByText('粘贴内容超过 4000 字节，已自动转换为 txt 附件', { exact: true }).first().waitFor();
    await clearAttachments();
  }
  console.log('✓ ASCII/Chinese/emoji long pastes create full txt attachments and preserve the draft');

  await input.fill('多行草稿\n'.repeat(40));
  await page.getByRole('button', { name: '展开输入框', exact: true }).click();
  const expanded = page.getByRole('textbox', { name: '完整消息', exact: true });
  await expanded.waitFor();
  const before = await expanded.inputValue();
  await paste(expanded, '展开时粘贴'.repeat(500));
  await page.waitForFunction(async () => {
    const { useChatAttachments } = await import('/src/store/chatAttachments.ts');
    return useChatAttachments.getState().items[0]?.value != null;
  });
  assert.equal(await expanded.inputValue(), before);
  assert.equal((await draftItems())[0].text, '展开时粘贴'.repeat(500));
  await page.getByRole('button', { name: '收起输入框', exact: true }).click();
  await expanded.waitFor({ state: 'hidden' });
  await clearAttachments();
  console.log('✓ Expanded composer uses the same conversion');

  await input.evaluate((el) => {
    const clipboardData = new DataTransfer();
    clipboardData.items.add(new File(['file paste'], '原文件.txt', { type: 'text/plain' }));
    clipboardData.setData('text/plain', '中'.repeat(2000));
    el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
  });
  await page.locator('[data-testid="chat-attachment"][data-state="ready"]').waitFor();
  assert.equal((await draftItems())[0].name, '原文件.txt');
  assert.equal((await draftItems()).length, 1);
  await clearAttachments();
  console.log('✓ Clipboard files retain priority over accompanying text');

  await page.evaluate(async () => {
    const { useChatAttachments } = await import('/src/store/chatAttachments.ts');
    useChatAttachments.getState().add(Array.from({ length: 8 }, (_, i) => new File(['full'], `full-${i}.txt`, { type: 'text/plain' })));
  });
  await page.waitForFunction(async () => {
    const { useChatAttachments } = await import('/src/store/chatAttachments.ts');
    return useChatAttachments.getState().items.every((item) => item.value);
  });
  await input.fill('附件满时也保留草稿');
  await paste(input, 'a'.repeat(4001));
  await page.getByText('每条消息最多 8 个附件，请移除附件后重新粘贴', { exact: true }).waitFor();
  assert.equal(await input.inputValue(), '附件满时也保留草稿');
  assert.equal((await draftItems()).length, 8);
  assert.deepEqual(errors, []);
  console.log('✓ Full attachment list reports an error without changing the draft; no page errors');
} finally {
  await browser.close();
}
