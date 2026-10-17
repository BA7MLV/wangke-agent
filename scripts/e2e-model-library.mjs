import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ reducedMotion: 'reduce' });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const base = process.env.BASE_URL ?? 'http://localhost:5173';
const state = () => page.evaluate(() => JSON.parse(localStorage.getItem('wangke-settings')).state);
try {
  await page.route('https://models.test/**', (route) => route.fulfill({ json: { data: [{ id: 'custom-alpha' }, { id: 'custom-beta' }] } }));
  await page.goto(`${base}/#/settings`);
  await page.getByTestId('card-model-library').waitFor();
  await page.evaluate(async () => {
    const { useSettings } = await import('/src/store/settings.ts');
    const current = useSettings.getState();
    current.update({ providers: current.providers.map((p) => ({ ...p, baseUrl: 'https://models.test/v1', apiKey: 'test-key' })) });
  });
  await page.reload();
  await page.getByTestId('btn-check-models').click();
  await page.getByText('custom-alpha', { exact: true }).waitFor();
  assert.equal((await state()).savedModels, undefined, 'fetch must not add models');
  await page.getByText('custom-alpha', { exact: true }).click();
  await page.getByRole('button', { name: '添加所选模型（1）', exact: true }).click();
  assert.ok((await state()).savedModels.some((m) => m.model === 'custom-alpha'));
  assert.ok(!(await state()).savedModels.some((m) => m.model === 'custom-beta'));
  await page.getByRole('button', { name: '编辑 custom-alpha', exact: true }).click();
  await page.getByRole('textbox', { name: '模型显示名称', exact: true }).fill('日常问答');
  await page.getByRole('button', { name: '保存模型', exact: true }).click();
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  await page.getByTestId('model-picker').click();
  await page.getByRole('searchbox', { name: '搜索已添加模型' }).fill('日常问答');
  await page.getByRole('option').filter({ hasText: '日常问答' }).click();
  assert.equal((await state()).llmModel.model, 'custom-alpha');
  await page.keyboard.press('Escape');
  await page.goto(`${base}/#/settings`);
  await page.getByRole('button', { name: '编辑 日常问答', exact: true }).click();
  await page.getByRole('textbox', { name: '模型 ID', exact: true }).fill('custom-alpha-v2');
  await page.getByRole('button', { name: '保存模型', exact: true }).click();
  assert.equal((await state()).llmModel.model, 'custom-alpha-v2', 'editing active ID migrates selection');
  await page.reload();
  await page.getByRole('button', { name: '编辑 日常问答', exact: true }).waitFor();
  assert.equal((await state()).llmModel.model, 'custom-alpha-v2');
  await page.getByRole('button', { name: '手动添加', exact: true }).click();
  await page.getByRole('textbox', { name: '模型 ID', exact: true }).fill('custom-alpha-v2');
  await page.getByRole('button', { name: '保存模型', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '已添加' }).waitFor();
  await page.getByRole('textbox', { name: '模型 ID', exact: true }).fill('manual-model');
  await page.getByRole('button', { name: '保存模型', exact: true }).click();
  assert.ok((await state()).savedModels.some((m) => m.model === 'manual-model'));
  await page.getByTestId('model-button-llmModel').evaluate((el) => el.scrollIntoView({ behavior: 'instant', block: 'center' }));
  await page.getByTestId('model-button-llmModel').click();
  await page.getByTestId('model-option-manual-model').click();
  assert.equal((await state()).llmModel.model, 'manual-model', 'settings uses the same library');
  await page.getByRole('button', { name: '移除 日常问答', exact: true }).click();
  await page.getByTestId('confirm-dialog-confirm').click();
  assert.ok(!(await state()).savedModels.some((m) => m.model === 'custom-alpha-v2'));
  const contracts = await page.evaluate(async () => {
    const { useSettings } = await import('/src/store/settings.ts');
    const { savedModelsOf, editModelPatch, modelsForSlot } = await import('/src/store/modelLibrary.ts');
    const s = useSettings.getState();
    const original = savedModelsOf(s).find((m) => m.model === 'manual-model');
    const withFavorite = { ...s, favorites: { ...s.favorites, chat: [original] } };
    const patch = editModelPatch(withFavorite, original, { ...original, model: 'renamed' });
    let rejectsActivePurpose = false;
    try { editModelPatch(s, original, { ...original, slots: ['vision'] }); } catch { rejectsActivePurpose = true; }
    const second = { ...s.providers[0], id: 'second', name: 'Second provider' };
    const multi = { ...s, providers: [...s.providers, second] };
    const added = editModelPatch(multi, null, { ...original, providerId: 'second' });
    return {
      favorite: patch.favorites.chat[0].model,
      rejectsActivePurpose,
      sameIdDifferentProvider: added.savedModels.filter((m) => m.model === 'manual-model').length,
      asrNotInChat: !modelsForSlot(s, 'chat').some((m) => m.model === s.asrModel.model),
    };
  });
  assert.deepEqual(contracts, { favorite: 'renamed', rejectsActivePurpose: true, sameIdDifferentProvider: 2, asrNotInChat: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'mobile must not overflow');
  assert.deepEqual(errors, []);
  console.log('PASS: discovery opt-in, add, alias, Chat/settings selection, active-ID/favorite migration, persistence, duplicates, manual add, remove, provider isolation, purpose validation, mobile width');
} finally {
  await browser.close();
}
