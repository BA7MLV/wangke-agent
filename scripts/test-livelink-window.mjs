#!/usr/bin/env node
/**
 * 实时链路拉流窗口（window.ts）的单元测试：给定「已缓冲区间 + 在途数 + 播放头」，
 * 算出下一轮该向 host 请求哪些字节段。Node ≥22.18 原生类型剥离子句直接跑 .ts，无需构建。
 * 运行：node scripts/test-livelink-window.mjs
 *
 * 为什么必须有这条：这些断言不是「算得漂亮」，而是**链路不被自己打坏**的下限——
 *   - 与已缓冲区间重叠的请求会让 MSE 重复 append 同一段字节，直接损坏已解码帧
 *     （花屏、无声、无任何报错），所以「防重叠」必须逐字节钉住；
 *   - 窗口锚错地方比不封顶更隐蔽：钉在缓冲末端会追着末端跑（等于不封顶），
 *     钉在文件头则首窗填满后永久停摆——8MB 窗口约 13 秒，播到 13 秒就饿死。
 *     只有锚在播放头才能「边播边拉」；
 *   - 播放头后的旧数据不回头补：用户拖进度条跳到新位置后，把跳过的数据重新
 *     搬过中继纯属带宽浪费；
 *   - 脏输入若抛异常或死循环，死的是播放这一轮，而它跑在 timeupdate 事件
 *     回调里——异常会顺着事件冒泡把整条 socket 打死。
 *
 * 作用域声明：这里只管**下一轮请求哪些字节段**的纯计算契约（窗口随播放头滑动、
 * 背压、钳制、防重叠）；请求发出后的重组、MSE append、在途登记是 Task 6（mse.ts）的事。
 */
import assert from 'node:assert/strict';
import { planFetches } from '../apps/web/src/livelink/window.ts';

const CHUNK = 300, WIN = 500;
const full = { chunk: CHUNK, windowBytes: WIN, inflight: 0, maxInflight: 4 };

// ---------- 1. 空缓冲：从头按 chunk 拉，总量不超过 window ----------

assert.deepEqual(
  planFetches({ size: 1000, buffered: [], chunk: CHUNK, windowBytes: WIN, inflight: 0, maxInflight: 4 }),
  [{ start: 0, len: 300 }, { start: 300, len: 200 }],
);

// ---------- 2. 已有连续缓冲：只补窗口内的缺口 ----------

assert.deepEqual(
  planFetches({ size: 1000, buffered: [{ start: 0, end: 300 }], chunk: CHUNK, windowBytes: WIN, inflight: 0, maxInflight: 4 }),
  [{ start: 300, len: 200 }],
);

// ---------- 3. pos 锚定：窗口跟着播放头开到 [500, 1000) ----------
// 注：API 从 seek 改为 pos 后期望值随之改变。旧版期望 [{500,300},{300,200}]
// 意味着 seek 后回补播放头之后的洞——那正是「把用户跳过的数据重新搬过中继」，
// 新语义下播放头就是窗口锚点，只向前开窗。

