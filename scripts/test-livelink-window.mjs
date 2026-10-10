#!/usr/bin/env node
/**
 * 实时链路拉流窗口（window.ts）的单元测试：给定「已缓冲区间 + 在途数 + seek 目标」，
 * 算出下一轮该向 host 请求哪些字节段。Node ≥22.18 原生类型剥离子句直接跑 .ts，无需构建。
 * 运行：node scripts/test-livelink-window.mjs
 *
 * 为什么必须有这条：这些断言不是「算得漂亮」，而是**链路不被自己打坏**的下限——
 *   - 与已缓冲区间重叠的请求会让 MSE 重复 append 同一段字节，直接损坏已解码帧
 *     （花屏、无声、无任何报错），所以「防重叠」必须逐字节钉住；
 *   - 窗口不封顶就等于把整部视频搬过中继：带宽翻倍，且 seek 之前的时间全浪费；
 *   - seek 越界/非正 size 这类脏输入若抛异常或死循环，死的是播放这一轮，
 *     而它跑在 timeupdate 事件回调里——异常会顺着事件冒泡把整条 socket 打死。
 *
 * 作用域声明：这里只管**下一轮请求哪些字节段**的纯计算契约（窗口封顶、seek 优先、
 * 背压、钳制、防重叠）；请求发出后的重组、MSE append、在途登记是 Task 6（mse.ts）的事。
 */
import assert from 'node:assert/strict';
import { planFetches } from '../src/livelink/window.ts';

const CHUNK = 300, WIN = 500;
const full = { chunk: CHUNK, windowBytes: WIN, inflight: 0, maxInflight: 4 };

// ---------- 1. 空缓冲：从头按 chunk 拉，总量不超过 window ----------

assert.deepEqual(
  planFetches({ size: 1000, buffered: [], chunk: CHUNK, windowBytes: WIN, inflight: 0, maxInflight: 4 }),
  [{ start: 0, len: 300 }, { start: 300, len: 200 }],
);

// ---------- 2. 已有连续缓冲：从覆盖末端续拉 ----------

assert.deepEqual(
  planFetches({ size: 1000, buffered: [{ start: 0, end: 300 }], chunk: CHUNK, windowBytes: WIN, inflight: 0, maxInflight: 4 }),
  [{ start: 300, len: 200 }],
);

// ---------- 3. seek 优先：先取 seek 那片，再补洞 ----------

assert.deepEqual(
  planFetches({ size: 1000, buffered: [{ start: 0, end: 300 }], seek: 500, chunk: CHUNK, windowBytes: WIN, inflight: 0, maxInflight: 4 }),
  [{ start: 500, len: 300 }, { start: 300, len: 200 }],
);

// ---------- 4. 在途占满 → 空 ----------

assert.deepEqual(
  planFetches({ size: 1000, buffered: [], chunk: CHUNK, windowBytes: WIN, inflight: 4, maxInflight: 4 }),
  [],
);

// ---------- 5. 尾部钳制 ----------

assert.deepEqual(
  planFetches({ size: 250, buffered: [], chunk: CHUNK, windowBytes: 5000, inflight: 0, maxInflight: 4 }),
  [{ start: 0, len: 250 }],
);

// ---------- 6. seek 越界被钳掉，不死循环 ----------

assert.deepEqual(
  planFetches({ size: 1000, buffered: [], seek: 9999, chunk: CHUNK, windowBytes: WIN, inflight: 0, maxInflight: 4 }),
  [{ start: 0, len: 300 }, { start: 300, len: 200 }],
);

// ---------- 7. 非正/非有限 size → 空 ----------

assert.deepEqual(planFetches({ size: 0, buffered: [], chunk: CHUNK, windowBytes: WIN, inflight: 0, maxInflight: 4 }), []);
assert.deepEqual(planFetches({ size: -5, buffered: [], chunk: CHUNK, windowBytes: WIN, inflight: 0, maxInflight: 4 }), []);
assert.deepEqual(planFetches({ size: Infinity, buffered: [], chunk: CHUNK, windowBytes: WIN, inflight: 0, maxInflight: 4 }), []);

console.log('7 组硬断言全过');

// ---------- 8. 补充边界 ----------

