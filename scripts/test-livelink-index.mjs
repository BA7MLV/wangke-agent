#!/usr/bin/env node
/**
 * 实时链路 host 侧载荷构建（payloads.ts）的单元测试：索引 + meta/content/cover 单元。
 * Node ≥22.18 原生类型剥离子句直接跑 .ts，无需构建。
 * 运行：node scripts/test-livelink-index.mjs
 *
 * 为什么必须有这条：这些断言不是「JSON 能不能 stringify」，而是**guest 不会收到
 * 一份能解析却放不出东西的载荷**的下限——
 *   - `fileDeleted` 是少见的「本机事实却必须跨设备」字段：本机 OPFS 里文件被删了，
 *     guest 那边 openFile 必然失败。索引不带它，guest 只能等到播放器报错才知道看不了，
 *     而用户可以也应该在列表上就看到「这台机器上文件已删」；
 *   - meta 单元的字段取舍必须**逐字段钉住**：多给（htmlView / skillOverride / coverState
 *     这类本机偏好与状态）等于把一台设备的选择强加给另一台——host 的 coverState=skipped
 *     照抄过来，guest 上就是一张永远等不到的「待生成」占位；少给（lastPosition 缺省成
 *     0 之外的 undefined）会让 guest 镜像的进度条算出 NaN；
 *   - 空字幕段数组也必须是合法载荷——没转写完的课程正好是链路最常见的场景，
 *     此时 content 单元返回 `{segments: [], tracks: []}`，guest 侧不能当成坏帧；
 *   - cover 走 blob→base64：分片进制写错在 40KB 小封面上看不出来，材料封面一宽就
 *     spread 爆栈 RangeError，而它跑在 unit.req 的 await 链上，炸的是整条链路。
 *
 * 作用域声明：这里只管**DB 行 → 链路载荷**的纯函数契约（字段取舍、缺省值、可逆性）；
 * 单元 id 的构造与分片在 protocol.ts / sync/units.ts 钉着，socket 行为归 Task 6+ 的测试。
 */
import assert from 'node:assert/strict';
import {
  buildIndex,
  buildMetaUnit,
  buildContentUnit,
  coverUnitFromBlob,
  bytesToBase64,
} from '../src/livelink/payloads.ts';

// ---------- 1. 索引：fileDeleted 也要给 guest，其余本机事实不带 ----------

const idx = buildIndex([
  { id: 'a', name: '课一', duration: 60, size: 10, mimeType: 'video/mp4', kind: 'video', createdAt: 2, status: 'transcribed' },
  { id: 'b', name: '课二', duration: 0, size: 20, mimeType: 'application/pdf', kind: 'material', materialFormat: 'pdf', createdAt: 1, status: 'transcribed', fileDeleted: 1 },
]);
assert.equal(idx.length, 2);
assert.equal(idx.find((c) => c.id === 'b').fileDeleted, true);
assert.equal(idx.find((c) => c.id === 'a').fileDeleted, false);

// 顺序即调用方给的顺序（host 按 createdAt 排好后发，索引不再重排，免得 guest 列表抖动）
assert.deepEqual(idx.map((c) => c.id), ['a', 'b']);
assert.deepEqual(idx[1], {
  id: 'b',
  name: '课二',
  kind: 'material',
  duration: 0,
  size: 20,
  mimeType: 'application/pdf',
  createdAt: 1,
  status: 'transcribed',
  materialFormat: 'pdf',
  fileDeleted: true,
});

// kind 缺省 'video'：老数据（材料化改造前入库）没有这个字段，默认成 material 会让
// 列表把它当讲义渲染，而它其实是个视频
assert.equal(buildIndex([{ id: 'c', name: '课三', duration: 5, size: 1, mimeType: 'video/mp4', createdAt: 0, status: 'new' }])[0].kind, 'video');
assert.equal(buildIndex([{ id: 'c', name: '课三', duration: 5, size: 1, mimeType: 'video/mp4', createdAt: 0, status: 'new' }])[0].materialFormat, undefined);

// 本机事实不进索引：coverState / htmlView / skillOverride 是这台设备的状态与偏好，
// 跟着走既污染对面又没有渲染价值
assert.equal(idx.find((c) => c.id === 'a').coverState, undefined);
assert.equal(idx.find((c) => c.id === 'a').htmlView, undefined);

