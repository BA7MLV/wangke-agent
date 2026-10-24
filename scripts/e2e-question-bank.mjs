// Isolated browser contexts + mocked model responses: verifies the real tool/UI/storage chain,
// not the accuracy of an external model's PDF extraction. No live API or user data is used.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:5173';
const pdf = (await readFile(new URL('./fixtures/sample-zh.pdf', import.meta.url))).toString('base64');
// A real PDF with positioned text, colored original pixels and a blank/scanned-style second page.
function numberedPdf() {
  const stream = 'BT /F1 14 Tf 40 740 Td (1. Original first question) Tj 0 -40 Td (A. One   B. Two) Tj ET\n0.2 0.6 0.8 rg 50 550 180 100 re f\nBT /F1 14 Tf 40 360 Td (2. Original second question) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << >> >>'];
  let data = '%PDF-1.4\n'; const offsets = [0];
  for (const [i, object] of objects.entries()) { offsets.push(data.length); data += `${i + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = data.length;
  data += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('');
  return Buffer.from(data + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`).toString('base64');
}
const sse = (delta, finish_reason = 'stop') => `data: ${JSON.stringify({ choices: [{ delta, finish_reason }] })}\n\ndata: [DONE]\n\n`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const mobile of [false, true]) {
    const context = await browser.newContext({
      locale: 'zh-CN', reducedMotion: 'reduce',
      viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
      isMobile: mobile, hasTouch: mobile,
    });
    await context.route('**/api/v1/cloud/status', route => route.fulfill({ json: { cloud: false } }));
    await context.route('https://models.dev/**', route => route.fulfill({ json: {} }));
    await context.addInitScript(() => {
      if (window.top !== window) return;
      if (!localStorage.getItem('wangke-settings')) localStorage.setItem('wangke-settings', JSON.stringify({ version: 5, state: {
        uiLanguage: 'zh-CN', theme: 'light',
        providers: [{ id: 'test', name: 'Test', baseUrl: 'https://question-bank.test/v1', apiKey: 'fake-test-key', serves: ['chat'], catalogId: '' }],
        llmModel: { providerId: 'test', model: 'test-model' },
      } }));
      window.__bankImport = (path) => {
        const resource = performance.getEntriesByType('resource').findLast(entry => new URL(entry.name).pathname === path);
        return import(resource?.name ?? path);
      };
    });
    const sourceId = 'question-bank-e2e-pdf';
    const bankId = `__course_questions__${sourceId}`;
    const questions = Array.from({ length: 7 }, (_, index) => ({
      stem: `${index + 1}. ${index === 0 ? '原卷页面图题：请选择正确选项。' : '原题练习，请选择正确选项。'}`,
      options: ['第一项', '第二项', '第三项', '第四项'], answer: 1,
      answerSource: index === 2 ? 'ai' : index === 3 || index === 6 ? 'missing' : index === 1 ? 'verified' : 'original',
      explanation: index === 2 ? 'AI 补充解析：此答案尚待核验。' : index === 3 || index === 6 ? '原文未附答案与解析，待核对。' : '原卷答案为 B，见第 3 页；原文未附解析。',
      source: { courseId: sourceId, name: '原题测试卷.pdf', page: 1 },
      ...(index === 0 ? { images: [`#source-image/${sourceId}/page-1`] } : {}),
    }));
    for (const q of questions) if (q.answerSource === 'missing') q.answer = -1;
    const markdown = '# 原题测试卷 · 题库\n\n覆盖：第 1–3 页（测试数据）。\n\n我的笔记：保留。\n\n```quiz\n' + JSON.stringify({ questions }, null, 2) + '\n```\n';
    const extraction = [
      ['read', { path: '/skills/' + encodeURIComponent('原题题库') }],
      ['read', { path: '/courses/current/info' }],
      ['read', { path: '/courses/current/material', start: 1, end: 3 }],
      ['read', { path: '/courses/current/images', start: 1, end: 1 }],
      ['read', { path: '/courses/current/questions.md' }],
      ['edit', { path: '/courses/current/questions.md', create: true, content: markdown }],
      ['present_quiz', { path: '/courses/current/questions.md', offset: 0, limit: 5 }],
    ];
    const requests = [];
    await context.route('https://question-bank.test/**', route => {
      const body = route.request().postDataJSON();
      if (!body.stream) return route.fulfill({ json: { choices: [{ message: { role: 'assistant', content: '原题练习' } }] } });
      requests.push(body);
      const lastUser = body.messages.findLastIndex(message => message.role === 'user');
      const text = body.messages[lastUser].content;
      if (typeof text === 'string' && text.startsWith('请对这道题提供 AI 参考批改')) return route.fulfill({ contentType: 'text/event-stream', body: sse({ role: 'assistant', content: 'AI 参考批改：这只是建议，请对照原卷核验，不计入自动成绩。' }) });
      const tools = body.messages.slice(lastUser + 1).filter(message => message.role === 'tool');
      const extracting = text.includes('逐页提取');
      const continuing = text === '继续';
      // Independent reads share a round, so the normal six-round guard remains enabled.
      const steps = extracting ? { 0: extraction.slice(0, 2), 2: extraction.slice(2, 5), 5: [extraction[5]], 6: [extraction[6]] } : { 0: [['present_quiz', {
        path: text.includes('/courses/current/material') ? '/courses/current/material' : '/courses/current/questions.md',
        offset: continuing ? 5 : 0, limit: 5,
      }]] };
      const step = steps[tools.length];
      if (!step) return route.fulfill({ contentType: 'text/event-stream', body: sse({ role: 'assistant', content: extracting
        ? `测试题库已保存：[打开题库](#/player/${bankId})。请在题卡中作答。` : '请继续在题卡中作答。' }) });
      return route.fulfill({ contentType: 'text/event-stream', body: sse({ role: 'assistant', tool_calls: step.map(([name, args], index) => ({
        index, id: `bank-${requests.length}-${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) },
      })) }, 'tool_calls') });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(BASE);
    await page.evaluate(async ({ pdf, sourceId }) => {
      const { db } = await window.__bankImport('/src/store/db.ts');
      const now = Date.now();
      const folderId = await db.folders.add({ name: '原题测试', createdAt: now });
      await db.videos.put({ id: sourceId, name: '原题测试卷.pdf', kind: 'material', materialFormat: 'pdf',
        status: 'transcribed', folderId, unitCount: 3, duration: 0, createdAt: now });
      await db.files.put({ id: sourceId, blob: new Blob([Uint8Array.from(atob(pdf), c => c.charCodeAt(0))], { type: 'application/pdf' }) });
      await db.materialBlocks.add({ materialId: sourceId, idx: 0, unit: 1, unitLabel: '第 1 页', text: '原题测试用正文' });
    }, { pdf, sourceId });
    await page.goto(`${BASE}/#/player/${sourceId}`);
    const openAssistant = page.getByRole('button', { name: '打开学习助手', exact: true });
    await page.getByTestId('study-assistant-toggle').waitFor();
    if (await openAssistant.isVisible()) await openAssistant.click();
    const composer = page.getByTestId('chat-input').locator('textarea');
    await composer.waitFor();
    await page.getByTestId('panel-chat-add').click();
    await page.getByTestId('question-bank-extract').click();
    const cards = page.getByTestId('quiz-card');
    await cards.first().waitFor({ timeout: 60000 });
    await page.getByRole('link', { name: '打开题库', exact: true }).waitFor();
    await page.getByTestId('chat-stop').waitFor({ state: 'hidden' });
    assert.equal(await cards.first().locator('.quiz-q').count(), 5);
    assert.equal(await cards.first().getByTestId('quiz-explain').count(), 0, 'answers stay hidden until a pick');
    assert.match(JSON.stringify(requests[0].tools), /present_quiz/);
    assert.match(requests[0].messages[0].content, /原题题库/);
    const qNodes = cards.first().locator('.quiz-q');
    const image = qNodes.first().locator('.material-image__preview img');
    await image.waitFor();
    await image.evaluate(img => img.decode());
    assert.ok(await image.evaluate(img => img.naturalWidth > 500), 'original PDF page is rendered, not an AI redrawing');
    await qNodes.first().getByRole('button', { name: /放大查看/ }).click();
    const dialog = page.getByTestId('material-image-dialog');
    await dialog.waitFor();
    assert.match(await dialog.getByRole('link', { name: /打开原文/ }).getAttribute('href'), /\?unit=1$/);
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();

    for (const [index, pick] of [0, 1, 0, 2, 1].entries()) await qNodes.nth(index).locator('button.quiz-option').nth(pick).click();
    await qNodes.first().getByText('正确答案：B', { exact: true }).waitFor();
    await qNodes.nth(1).getByText('回答正确', { exact: true }).waitFor();
    await qNodes.nth(2).getByText('已作答；AI 参考答案：B（待核验）', { exact: true }).waitFor();
    await qNodes.nth(3).getByText('已作答，待补充答案后批改', { exact: true }).waitFor();
    await qNodes.first().getByText('已记录到', { exact: false }).waitFor();
    assert.match(await cards.first().locator('.quiz-score').textContent(), /2\/3.*2 题待核验/);
    for (const index of [2, 3]) {
      assert.equal(await qNodes.nth(index).locator('.quiz-option--wrong, .quiz-option--correct').count(), 0);
      assert.equal(await qNodes.nth(index).locator('.quiz-option--selected[aria-pressed="true"]').count(), 1);
    }
    const readState = () => page.evaluate(async ({ sourceId, bankId }) => {
      const { db } = await window.__bankImport('/src/store/db.ts');
      const { parseWrongbook } = await window.__bankImport('/src/study/wrongbook.ts');
      const { readWrongbook } = await window.__bankImport('/src/store/wrongbook.ts');
      const { getMaterialFile } = await window.__bankImport('/src/store/fileStore.ts');
      const chat = (await db.chats.where('videoId').equals(sourceId).sortBy('createdAt')).filter(row => row.quiz);
      return { chat, entries: parseWrongbook(await readWrongbook()), markdown: await (await getMaterialFile(bankId)).text(),
        file: await db.videos.get(bankId), source: await db.videos.get(sourceId) };
    }, { sourceId, bankId });
    let state = await readState();
    assert.equal(state.entries.length, 1, 'only the verified wrong answer is collected');
    assert.deepEqual(state.entries[0].question.images, questions[0].images);
    assert.equal(state.entries[0].source.courseId, sourceId);
    assert.equal(state.file.folderId, state.source.folderId);
    assert.equal(state.markdown, markdown);
    assert.deepEqual(state.chat[0].quiz.picks, [0, 1, 0, 2, 1]);
    assert.deepEqual(state.chat[0].quiz.data.bank, { path: '/courses/current/questions.md', offset: 0, total: 7 });
    await page.reload();
    await page.getByTestId('study-assistant-toggle').waitFor();
    if (await openAssistant.isVisible()) await openAssistant.click();
    await cards.first().waitFor();
    assert.equal(await qNodes.first().locator('.quiz-option--wrong').count(), 1, 'reload restores grading and picks');
    await composer.fill('继续');
    await composer.press('Enter');
    await cards.nth(1).waitFor();
    await page.getByTestId('chat-stop').waitFor({ state: 'hidden' });
    assert.equal(await cards.nth(1).locator('.quiz-q').count(), 2);
    assert.match(requests.findLast(body => body.messages.some(message => message.role === 'user' && message.content === '继续')).messages.map(message => message.content).join('\n'), /题库练习快照[\s\S]*offset=5/);
    const nextQs = cards.nth(1).locator('.quiz-q');
    await nextQs.nth(0).locator('button.quiz-option').nth(1).click();
    await nextQs.nth(1).locator('button.quiz-option').nth(0).click();
    assert.match(await cards.nth(1).locator('.quiz-score').textContent(), /1\/1.*1 题待核验/);
    if (process.env.SCREENSHOT_PATH && !mobile) await page.screenshot({ path: process.env.SCREENSHOT_PATH, animations: 'disabled' });
    assert.equal(await cards.last().evaluate(node => node.scrollWidth > node.clientWidth + 1), false, 'no question-card overflow');

    // An ordinary Markdown edit changes new practice, never a historical grade.
    await page.evaluate(async bankId => {
      const { getMaterialFile } = await window.__bankImport('/src/store/fileStore.ts');
      const { saveMarkdownMaterial } = await window.__bankImport('/src/materials/markdownFile.ts');
      const before = await (await getMaterialFile(bankId)).text();
      await saveMarkdownMaterial(bankId, before.replace('"answer": 1', '"answer": 2'), before);
    }, bankId);
    await page.getByTestId('panel-chat-add').click();
    await page.getByTestId('question-bank-practice').click();
    await cards.nth(2).waitFor();
    await page.getByTestId('chat-stop').waitFor({ state: 'hidden' });
    await cards.nth(2).locator('.quiz-q').first().locator('button.quiz-option').nth(2).click();
    await cards.nth(2).locator('.quiz-q').first().getByText('回答正确', { exact: true }).waitFor();
    assert.match(await qNodes.first().locator('.quiz-result').innerText(), /正确答案：B/, 'old snapshot is unchanged');
    state = await readState();
    assert.equal(state.chat[2].quiz.data.questions[0].answer, 2);
    assert.equal(state.entries.length, 1, 'correct new attempt and refresh do not duplicate wrongbook history');
    assert.equal(state.entries[0].attempts.length, 1);
    assert.match(state.markdown, /我的笔记：保留/);

    // New types share the same editable bank, host grading, chat snapshots and wrongbook.
    const base = { explanation: '原文参考解析。', answerSource: 'original', source: questions[0].source };
    const mixed = [
      { ...base, stem: '多选原题', type: 'multiple', options: ['甲', '乙', '丙'], answer: [0, 2] },
      { ...base, stem: '判断原题', type: 'boolean', answer: false },
      { ...base, stem: '填空原题', type: 'fill', answer: ['北京', '2'], acceptedAnswers: [['北京', '北京市'], ['2']] },
      { ...base, stem: '排序原题', type: 'ordering', options: ['先甲', '后乙'], answer: [1, 0] },
      { ...base, stem: '配对原题', type: 'matching', options: ['左甲', '左乙'], matches: ['右一', '右二'], answer: [1, 0] },
      { ...base, stem: '证明原题', type: 'freeform', typeLabel: '证明题', answer: '原文参考证明。' },
      { ...base, stem: '阅读材料与小题', type: 'composite', parts: [
        { ...base, stem: '小题一', type: 'boolean', answer: true },
        { ...base, stem: '小题二：解释理由', type: 'freeform', answer: '原文理由。' },
      ], answer: [true, '原文理由。'] },
      { ...base, stem: '特殊交互原题', type: 'freeform', typeLabel: '交互题', answer: '原文交互参考。', presentation: { html: '<button onclick="__wbw.setAnswerDraft(\'交互答案\')">填写交互答案</button><button onclick="__wbw.setAnswerDraft({answer:\'伪造\',selfGrade:true}).catch(()=>{})">伪造自评分</button>' } },
      { ...base, stem: '缺答案多空原题', type: 'fill', blanks: 2, answerSource: 'missing', answer: -1 },
      { ...base, stem: '只有两个选项的原题', options: ['甲', '乙'], answer: 1 },
    ];
    await page.evaluate(async ({ bankId, mixed }) => {
      const { getMaterialFile } = await window.__bankImport('/src/store/fileStore.ts');
      const { saveMarkdownMaterial } = await window.__bankImport('/src/materials/markdownFile.ts');
      const before = await (await getMaterialFile(bankId)).text();
      await saveMarkdownMaterial(bankId, '# 混合原题\n\n```quiz\n' + JSON.stringify({ questions: mixed }) + '\n```\n', before);
    }, { bankId, mixed });
    await page.getByTestId('panel-chat-add').click();
    await page.getByTestId('question-bank-practice').click();
    const objective = cards.filter({ hasText: '多选原题' });
    await objective.waitFor().catch(async error => {
      console.error('Mixed bank failure:', (await page.locator('body').innerText()).slice(-8000));
      console.error('Last tools:', requests.at(-1)?.messages.filter(m => m.role === 'tool'));
      console.error('Runtime errors:', errors);
      throw error;
    });
    await page.getByTestId('chat-stop').waitFor({ state: 'hidden' });
    const objectiveQs = objective.locator('.quiz-q');
    await objectiveQs.nth(0).locator('.quiz-option').nth(0).click();
    assert.equal(await objectiveQs.nth(0).getByTestId('quiz-explain').count(), 0, 'multiple selection is a draft until explicit submit');
    await objectiveQs.nth(0).locator('.quiz-option').nth(2).click();
    await objectiveQs.nth(0).getByRole('button', { name: '提交答案', exact: true }).click();
    await objectiveQs.nth(1).locator('.quiz-option').nth(0).click(); // verified wrong
    await objectiveQs.nth(1).getByRole('button', { name: '提交答案', exact: true }).click();
    await objectiveQs.nth(2).locator('input').nth(0).fill('北京市');
    await objectiveQs.nth(2).locator('input').nth(1).fill('2');
    await objectiveQs.nth(2).getByRole('button', { name: '提交答案', exact: true }).click();
    await objectiveQs.nth(3).getByRole('button', { name: '下移 A', exact: true }).click();
    await objectiveQs.nth(3).getByRole('button', { name: '提交答案', exact: true }).click();
    await objectiveQs.nth(4).locator('select').nth(0).selectOption('1');
    await objectiveQs.nth(4).locator('select').nth(1).selectOption('0');
    await objectiveQs.nth(4).getByRole('button', { name: '提交答案', exact: true }).click();
    await objectiveQs.nth(1).getByText('已记录到', { exact: false }).waitFor();
    assert.match(await objective.locator('.quiz-score').textContent(), /4\/5/);

    await composer.fill('继续'); await composer.press('Enter');
    const open = cards.filter({ hasText: '证明原题' });
    await open.waitFor();
    await page.getByTestId('chat-stop').waitFor({ state: 'hidden' });
    const openQs = open.locator('.quiz-q');
    await openQs.nth(0).locator('textarea').fill('我的证明\n中间遗漏了一步。');
    await openQs.nth(0).getByRole('button', { name: '提交答案', exact: true }).click();
    await openQs.nth(0).getByText('已作答，请对照参考答案核对', { exact: true }).waitFor();
    assert.equal(await openQs.nth(0).getByText('已记录到', { exact: false }).count(), 0, 'subjective response alone cannot write a wrong answer');
    await openQs.nth(0).getByRole('button', { name: '我已核对：需复习', exact: true }).click();
    await openQs.nth(0).getByText('已记录到', { exact: false }).waitFor();
    await openQs.nth(1).locator('.quiz-option').nth(0).click();
    await openQs.nth(1).locator('textarea').fill('我的解释理由。');
    await openQs.nth(1).getByRole('button', { name: '提交答案', exact: true }).click();
    const html = openQs.nth(2).frameLocator('iframe');
    await html.getByRole('button', { name: '伪造自评分', exact: true }).click();
    await openQs.nth(2).getByRole('alert').filter({ hasText: '草稿格式与题型不符' }).waitFor();
    assert.equal(await openQs.nth(2).getByTestId('quiz-explain').count(), 0);
    await html.getByRole('button', { name: '填写交互答案', exact: true }).click();
    await openQs.nth(2).getByLabel('交互作答草稿').filter({ hasText: '交互答案' }).waitFor();
    assert.equal(await openQs.nth(2).getByTestId('quiz-explain').count(), 0, 'HTML has only draft capability, not submit/grading authority');
    await openQs.nth(2).getByRole('button', { name: '提交答案', exact: true }).click();
    await openQs.nth(3).locator('input').nth(0).fill('任意答案一');
    await openQs.nth(3).locator('input').nth(1).fill('任意答案二');
    await openQs.nth(3).getByRole('button', { name: '提交答案', exact: true }).click();
    await openQs.nth(4).locator('.quiz-option').nth(1).click();
    assert.match(await open.locator('.quiz-score').textContent(), /1\/1/);
    if (process.env.SCREENSHOT_PATH && !mobile) {
      await openQs.nth(0).scrollIntoViewIfNeeded();
      await page.screenshot({ path: process.env.SCREENSHOT_PATH.replace(/\.png$/, '-types.png'), animations: 'disabled' });
    }
    await openQs.nth(0).getByRole('button', { name: '请求 AI 参考批改（发送消息）', exact: true }).click();
    await page.getByText('AI 参考批改：这只是建议，请对照原卷核验，不计入自动成绩。', { exact: true }).waitFor();
    await page.getByTestId('chat-stop').waitFor({ state: 'hidden' });
    state = await readState();
    assert.equal(state.entries.length, 3, 'only original single error + objective error + explicit subjective self-check');
    assert.equal(state.entries.find(e => e.question.type === 'freeform').attempts[0].grading, 'self');
    assert.equal(state.chat[4].quiz.picks[2].answer, '交互答案');
    await page.reload();
    await page.getByTestId('study-assistant-toggle').waitFor();
    if (await openAssistant.isVisible()) await openAssistant.click();
    await openQs.nth(0).getByText('自评：需复习（非自动判分）', { exact: true }).waitFor();
    await openQs.nth(2).locator('iframe').waitFor();
    assert.deepEqual(await html.locator('body').evaluate(() => window.__wbw.answerInput), { answer: '交互答案', submitted: true });
    assert.equal(await open.evaluate(node => node.scrollWidth > node.clientWidth + 1), false);

    const crops = await page.evaluate(async pdf => {
      const { db } = await window.__bankImport('/src/store/db.ts');
      const { createResourceExecutor } = await window.__bankImport('/src/harness/resources.ts');
      const { loadMaterialImage } = await window.__bankImport('/src/materials/images.ts');
      const { parseMaterialImageHref } = await window.__bankImport('/src/materials/imageRefs.ts');
      const id = 'numbered-crop-pdf';
      await db.videos.put({ id, name: '原页裁图测试.pdf', kind: 'material', materialFormat: 'pdf', duration: 0, status: 'transcribed', createdAt: Date.now() });
      await db.files.put({ id, blob: new Blob([Uint8Array.from(atob(pdf), c => c.charCodeAt(0))], { type: 'application/pdf' }) });
      const count = await db.files.count();
      const execute = createResourceExecutor({ courseId: id, kind: 'page' });
      const catalog = await execute('read', { path: '/courses/current/images', crop: 'questions', start: 1, end: 1 });
      const refs = [...catalog.matchAll(/!\[原题裁图\]\(([^)]+)\)/g)].map(m => m[1]);
      const first = parseMaterialImageHref(refs[0]);
      const [crop, full] = await Promise.all([loadMaterialImage(id, first.key), loadMaterialImage(id, 'page-1')]);
      const [cropped, original] = await Promise.all([createImageBitmap(crop.blob), createImageBitmap(full.blob)]);
      const expected = document.createElement('canvas'); expected.width = cropped.width; expected.height = cropped.height;
      const x = Math.floor(first.region.x / 1000 * original.width), y = Math.floor(first.region.y / 1000 * original.height);
      const ctx = expected.getContext('2d'); ctx.drawImage(original, -x, -y);
      const actual = document.createElement('canvas'); actual.width = cropped.width; actual.height = cropped.height;
      const ac = actual.getContext('2d'); ac.drawImage(cropped, 0, 0);
      const a = ac.getImageData(0, 0, actual.width, actual.height).data, b = ctx.getImageData(0, 0, expected.width, expected.height).data;
      const same = a.length === b.length && a.every((value, i) => value === b[i]);
      const fallback = await execute('read', { path: '/courses/current/images', crop: 'questions', start: 2, end: 2 });
      const invalid = await execute('read', { path: '/courses/current/images', crop: 'questions', start: 1, end: 1, regions: [{ page: 1, x: 900, y: 0, width: 200, height: 10 }] });
      const corrected = await execute('read', { path: '/courses/current/images', crop: 'questions', start: 1, end: 1, regions: [{ page: 1, x: 50, y: 50, width: 800, height: 450 }] });
      cropped.close(); original.close();
      return { catalog, refs, same, fallback, invalid, corrected, noNewFiles: count === await db.files.count() };
    }, numberedPdf());
    assert.equal(crops.refs.length, 2, crops.catalog);
    assert.equal(crops.same, true, 'cropped pixels are identical to original PDF render, not redrawn');
    assert.match(crops.fallback, /未能可靠定位题号/);
    assert.match(crops.fallback, /page-2\)/);
    assert.match(crops.invalid, /不能越界/);
    assert.match(crops.corrected, /page-1-region-50-50-800-450/);
    assert.equal(crops.noNewFiles, true, 'crop references create no shadow blob store');
    assert.deepEqual(errors, [], 'browser runtime errors');
    console.log(`PASS ${mobile ? 'mobile' : 'desktop'}: bank extraction, all question inputs, objective grading, subjective self-check/AI review, HTML draft isolation, persistence, automatic PDF crops/pixel identity/fallback/correction`);
    await context.close();
  }
} finally {
  await browser.close();
}