// 多个不连续区间：窗口内只补第一个洞，第二个洞在窗口外，一个字节都不碰
assert.deepEqual(
  planFetches({ size: 1000, buffered: [{ start: 0, end: 300 }, { start: 600, end: 900 }], ...full }),
  [{ start: 300, len: 200 }],
);

// seek 落在已缓冲区间内 → 不产生 seek 请求（硬约束：与已缓冲重叠会损坏 MSE 已解码帧）
assert.deepEqual(
  planFetches({ size: 1000, buffered: [{ start: 0, end: 800 }], seek: 500, ...full }),
  [],
);

// seek 骑在覆盖区边缘 → trim 掉已覆盖部分，只取没拉过的那截
assert.deepEqual(
  planFetches({ size: 1000, buffered: [{ start: 0, end: 300 }, { start: 500, end: 800 }], seek: 400, ...full }),
  [{ start: 400, len: 100 }, { start: 300, len: 100 }],
);

// 额度真的是配额：窗口再宽，一轮也超不过 maxInflight（且要减去已在途）
assert.equal(
  planFetches({ size: 1000, buffered: [], chunk: 100, windowBytes: 5000, inflight: 0, maxInflight: 2 }).length,
  2,
);
assert.equal(
  planFetches({ size: 1000, buffered: [], chunk: 100, windowBytes: 5000, inflight: 1, maxInflight: 2 }).length,
  1,
);

// 额度满时 seek 也不插队：背压优先。链路满了硬塞只会把 socket 缓冲顶爆
assert.deepEqual(
  planFetches({ size: 1000, buffered: [], seek: 500, ...full, inflight: 4, maxInflight: 4 }),
  [],
);

// 前部有洞：先补洞再续拉，最后一片仍撞上窗口封顶
assert.deepEqual(
  planFetches({ size: 1000, buffered: [{ start: 200, end: 400 }], ...full }),
  [{ start: 0, len: 200 }, { start: 400, len: 100 }],
);

// seek 贴近文件尾：seek 片本身也要钳到尾余数
assert.deepEqual(
  planFetches({ size: 1000, buffered: [], seek: 900, ...full }),
  [{ start: 900, len: 100 }, { start: 0, len: 300 }, { start: 300, len: 200 }],
);

// 缓冲恰好铺满窗口 → 不再拉
assert.deepEqual(
  planFetches({ size: 1000, buffered: [{ start: 0, end: WIN }], ...full }),
  [],
);

// buffered 归一化：整体越过 size 的区间钳完即空，NaN 端点丢掉，都不是覆盖
assert.deepEqual(
  planFetches({ size: 1000, buffered: [{ start: 2000, end: 3000 }, { start: NaN, end: 5 }], ...full }),
  [{ start: 0, len: 300 }, { start: 300, len: 200 }],
);

// 脏的窗口/配额/chunk：负 inflight 按 0 计（计错数的计数器不该换来超发配额），
// NaN / 非正一律安静空转，绝不抛异常
assert.deepEqual(planFetches({ size: 1000, buffered: [], ...full, inflight: -2 }), [{ start: 0, len: 300 }, { start: 300, len: 200 }]);
assert.deepEqual(planFetches({ size: 1000, buffered: [], ...full, inflight: NaN }), []);
assert.deepEqual(planFetches({ size: 1000, buffered: [], ...full, chunk: NaN }), []);
assert.deepEqual(planFetches({ size: 1000, buffered: [], ...full, chunk: 0 }), []);
assert.deepEqual(planFetches({ size: 1000, buffered: [], ...full, windowBytes: NaN }), []);
assert.deepEqual(planFetches({ size: 1000, buffered: [], ...full, windowBytes: -7 }), []);

// 窗口为 0 时只服务 seek（用户此刻就要看），补洞一个字节都不多拉
assert.deepEqual(
  planFetches({ size: 1000, buffered: [], ...full, windowBytes: 0, seek: 500 }),
  [{ start: 500, len: 300 }],
);

// 不改入参：覆盖表是内部副本，调用方持有的是 MSE buffered 的同一条数组
{
  const buf = [{ start: 0, end: 300 }];
  planFetches({ size: 1000, buffered: buf, ...full });
  assert.deepEqual(buf, [{ start: 0, end: 300 }]);
}

console.log('补充边界断言全过');
