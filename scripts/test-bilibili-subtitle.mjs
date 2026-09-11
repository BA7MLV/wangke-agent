// B 站字幕接口的纯逻辑单测：protobuf 编解码 / 真实响应解析 / 语言优先级 / 落库切分。
// 用法：node scripts/test-bilibili-subtitle.mjs
//
// fixture：DMVIEW_FIXTURE_B64 是 2026-09-11 从 app.biliapi.net 真实抓的一次 DmView 响应
// （BV1d7wAzsE8V《线性代数》宋浩：ai-zh 中文自动生成 + 5 种自动翻译），
// 只喂解析器，测试本身不发网络请求（auth_key 早已过期，也不影响解析断言）。

import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-bili-sub-'));
const build = (entry, name) => {
  const out = path.join(tmpDir, `${name}.mjs`);
  execSync(
    `node_modules/.bin/esbuild ${entry} --bundle --platform=node --format=esm --outfile=${out}`,
    { cwd: root, stdio: 'inherit' },
  );
  return out;
};

const wire = await import(build('src/bilibili/wire.ts', 'wire'));
const dmview = await import(build('src/bilibili/dmview.ts', 'dmview'));
const subtitle = await import(build('src/bilibili/subtitle.ts', 'subtitle'));

let passed = 0;
let failed = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`  ok  ${label}`);
  } else {
    failed++;
    console.error(`  FAIL ${label}\n    expected: ${e}\n    actual:   ${a}`);
  }
}
function ok(cond, label) {
  eq(!!cond, true, label);
}

// ---------------- wire ----------------
console.log('wire');
eq([...wire.encodeVarint(300)], [0xac, 0x02], 'varint 300');
eq([...wire.encodeVarint(0)], [0], 'varint 0');
eq([...wire.encodeVarint(2 ** 40)], [0x80, 0x80, 0x80, 0x80, 0x80, 0x20], 'varint 2^40');
{
  // B 站新视频的 aid 会超过 2^32（实测 116211161497788），必须 BigInt 编码
  const aid = 116211161497788;
  const msg = wire.encodeMessage([
    wire.fieldVarint(1, aid),
    wire.fieldVarint(2, 36629840236),
    wire.fieldVarint(3, 1),
    wire.fieldBytes(4, wire.utf8('main.ugc-video-detail.0.0')),
  ]);
  const fields = wire.decodeFields(msg);
  eq(wire.getNumber(fields, 1), aid, '64 位 aid 往返');
  eq(wire.getNumber(fields, 2), 36629840236, '64 位 cid 往返');
  eq(wire.getNumber(fields, 3), 1, 'type 往返');
  eq(wire.getString(fields, 4), 'main.ugc-video-detail.0.0', 'spmid 往返');
}

// ---------------- gRPC 帧 ----------------
console.log('grpc frame');
{
  const req = dmview.buildDmViewRequest(116211161497788, 36629840236);
  const view = new DataView(req.buffer);
  eq(req[0], 0, '压缩标记 0');
  eq(view.getUint32(1, false), req.byteLength - 5, '长度字段 = 消息体长度');
  const { compressed, message } = dmview.unframeGrpc(req);
  eq(compressed, false, 'unframe 不压缩');
  eq(message.byteLength, req.byteLength - 5, 'unframe 消息体长度');
  eq(wire.getNumber(wire.decodeFields(message), 1), 116211161497788, '请求体里的 aid');
}
{
  // 声明长度大于实际（被截断的响应）时退化为取到末尾，不抛
  const { message } = dmview.unframeGrpc(new Uint8Array([0, 0, 0, 1, 0, 7]));
  eq(message.byteLength, 1, '长度越界时截到末尾');
}
{
  let threw = false;
  try {
    dmview.unframeGrpc(new Uint8Array([0, 0]));
  } catch {
    threw = true;
  }
  ok(threw, '过短响应抛错');
}

