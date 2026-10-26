#!/usr/bin/env node
/**
 * 从 models.dev 生成供应商与模型目录：src/api/catalog/models.generated.json
 *
 * 做法照 pi（earendil-works/pi 的 packages/ai/scripts/generate-models.ts）：
 * 只收一份挑过的供应商名单，按 models.dev 的 `npm` 字段决定协议，缺 `api` 的补官方地址，
 * 生成的文件提交进仓库，运行时不依赖 models.dev 可达。
 *
 *   npm run generate:models            # 拉最新
 *   node scripts/generate-models.mjs --input api.json   # 用本地快照
 */
import fs from 'node:fs';
import path from 'node:path';

const OUTPUT = path.resolve('src/api/catalog/models.generated.json');
const SOURCE = 'https://models.dev/api.json?type=all';

/**
 * 收哪些供应商，顺序就是选择列表里的顺序。
 * baseUrl 只在 models.dev 没给 `api` 时补；protocol 只在 npm 推断不对时补。
 */
const PROVIDERS = [
  { id: 'openai', baseUrl: 'https://api.openai.com/v1' },
  { id: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' },
  { id: 'google', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', protocol: 'openai-chat' },
  { id: 'deepseek' },
  { id: 'moonshotai-cn' },
  { id: 'moonshotai' },
  { id: 'zhipuai' },
  { id: 'zai' },
  { id: 'alibaba-cn' },
  { id: 'alibaba' },
  { id: 'siliconflow-cn' },
  { id: 'siliconflow' },
  { id: 'volcengine' },
  { id: 'minimax-cn' },
  { id: 'minimax' },
  { id: 'stepfun' },
  { id: 'xiaomi' },
  { id: 'modelscope' },
  { id: 'openrouter', protocol: 'openai-chat' },
  { id: 'vercel', baseUrl: 'https://ai-gateway.vercel.sh/v1', protocol: 'openai-chat' },
  { id: 'xai', baseUrl: 'https://api.x.ai/v1', protocol: 'openai-chat' },
  { id: 'groq', baseUrl: 'https://api.groq.com/openai/v1', protocol: 'openai-chat' },
  { id: 'mistral', baseUrl: 'https://api.mistral.ai/v1', protocol: 'openai-chat' },
  { id: 'togetherai', baseUrl: 'https://api.together.xyz/v1', protocol: 'openai-chat' },
  { id: 'fireworks-ai' },
  { id: 'nvidia' },
  { id: 'huggingface' },
];

/**
 * TypeSafe 不在 models.dev 的供应商列表里，但它的 Jev 决策模型以别家网关条目出现
 * （vercel 的 typesafe-ai/jev*）。决策槽位只认 TypeSafe 的 /systemone 协议，所以单独补一家。
 */
const EXTRA = [{
  id: 'typesafe', name: 'TypeSafe', baseUrl: 'https://api.typesafe.ai/v1', protocol: 'openai-chat',
  borrow: { from: 'vercel', prefix: 'typesafe-ai/' },
}];

const SKIP_TYPES = new Set(['image', 'embedding', 'video', 'speech', 'reranking', 'realtime']);

function protocolOf(npm) {
  if (npm === '@ai-sdk/anthropic') return 'anthropic-messages';
  // @ai-sdk/openai 默认走 Responses，但 Chat Completions 兼容面更广；需要时可在设置里改。
  return 'openai-chat';
}

function model(id, m) {
  const input = m.modalities?.input ?? ['text'];
  const output = m.modalities?.output ?? ['text'];
  const entry = { id, name: m.name || id };
  const type = m.type && m.type !== 'language' && m.type !== 'chat' ? m.type : undefined;
  if (type) entry.type = type;
  if (input.join() !== 'text') entry.input = input.filter((x) => ['text', 'image', 'audio', 'video', 'pdf'].includes(x));
  if (output.join() !== 'text') entry.output = output;
  if (m.reasoning) entry.reasoning = true;
  if (m.tool_call) entry.toolCall = true;
  if (m.limit?.context) entry.context = m.limit.context;
  if (m.limit?.output) entry.maxOutput = m.limit.output;
  if (m.release_date) entry.released = m.release_date;
  return entry;
}

function usable(m) {
  if (m.status === 'deprecated') return false;
  if (SKIP_TYPES.has(m.type)) return false;
  return (m.modalities?.output ?? ['text']).includes('text');
}

/** 新的在前，同日按名字；选择列表默认就是这个顺序。 */
const byRecency = (a, b) => (b.released ?? '').localeCompare(a.released ?? '') || a.name.localeCompare(b.name);

async function main() {
  const inputIndex = process.argv.indexOf('--input');
  const raw = inputIndex > 0
    ? fs.readFileSync(process.argv[inputIndex + 1], 'utf8')
    : await fetch(SOURCE, { signal: AbortSignal.timeout(60_000) }).then((r) => {
      if (!r.ok) throw new Error(`models.dev HTTP ${r.status}`);
      return r.text();
    });
  const data = JSON.parse(raw);
  const providers = [];
  for (const spec of PROVIDERS) {
    const p = data[spec.id];
    if (!p) { console.warn(`skip ${spec.id}: not in models.dev`); continue; }
    const baseUrl = (p.api || spec.baseUrl || '').replace(/\/+$/, '');
    if (!/^https:\/\//.test(baseUrl) || baseUrl.includes('${')) { console.warn(`skip ${spec.id}: no usable base URL`); continue; }
    const models = Object.entries(p.models ?? {}).filter(([, m]) => usable(m)).map(([id, m]) => model(id, m)).sort(byRecency);
    if (!models.length) continue;
    providers.push({ id: spec.id, name: p.name, baseUrl, protocol: spec.protocol ?? protocolOf(p.npm), env: p.env ?? [], doc: p.doc, models });
  }
  for (const extra of EXTRA) {
    const source = data[extra.borrow.from]?.models ?? {};
    const models = Object.entries(source)
      .filter(([id, m]) => id.startsWith(extra.borrow.prefix) && m.type === 'decision' && m.status !== 'deprecated')
      .map(([id, m]) => model(id.slice(extra.borrow.prefix.length), m)).sort(byRecency);
    if (models.length) providers.push({ id: extra.id, name: extra.name, baseUrl: extra.baseUrl, protocol: extra.protocol, env: [], models });
  }
  const output = { source: 'https://models.dev', generatedAt: new Date().toISOString().slice(0, 10), providers };
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, `${JSON.stringify(output)}\n`);
  const count = providers.reduce((n, p) => n + p.models.length, 0);
  console.log(`models catalog: ${providers.length} providers, ${count} models → ${path.relative(process.cwd(), OUTPUT)} (${(fs.statSync(OUTPUT).size / 1024).toFixed(0)} KiB)`);
}

await main();
