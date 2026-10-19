/* eslint-disable no-console */
/**
 * E2E：实时链路 P1 全链路（host 设置页 ↔ Node 桩中继 ↔ guest 镜像页）。
 *
 * 跑法：先起 dev（npm run dev，端口 5173），再 `node scripts/e2e-livelink.mjs`。
 *
 * ── 为什么必须有这条 ──────────────────────────────────────────────────────────
 * 这条守的是静默失效形态，单元测试照不到：
 *   ① range 拉到的字节段与 host 本机文件是否逐字节一致。host 的 `handleVideoRange`
 *      把 `start` 钳进文件尾、按 EOF 截断 len，任何一处算错（比如忘了钳、或钳错了
 *      方向）在浏览器里表现为「能播但花屏/音画错位」或「拉了个空段卡住」——
 *      没有报错，只有画面不对。只有把「桩中继实际转发的字节」与「host 页真文件的
 *      同一区间」逐字节比对，才守得住这条。
 *   ② host 下线 guest 立刻可见。host 点停止后 guest 必须进 offline 态（不变量 7）。
 *      这条链上任何一环退化（桩中继不广播 host-link-down、guest 漏接、页面拿陈旧
 *      镜像假装在线）都表现为「主轴都关了对面还在看」——最严重的静默失效。
 *   ③ 配对码真的把两端接进同一房间。host 与 guest 各自连 `?room=CODE&role=…`，
 *      room 名拼错一个字符的表现是「两边都显示在线，但什么都拉不到」。
 *   ④ 索引 → 单元 → 封面的两级拉取（index.req / unit.req 两段式 + rid 分片路由）
 *      在真浏览器 + 真 socket 上才凑得齐：rid 命名空间撞车（host 高半区 vs guest
 *      低半区）会让视频字节错配进字幕单元——不报错，只是内容错乱。
 *
 * ── 为什么用桩中继而不是真部署 DO ────────────────────────────────────────────
 * CI 没有 Cloudflare 凭据，也不该为了跑一条 e2e 去部署一个真 Worker。桩中继
 * （下面「1. 桩中继」）只复刻协议级行为：按 room 配对、异角色原样转发、
 * host 断开向 guest 广播 host-link-down。它与真 DO（cloudflare-worker/live-relay）
 * 的差异只在传输层细节——宽限 60s、配对限速、hibernation 恢复，这些都不改变
 * 两端交换的帧。**协议帧在桩与真中继上逐字节一致**，所以这条守的正是「帧契约」；
 * 真 DO 归手动验收（设计文档的验收项）。
 *
 * ── 双轨断言：mp4 只做协议级，webm 才真解码 ──────────────────────────────────
 * 本机 Chrome 155 实测：MSE 播 mp4 全灭（任何 codec 串；`isTypeSupported` 返回
 * true 会说谎），带音频轨的容器也全灭（vp9+opus → video error 3），**只有
 * video-only 的 webm/vp9 能真播**。所以 fixture 与断言分两轨：
 *   · mp4 门：文件是「ftyp 头 + 3MB 确定性伪随机字节」，本机播不了（预期）。
 *     它只守**协议级字节边界**——range 帧数、每次 {start,len} 不越界、转发载荷
 *     不超过文件 size。这些与能不能播无关，任何字节流都成立。
 *   · webm 门：ffmpeg 现场生成 45s/640x360/vp9、video-only（`-an`）的 fixture，
 *     断言真解码——`video.buffered.length > 0`、`play()` 后 currentTime 增大。
 *     **ffmpeg 缺失时这一步跳过并打印原因**，不静默、不假通过（退出码仍为 0，
 *     但汇总里会写明「跳过了真解码」）。
 *
 * ── 为什么 webm fixture 必须 > 8MB（终审 A 的照妖镜）──────────────────────
 * 8MB 正是 guest 的 WINDOW_BYTES，也是 host 读盘并发的历史上限（2）与
 * MAX_INFLIGHT（4）交叠的位置。fixture 小于 8MB 时，整个文件一轮就拉完，
 * 多 chunk / 窗口滑动 / 并发排队**一条路径都撞不到**，而「host 超限静默丢帧」
 * 这个 Critical 恰恰只在那条路径上现形。所以用 `testsrc` + 时序噪声把码率顶到
 * 2000kbps：45s ≈ 11MB > 8MB，一次填充必然拆成 8+ 个 1MB 请求、在途打满
 * MAX_INFLIGHT=4。断言也因此三条一起上：
 *   ① **video.buffered 连续无洞**：播放头前方出现任何缺口都红。丢帧的 rid 永远
 *      等不到应答，那段区间被 guest 的覆盖表永久算成已覆盖 —— 文件留洞、播放头
 *      卡住、没有 error 也没有 UI 变化，唯一的外在症状就是 buffered 里的洞；
 *   ② **buffered 覆盖到接近播完**（≥75% 时长）：窗口真的在跟着播放头滑动，
 *      不是把首窗拉满就停；
 *   ③ **完整性**：桩中继记下的每个 `video.range` 请求的 rid，都必须出现过对应的
 *      响应帧（给出 3s 宽限，loopback 上足够）—— 丢一个帧就红。
 *
 * ── 字节记账按 rid 命名空间分开（终审修）─────────────────────────────────
 * 二进制帧有两种 rid：低半区（<0x80000000）是视频 range 的应答，高半区是 host
 * 的单元分片（gzip 后的字幕 / 索引载荷）。早先把两者的字节数加进同一个计数器，
 * 于是「转发载荷不超过文件 size」这条断言被几百字节的单元分片顶红 —— 假红比
 * 漏红更糟（它会训练人跳过这条断言）。现在分开记：`rangeBytes` 只算视频字节。
 *
 * ── 时序上做了什么 ────────────────────────────────────────────────────────────
 *   · host 开共享后 status 先 connecting 再 online，断言用 waitForFunction（见下）。
 *   · guest 侧「首片 append 落地」要经过 waitUpdateEnd，buffered 才长出来；
 *     播放推进更是异步，一律 waitForFunction + 超时，不用 sleep 猜。
 *   · React 19 StrictMode 双挂载会让 effect 跑两次：guest 页会「连上→断开→再连」，
 *     host 的 guests 计数因此可能抖一下。所以「正在共享给 1 台设备」用
 *     waitForFunction 等，而不是读过一次就断言。
 *   · OPFS 写入（saveVideoFile）与 DB 播种都是异步的，播种后从 host 页回读一次
 *     `getCourseFile(id).size` 当作「文件真的落盘了」的闸门。
 */
import { setTimeout as delay } from 'node:timers/promises';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { WebSocketServer } from 'ws';
// ⚠️ 这里**不 import 任何协议版本**：桩中继合成的两帧是控制帧（ctl 形状），与 app 的
// PROTOCOL_VERSION 无关（见 live-relay/src/index.ts 与 protocol.ts 的 decodeControlFrame）。
// 在测试里 import PROTOCOL_VERSION 恰好是把两个部署物的生命周期重新绑在一起 ——
// 上一版就是那么写的，于是每次 app bump 协议，桩和真中继都得跟着改，而忘了改真中继
// 不会让任何断言变红。