// ---------------- 真实响应解析 ----------------
console.log('parseSubtitleList（真实 fixture）');
const DMVIEW_FIXTURE_B64 =
  'GqoMGpICCICsnPT85pGvGxITMTk3MjA5MTk5MTg0ODU4ODgwMBoFYWktemgiGOS4reaWh++8iOiHquWKqOeUn+aIkO+8iSrDAWh0' +
  'dHA6Ly9haXN1YnRpdGxlLmhkc2xiLmNvbS9iZnMvYWlfc3VidGl0bGUvcHJvZC8xMTYyMTExNjE0OTc3ODgzNjYyOTg0MDIzNmZl' +
  'ZjQ0Njk5NTVkMDJhYjJhZjRjNGJlZWYxYTAxZWFmP2F1dGhfa2V5PTE3ODkwOTcxMjItNGY4MjNhYWVlNzU2NDU2ZmI2NGVlZTU5' +
  'YjIwYzM5YWUtMC0xNWRmM2MzNTEzNTg0YjdmMDRjMGFhNjAwZmQxYjAwZTgBQgbkuK3mlodQAhr6AQiA6Ieg0ua4sBsSEzE5NzI4' +
  'MjY0NTQxNjUxNTY4NjQaBWFpLWVuIhjoi7Hor63vvIjoh6rliqjnv7vor5HvvIkqqQFodHRwOi8vYWlzdWJ0aXRsZS5oZHNsYi5j' +
  'b20vYmZzL2FpX3N1YnRpdGxlL3Byb2QvYzdlNDczMTZiZDAyYjUzYTY1MmU3ODMxYmQ3MTM1OGM/YXV0aF9rZXk9MTc4OTA5NzEy' +
  'Mi1mOGI2ZDVhODg5ZTE0NjkzOGQ2YWRhMGQzNjg2NmZkZi0wLTZhYjllNzkxNDZhMWM0ODFmMGViZWUyNTRhMWU0NDIxOAFCBuiL' +
  'seivrUgBUAIa+gEIgICEwPTQuLAbEhMxOTcyODI1NzA3NDQ0NzY0NjcyGgVhaS1qYSIY5pel5paH77yI6Ieq5Yqo57+76K+R77yJ' +
  'KqkBaHR0cDovL2Fpc3VidGl0bGUuaGRzbGIuY29tL2Jmcy9haV9zdWJ0aXRsZS9wcm9kLzI1OWZkZmFlODUzY2JhN2UxZTdmNWQ4' +
  'YjZlMDk0MGQ3P2F1dGhfa2V5PTE3ODkwOTcxMjItMGRmOGU5YmNiYmVhNDYxMGI1MzFiZDViMmE4YTI2ODgtMC0zMjhlZDMzOGEx' +
  'MDJkOTU4Y2M4NjFjMWVlM2FmY2Q3NDgBQgbml6XmlodIAVACGoYCCICMhty2zriwGxITMTk3MjgyNTYyMjE0MTA0NDIyNBoFYWkt' +
  'ZXMiHuilv+ePreeJmeivre+8iOiHquWKqOe/u+ivke+8iSqpAWh0dHA6Ly9haXN1YnRpdGxlLmhkc2xiLmNvbS9iZnMvYWlfc3Vi' +
  'dGl0bGUvcHJvZC8zNDU1MTkxNjFhOWQzN2M2YThiOGRmOGY1NDkxODU2ZT9hdXRoX2tleT0xNzg5MDk3MTIyLTdmYjdhMjQzNGZh' +
  'MzQ3ZTRhZWZhZTM5YzQ1OTczZDk2LTAtNjg1YTA1OGQzZGVkMmU1MTFkODlkMmViMGI0ZjMyMzA4AUIM6KW/54+t54mZ6K+tSAFQ' +
  'AhqGAgiAxp2IlM64sBsSEzE5NzI4MjU2MTI4Mzg0NjIyMDgaBWFpLWFyIh7pmL/mi4nkvK/or63vvIjoh6rliqjnv7vor5HvvIkq' +
  'qQFodHRwOi8vYWlzdWJ0aXRsZS5oZHNsYi5jb20vYmZzL2FpX3N1YnRpdGxlL3Byb2QvYmVhODU2ZDQyYmM5YjU1MDU4ODE0YmIz' +
  'MzBmODA0YjM/YXV0aF9rZXk9MTc4OTA5NzEyMi0xMzNkNjQzZTY4MjY0ZjNjODNkZmE1MDA3MjA3MTJjZS0wLTM3NjgyOTBlOTU0' +
  'MjI0ZGVjMjc5ZGMzM2RmYzY0Yzk1OAFCDOmYv+aLieS8r+ivrUgBUAIahgIIgMCZvMrOuLAbEhMxOTcyODI1NjI3NDQyOTYyNDMy' +
  'GgVhaS1wdCIe6JGh6JCE54mZ6K+t77yI6Ieq5Yqo57+76K+R77yJKqkBaHR0cDovL2Fpc3VidGl0bGUuaGRzbGIuY29tL2Jmcy9h' +
  'aV9zdWJ0aXRsZS9wcm9kLzhmMjhkMDI4NGZkMTFmMjY3OTQ0ZjExMGQ2NmE3Mjc4P2F1dGhfa2V5PTE3ODkwOTcxMjItZDJhMjg2' +
  'MGFlNjA5NDBmYmI4NTIwMGMwYTgwYzBjYzctMC00NDUzYjJlMDhmZmI0YzRkNzJkMzEzNTM0ZjU2YTcyYzgBQgzokaHokITniZno' +
  'r61IAVACKjkIAxIz5byA5ZCv5ZCO77yM5YWo56uZ6KeG6aKR5bCG5oyJ562J57qn562J5LyY5YyW5by55bmVGAEyMgowIAEoA2XN' +
  'zEw/bQAAgD91AACAP3gegAEBkAEBmgEECAMQCJoBBAgCEASaAQQIARADQAFyGBEtQxzr4jYaPxoLEP///////////wEgQHoAggHs' +
  'AQpsCgzliY3mlrnpq5jog70ST2h0dHA6Ly9pMC5oZHNsYi5jb20vYmZzL2ZlZWQtYWRtaW4vYmQ5MDcyNmJiMGM5ODJjMTYxZWFi' +
  'N2FkNjdlODQ2MDI1OGE4OTU5Yy5wbmcaCxD///////////8BCnwKA29oaAoDT0hICgNPaGgKA29ISAoDQWhoCgNBSEgST2h0dHA6' +
  'Ly9pMC5oZHNsYi5jb20vYmZzL2ZlZWQtYWRtaW4vZDgzMWNiYWU2N2FlZTFhOGZlMWNjNDYzZmIyM2M5MTEwZWU0NjgwNy5wbmca' +
  'CxD///////////8BkgG0AXsiaWQiOjEwMDExLCJzdGFydCI6MCwiZW5kIjo1LCJyYXdfZGF0YSI6bnVsbCwicGljdHVyZSI6eyJt' +
  'aW1lIjoiaW1hZ2UiLCJyZXNvdXJjZSI6Imh0dHBzOi8vaTAuaGRzbGIuY29tL2Jmcy9hY3Rpdml0eS1wbGF0L3N0YXRpYy85YmRk' +
  'OTg4YWVkNjRhMjM5NzZkNmQ1NDk0NTMzYTQ1MC92QklTSG96U3UwLnBuZyJ9faoBAggDsgGvAwqsAwiAlILcuP720xwQ7IK8uogB' +
  'GPy04R8iCyNBVFRFTlRJT04jKgzlhbPms6jlvLnluZU6EzIwMjYtMDMtMTEgMjM6MDk6NDhCEzIwMjYtMDMtMTEgMjM6MDk6NDhK' +
  'twJ7ImR1cmF0aW9uIjo1MDAwLCJwb3NYIjozMzMuNSwicG9zWSI6MjQzLjc1LCJwb3NYXzIiOjUwLCJwb3NZXzIiOjY1LCJpY29u' +
  'IjoiaHR0cDovL2kwLmhkc2xiLmNvbS9iZnMvYXBwL2Q0NTNkYzhiMzgwYzZkNmE2YzIzNmMwYmYyOTFhOTU4MTNkNmQ0YmEucG5n' +
  'IiwidHlwZSI6MiwiYXJjX3R5cGUiOjAsInVwb3dlcl9vcGVuIjpmYWxzZSwidXBvd2VyX3N0YXRlIjowLCJ1cG93ZXJfaWNvbiI6' +
  'IiIsInVwb3dlcl9pY29uX3dlYiI6IiIsInVwb3dlcl9qdW1wX3VybCI6IiIsInVwb3dlcl9idXR0b25fbWFwIjpudWxsLCJ1cG93' +
  'ZXJfZ3VpZGUiOiIifVITMjA2NDg2MDc5MzIzNjY1NDU5MlgFugHsAXsiYmxvY2tfcmVwZWF0X2V4cCI6ZmFsc2UsImNoYW1waW9u' +
  'X21hc2tfZXhwIjpmYWxzZSwiY2hyb25vcyI6eyJnbG9iYWwiOnsibWF4X2RtcyI6MjAwLCJtYXhfZG1zX3Blcl9zZWMiOjIwLCJ2' +
  'dF9yZXBvcnQiOnsiaW50ZXJ2YWwiOjEwLCJzYW1wbGVyIjoxfX19LCJkbV9jb25maWdfcGFuZWxfZXhwIjpmYWxzZSwiZG1fcmVu' +
  'ZGVyX2V4cCI6MSwiaGVyZF9wb3N0X2V4cCI6Miwic2hvd19kbV9yZXBseSI6ZmFsc2V9';
