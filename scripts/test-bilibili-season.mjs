// 用法：npx tsx --test scripts/test-bilibili-season.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchVideoView } from '../src/bilibili/api.ts';
import { resolveBiliTarget, fetchPageSubtitles, importBiliPages } from '../src/bilibili/index.ts';
import { pageLabel, pageVideoTitle } from '../src/bilibili/pages.ts';

const first = 'BV1Jft366E7W';
const second = 'BV1QMtJ62EWj';
const part = (cid, page = 1) => ({ cid, page, part: `分段${page}`, duration: 120 });
function fixture() {
  return {
    aid: 202, title: '第二课', duration: 120, pages: [part(222)],
    ugc_season: { title: '申论系统课', sections: [
      { episodes: [{ bvid: first, aid: 101, cid: 111, title: '第一课', pages: [part(111)] }] },
      { episodes: [{ bvid: second, aid: 202, cid: 222, title: '第二课', page: part(222) }] },
    ] },
  };
}
function mock(data = fixture()) {
  const calls = [];
  const bridge = { version: 'test', async fetch(url, init) {
    calls.push({ url, init });
    if (url.includes('/x/web-interface/view')) {
      const text = JSON.stringify({ code: 0, data });
      return { ok: true, status: 200, json: async () => JSON.parse(text),
        text: async () => text, arrayBuffer: async () => new TextEncoder().encode(text).buffer };
    }
    if (url.includes('/x/player/playurl')) throw new Error('stop before downloading');
    // 字幕接口失败不应阻止解析；同时保留请求体供检查 aid/cid。
    throw new Error('no subtitles');
  } };
  return { opts: { bridge }, calls };
}

test('合集跨分区展示所有集数，默认仅选链接对应的视频', async () => {
  const { opts } = mock();
  const target = await resolveBiliTarget(opts, `https://www.bilibili.com/video/${second}/`);
  assert.equal(target.kind, 'season');
  assert.equal(target.title, '申论系统课');
  assert.deepEqual(target.defaultPages, [2]);
  assert.deepEqual(target.pages.map(p => [p.page, p.bvid, p.aid, p.cid]), [
    [1, first, 101, 111], [2, second, 202, 222],
  ]);
  assert.equal(pageLabel(target.pages[0]), '第1集 第一课');
  assert.equal(pageVideoTitle(target.title, target.pages, 1), '第1集 第一课');
});

test('下载每集使用各自的 BV/cid，空选择不回退默认集', async () => {
  const { opts, calls } = mock();
  const target = await resolveBiliTarget(opts, second);
  for (const page of target.pages) {
    await assert.rejects(importBiliPages(target, { ...opts, pages: [page.page] }, () => {}), /stop before downloading/);
    const url = new URL(calls.at(-1).url);
    assert.equal(url.searchParams.get('bvid'), page.bvid);
    assert.equal(url.searchParams.get('cid'), String(page.cid));
  }
  const before = calls.length;
  await assert.rejects(importBiliPages(target, { ...opts, pages: [] }, () => {}), /没有选中/);
  assert.equal(calls.length, before);
});

test('字幕请求使用所选集的 aid/cid，而不是入口视频的 aid', async () => {
  const { opts, calls } = mock();
  const target = await resolveBiliTarget(opts, second);
  await fetchPageSubtitles(opts, target, 1);
  const request = calls.at(-1);
  assert.ok(request.url.includes('DmView'));
  // protobuf varint: field 1=pid(aid), field 2=oid(cid)。
  const body = [...request.init.body];
  assert.ok(body.includes(101));
  assert.ok(body.includes(111));
  assert.ok(!body.includes(202));
});

test('合集中含传统多 P 时保持全部分段，p 参数选择源分段', async () => {
  const data = fixture();
  data.pages = [part(222), part(223, 2)];
  data.ugc_season.sections[0].episodes.push(data.ugc_season.sections[0].episodes[0]);
  const { opts } = mock(data);
  const target = await resolveBiliTarget(opts, `${second}?p=2`);
  assert.equal(target.pages.length, 3); // 去除重复集，不丢失子分 P
  assert.deepEqual(target.defaultPages, [3]);
  assert.equal(target.pages[2].cid, 223);
  assert.equal(target.pages[2].sourcePage, 2);
});

test('无合集或合集数据不可用时保留传统分 P', async () => {
  for (const season of [undefined, { sections: [{ episodes: [{ aid: 1, cid: 1 }] }] }]) {
    const data = fixture();
    data.ugc_season = season;
    const { opts } = mock(data);
    const view = await fetchVideoView(opts, second);
    assert.equal(view.season, undefined);
    const target = await resolveBiliTarget(opts, second);
    assert.equal(target.kind, 'pages');
    assert.equal(target.title, '第二课');
    assert.deepEqual(target.defaultPages, [1]);
  }
});