// 空库也是合法索引（刚装上什么都没导入，不能因此让链路报错）
assert.deepEqual(buildIndex([]), []);

// ---------- 2. meta 单元：JSON 可解析、缺省值补齐、字段白名单 ----------

const meta = JSON.parse(
  buildMetaUnit({
    id: 'a',
    name: '课一',
    duration: 60,
    size: 10,
    mimeType: 'video/mp4',
    kind: 'video',
    lastPosition: 12.5,
    createdAt: 2,
    status: 'transcribed',
    coverState: 'done',
    dominantColor: '#123456',
  }),
);
assert.equal(meta.id, 'a');
assert.equal(meta.lastPosition, 12.5);
assert.equal(meta.dominantColor, '#123456');

// coverState **不发**：guest 是纯内存镜像、永不生成封面，host 端的 skipped（典型成因是
// 「本机文件已删，没法生成」）照抄过来只会在 guest 上显示成「待生成」且永远等不到——
// 把一台设备的状态 facts 投射成另一台的等待，纯噪音。guest 判空的唯一依据是 cover
// 单元拉不拉得到，所以这里连键都不该出现（而不是发个 false / null 让它猜）
assert.equal('coverState' in meta, false);

// 缺省值：没播过的课 lastPosition/finished 必须是「显式的 0」，不是 undefined ——
// guest 侧进度条直接拿它算比例，undefined 会变成 NaN 进度
const bare = JSON.parse(buildMetaUnit({ id: 'x', name: 'x', duration: 0, size: 0, mimeType: 'video/mp4', createdAt: 0, status: 'new' }));
assert.equal(bare.lastPosition, 0);
assert.equal(bare.finished, 0);
assert.equal(bare.kind, 'video');
// 0|1 标记一律归一成布尔：host 库里可能是 undefined（老数据），guest 两边判等要一致
assert.equal(bare.scanned, false);
assert.equal(bare.empty, false);
assert.equal(JSON.parse(buildMetaUnit({ id: 'x', name: 'x', duration: 0, size: 0, mimeType: 'video/mp4', createdAt: 0, status: 'new', scanned: 1, empty: 1 })).scanned, true);

// 白名单内的可选字段原样透传：materialFormat 决定 guest 用 PDF 渲染器还是 MD 渲染器
assert.equal(JSON.parse(buildMetaUnit({ id: 'm', name: '讲义', duration: 0, size: 9, mimeType: 'application/pdf', kind: 'material', materialFormat: 'pdf', createdAt: 0, status: 'transcribed' })).materialFormat, 'pdf');

// 白名单外一律不带：fileDeleted / htmlView / skillOverride / coverState 是
// 「这台机器的事实与偏好」，跟着走只会污染对面（coverState 的额外理由见上）
assert.equal(meta.fileDeleted, undefined);
assert.equal(meta.htmlView, undefined);
assert.equal(meta.skillOverride, undefined);
assert.equal(
  JSON.parse(
    buildMetaUnit({
      id: 'y',
      name: 'y',
      duration: 0,
      size: 0,
      mimeType: 'video/mp4',
      createdAt: 0,
      status: 'new',
      fileDeleted: 1,
      htmlView: 'segment',
      coverState: 'pending',
      skillOverride: { pin: [1], drop: [] },
    }),
  ).coverState,
  undefined,
);
// dominantColor 仍在白名单里：guest 列表要用它画封面占位底色（它不是状态，是内容属性）
assert.equal(meta.dominantColor, '#123456');

// 载荷自描述：id 写进 JSON，与单元 id（video:<id>:meta）能互相校验 ——
// 「索引指向 A、载荷里装着 B」这类错乱要在 guest 写入前就能发现
assert.equal(bare.id, 'x');

// ---------- 3. content 单元：段 + 对照轨；空数据也是合法载荷 ----------

const content = JSON.parse(
  buildContentUnit('a', [{ idx: 0, start: 0, end: 1, text: '你好', status: 1 }], [
    { lang: 'ai-en', lanDoc: '英语', primary: 0, cues: [{ start: 0, end: 1, text: 'hi' }] },
  ]),
);
assert.equal(content.videoId, 'a');
assert.equal(content.segments[0].text, '你好');
assert.equal(content.tracks[0].lang, 'ai-en');