const fixture = new Uint8Array(Buffer.from(DMVIEW_FIXTURE_B64, 'base64'));
const list = dmview.parseSubtitleList(fixture);
eq(list.length, 6, '一路原文 + 5 路自动翻译');
eq(list[0].lan, 'ai-zh', '第一路是中文自动生成');
eq(list[0].lanDoc, '中文（自动生成）', 'lan_doc');
eq(list[0].langSimple, '中文', '简化语言名');
eq(list[1].lan, 'ai-en', '第二路是英文');
ok(list.every((s) => s.url.startsWith('http://aisubtitle.hdslb.com/bfs/')), '直链 host 正确');
ok(
  list.every((s) => /auth_key=\d{10}-[0-9a-f]{32}-\d-[0-9a-f]{32}$/.test(s.url)),
  'auth_key 完整（没有把后续 protobuf 字节吃进 URL）',
);
ok(list.every((s) => s.aiMark !== null), 'AI 标记存在');

// ---------------- 字幕 JSON ----------------
console.log('cuesFromSubtitleJson');
const SUBTITLE_JSON_FIXTURE = {
  font_size: 0.4,
  body: [
    { from: 0.56, to: 3.3, sid: 1, location: 2, content: '好我们先看一下第一部分的内容啊', music: 0.0 },
    { from: 3.3, to: 6.09, sid: 2, location: 2, content: '叫做二阶行列式', music: 0.0 },
    { to: 9.79, sid: 3, location: 2, content: '  缺失 from 的行  ' },
    { from: 20, to: 20, content: '' },
  ],
};
{
  const cues = dmview.cuesFromSubtitleJson(SUBTITLE_JSON_FIXTURE);
  eq(cues.length, 3, '空文本行被丢掉');
  const byText = new Map(cues.map((c) => [c.text, c]));
  eq(byText.get('好我们先看一下第一部分的内容啊'), { start: 0.56, end: 3.3, text: '好我们先看一下第一部分的内容啊' }, '普通行取 from/to');
  eq(byText.get('缺失 from 的行'), { start: 0, end: 9.79, text: '缺失 from 的行' }, '缺 from 视为 0、文本去空白');
  // 输出按 start 升序（归并配对的前提）：缺 from 的那条从 0 开始，所以排最前
  eq(cues.map((c) => c.start), [0, 0.56, 3.3], '按 start 升序');
  eq(dmview.cuesFromSubtitleJson(null), [], '空 JSON → []');
  eq(dmview.cuesFromSubtitleJson({ body: 'nope' }), [], 'body 非数组 → []');
}

