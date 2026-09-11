// api.ts 单元测试：用假 fetch 验证接口封装（不真正联网）。
// 用法：node scripts/test-bilibili-api.mjs

import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(os.tmpdir(), `test-bilibili-api-${Date.now()}.mjs`);
execSync(
  `node_modules/.bin/esbuild src/bilibili/api.ts --bundle --platform=node --format=esm --outfile=${tmp}`,
  { cwd: root, stdio: 'inherit' },
);
const api = await import(tmp);

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ok  ${label}`); }
  else { failed++; console.error(`  FAIL ${label}`); }
}
function eq(a, b, label) { ok(JSON.stringify(a) === JSON.stringify(b), `${label}（${JSON.stringify(a)}）`); }

// ---- 假 fetch：记录请求、按 url 返回预定响应，并替换全局 fetch ----
function makeFetch(routes) {
  const calls = [];
  const fetchMock = async (url, init) => {
    calls.push({ url, init });
    const u = new URL(url);
    const target = decodeURIComponent(u.searchParams.get('url') ?? '');
    for (const [match, responder] of routes) {
      if (target.includes(match)) {
        const r = responder(target);
        return {
          ok: r.ok ?? true,
          status: r.status ?? 200,
          json: async () => r.json,
          text: async () => r.text ?? '',
        };
      }
    }
    throw new Error(`未匹配的请求: ${target}`);
  };
  return { fetchMock, calls };
}

// 用 withFetch 包装：在回调期间把全局 fetch 换成 mock，结束恢复
async function withFetch(fetchMock, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = fetchMock;
  try {
    return await fn();
  } finally {
    globalThis.fetch = orig;
  }
}

const proxy = 'https://proxy.example.com';

console.log('fetchVideoView');
{
  const { fetchMock, calls } = makeFetch([
    ['/x/web-interface/view', () => ({
      json: {
        code: 0,
        data: {
          aid: 80433022,
          title: '测试课程',
          duration: 3661,
          pages: [
            { cid: 111, part: 'P1', page: 1, duration: 100 },
            { cid: 222, part: '第二章', page: 2, duration: 200 },
          ],
        },
      },
    })],
  ]);
  const r = await withFetch(fetchMock, () => api.fetchVideoView({ proxy, cookie: 'SESSDATA=x' }, 'BV1xx411c7mD'));
  eq(r, {
    aid: 80433022,
    title: '测试课程',
    duration: 3661,
    pages: [
      { page: 1, cid: 111, part: 'P1', duration: 100 },
      { page: 2, cid: 222, part: '第二章', duration: 200 },
    ],
  }, '取到全部分 P（多 P 合集要在对话框里挑 P）');
  ok(calls[0].url.startsWith(proxy + '?url='), '经代理');
  ok(calls[0].url.includes(encodeURIComponent('bvid=BV1xx411c7mD')), '带 bvid');
  eq(calls[0].init.headers['X-Bili-Cookie'], 'SESSDATA=x', 'Cookie 透传头');
}
{
  const { fetchMock } = makeFetch([
    ['/x/web-interface/view', () => ({ json: { code: -404, message: '啥都木有' } })],
  ]);
  let msg = '';
  try { await withFetch(fetchMock, () => api.fetchVideoView({ proxy }, 'BV1xx411c7mD')); } catch (e) { msg = e.message; }
  ok(msg.includes('code=-404') && msg.includes('啥都木有'), '接口错误码透出');
}

console.log('fetchPlayStreams');
{
  const { fetchMock, calls } = makeFetch([
    ['/x/player/playurl', () => ({
      json: {
        code: 0,
        data: {
          dash: {
            duration: 3661,
            video: [
              { id: 80, height: 1080, baseUrl: 'https://upos-sz-mirror08.bilivideo.com/v1080.m4s' },
              { id: 32, height: 480, baseUrl: 'https://upos-sz-mirror08.bilivideo.com/v480.m4s' },
            ],
            audio: [{ baseUrl: 'https://upos-sz-mirror08.bilivideo.com/a.m4s' }],
          },
        },
      },
    })],
  ]);
  const s = await withFetch(fetchMock, () => api.fetchPlayStreams({ proxy }, 'BV1xx411c7mD', 222));
  eq(s.videoUrl, 'https://upos-sz-mirror08.bilivideo.com/v1080.m4s', '选最高清晰度视频流');
  eq(s.audioUrl, 'https://upos-sz-mirror08.bilivideo.com/a.m4s', '音频流');
  eq(s.qualityLabel, '1080P', '清晰度标签');
  eq(s.duration, 3661, '时长');
  ok(calls[0].url.includes(encodeURIComponent('fnval=16')), '请求 DASH');
  ok(calls[0].url.includes(encodeURIComponent('cid=222')), '带 cid');
}
{
  const { fetchMock } = makeFetch([
    ['/x/player/playurl', () => ({ json: { code: 0, data: { dash: { video: [], audio: null } } } })],
  ]);
  let msg = '';
  try { await withFetch(fetchMock, () => api.fetchPlayStreams({ proxy }, 'BV1xx411c7mD', 1)); } catch (e) { msg = e.message; }
  ok(msg.includes('未获取到 DASH'), '无 DASH 流报错');
}

console.log('resolveShortUrl');
{
  const { fetchMock } = makeFetch([
    ['b23.tv', () => ({ text: '<html><a href="https://www.bilibili.com/video/BV1Ab411c7mD/">go</a></html>' })],
  ]);
  const bvid = await withFetch(fetchMock, () => api.resolveShortUrl({ proxy }, 'https://b23.tv/abc'));
  eq(bvid, 'BV1Ab411c7mD', '短链解析出 BV');
}

console.log('出口未配置');
{
  let msg = '';
  try { await api.fetchVideoView({ proxy: '', bridge: null }, 'BV1xx411c7mD'); } catch (e) { msg = e.message; }
  ok(msg.includes('油猴') && msg.includes('代理'), '无桥无代理时报错引导安装油猴');
}

console.log('fetchPlayStreams 优先选 upos backup');
{
  const { fetchMock } = makeFetch([
    ['/x/player/playurl', () => ({
      json: {
        code: 0,
        data: {
          dash: {
            duration: 10,
            video: [{
              id: 32,
              height: 480,
              baseUrl: 'https://xy1.mcdn.bilivideo.cn/v.m4s',
              backupUrl: [
                'https://foo.edge.mountaintoys.cn/v.m4s',
                'https://upos-sz-mirrorcoso1.bilivideo.com/v.m4s',
              ],
            }],
            audio: [{
              baseUrl: 'https://xy2.mcdn.bilivideo.cn/a.m4s',
              backup_url: ['https://upos-sz-estgoss.bilivideo.com/a.m4s'],
            }],
          },
        },
      },
    })],
  ]);
  const s = await withFetch(fetchMock, () => api.fetchPlayStreams({ proxy }, 'BV1xx411c7mD', 1));
  eq(s.videoUrl, 'https://upos-sz-mirrorcoso1.bilivideo.com/v.m4s', '视频跳过 mcdn 选 upos backup');
  eq(s.audioUrl, 'https://upos-sz-estgoss.bilivideo.com/a.m4s', '音频跳过 mcdn 选 upos backup');
}

fs.rmSync(tmp, { force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