// 段字段：idx/start/end/text/cues 全带（cues 是句级跳转的依据，显示层切分也靠它），
// 而 DB 的自增主键 id / videoId 不带——它们只在本机库里有意义
assert.deepEqual(content.segments[0], { idx: 0, start: 0, end: 1, text: '你好' });
// cues 缺失时 JSON 里干脆没这个键（而不是 null / "undefined" 字符串），
// guest 侧要靠「键在不在」区分「ASR 给了句级时间戳」和「没有，按字数估算」
assert.equal('cues' in content.segments[0], false);
assert.deepEqual(content.tracks[0], { lang: 'ai-en', lanDoc: '英语', primary: false, cues: [{ start: 0, end: 1, text: 'hi' }] });

// primary 归一成布尔：老轨没有这个字段，false 与显式 0 必须判等一致
assert.equal(JSON.parse(buildContentUnit('a', [], [{ lang: 'ai-zh', lanDoc: '中文', cues: [] }])).tracks[0].primary, false);

// status 0 的未转写段也发：哪句转完了是 guest 显示层的事，host 侧过滤会让
// 「正在转写」这门课在 guest 上看着像空课
assert.equal(JSON.parse(buildContentUnit('a', [{ idx: 0, start: 0, end: 1, text: '', status: 0 }], [])).segments[0].status, undefined);
assert.equal(JSON.parse(buildContentUnit('a', [{ idx: 0, start: 0, end: 1, text: '', status: 0 }], [])).segments.length, 1);

// 空数据也是合法载荷：没字幕的课 content 单元照样有一份内容，
// guest 侧要能把它和「拉取失败」区分开
const emptyContent = JSON.parse(buildContentUnit('a', [], []));
assert.deepEqual(emptyContent.segments, []);
assert.deepEqual(emptyContent.tracks, []);
assert.equal(emptyContent.videoId, 'a');

// ---------- 4. cover 单元：blob → base64 可逆 ----------

const bytes = new Uint8Array([0, 1, 2, 250]);
const cov = JSON.parse(
  await coverUnitFromBlob({ videoId: 'a', blob: new Blob([bytes]), w: 480, h: 270, ts: 3 }),
);
assert.equal(cov.videoId, 'a');
assert.equal(cov.w, 480);
assert.equal(cov.h, 270);
assert.equal(cov.ts, 3);
assert.deepEqual([...Uint8Array.from(atob(cov.blobBase64), (c) => c.charCodeAt(0))], [...bytes]);

// 空 blob 也合法（封面表有记录但 blob 是空文件的课）
assert.equal(JSON.parse(await coverUnitFromBlob({ videoId: 'z', blob: new Blob([]), w: 0, h: 0, ts: 0 })).blobBase64, '');

console.log('4 组硬断言全过');

// ---------- 5. bytesToBase64 大载荷分片不爆栈 ----------

// 100KB：一次 spread 会把参数表顶爆（RangeError / 栈溢出），分片后必须完好无损
{
  const big = new Uint8Array(100 * 1024);
  for (let i = 0; i < big.length; i++) big[i] = i % 256;
  const b64 = bytesToBase64(big);
  assert.equal(b64.length, Math.ceil(big.length / 3) * 4);
  assert.deepEqual([...Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], [...big]);
}

// 分片边界长度（0x8000 的整数倍±1）：差一字节就漏一段，是最容易写错的 off-by-one
for (const n of [0x8000 - 1, 0x8000, 0x8000 + 1, 0x10000]) {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 7) % 256;
  const b64 = bytesToBase64(b);
  assert.equal(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).length, n, `长度 ${n}`);
  assert.deepEqual([...Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], [...b], `内容 ${n}`);
}

// 全字节值覆盖：base64 在 latin1 字符上搬运，高位字节（>0x7f）最容易出错
{
  const all = new Uint8Array(256);
  for (let i = 0; i < 256; i++) all[i] = i;
  assert.deepEqual([...Uint8Array.from(atob(bytesToBase64(all)), (c) => c.charCodeAt(0))], [...all]);
}

console.log('补充边界断言全过');
