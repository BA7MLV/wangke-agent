// npx tsx --test scripts/test-bilibili-load-subtitles.mjs
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { biliVideoSource } from '../apps/web/src/bilibili/source.ts';
import { loadBiliSubtitles } from '../apps/web/src/bilibili/loadSubtitles.ts';
import { resolveBiliVideoSource } from '../apps/web/src/bilibili/resolveSource.ts';
import { encodeMessage, fieldBytes, fieldVarint, utf8, decodeFields, getNumber } from '../apps/web/src/bilibili/wire.ts';
import { unframeGrpc } from '../apps/web/src/bilibili/dmview.ts';
import { db } from '../apps/web/src/store/db.ts';
import { saveImportedSubtitles } from '../apps/web/src/store/subtitles.ts';
import { VIDEO_META_FIELDS } from '../apps/web/src/sync/units.ts';

after(() => db.close());

const source = { bvid: 'BV1GJ411x7h7', aid: 101, cid: 202, page: 2 };

function mockBridge(langs = ['ai-zh', 'ai-en', 'ja'], failures = [], listStatus = 200, empty = []) {
  const calls = [];
  let requestId = 0;
  return {
    calls,
    bridge: {
      version: '2.1.1',
      async fetch(url, init) {
        calls.push({ url, init });
        let status = 200;
        let bytes;
        if (url.includes('/DmView')) {
          requestId++;
          status = listStatus;
          const message = encodeMessage([fieldBytes(3, encodeMessage(langs.map((lan, i) =>
            fieldBytes(3, encodeMessage([
              fieldVarint(1, i + 1), fieldBytes(3, utf8(lan)), fieldBytes(4, utf8(lan)),
              fieldBytes(5, utf8(`https://aisubtitle.hdslb.com/${lan}?request=${requestId}`)),
            ])),
          )))]);
          bytes = new Uint8Array(5 + message.length);
          new DataView(bytes.buffer).setUint32(1, message.length, false);
          bytes.set(message, 5);
        } else {
          const lan = new URL(url).pathname.slice(1);
          if (failures.includes(lan)) status = 403;
          bytes = utf8(JSON.stringify({ body: empty.includes(lan) ? [] : [{ from: 1, to: 3, content: `${lan} text` }] }));
        }
        return {
          ok: status === 200, status,
          arrayBuffer: async () => bytes.buffer,
          text: async () => new TextDecoder().decode(bytes),
          json: async () => JSON.parse(new TextDecoder().decode(bytes)),
        };
      },
    },
  };
}

test('保留准确的分 P / 合集来源，不混用主视频 aid', () => {
  assert.deepEqual(biliVideoSource(source, { page: 3, cid: 303 }), { ...source, cid: 303, page: 3 });
  assert.deepEqual(biliVideoSource(source, { bvid: 'BVepisode', aid: 404, cid: 505, page: 8, sourcePage: 2 }), {
    bvid: 'BVepisode', aid: 404, cid: 505, page: 2,
  });
  assert.ok(VIDEO_META_FIELDS.includes('biliSource'));
});

test('旧视频链接只读取元数据，准确匹配分 P，无效序号明确报错', async () => {
  const calls = [];
  const bridge = { version: '2.1.1', async fetch(url) {
    calls.push(url);
    const data = { aid: 101, title: 'test', pages: [{ page: 1, cid: 201 }, { page: 2, cid: 202 }] };
    const bytes = utf8(JSON.stringify({ code: 0, data }));
    return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer, json: async () => ({ code: 0, data }) };
  } };
  assert.deepEqual(await resolveBiliVideoSource({ bridge }, `https://www.bilibili.com/video/${source.bvid}?p=2`), source);
  await assert.rejects(resolveBiliVideoSource({ bridge }, `https://www.bilibili.com/video/${source.bvid}?p=99`), /不存在 P99/);
  assert.ok(calls.every(url => url.includes('/x/web-interface/view')));
});

test('独立拉字幕：默认中英、主语言正确、每次刷新短期直链', async () => {
  const { bridge, calls } = mockBridge();
  const bundle = await loadBiliSubtitles({ bridge }, source);
  assert.equal(bundle.primary.lang, 'ai-zh');
  assert.deepEqual(bundle.tracks.map(t => t.lang), ['ai-zh', 'ai-en']);
  const fields = decodeFields(unframeGrpc(calls[0].init.body).message);
  assert.equal(getNumber(fields, 1), source.aid);
  assert.equal(getNumber(fields, 2), source.cid);
  await loadBiliSubtitles({ bridge }, source);
  assert.equal(calls.filter(c => c.url.includes('/DmView')).length, 2);
  assert.ok(calls.some(c => c.url.includes('request=2')));
  assert.ok(calls.every(c => !c.url.includes('playurl')));
});

test('语言选择：显式空列表不请求；指定语言只拉对应路', async () => {
  const { bridge, calls } = mockBridge();
  assert.deepEqual(await loadBiliSubtitles({ bridge }, source, []), { primary: null, tracks: [] });
  assert.equal(calls.length, 0);
  assert.equal((await loadBiliSubtitles({ bridge }, source, ['ja'])).primary.lang, 'ja');
  assert.equal(calls.length, 2);
});

test('某一路失败或空内容时，成功语言仍能成为主语言', async () => {
  for (const opts of [mockBridge(undefined, ['ai-zh']), mockBridge(undefined, [], 200, ['ai-zh'])]) {
    const bundle = await loadBiliSubtitles(opts, source);
    assert.equal(bundle.primary.lang, 'ai-en');
    assert.equal(bundle.tracks[0].primary, 1);
  }
});

test('区分真的无字幕、列表接口失败、全部下载失败', async () => {
  assert.deepEqual(await loadBiliSubtitles(mockBridge([]), source), { primary: null, tracks: [] });
  await assert.rejects(loadBiliSubtitles(mockBridge(undefined, [], 503), source), /HTTP 503/);
  await assert.rejects(loadBiliSubtitles(mockBridge(undefined, ['ai-zh', 'ai-en']), source), /HTTP 403/);
  await assert.rejects(loadBiliSubtitles(mockBridge(undefined, [], 200, ['ai-zh', 'ai-en']), source), /没有可用内容/);
});

test('补拉后主字幕和对照轨一起落库，来源保持可供下次重试', async () => {
  const id = 'bili-subtitle-test';
  await db.videos.put({ id, name: 'test', size: 0, mimeType: 'video/mp4', duration: 10, createdAt: Date.now(), status: 'new', biliSource: source });
  await db.segments.add({ videoId: id, idx: 0, start: 0, end: 1, text: 'old', status: 1 });
  const bundle = await loadBiliSubtitles(mockBridge(), source);
  await saveImportedSubtitles(id, bundle);
  const video = await db.videos.get(id);
  assert.equal(video.status, 'transcribed');
  assert.deepEqual(video.biliSource, source);
  assert.deepEqual((await db.segments.where('videoId').equals(id).toArray()).map(s => s.text), ['ai-zh text']);
  assert.equal(await db.subtitleTracks.where('videoId').equals(id).count(), 2);
});