// ---------------- 语言优先级 / 落库 ----------------
console.log('语言优先级');
eq(subtitle.langRank('ai-zh'), 0, 'ai-zh 最高');
eq(subtitle.langRank('zh-Hans'), 0, 'zh-Hans 同为最高');
eq(subtitle.langRank('zh-Hant'), 1, '繁体次之');
eq(subtitle.langRank('ai-en'), 2, '英文再次');
eq(subtitle.langRank('ja'), 3, '其余最后');
eq(subtitle.pickPrimary(list)?.lan, 'ai-zh', '主语言 = 中文自动生成');
eq(subtitle.defaultSelectedLangs(list), ['ai-zh', 'ai-en'], '默认勾中文 + 英文');
eq(subtitle.defaultSelectedLangs([list[3]]), ['ai-es'], '只有非中文时退回第一路');
eq(subtitle.pickPrimary([]), null, '空列表 → null');

console.log('cuesToSegments / buildBundle');
{
  const cues = [
    { start: 0, end: 2, text: '甲' },
    { start: 2, end: 4, text: '乙' },
  ];
  const rows = subtitle.cuesToSegments(cues);
  eq(rows, [
    { idx: 0, start: 0, end: 2, text: '甲', status: 1 },
    { idx: 1, start: 2, end: 4, text: '乙', status: 1 },
  ], 'cue → segment 行');
}
{
  const fetched = [
    { item: list[0], cues: [{ start: 0, end: 1, text: '中文' }] },
    { item: list[1], cues: [{ start: 0, end: 1, text: 'english' }] },
    { item: list[2], cues: [] }, // 拉失败/空字幕的路不落库
  ];
  const bundle = subtitle.buildBundle(fetched, subtitle.pickPrimary(fetched.map((f) => f.item)));
  eq(bundle.primary?.lang, 'ai-zh', '主语言 ai-zh');
  eq(bundle.primary?.cues.length, 1, '主语言 cue 数');
  eq(bundle.tracks.map((t) => [t.lang, t.primary]), [['ai-zh', 1], ['ai-en', 0]], '轨道 + 主语言标记');
  const empty = subtitle.buildBundle([], null);
  eq(empty, { primary: null, tracks: [] }, '无字幕时为空负载');
}

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
