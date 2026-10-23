import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import 'fake-indexeddb/auto';
import { normalizeUiLanguage, resolveLocale } from '../src/i18n/locale.ts';

const storage = new Map();
globalThis.localStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
  removeItem: key => storage.delete(key),
};
globalThis.window = Object.assign(new EventTarget(), { localStorage: globalThis.localStorage });
const { useSettings, migrateSettings, getSettings } = await import('../src/store/settings.ts');
const { pickSyncSettings } = await import('../src/sync/units.ts');
const initial = getSettings();

test('new installs follow system; supported languages are resolved in preference order', () => {
  assert.equal(initial.uiLanguage, 'auto');
  assert.equal(resolveLocale('auto', ['fr-FR', 'en-GB', 'zh-CN']), 'en-US');
  assert.equal(resolveLocale('auto', ['zh-Hant', 'en-US']), 'zh-CN');
  assert.equal(resolveLocale('auto', ['fr-FR']), 'zh-CN');
  assert.equal(resolveLocale('auto', []), 'zh-CN');
  assert.equal(resolveLocale('zh-CN', ['en-US']), 'zh-CN');
  assert.equal(resolveLocale('en-US', ['zh-CN']), 'en-US');
});

test('invalid preferences fall back safely', () => {
  for (const value of [null, undefined, '', 'fr-FR', {}, 42, 'en-us']) assert.equal(normalizeUiLanguage(value), 'zh-CN');
  assert.equal(normalizeUiLanguage(undefined, 'auto'), 'auto');
  for (const value of ['auto', 'zh-CN', 'en-US']) assert.equal(normalizeUiLanguage(value), value);
});

test('legacy and modern settings without a language preserve Chinese and credentials', () => {
  const { uiLanguage, ...old } = initial;
  for (const version of [2, 3, 4]) {
    const migrated = migrateSettings({ ...old, providers: [{ ...old.providers[0], apiKey: 'keep-me' }] }, version);
    assert.equal(migrated.uiLanguage, 'zh-CN');
    assert.equal(migrated.providers[0].apiKey, 'keep-me');
  }
  const legacy = migrateSettings({ apiKey: 'legacy-key' }, 1);
  assert.equal(legacy.uiLanguage, 'zh-CN');
  assert.equal(legacy.providers[0].apiKey, 'legacy-key');
  assert.equal(migrateSettings({ ...old, uiLanguage: 'en-US' }, 4).uiLanguage, 'en-US');
  assert.equal(migrateSettings({ ...old, uiLanguage: 'bogus' }, 5).uiLanguage, 'zh-CN');
});

test('persist merge and all update/import paths normalize the language', () => {
  const { merge } = useSettings.persist.getOptions();
  const current = useSettings.getState();
  assert.equal(merge(undefined, current).uiLanguage, 'auto');
  assert.equal(merge({}, current).uiLanguage, 'zh-CN');
  assert.equal(merge({ uiLanguage: 'bogus' }, current).uiLanguage, 'zh-CN');
  useSettings.getState().update({ uiLanguage: 'en-US' });
  assert.equal(getSettings().uiLanguage, 'en-US');
  assert.equal(JSON.parse(storage.get('wangke-settings')).state.uiLanguage, 'en-US');
  assert.equal(JSON.parse(storage.get('wangke-settings')).version, 5);
  useSettings.getState().update({ uiLanguage: 'bogus' });
  assert.equal(getSettings().uiLanguage, 'zh-CN');
  useSettings.getState().update({ uiLanguage: 'auto' });
  assert.equal(pickSyncSettings(getSettings()).uiLanguage, 'auto', 'sync preference, not device-resolved locale');
});

test('both bundled namespaces translate immediately without a network request', async () => {
  const { default: i18n } = await import('../src/i18n/index.ts');
  assert.equal(i18n.isInitialized, true);
  assert.equal(i18n.t('settings'), '设置');
  await i18n.changeLanguage('en-US');
  assert.equal(i18n.t('settings'), 'Settings');
  assert.equal(i18n.t('appearance.fontScale', { ns: 'settings' }), 'Text size');
  await i18n.changeLanguage('zh-CN');
  assert.equal(i18n.t('appearance.fontScale', { ns: 'settings' }), '字号');
});

test('store + system-language sync updates HTML and title, with explicit preferences taking priority', async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { languages: ['en-GB'], language: 'en-GB' } });
  globalThis.document = { documentElement: { lang: '', dir: '' }, title: '' };
  const { startLocaleSync } = await import('../src/i18n/settings.ts');
  useSettings.getState().update({ uiLanguage: 'auto' });
  const stop = startLocaleSync();
  try {
    assert.equal(document.documentElement.lang, 'en-US');
    assert.equal(document.documentElement.dir, 'ltr');
    assert.equal(document.title, 'Wangke Learning Assistant');
    navigator.languages = ['zh-CN'];
    window.dispatchEvent(new Event('languagechange'));
    assert.equal(document.documentElement.lang, 'zh-CN');
    useSettings.getState().update({ uiLanguage: 'en-US' });
    window.dispatchEvent(new Event('languagechange'));
    assert.equal(document.documentElement.lang, 'en-US');
    assert.equal(getSettings().asrModel.model, initial.asrModel.model);
    assert.equal(getSettings().llmModel.model, initial.llmModel.model);
  } finally {
    stop();
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else delete globalThis.navigator;
    delete globalThis.document;
  }
});

test('cloud preferences validate incoming values and store the auto sentinel', async () => {
  const { db } = await import('../src/store/db.ts');
  const { cloud } = await import('../src/cloud/state.ts');
  const { loadPreferences, startPreferences, flushPreferences } = await import('../src/cloud/preferences.ts');
  await db.table('preferences').put({ id: 'uiLanguage', value: 'en-US' });
  await loadPreferences();
  assert.equal(getSettings().uiLanguage, 'en-US');
  await db.table('preferences').put({ id: 'uiLanguage', value: 'bogus' });
  await loadPreferences();
  assert.equal(getSettings().uiLanguage, 'zh-CN');
  await db.table('preferences').delete('uiLanguage');
  useSettings.getState().update({ uiLanguage: 'en-US' });
  await startPreferences();
  assert.equal((await db.table('preferences').get('uiLanguage')).value, 'en-US', 'adopt the pre-login preference when the account has none');
  useSettings.getState().update({ uiLanguage: 'auto' });
  await flushPreferences();
  assert.equal((await db.table('preferences').get('uiLanguage')).value, 'auto');
  cloud.worker = true;
  await startPreferences(); // 解除订阅，不留下测试写入链。
  await db.delete();
});

after(() => useSettings.setState(initial));