const BASE = process.env.BASE_URL || 'http://localhost:5173';
/** 桩中继端口。避开 dev(5173)/preview(4173)，也避开本机常见的 8080/3000。 */
const RELAY_PORT = 8899;
const RELAY = `ws://127.0.0.1:${RELAY_PORT}`;
/** mp4 门 fixture 的文件大小（确定性伪随机字节，本机 Chrome 播不了是预期）。 */
const MP4_SIZE = 3 * 1024 * 1024;
/**
 * webm fixture 的名义时长（秒）。ffmpeg 的 `testsrc=duration=45:rate=15` 决定，
 * 与 seedHost 里 videos 行的 duration 对齐。
 *
 * 为什么需要它兜底：`video.duration` 在 MSE 下由媒体自己解出来（webm 的 Info 段），
 * 实测 Chrome 会给出精确值；但万一某个环境给出 Infinity / NaN（没有显式
 * endOfStream 时规范允许），采样循环的目标值仍要有个基准，否则「覆盖到接近播完」
 * 这条断言会因为除以 Infinity 而恒真 —— 假绿比假红更糟。
 */
const WEBM_EXPECT_SEC = 45;

const MP4_COURSE = '实时链路测试课 mp4';
const WEBM_COURSE = '实时链路测试课 webm';
const SUB_TEXT = '第一段：实时链路从这里开始';

let failed = 0;
/** 真解码这一步的最终状态：'ran' | 'skipped' | 'n/a'，只用于汇总里说清验过什么。 */
let LAST_WEBM_STATE = 'n/a';
const ok = (msg) => console.log(`   ✓ ${msg}`);
const fail = (msg) => {
  failed++;
  console.error(`   ❌ ${msg}`);
};
const skip = (msg) => console.log(`   ⚠ 跳过：${msg}`);
async function check(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (e) {
    fail(`${name}\n      ${e.message}`);
  }
}

/**
 * 读配对码。mdui-text-field 的真值有三种可能的落点（React 受控 value 属性、
 * shadow DOM 里的 input.value、宿主属性），逐个试——只试一种的话，mdui 版本
 * 一升级就会让这条读成空串，而空串会让后面所有断言以「配对码格式不对」的
 * 面貌红掉，把真正的原因（取值方式变了）盖住。
 */
async function readPairCode(page) {
  return (
    await page
      .locator('[data-testid="live-code"]')
      .evaluate((el) => {
        const inner = el.shadowRoot?.querySelector('input,textarea');
        return el.value ?? el.getAttribute('value') ?? inner?.value ?? '';
      })
      .catch(() => '')
  ).trim();
}

/** 构造 guest 链接（单独抽出来，断言 host 展示的码与 URL 里的 pair 是同一个）。 */
function liveUrlFor(code) {
  return `${BASE}/#/live?relay=${encodeURIComponent(RELAY)}&pair=${encodeURIComponent(code)}`;
}

/**
 * guest 页面上的 live-* 节点快照。**只在断言失败时打**（见 dumpGuest）。
 *
 * 为什么需要它：「课程项不出现」有两种完全不同的成因 —— 没连上（URL / 端口 /
 * 中继没起）与连上了但拉不到索引（host 读库失败）。两者的修法没有交集，
 * 而症状在日志里都只是「waitForSelector 超时」。这个快照一次说清是哪种。
 */
async function guestSnapshot(page) {
  return page
    .evaluate(() => ({
      url: location.href,
      nodes: [...document.querySelectorAll('[data-testid^="live-"]')].map((el) => ({
        id: el.getAttribute('data-testid'),
        txt: (el.textContent || '').slice(0, 100),
      })),
      body: (document.body.innerText || '').slice(0, 200),
    }))
    .catch((e) => ({ err: String(e).slice(0, 200) }));
}

/** 断言失败时调：把 guest 快照附在失败信息后面，省得回头再跑一遍看现场。 */
async function dumpGuest(page, label) {
  const snap = await guestSnapshot(page);
  console.log(`   [诊断·${label}] ${JSON.stringify(snap)}`);
}

// ───────────────────────────── 1. 桩中继 ─────────────────────────────
/**
 * 进程内桩中继：只做协议级三件事（配对 / 转发 / host 断线广播），
 * 与真 DO 的 `fetch`(登记+host-link-up) / `webSocketMessage`(原样转发) /
 * `webSocketClose`(host-link-down) 三条路径对应。
 *
 * `stats` 是这条 e2e 的**观测面**：range 帧数、载荷总字节、每个 range 请求的
 * {start,len}、host-link-down 广播次数。它们同时是断言依据（见 part 4/6）。
 */
const stats = {
  rangeFrames: 0,
  /** 视频 range 的载荷字节（**只算低半区 rid**；高半区是单元分片，另计 unitBytes） */
  rangeBytes: 0,
  /** host 单元分片的载荷字节（gzip 后的索引 / 字幕 / 封面），不是视频文件字节 */
  unitBytes: 0,
  /** 每个 video.range 请求的 {start,len}（视频面协议级断言的原始记录） */
  rangeRequests: [],
  /** 二进制帧（含 12 字节头）的 rid 清单，用于确认 rid 不与单元分片撞车 */
  binaryRids: [],
  /** host 实际发出的 range 帧 {rid, seq, bytes}（反推服务区间用；只含视频 range） */
  rangeResponses: [],
  /** rid → video.range 请求 {start, len, videoId, at}（完整性断言的请求侧） */
  rangeRequested: new Map(),
  /** rid → 已收到的应答帧数（完整性断言的应答侧） */
  rangeServed: new Map(),
  hostLinkDown: 0,
  hostLinkDownPayloads: [],
  /** 转发的文本帧路由（诊断用：确认 index/unit 真的过了中继） */
  textTypes: [],
};