assert.deepEqual(
  planFetches({ size: 1000, buffered: [{ start: 0, end: 300 }], pos: 500, chunk: CHUNK, windowBytes: WIN, inflight: 0, maxInflight: 4 }),
  [{ start: 500, len: 300 }, { start: 800, len: 200 }],
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

// ---------- 6. pos 越界（9999 ≥ size）钳到文件尾：前方无字节可缓冲 → 空，不死循环 ----------

assert.deepEqual(
  planFetches({ size: 1000, buffered: [], pos: 9999, chunk: CHUNK, windowBytes: WIN, inflight: 0, maxInflight: 4 }),
  [],
);

// ---------- 7. 非正/非有限 size → 空 ----------

assert.deepEqual(planFetches({ size: 0, buffered: [], chunk: CHUNK, windowBytes: WIN, inflight: 0, maxInflight: 4 }), []);
assert.deepEqual(planFetches({ size: -5, buffered: [], chunk: CHUNK, windowBytes: WIN, inflight: 0, maxInflight: 4 }), []);
assert.deepEqual(planFetches({ size: Infinity, buffered: [], chunk: CHUNK, windowBytes: WIN, inflight: 0, maxInflight: 4 }), []);

console.log('7 组硬断言全过');

// ---------- 8. pos 锚定：窗口跟着播放头滑动（本模块的核心语义） ----------

// 8.1 pos=600, buffered=[] → 窗口 [600, 1100)，从播放头起按 chunk 拉
assert.deepEqual(
  planFetches({ size: 2000, buffered: [], pos: 600, chunk: CHUNK, windowBytes: WIN, inflight: 0, maxInflight: 4 }),
  [{ start: 600, len: 300 }, { start: 900, len: 200 }],
);

// 8.2 pos=600, buffered=[{600,900}] → 跳过已覆盖，只补到窗口末端
assert.deepEqual(
  planFetches({ size: 2000, buffered: [{ start: 600, end: 900 }], pos: 600, chunk: CHUNK, windowBytes: WIN, inflight: 0, maxInflight: 4 }),
  [{ start: 900, len: 200 }],
);

// 8.3 pos=1900, size=2000, win=500 → 窗口 [1900,2000) 被 size 截断
assert.deepEqual(
  planFetches({ size: 2000, buffered: [], pos: 1900, chunk: CHUNK, windowBytes: WIN, inflight: 0, maxInflight: 4 }),
  [{ start: 1900, len: 100 }],
);

// 8.4 pos=1900, buffered=[{0,500}] → 播放头之前的旧缓冲不牵引窗口，也一个字节都不回头拉
assert.deepEqual(
  planFetches({ size: 2000, buffered: [{ start: 0, end: 500 }], pos: 1900, chunk: CHUNK, windowBytes: WIN, inflight: 0, maxInflight: 4 }),
  [{ start: 1900, len: 100 }],
);

// 8.5 pos=500, buffered=[{400,700}] → 播放头落在已覆盖区间内（常态）：先跳到覆盖末端 700 再开拉
assert.deepEqual(
  planFetches({ size: 2000, buffered: [{ start: 400, end: 700 }], pos: 500, chunk: CHUNK, windowBytes: WIN, inflight: 0, maxInflight: 4 }),
  [{ start: 700, len: 300 }],
);

// 8.6 窗口随播放头滑动（「首窗填满后停摆」的回归测试）：
//     上一轮 pos=600 已把 [600,1100) 填满并播到 950；本轮 pos=950，
//     窗口 [950,1450)，已覆盖部分跳过 → 拉 [1100,1450)
assert.deepEqual(
  planFetches({ size: 2000, buffered: [{ start: 600, end: 1100 }], pos: 950, chunk: CHUNK, windowBytes: WIN, inflight: 0, maxInflight: 4 }),
  [{ start: 1100, len: 300 }, { start: 1400, len: 50 }],
);

// 8.7 pos=null → 回落锚点 0（播放开始前的首窗口）。
//     推导：stop=0+500=500；[0,300) 是洞，先补；[300,600) 已覆盖，跳过；
//     此时连续覆盖末端 600 已越过 stop，收工。注意不是补 [600, …]——
//     窗口封顶在 500，已覆盖区之后的缺口要等窗口随播放头滑过去才轮得到。
assert.deepEqual(
  planFetches({ size: 1000, buffered: [{ start: 300, end: 600 }], pos: null, chunk: CHUNK, windowBytes: WIN, inflight: 0, maxInflight: 4 }),
  [{ start: 0, len: 300 }],
);

// 8.8 pos 非有限 / 负数 → 回落锚点 0，行为同 pos=null，不抛
assert.deepEqual(
  planFetches({ size: 1000, buffered: [], pos: NaN, ...full }),
  [{ start: 0, len: 300 }, { start: 300, len: 200 }],
);
assert.deepEqual(
  planFetches({ size: 1000, buffered: [], pos: -5, ...full }),
  [{ start: 0, len: 300 }, { start: 300, len: 200 }],
);

// 8.9 pos 是非 number 脏值（JS 调用方混入）→ 回落锚点 0，不抛（不做类型强转）
assert.deepEqual(
  planFetches({ size: 1000, buffered: [], pos: '600', ...full }),
  [{ start: 0, len: 300 }, { start: 300, len: 200 }],
);

// 8.10 pos = size（播到结尾）→ 前方无字节，空
assert.deepEqual(
  planFetches({ size: 1000, buffered: [], pos: 1000, ...full }),
  [],
);

console.log('pos 锚定断言全过');

// ---------- 9. 补充边界 ----------

// 多个不连续区间：窗口内只补第一个洞，第二个洞在窗口外，一个字节都不碰
assert.deepEqual(
  planFetches({ size: 1000, buffered: [{ start: 0, end: 300 }, { start: 600, end: 900 }], ...full }),
  [{ start: 300, len: 200 }],
);

// pos 骑在覆盖区边缘 → trim 掉已覆盖部分，只取没拉过的那截
assert.deepEqual(
  planFetches({ size: 1000, buffered: [{ start: 0, end: 300 }, { start: 500, end: 800 }], pos: 400, ...full }),
  [{ start: 400, len: 100 }, { start: 800, len: 100 }],
);

// 额度真的是配额：窗口再宽，一轮也超不过 maxInflight（且要减去已在途）
assert.equal(
  planFetches({ size: 1000, buffered: [], pos: 0, chunk: 100, windowBytes: 5000, inflight: 0, maxInflight: 2 }).length,
  2,
);
assert.equal(
  planFetches({ size: 1000, buffered: [], pos: 0, chunk: 100, windowBytes: 5000, inflight: 1, maxInflight: 2 }).length,
  1,
);

// 额度满时 pos 也不插队：背压优先。链路满了硬塞只会把 socket 缓冲顶爆
assert.deepEqual(
  planFetches({ size: 1000, buffered: [], pos: 500, ...full, inflight: 4, maxInflight: 4 }),
  [],
);

// 额度只剩 1 时，pos 处的开窗优先占掉它（用户此刻就要看）
assert.deepEqual(
  planFetches({ size: 1000, buffered: [], pos: 500, ...full, maxInflight: 1 }),
  [{ start: 500, len: 300 }],
);

// 前部有洞且播放头在 0：先补洞再续拉，最后一片仍撞上窗口封顶
assert.deepEqual(
  planFetches({ size: 1000, buffered: [{ start: 200, end: 400 }], ...full }),
  [{ start: 0, len: 200 }, { start: 400, len: 100 }],
);

// pos 贴近文件尾：seek 片本身钳到尾余数，且不回拉播放头之前的数据
assert.deepEqual(
  planFetches({ size: 1000, buffered: [], pos: 900, ...full }),
  [{ start: 900, len: 100 }],
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

// 窗口预算是 0 → 连播放头处的提前量都没有，一片都不拉
// （win=0 时 stop=pos，窗口是空区间；「提前缓冲」的预算为 0 就没有提前量）
assert.deepEqual(
  planFetches({ size: 1000, buffered: [], pos: 500, ...full, windowBytes: 0 }),
  [],
);

// 不改入参：覆盖表是内部副本，调用方持有的是 MSE buffered 的同一条数组
{
  const buf = [{ start: 0, end: 300 }];
  planFetches({ size: 1000, buffered: buf, ...full });
  assert.deepEqual(buf, [{ start: 0, end: 300 }]);
}

console.log('补充边界断言全过');
