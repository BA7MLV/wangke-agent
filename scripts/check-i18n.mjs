import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../src/i18n/locales/', import.meta.url);

function flatten(value, prefix = '', result = {}) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `Invalid namespace: ${prefix}`);
  for (const [key, entry] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof entry === 'string') {
      assert.ok(entry.trim(), `Empty translation: ${path}`);
      result[path] = entry;
    } else flatten(entry, path, result);
  }
  return result;
}

const pluralSuffix = /_(zero|one|two|few|many|other)$/;
const semanticKey = key => key.replace(pluralSuffix, '');
const parameters = value => [...value.matchAll(/\{\{\s*-?\s*([^},\s]+)[^}]*\}\}/g)].map(m => m[1]).sort();
const read = async (locale, file) => flatten(JSON.parse(await readFile(new URL(`${locale}/${file}`, root), 'utf8')));
const namespaces = (await readdir(new URL('zh-CN/', root))).filter(file => file.endsWith('.json')).sort();

for (const locale of ['zh-CN', 'en-US']) {
  const files = (await readdir(new URL(`${locale}/`, root))).filter(file => file.endsWith('.json')).sort();
  assert.deepEqual(files, namespaces, `${locale}: namespace mismatch`);
  for (const file of namespaces) {
    const base = await read('zh-CN', file);
    const target = await read(locale, file);
    const keys = value => [...new Set(Object.keys(value).map(semanticKey))].sort();
    assert.deepEqual(keys(target), keys(base), `${locale}/${file}: missing or extra semantic keys`);
    for (const [key, text] of Object.entries(target)) {
      const baseKey = Object.keys(base).find(candidate => semanticKey(candidate) === semanticKey(key));
      assert.deepEqual(parameters(text), parameters(base[baseKey]), `${locale}/${file}:${key}: interpolation mismatch`);
    }
    // 英文 one/other 与中文 other 的原始键集合不同，但每种语言都必须覆盖自己的复数规则。
    for (const key of keys(target)) {
      if (!Object.keys(target).some(candidate => pluralSuffix.test(candidate) && semanticKey(candidate) === key)) continue;
      for (const category of new Intl.PluralRules(locale).resolvedOptions().pluralCategories) {
        assert.ok(`${key}_${category}` in target, `${locale}/${file}: missing plural ${key}_${category}`);
      }
    }
  }
}
console.log(`i18n resources OK: ${namespaces.length} namespaces × 2 languages (${fileURLToPath(root)})`);