const rooms = new Map(); // code → { host, guests:Set }
const wss = new WebSocketServer({ port: RELAY_PORT });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const room = url.searchParams.get('room')?.trim();
  const role = url.searchParams.get('role');
  if (!room || (role !== 'host' && role !== 'guest')) {
    ws.close(4000, 'bad params');
    return;
  }
  if (!rooms.has(room)) rooms.set(room, { host: null, guests: new Set() });
  const r = rooms.get(room);
  if (role === 'host') r.host = ws;
  else r.guests.add(ws);
  console.log(`   [中继] ${role} 进房 ${room}（host=${r.host ? 1 : 0}, guests=${r.guests.size}）`);

  ws.on('message', (data, isBinary) => {
    // 视频面的 range 响应是二进制帧（12 字节头 rid u32 + seq f64 + 载荷）。
    // Node 侧 data 是 Buffer；ws 的 isBinary 标记必须原样带给 send，否则对端
    // 会把二进制帧当文本收——protocol.ts 的 decodeBinaryFrame 对非 ArrayBuffer
    // 一律返 null，链路像死了一样但没有任何报错（mse.ts 文件头钉过这条）。
    if (isBinary && data.length >= 12) {
      const rid = data.readUInt32LE(0);
      const seq = data.readDoubleLE(4);
      const bytes = data.length - 12;
      stats.binaryRids.push(rid);
      if (rid < 0x80000000) {
        // 低半区 = guest 的 mse.ts 生成的 range rid，即**视频文件字节**
        stats.rangeFrames++;
        stats.rangeBytes += bytes;
        // 记下「host 实际发出来的区间」：一个 rid 可能被切成多帧（host 的
        // handleVideoRange 按 RANGE_CHUNK 循环发），首帧的 seq 就是请求的 start，
        // 后续帧的 seq 递增。拿到 {rid, seq, len} 三元组才能反推 host 有没有
        // 按请求的区间回数据（而不是回了一段别的）。
        stats.rangeResponses.push({
          rid,
          seq,
          bytes,
          // 载荷指纹：用来与 host 文件同区间做「逐字节一致」比对。只存摘要不存
          // 字节 —— 11MB 的文件随便几帧就把内存吃光，而摘要足以判定一致性
          // （碰撞概率在这个量级上可以忽略，且我们同时比 len）。
          sha: createHash('sha1').update(data.subarray(12)).digest('hex').slice(0, 16),
        });
        // 完整性断言的应答侧：这个 rid 至少有一帧回来了（0 字节的 EOF 帧也算）
        stats.rangeServed.set(rid, (stats.rangeServed.get(rid) ?? 0) + 1);      } else {
        // 高半区 = host 的单元分片（rid 从 0x80000000 起）。它的载荷是 gzip 后的
        // 索引 / 字幕 / 封面，**不是视频文件字节** —— 早先并进 rangeBytes 计数，
        // 把「转发载荷不超过文件 size」顶出了假红（见文件头字节记账）。
        stats.unitBytes += bytes;
      }
    }
    if (!isBinary) {
      // 记录帧类型帮诊断：index.req/unit.req 有没有真的过中继
      try {
        const f = JSON.parse(data.toString());
        stats.textTypes.push(f.t);
        if (f.t === 'video.range' || f.t === 'video.open') {
          stats.rangeRequests.push({ t: f.t, id: f.id, start: f.start, len: f.len, videoId: f.videoId });
          if (f.t === 'video.range') {
            // 完整性断言的请求侧。id 是字符串（协议契约），rid 路由按数字，这里
            // 显式转成数字才能与二进制帧头的 rid 对上
            stats.rangeRequested.set(Number(f.id), {
              start: f.start,
              len: f.len,
              videoId: f.videoId,
              at: Date.now(),
            });
          }
        }
      } catch {
        /* 坏帧：桩与真中继一样不解析、照样转发（中继只搬运，取舍 1） */
      }
    }
    // 异角色转发，同角色互不可见（真 DO 的 webSocketMessage 同款）
    const targets = role === 'host' ? [...r.guests] : r.host ? [r.host] : [];
    for (const t of targets) {
      if (t.readyState === ws.OPEN) t.send(data, { binary: isBinary });
    }
  });

  ws.on('close', () => {
    if (role === 'host') {
      r.host = null;
      // host 断开：向全体 guest 广播 host-link-down（真 DO 的 webSocketClose）。
      // 帧内容与 live-relay/src/index.ts 的 HOST_LINK_DOWN 常量逐字节一致。
      // ctl: 1 写死：控制帧不跟 app 协议版本走，桩里要是顺手写成
      // `{ v: PROTOCOL_VERSION, ... }`，guest 的 decodeControlFrame 就解不出它（它不看
      // 版本），「主机已离线」的提示静默失效，而下面那条帧字节断言还照样绿。
      const payload = JSON.stringify({ ctl: 1, t: 'host-link-down', id: 'relay' });
      for (const g of r.guests) {
        if (g.readyState === ws.OPEN) {
          g.send(payload);
          stats.hostLinkDown++;
          stats.hostLinkDownPayloads.push(payload);
        }
      }
      console.log(`   [中继] host 断开，向 ${r.guests.size} 台 guest 广播 host-link-down`);
    } else {
      r.guests.delete(ws);
      console.log(`   [中继] guest 断开（剩 ${r.guests.size} 台）`);
    }
  });
});

wss.on('error', (e) => {
  console.error(`桩中继监听失败（端口 ${RELAY_PORT}）：${e.message}`);
  process.exit(1);
});

// ───────────────────────────── 2. fixture ─────────────────────────────
/** 确定性伪随机：同一个 seed 在任何机器上产出同一串字节（可复现 + 可复跑）。 */
function seededBytes(size, seed = 0x9e3779b9) {
  const out = new Uint8Array(size);
  let s = seed >>> 0;
  for (let i = 0; i < size; i++) {
    // xorshift32：短、无依赖、跨平台确定
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    out[i] = s & 0xff;
  }
  return out;
}

/**
 * ffmpeg 可执行文件路径；找不到返回 null（真解码那步据此跳过）。
 *
 * 支持 `E2E_FFMPEG` 覆盖：这是**给自己留的测试口**——上面那条「ffmpeg 缺失时
 * 跳过真解码」的降级路径必须真的能跑一遍才算验证过（否则它只是个注释）。
 * 把它指向一个不存在的路径就能触发降级，不用为了测降级去卸载 ffmpeg。
 */
function findFfmpeg() {
  if (process.env.E2E_FFMPEG !== undefined) {
    return process.env.E2E_FFMPEG === '' ? null : process.env.E2E_FFMPEG;
  }
  const candidates = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg', 'ffmpeg'];
  for (const c of candidates) {
    try {
      if (c === 'ffmpeg' || existsSync(c)) return c;
    } catch {
      /* 继续找下一个 */
    }
  }
  return null;
}

/**
 * 用 ffmpeg 造 video-only webm/vp9 fixture。
 *
 * `-an`（无音频轨）不是顺手加的：本机 Chrome 155 实测带音频轨的容器 MSE 全灭
 * （vp9+opus → video error 3），video-only 才能真播。
 *
 * **duration=45 / 2000kbps 是为了把文件顶过 8MB**（终审 A 的照妖镜，见文件头）：
 * 8MB 是 guest 的 WINDOW_BYTES，也是「一次填充拆几个请求、并发打不打满」的分水岭。
 * 纯 `testsrc` 只有 318kbps（内容太规整），45s 才 1.8MB —— 一轮就拉完，多 chunk /
 * 窗口滑动 / 并发排队一条路径都撞不到。加一道时序噪声（`noise=alls=25:allf=t`）把
 * 码率顶到目标值，产物约 11MB，一次填充必然拆成 8+ 个 1MB 请求。
 */
async function makeWebmFixture(dir) {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) return { path: null, reason: '找不到 ffmpeg（试过 /opt/homebrew/bin、/usr/local/bin、/usr/bin、PATH）' };
  const out = join(dir, 'webm-vp9.webm');
  const args = [
    '-y', '-f', 'lavfi', '-i', 'testsrc=duration=45:size=640x360:rate=15',
    '-vf', 'noise=alls=25:allf=t',
    '-c:v', 'libvpx', '-b:v', '2000k', '-an', out,
  ];
  await new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, args, { stdio: 'ignore' });
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg 退出码 ${code}`))));
  });
  return { path: existsSync(out) ? out : null, reason: existsSync(out) ? '' : 'ffmpeg 报告成功但产物不存在' };
}

/** mp4 门 fixture：ftyp 头 + 3MB 确定性伪随机字节。构造而成，不需要 ffmpeg。 */
function makeMp4Fixture() {
  // 24 字节 ftyp：足够让浏览器把它当 mp4 认（mimeType=video/mp4），
  // 之后的内容是伪随机字节——本机 Chrome 的 MSE 解不了它是实测事实，
  // 所以这门课只做协议级断言（见文件头「双轨断言」）。
  const head = new Uint8Array([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, // size + 'ftyp'
    0x69, 0x73, 0x6f, 0x6d, // major brand 'isom'
    0x00, 0x00, 0x02, 0x00, // minor version
    0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32, // compatible brands
  ]);
  const bytes = seededBytes(MP4_SIZE, 0x51ce5eed);
  head.forEach((b, i) => {
    bytes[i] = b;
  });
  return bytes;
}

/**
 * 在 host 页播种：两门课（mp4 / webm 各一）、字幕段、对照轨、封面、OPFS 文件。
 *
 * 为什么必须走 `import('/src/store/db.ts')`：dev 下按模块 URL import 拿到的是
 * **应用正在用的那一份实例**（e2e-md-editor.mjs 先例）。原生 IndexedDB 写入
 *  Dexie 感知不到，应用不会重渲染；而 host 侧读库发生在 WebSocket 消息回调里，
 * 写入只要真的落了盘就够，所以两条路其实都能喂到 host——但用同一份实例还能
 * 顺带断言「guest 拉到的正是 DB 里那条」，价值更大。
 *
 * 注意 `page.evaluate` 的参数不能是 Blob（跨 context 不可序列化），所以文件字节
 * 以 base64 字符串进去、在页面里还原（e2e-md-covers.mjs 同款做法）。
 */
async function seedHost(page, { mp4Bytes, webmPath }) {
  await page.goto(`${BASE}/#/settings`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="card-livelink"]', { timeout: 30000 });

  const MP4_B64 = Buffer.from(mp4Bytes).toString('base64');
  const WEBM_B64 = webmPath ? Buffer.from(await import('node:fs').then((fs) => fs.readFileSync(webmPath))).toString('base64') : '';

  const seeded = await page.evaluate(
    async ([mp4B64, webmB64, mp4SizeArg, subTextArg]) => {
      const { db } = await import('/src/store/db.ts');
      const { saveVideoFile, getCourseFile } = await import('/src/store/fileStore.ts');
      const fromB64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

      // 一门课一个 id；guest 的索引顺序 = host 的 orderBy('createdAt')，
      // 所以 createdAt 写成 mp4 在前、webm 在后，guest 列表顺序才可预期。
      const now = Date.now();
      const MP4_ID = 'live-e2e-mp4';
      const WEBM_ID = 'live-e2e-webm';

      await db.videos.bulkPut([
        {
          id: MP4_ID,
          name: '实时链路测试课 mp4',
          size: mp4SizeArg,
          mimeType: 'video/mp4',
          duration: 8,
          createdAt: now - 1000,
          status: 'transcribed',
          kind: 'video',
          dominantColor: '#3f6ad8',
        },
        {
          id: WEBM_ID,
          name: '实时链路测试课 webm',
          size: webmB64 ? fromB64(webmB64).byteLength : 0,
          mimeType: 'video/webm',
          // 与 fixture 的 duration=45 对齐：这个字段只进详情副标题显示，不影响拉流
          // （mse.ts 的 pos 估算用的是 video.duration，即媒体自己解出来的时长）
          duration: 45,
          createdAt: now,
          status: 'transcribed',
          kind: 'video',
          dominantColor: '#2f9e6a',
        },
      ]);

      // 字幕 + 对照轨：两门课各一份，文本内容相同（断言只看文本，不比对轨数）。
      // segments.idx 决定 guest 侧显示顺序，写 0 让第一段就是断言目标。
      const segs = [MP4_ID, WEBM_ID].map((videoId) => ({
        videoId,
        idx: 0,
        start: 0,
        end: 4,
        text: subTextArg,
        status: 1,
      }));
      await db.segments.bulkPut(segs);
      const tracks = [MP4_ID, WEBM_ID].map((videoId) => ({
        videoId,
        lang: 'zh',
        lanDoc: '中文',
        primary: 1,
        cues: [{ start: 0, end: 4, text: subTextArg }],
      }));
      await db.subtitleTracks.bulkPut(tracks);

      // 封面：真实 PNG（封面单元走 blob→base64，guest 侧 sniff 前缀判 mime）。
      // 用 1x1 的 WebP/PNG 都行，这里用一个 8x8 的纯色 PNG，够 coverUnitFromBlob
      // 走一遍 base64 分片（分片阈值 0x8000，8x8 远小于它，但路径一致）。
      // 64x36 纯色 PNG（ffmpeg 生成、已用 `file` 验过签名）。封面单元走
      // blob→base64，guest 用 base64 前缀 sniff mime（coverUrlOf），所以必须是
      // **真能解码**的图——手搓的字节会让 img.complete 永远为 false，
      // 「封面出现了但图是碎的」正是这条要守的静默失效形态。
      const png = Uint8Array.from(
        atob(
          'iVBORw0KGgoAAAANSUhEUgAAAEAAAAAkCAIAAAC2bqvFAAAACXBIWXMAAAABAAAAAQBPJcTWAAAA'
            + 'SElEQVR4nO3PQQ3AIADAQEjQhR8cI2cieFyW9BS0c587/mzpgFcNaA1oDWgNaA1oDWgNaA1oDWgN'
            + 'aA1oDWgNaA1oDWgNaA1oHzw0Ag06N/6bAAAAAElFTkSuQmCC',
        ),
        (c) => c.charCodeAt(0),
      );
      await db.covers.bulkPut([MP4_ID, WEBM_ID].map((videoId) => ({
        videoId,
        blob: new Blob([png], { type: 'image/png' }),
        w: 8,
        h: 8,
        ts: 0,
        source: 'auto',
        createdAt: now,
      })));

      // OPFS 文件：mp4 门永远写（协议级断言不依赖真实播放），webm 门有 fixture 才写。
      await saveVideoFile(MP4_ID, new Blob([fromB64(mp4B64)], { type: 'video/mp4' }));
      if (webmB64) await saveVideoFile(WEBM_ID, new Blob([fromB64(webmB64)], { type: 'video/webm' }));

      // 落盘闸门：回读 size，确认 OPFS 真的写进去了（不清库里旧行的话，
      // host 读到的会是上一次运行残留的文件——dev server 常驻时这是真风险）。
      const mp4File = await getCourseFile(MP4_ID);
      const webmFile = webmB64 ? await getCourseFile(WEBM_ID) : null;
      return {
        mp4Id: MP4_ID,
        webmId: WEBM_ID,
        mp4Size: mp4File ? mp4File.size : -1,
        webmSize: webmFile ? webmFile.size : -1,
      };
    },
    [MP4_B64, WEBM_B64, MP4_SIZE, SUB_TEXT],
  );
  return seeded;

}

// ───────────────────────────── 3. 主流程 ─────────────────────────────

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  // MSE 只在真 Chrome 上可用：headless shell 连 addSourceBuffer('video/mp4')
  // 都抛 NotSupportedError（仓库惯例，scripts/e2e-agent-guard.mjs 等同样）。
  args: ['--autoplay-policy=no-user-gesture-required'],
});

/**
 * 预检：dev 服务在不在。
 *
 * 不在就**明确报错并退出**，而不是让第一个 page.goto 抛一个裸的
 * ERR_EMPTY_RESPONSE —— 那条栈信息指向 seedHost 内部，看不出来「其实是没起
 * 服务」。编排器（e2e-all.mjs）会复用端口上已有的服务，端口被别的项目占着时
 *  复用的是别家的页面，症状同样是这个错。先探一次能一次说清。
 */
async function preflight() {
  try {
    const res = await fetch(BASE, { method: 'GET', signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    console.error(`\n❌ 连不上 dev 服务 ${BASE}（${e.message}）`);
    console.error('   先起服务：npm run dev（或设 BASE_URL 指向已起的那份）');
    console.error('   端口被别的项目占用时会复用到别家页面，症状也是这个错。\n');
    process.exit(1);
  }
}

let tmpDir = null;
let hostCtx = null;
let guestCtx = null;
try {
  await preflight();
  tmpDir = mkdtempSync(join(tmpdir(), 'live-e2e-'));
  const mp4Bytes = makeMp4Fixture();
  const webm = await makeWebmFixture(tmpDir);
  const webmSize = webm.path ? statSync(webm.path).size : 0;
  console.log(
    `2. fixture：mp4=${mp4Bytes.byteLength}B（确定性伪随机）；webm=${webm.path ? `${webmSize}B` : '不可用'}`
    + `${webmSize > 8 * 1024 * 1024 ? '（>8MB：多 chunk + 窗口滑动 + 并发排队都会走到）' : ''}`,
  );
  if (!webm.path) console.log(`   ⚠ ${webm.reason} —— 真解码断言将跳过`);

  // 两个 context = 两台设备。host 侧开着共享条（任何页面都在），guest 侧只进镜像页。
  hostCtx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  guestCtx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const hostPage = await hostCtx.newPage();
  const guestPage = await guestCtx.newPage();

  // pageerror 收集到结尾再报：中途抛会让后面的断言一起红，真正的原因被淹掉
  // （e2e-md-editor.mjs 同款理由）。
  const pageErrors = [];
  for (const [name, page] of [['host', hostPage], ['guest', guestPage]]) {
    page.on('pageerror', (e) => pageErrors.push(`[${name}] ${String(e).slice(0, 300)}`));
    page.on('console', (m) => {
      if (m.type() === 'error') console.log(`   [${name} console.error] ${m.text().slice(0, 200)}`);
    });
  }

  // ── 3.1 host 播种 + 开共享 ──
  console.log('3. host 播种并开启共享');
  const seeded = await seedHost(hostPage, { mp4Bytes, webmPath: webm.path });
  check('host 页两门课已落库、OPFS 文件已写（mp4 回读 size 与 fixture 一致）', () => {
    assert.equal(seeded.mp4Size, mp4Bytes.byteLength, `mp4 size=${seeded.mp4Size}`);
    // webm 门在 ffmpeg 缺失时没有文件可写（fixture 造不出来），size=0 是**预期的
    // 降级形态**而不是失败——只在有 fixture 时才要求它落盘。
    if (webm.path) assert.ok(seeded.webmSize > 0, `webm size=${seeded.webmSize}`);
  });
  console.log(`   videoId：mp4=${seeded.mp4Id} webm=${seeded.webmId}`);

  await hostPage.fill('[data-testid="live-relay"] input', RELAY);
  await hostPage.click('[data-testid="live-enable"]');

  // status 先 connecting 再 online（LiveHost.start 同步回调 connecting，
  // socket open 才 online）——直接断言会撞上中间态，必须 waitForFunction。
  await check('host live-status 进入「在线」', async () => {
    await hostPage.waitForFunction(
      () => (document.querySelector('[data-testid="live-status"]')?.textContent ?? '').includes('在线'),
      null,
      { timeout: 15000 },
    );
  });
  const statusText = await hostPage.textContent('[data-testid="live-status"]');
  console.log(`   live-status = ${JSON.stringify(statusText)}`);

  // live-code 是 mdui-text-field：真值在 shadow DOM 的 input 上，宿主 textContent
  // 是空串（e2e-providers.mjs 的 fieldValue 同款结论）。读宿主元素的 value 属性。
  const codeTrim = await readPairCode(hostPage);
  console.log(`   live-code = ${JSON.stringify(codeTrim)}`);
  await check('配对码是 8 位 [A-Z2-9]{8}', () => {
    assert.match(codeTrim, /^[A-Z2-9]{8}$/);
  });
  await check('配对码与 guest 链接里的 pair 一致（host 展示的就是 guest 该用的那个）', () => {
    // hash 路由（HashRouter）下 query 串在 `location.hash` 里，不在 URL 的
    // search 里 —— `new URL(liveUrl).searchParams` 会返回 null，看着像「码没
    // 传过去」，其实是取值方式错了。从 hash 后半段解析。
    const hash = liveUrlFor(codeTrim).slice(liveUrlFor(codeTrim).indexOf('#') + 1);
    const pair = new URLSearchParams(hash.slice(hash.indexOf('?'))).get('pair');
    assert.equal(pair, codeTrim);
  });

  // ── 3.2 配对：guest 进房 ──
  console.log('4. guest 经配对码进房');
  const liveUrl = liveUrlFor(codeTrim);
  console.log(`   guest 链接 = ${liveUrl}`);
  await guestPage.goto(liveUrl, { waitUntil: 'domcontentloaded' });

  await check('guest 出现课程项（live-course-item）', async () => {
    try {
      await guestPage.waitForSelector('[data-testid="live-course-item"]', { timeout: 20000 });
    } catch (e) {
      await dumpGuest(guestPage, 'guest 课程项未出现');
      throw e;
    }
  });

  // 名字在 mdui-list-item 的 shadow DOM（headline 属性），宿主 textContent 是空串
  const headlines = await guestPage
    .locator('[data-testid="live-course-item"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('headline')));
  await check('guest 列表两门课、顺序与 host 的 orderBy(createdAt) 一致', () => {
    assert.deepEqual(headlines, [MP4_COURSE, WEBM_COURSE]);
  });
  console.log(`   课程项 headline = ${JSON.stringify(headlines)}`);

  // host 的共享条文案：guest 连上后 guests 计数变 1。
  // 计数依赖 guest 的 hello 帧真的到了 host（onGuests → set），是 pairing 的一部分。
  await check('host 共享条显示「正在共享给 1 台设备」', async () => {
    await hostPage.waitForFunction(
      () => (document.querySelector('[data-testid="live-share-text"]')?.textContent ?? '').includes('正在共享给 1 台设备'),
      null,
      { timeout: 15000 },
    );
  });
  await check('host 共享条常驻且可见（live-share-bar）', async () => {
    await hostPage.waitForSelector('[data-testid="live-share-bar"]', { timeout: 5000 });
  });
  await check('中继侧确实发生了 index.req / unit.req 转发', () => {
    assert.ok(stats.textTypes.length > 0, '中继没见到任何文本帧');
    assert.ok(stats.textTypes.includes('index.req'), '没有 index.req —— 配对没通');
  });
  console.log(`   中继文本帧类型 = ${JSON.stringify([...new Set(stats.textTypes)])}`);

  // ── 3.3 guest 点开 mp4 门：封面 + 字幕 ──
  console.log('5. guest 打开 mp4 课程（封面 + 字幕文本）');
  await guestPage.locator(`[data-testid="live-course-item"][headline="${MP4_COURSE}"]`).click();
  await check('guest 出现封面 live-cover', async () => {
    await guestPage.waitForSelector('[data-testid="live-cover"]', { timeout: 20000 });
  });
  await check('封面真的解出来了（img complete 且宽高 > 0）', async () => {
    await guestPage.waitForFunction(
      () => {
        const img = document.querySelector('[data-testid="live-cover"]');
        return !!img && img.complete && img.naturalWidth > 0 && img.naturalHeight > 0;
      },
      null,
      { timeout: 15000 },
    );
  });
  await check('字幕第一段文本等于 seed 的 SUB_TEXT', async () => {
    await guestPage.waitForSelector('[data-testid="live-subtitle-item"]', { timeout: 20000 });
    const text = await guestPage.textContent('[data-testid="live-subtitle-item"]');
    assert.equal((text ?? '').trim(), SUB_TEXT);
  });

  // ── 3.4 协议级字节断言（mp4 门）──
  console.log('6. 协议级字节边界（mp4 门，不依赖真实播放）');
  const hostFileSize = await hostPage.evaluate(async (videoId) => {
    const { getCourseFile } = await import('/src/store/fileStore.ts');
    const f = await getCourseFile(videoId);
    return f ? f.size : -1;
  }, seeded.mp4Id);
  console.log(`   host OPFS 真文件 size = ${hostFileSize}（fixture ${mp4Bytes.byteLength}）`);
  await check('host 文件 size 与 fixture 一致（读的是 OPFS 真文件，不是行上的元数据）', () => {
    assert.equal(hostFileSize, mp4Bytes.byteLength);
  });

  // player 的首轮填充走 timeupdate/progress → fill() → requestRange。
  // 等中继侧见到二进制帧（range 响应）再断言；这一步不猜时序。
  await check('桩中继收到 video range 二进制帧（帧数 > 0）', async () => {
    await guestPage.waitForFunction(
      () => {
        const v = document.querySelector('[data-testid="live-video"]');
        return !!v;
      },
      null,
      { timeout: 20000 },
    );
    const deadline = Date.now() + 15000;
    while (stats.rangeFrames === 0 && Date.now() < deadline) await delay(200);
    assert.ok(stats.rangeFrames > 0, `15s 内没见到任何 range 二进制帧（当前 ${stats.rangeFrames}）`);
  });

  // 快照：mp4 阶段的统计必须钉在**这一刻**。桩中继是全程累计的，webm 阶段
  // （第 7 步）还会再产生一批 range 帧——不 snapshot 的话，这里打印和断言的
  // 都是两门课混起来的数，「mp4 门没超拉」就永远验证不到。
  const mp4RangeReqCount = stats.rangeRequests.filter((r) => r.t === 'video.range').length;
  const mp4Frames = stats.rangeFrames;
  // 只算**视频 range 的字节**（低半区 rid）。单元分片（高半区，gzip 后的字幕 /
  // 索引）算进来会让这条断言假红 —— 终审修，见文件头「字节记账」。
  const mp4BytesForwarded = stats.rangeBytes;
  console.log(`   range 请求记录 = ${JSON.stringify(stats.rangeRequests.filter((r) => r.t === 'video.range'))}`);
  await check('每次 range 请求 {start,len} 满足 start+len <= host 文件 size', () => {
    const reqs = stats.rangeRequests.filter((r) => r.t === 'video.range');
    assert.ok(reqs.length > 0, '中继没记录到任何 video.range 请求');
    for (const r of reqs) {
      assert.equal(typeof r.start, 'number', `start 不是数字：${JSON.stringify(r)}`);
      assert.equal(typeof r.len, 'number', `len 不是数字：${JSON.stringify(r)}`);
      assert.ok(r.start >= 0, `start 为负：${JSON.stringify(r)}`);
      assert.ok(r.start + r.len <= hostFileSize, `越界：${JSON.stringify(r)}，size=${hostFileSize}`);
    }
  });
  await check('单个 range 请求的 len 不超过 host 的分片上限 1MB', () => {
    // host 的 handleVideoRange 把 len 钳到 RANGE_CHUNK=1MB。超过 1MB 的帧会被
    // relay 与浏览器静默丢弃（单帧上限）—— 表现是「有个区间永远拉不到」。
    for (const r of stats.rangeRequests.filter((x) => x.t === 'video.range')) {
      assert.ok(r.len <= 1024 * 1024, `len=${r.len} > 1MB`);
    }
  });
  await check('mp4 阶段转发的载荷不超过「文件 size」这么多（没有超拉整文件）', () => {
    // 为什么不是「<= size」：codec 猜错时 mse.ts 会整套拆掉重来（见其文件头
    // 「猜错就换」），同一区间会被重拉。所以这里的上界是「每一个请求最多
    // 被满足一次」的量级：`请求数 × 1MB` 且不超过 `size` 本身 —— mp4 门只发起
    // 过一轮填充（首窗 8MB > 3MB 文件，一次性覆盖全文件），实际载荷应接近 size。
    assert.ok(
      mp4BytesForwarded <= mp4RangeReqCount * 1024 * 1024,
      `载荷 ${mp4BytesForwarded} 超过 ${mp4RangeReqCount}×1MB`,
    );
    assert.ok(
      mp4BytesForwarded <= hostFileSize + 1024 * 1024,
      `载荷 ${mp4BytesForwarded} 比文件 ${hostFileSize} 多出超过一个分片 —— 真的在超拉`,
    );
  });
  // 逐字节一致：这是本条 e2e 最核心的断言，守的正是 start/len 钳位算错时
  // 「能播但花屏 / 拉到空段卡住」这种**没有报错**的静默失效。做法是让 host 页
  // 用 crypto.subtle 对文件同区间算 sha1，与桩中继记下的载荷摘要逐个比对。
  // 短哈希（16 hex）在这个量级上足够，且我们同时比对 len —— len 对不上时
  // 哈希对不对都说明问题。
  const hostSlices = await hostPage.evaluate(
    async ([videoId, windows]) => {
      const { getCourseFile } = await import('/src/store/fileStore.ts');
      const file = await getCourseFile(videoId);
      if (!file) return { error: `host 上取不到文件 ${videoId}` };
      const buf = new Uint8Array(await file.arrayBuffer());
      const out = [];
      for (const w of windows) {
        // host 的 readCourseFileRange 会把 start 钳进 [0, size]，这里**故意不钳**，
        // 用浏览器侧的 slice 语义算原始区间 —— 两端算法一致才配做基准
        const chunk = buf.subarray(w.seq, w.seq + w.bytes);
        const digest = await crypto.subtle.digest('SHA-1', chunk);
        const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
        out.push({ rid: w.rid, seq: w.seq, bytes: w.bytes, sha: hex.slice(0, 16) });
      }
      return { slices: out, size: buf.byteLength };
    },
    // 只比**视频 range** 的帧。高半区的 rid 是单元分片（gzip 后的字幕/索引
    // 载荷），压根不是文件字节——拿它们跟文件切片比摘要永远对不上，那是拿单元面
    // 跟视频面混为一谈。rangeResponses 现在只收低半区（见 ws.on('message')），
    // 这里的兜底 filter 是为了让这段代码自身仍然自明。
    [seeded.mp4Id, stats.rangeResponses.filter((r) => r.rid < 0x80000000)],
  );
  console.log(`   host 文件区间摘要 = ${hostSlices.error ?? JSON.stringify(hostSlices.slices.map((x) => [x.rid, x.seq, x.bytes, x.sha]))}`);
  await check('拉到的字节段与 host 文件逐字节一致（载荷摘要 + len 都对上）', () => {
    assert.ok(!hostSlices.error, hostSlices.error ?? '');
    assert.equal(hostSlices.size, hostFileSize);
    assert.ok(hostSlices.slices.length > 0, '没有可比的区间');
    for (const got of hostSlices.slices) {
      assert.equal(
        got.sha,
        stats.rangeResponses.find((r) => r.rid === got.rid)?.sha,
        `rid=${got.rid} 区间 [${got.seq}, ${got.seq + got.bytes}) 的载荷摘要不一致`,
      );
    }
  });

  await check('video range 的 rid 不与 host 单元分片 rid 撞车（guest 侧必须留在低半区）', () => {
    // host 单元 rid 从 0x80000000 起；guest 的 range rid 由 mse.ts 的 nextRid 给，
    // 必须 < 0x80000000（协议契约，guest.ts 文件头钉过）。撞车的后果是视频字节
    // 被错配进字幕单元——不报错、只是内容错乱。
    const low = stats.binaryRids.filter((rid) => rid < 0x80000000);
    assert.ok(low.length > 0, '中继没见到低半区 rid 的二进制帧（range 响应）');
    for (const rid of low) assert.ok(rid >= 0 && rid < 0x80000000, `rid=${rid} 越界`);
    const high = stats.binaryRids.filter((rid) => rid >= 0x80000000);
    console.log(`   二进制帧 rid：单元分片（高半区）${high.length} 帧，视频 range（低半区）${low.length} 帧`);
  });

  // mp4 在本机 Chrome 放不了是实测事实：记录 play-error 出现与否，不断言它播起来。
  const mp4PlayErr = await guestPage
    .locator('[data-testid="live-play-error"]')
    .textContent()
    .catch(() => null);
  console.log(`   mp4 门 live-play-error = ${mp4PlayErr ? JSON.stringify(mp4PlayErr.slice(0, 80)) : '（未出现）'}`);
  console.log(`   mp4 阶段：range 帧 ${mp4Frames}，载荷 ${mp4BytesForwarded} 字节（文件 ${hostFileSize}）`);

  // ── 3.5 真实解码（webm 门）──
  console.log('7. webm 门真解码（buffered + currentTime 推进）');
  if (!webm.path) {
    skip(`真解码（${webm.reason}）`);
    LAST_WEBM_STATE = 'skipped';
  } else {
    LAST_WEBM_STATE = 'ran';
    await guestPage.locator(`[data-testid="live-course-item"][headline="${WEBM_COURSE}"]`).click();
    await check('webm 门出现 live-video 播放器', async () => {
      await guestPage.waitForSelector('[data-testid="live-video"]', { timeout: 20000 });
    });

    // video.buffered 是**秒**不是字节。真 webm 上首片 append 落地后 1-2s 内
    // buffered.length > 0 成立（Task 4 的实测）。首片要经过 sourceopen →
    // addSourceBuffer → range 请求 → host 读 OPFS → 转发 → appendBuffer →
    // updateend，整条链走完才长出来，所以给足超时、不猜时序。
    await check('video.buffered.length > 0（首片真的进了 SourceBuffer）', async () => {
      await guestPage.waitForFunction(
        () => {
          const v = document.querySelector('[data-testid="live-video"]');
          return !!v && v.buffered && v.buffered.length > 0;
        },
        null,
        { timeout: 25000 },
      );
    });
    const bufInfo = await guestPage.evaluate(() => {
      const v = document.querySelector('[data-testid="live-video"]');
      if (!v || !v.buffered || v.buffered.length === 0) return null;
      return { start: v.buffered.start(0), end: v.buffered.end(0), duration: v.duration };
    });
    console.log(`   buffered = ${JSON.stringify(bufInfo)}`);

    // play() 后 currentTime 增大 = 真解码在往前走（不只是缓冲到了）。
    // 自动播放策略在本 context 已用 --autoplay-policy=no-user-gesture-required 放开。
    // 2 倍速：11MB 的 fixture 要走过窗口滑动的路径，1 倍速得等几十秒墙钟时间。
    // 倍速只影响播放头，拉流仍按字节预算走（pos 前移 → 窗口前移 → 重新规划）。
    const t0 = await guestPage.evaluate(() => document.querySelector('[data-testid="live-video"]').currentTime);
    await guestPage.evaluate(() => {
      const v = document.querySelector('[data-testid="live-video"]');
      if (v) {
        v.playbackRate = 2;
        void v.play().catch(() => {});
      }
    });

    // ── 采样循环：一边播一边盯 video.buffered（终审 A 的照妖镜）──
    // 后续三条断言全部来自这一次采样：
    //   ① worstGapAhead —— 播放头**前方**的缺口。丢帧的 rid 永远等不到应答，那段
    //      字节既不 append 也不重拉（guest 的覆盖表把它算成已覆盖），video.buffered
    //      上就留一个洞：播放头到那里 MSE 只是 waiting，没有 error、没有 UI 变化。
    //      播放头**后方**的缺口是浏览器淘汰已播数据，正常，不计。
    //   ② maxEnd —— buffered 末端最远到过哪儿。≥75% 时长说明窗口跟着播放头滑过了
    //      多个 1MB 分片，不是把首窗拉满就停。
    //   ③ samples —— 采样次数，纯诊断（太少说明循环早退）。
    const probe = await guestPage.evaluate(async (opts) => {
      const v = document.querySelector('[data-testid="live-video"]');
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const deadline = Date.now() + opts.timeoutMs;
      let worstGapAhead = 0;
      let worstGapAt = null;
      let maxEnd = 0;
      let samples = 0;
      let lastRanges = null;
      while (Date.now() < deadline) {
        if (v.buffered && v.buffered.length > 0) {
          samples++;
          const ranges = [];
          for (let i = 0; i < v.buffered.length; i++) ranges.push([v.buffered.start(i), v.buffered.end(i)]);
          lastRanges = ranges;
          maxEnd = Math.max(maxEnd, ranges[ranges.length - 1][1]);
          for (let i = 1; i < ranges.length; i++) {
            const gap = ranges[i][0] - ranges[i - 1][1];
            const aheadOfPlayhead = ranges[i - 1][1] > v.currentTime + 0.05;
            if (gap > 0.05 && aheadOfPlayhead && gap > worstGapAhead) {
              worstGapAhead = gap;
              worstGapAt = { t: v.currentTime, ranges };
            }
          }
          if (maxEnd >= opts.targetEnd && v.currentTime >= opts.targetTime) break;
        }
        await sleep(100);
      }
      return {
        samples,
        worstGapAhead,
        worstGapAt,
        maxEnd,
        ranges: lastRanges,
        duration: v.duration,
        currentTime: v.currentTime,
        readyState: v.readyState,
        paused: v.paused,
        errorCode: v.error ? v.error.code : null,
        errorMessage: v.error ? v.error.message : null,
      };
    }, { timeoutMs: 45000, targetEnd: 0.75 * WEBM_EXPECT_SEC, targetTime: 10 });

    const dur = Number.isFinite(probe.duration) && probe.duration > 1 ? probe.duration : WEBM_EXPECT_SEC;
    console.log(
      `   采样 ${probe.samples} 次：buffered 末端最远 ${probe.maxEnd.toFixed(2)}s / 时长 ${dur}s，`
        + `播放头前方最大缺口 ${probe.worstGapAhead.toFixed(3)}s，currentTime=${probe.currentTime.toFixed(2)}`
        + `（readyState=${probe.readyState} paused=${probe.paused} video.error=${probe.errorCode ?? '无'} ${probe.errorMessage ?? ''}，`
        + `buffered=${JSON.stringify(probe.ranges)}）`,
    );
    // 播放器自报的错误（如果有）先打出来：后面几条断言都可能只是它的下游
    const webmPlayErr = await guestPage
      .locator('[data-testid="live-play-error"]')
      .textContent()
      .catch(() => null);
    console.log(`   webm 门 live-play-error = ${webmPlayErr ? JSON.stringify(webmPlayErr.slice(0, 240)) : '（未出现）'}`);

    await check('video.buffered 连续无洞（播放头前方没有缺口 = 没有丢帧留洞）', () => {
      assert.ok(probe.samples > 0, '一次都没采到 buffered');
      assert.ok(
        probe.worstGapAhead <= 0.05,
        `播放头前方有 ${probe.worstGapAhead.toFixed(3)}s 的洞：${JSON.stringify(probe.worstGapAt)}`
          + '（丢帧的 rid 永远等不到应答，区间被覆盖表永久算成已覆盖 —— 文件留洞、播放卡住且无报错）',
      );
    });
    await check('video.buffered 覆盖到接近播完（窗口跟着播放头滑过多个 1MB 分片）', () => {
      assert.ok(
        probe.maxEnd >= dur * 0.75,
        `buffered 末端只到 ${probe.maxEnd.toFixed(2)}s / ${dur}s —— 窗口没滑起来，或中途停摆`,
      );
    });

    await check('play() 后 currentTime 增大（真解码）', async () => {
      await guestPage.waitForFunction(
        (t0v) => {
          const v = document.querySelector('[data-testid="live-video"]');
          return !!v && v.currentTime > t0v + 0.15;
        },
        t0,
        { timeout: 20000 },
      );
    });
    const t1 = await guestPage.evaluate(() => document.querySelector('[data-testid="live-video"]').currentTime);
    console.log(`   currentTime：${t0.toFixed(3)} → ${t1.toFixed(3)}`);
    await check('webm 门没有 live-play-error', async () => {
      const err = await guestPage.locator('[data-testid="live-play-error"]').count();
      assert.equal(err, 0, `webm 门出现了播放错误：${webmPlayErr ?? '?'}`);
    });

    // ── 完整性：每个请求的 rid 都收到过应答帧（终审 A 的第二条断言）──
    // 只查 webm 门这门课的请求（mp4 门在上面已经逐字节比对过）。
    // 匹配条件是 **rid + seq**：host 的首帧 seq 恒等于请求的 start，所以「同 rid 且
    // 同 start 的应答出现过」才叫这个请求真的被满足过（只比 rid 的话，另一个 course
    // 复用同一 rid 时会被误判成已应答 —— 实测踩过：rid 是每播放器各自的游标）。
    // 也不要求「此刻一条在途都没有」—— guest 常态就挂着最多 4 个在途请求，那是设计
    // 而不是失败；真正的失败形态是「某个 rid 自始至终一帧都没回来」。
    const servedKeys = new Set(stats.rangeResponses.map((r) => `${r.rid}:${r.seq}`));
    const webmReqs = stats.rangeRequests.filter((r) => r.t === 'video.range' && r.videoId === seeded.webmId);
    const lost = webmReqs.filter((r) => !servedKeys.has(`${Number(r.id)}:${r.start}`));
    await check(`完整性：webm 门每个 video.range 请求都收到了应答帧（共 ${webmReqs.length} 次）`, () => {
      assert.ok(webmReqs.length > 0, '中继没记录到 webm 门的 video.range 请求');
      assert.equal(
        lost.length,
        0,
        `有 ${lost.length} 个请求没有任何应答帧：${lost.slice(0, 12).map((r) => `rid=${r.id}@${r.start}`).join(', ')}`,
      );
    });
    await check('窗口真的滑过了首窗 8MB（fixture > 8MB，请求覆盖超出首窗）', () => {
      const ivs = webmReqs
        .map((r) => [r.start, r.start + r.len])
        .sort((a, b) => a[0] - b[0]);
      assert.ok(ivs.length > 8, `webm 门只发出 ${ivs.length} 个 range 请求，${webmSize}B 的 fixture 该拆成更多`);
      // 合并相邻/重叠区间，算实际请求覆盖的字节数
      let covered = 0;
      let cur = ivs[0];
      for (const iv of ivs.slice(1)) {
        if (iv[0] <= cur[1]) cur[1] = Math.max(cur[1], iv[1]);
        else {
          covered += cur[1] - cur[0];
          cur = iv;
        }
      }
      covered += cur[1] - cur[0];
      console.log(`   webm 门请求覆盖 ${covered} 字节（首窗 8MB，fixture ${webmSize}B）`);
      assert.ok(
        covered > 8 * 1024 * 1024,
        `请求只覆盖 ${covered} 字节 —— 没滑出首窗 8MB，多 chunk / 窗口滑动这条路径没被走到`,
      );
    });
  }

  // ── 3.6 断线：host 停机，guest 立刻离线 ──
  console.log('8. 断线：host 停机 → guest 离线');
  const shareBarBefore = await hostPage.locator('[data-testid="live-share-bar"]').count();
  await hostPage.click('[data-testid="live-share-stop"]');

  await check('guest 出现 live-offline（主机下线立刻可见）', async () => {
    await guestPage.waitForSelector('[data-testid="live-offline"]', { timeout: 10000 });
  });
  await check('host 共享条消失（成对断言：停机后不再假装在共享）', async () => {
    await hostPage.waitForSelector('[data-testid="live-share-bar"]', { state: 'detached', timeout: 10000 });
  });
  console.log(`   停机前共享条存在=${shareBarBefore > 0}，host-link-down 广播次数=${stats.hostLinkDown}`);
  await check('中继广播了 host-link-down（帧内容与真 DO 常量一致）', () => {
    assert.ok(stats.hostLinkDown > 0, '没广播 host-link-down');
    // 黄金字节：ctl 形状、**没有 v**。真中继改这一行时这里会红（桩与真中继各改一半的
    // 症状是「新来宾收不到离线条」，而这条断言正好是那条症状的哨兵）。
    assert.equal(stats.hostLinkDownPayloads[0], '{"ctl":1,"t":"host-link-down","id":"relay"}');
  });

  // 页面错误：真错误才红。React 的 StrictMode 双挂载在 dev 下会有无害噪音，
  // 但这里的 pageerror 都是真异常（脚本自己造成的除外），值得显式看见。
  await check('全程无未捕获页面异常', () => {
    const real = pageErrors.filter((e) => !/ResizeObserver|autoplay|play\(\)/i.test(e));
    assert.equal(real.length, 0, real.join('\n      '));
  });

  // ── 3.7 「开着但没连上」时共享条仍在（终审 L）──
  // 隐私不变量 5 的字面是「一开共享，任何页面都有消不掉的提示」。旧实现的条件是
  // enabled && status==='online'，于是「开着但连不上」（中继地址填错）时整条消失 ——
  // 用户以为没在共享，其实开关还开着。这里把中继换成一个必然连不上的地址再开共享，
  // 断言条目还在、且文案说清「连不上」。
  console.log('9. 共享条：开着但连不上时仍在，并按 status 说实话');
  await hostPage.fill('[data-testid="live-relay"] input', 'ws://127.0.0.1:1/');
  await hostPage.click('[data-testid="live-enable"]');
  await check('连不上时共享条仍在（live-share-bar），文案说清连不上', async () => {
    await hostPage.waitForFunction(
      () => {
        const t = document.querySelector('[data-testid="live-share-text"]')?.textContent ?? '';
        return t.includes('连接失败');
      },
      null,
      { timeout: 15000 },
    );
  });
  const failText = await hostPage.textContent('[data-testid="live-share-text"]');
  console.log(`   连不上时的共享条 = ${JSON.stringify(failText)}`);
  await hostPage.click('[data-testid="live-share-stop"]');
  await check('点「停止」后共享条消失（enabled=false）', async () => {
    await hostPage.waitForSelector('[data-testid="live-share-bar"]', { state: 'detached', timeout: 10000 });
  });
} finally {
  // 清理：browser / 桩中继 / tmp fixture，任何一步炸了也要走到这
  await browser.close().catch(() => {});
  wss.close();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  // 临时诊断口：DUMP_REQ=<路径> 把 range 请求明细落盘，用来分析请求风暴 / 覆盖区间。
  // 与 E2E_FFMPEG 同一性质 —— 给自己留的测试口，正常跑不设它。
  if (process.env.DUMP_REQ) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      process.env.DUMP_REQ,
      JSON.stringify({
        requests: stats.rangeRequests.filter((r) => r.t === 'video.range'),
        responses: stats.rangeResponses,
      }),
    );
  }
}

// ───────────────────────────── 4. 汇总 ─────────────────────────────
console.log('\n── 汇总 ──────────────────────────────────────────');
console.log(
  `桩中继：range 帧 ${stats.rangeFrames}，range 载荷 ${stats.rangeBytes} 字节`
    + `（另有单元分片载荷 ${stats.unitBytes} 字节，不计入视频面）`
    + `，video.range 请求 ${stats.rangeRequests.filter((r) => r.t === 'video.range').length} 次 / ${stats.rangeRequested.size} 个 rid`
    + `，host-link-down ${stats.hostLinkDown} 次`,
);
if (LAST_WEBM_STATE === 'skipped') {
  console.log('真解码：跳过（ffmpeg 缺失，原因见上）—— 本轮只验了协议级与镜像链路');
} else if (LAST_WEBM_STATE === 'ran') {
  console.log('真解码：已验（webm buffered 无洞 + 覆盖 ≥75% 时长 + currentTime 推进 + 每个 rid 都有应答帧）');
}
console.log(`断言失败 ${failed} 项`);
if (failed === 0) {
  console.log('\n✅ e2e-livelink 全链路通过');
  process.exit(0);
}
console.error(`\n⚠️ 有 ${failed} 项断言失败`);
process.exit(3);
