/**
 * 实时链路上传中继（live-relay）：按配对码把 host 与 guest 接进同一 DO 房间，
 * 原样转发帧，不解析、不存任何业务数据——与 bili-proxy 同一条「只搬运」原则。
 *
 * 四条取舍（为什么是这个形态）：
 *
 * 1. **不解析业务载荷**。免费档 CPU 限额是 10ms/请求，一条带字幕的 content 单元
 *    JSON.parse 就能打爆；而中继没有任何需要懂帧内容的理由——路由只认 URL 上的
 *    room/role 与 socket 生命周期。文本帧（JSON）与二进制帧（12 字节头 + 载荷）
 *    在这里都是不透明消息，原样转发，**坏帧也转发**：host/guest 侧的 decodeFrame
 *    自己会拒收，中继替它们拒收只会让两边协议分叉。
 * 2. **用 DO 而不是纯 Worker**。Worker 无状态，而「把两个 socket 配成一对」需要
 *    共享状态；DO 按名字寻址（idFromName(code)）天然就是「一间房」：同配对码的
 *    连接必然落到同一个实例，跨实例同步问题从根上不存在。
 * 3. **host 宽限 60 秒**。host 刷新页面、短暂断网时会重连，宽限期内回来则 guest
 *    自动恢复：断开那一刻**立刻**向全体 guest 广播 host-link-down（不变量 7 要求
 *    「host 消失必须被显式感知」），host 回来时再补发 host-link-up（guest 端收到即
 *    回到 ready，另有 3 秒轮询兜底）。两头都有提示，不是「无感」——  guest 侧会先
 *    看到「主机已离线」再看到恢复，全程不用手动操作。60 秒还不够回来才让宽限
 *    alarm 收房间（close 4000）。宽限 alarm 在 host 重连时取消（见 fetch 的 host 分支）。
 * 4. **限速计数在 DO storage 而不是内存**。Hibernation 下 DO 内存会被逐出，
 *    「房间没人碰」的空窗里变量清零，爆破者等一个空窗就把计数洗了；storage 才
 *    活得过空窗（代价是每次计数一次写，可忽略）。
 *
 * 连接契约（与 src/livelink/ 的 host.ts / guest.ts 对齐，两侧已按此实现）：
 *   wss://<worker>?room=<配对码>&role=host|guest
 * 中继只合成两种帧（v 必须等于应用侧 protocol.ts 的 PROTOCOL_VERSION——两套部署
 * 不共享模块，只能靠约定；应用侧 bump 到 P2 的 v2 时**这里必须同步改并重新部署**，
 * 否则 guest 的 decodeFrame 会把这两帧当坏帧静默丢掉，「主机已离线 / 已恢复」这条
 * 提示会毫无征兆地失效）：
 *   {"v":2,"t":"host-link-down","id":"relay"}   host 断开时广播给全体 guest
 *   {"v":2,"t":"host-link-up","id":"relay"}     host 宽限内回来时广播给全体 guest
 *
 * close code 与 guest 页 FATAL_CLOSE_CODES（LiveGuest.tsx）一一对应，改前先看那：
 *   4000 房间回收 / 4001 配对码不存在 / 4403 配对限流
 */

import { DurableObject } from 'cloudflare:workers';

// 注意：class 用 `export class` 直接导出即可，不要额外写 `export { Room }`——
// 两处都导出同名 binding 在 tsc 下是货真价实的 redeclare 冲突（esbuild 不报，
// 但类型检查过不了）。wrangler 的 class_name 认的就是 export class。

/** 角色。入口与 DO 内各校验一次：DO fetch 将来若被别的方式调到，不能只靠入口兜底。 */
type Role = 'host' | 'guest';

/** 随 socket 持久化的最小状态。Hibernation 下 socket 对象本身不保留 JS 侧字段。 */
interface Attachment {
  role: Role;
}

/** host 断开后的宽限：刷新页面 / 短暂断网，这么短时间内回来 guest 能自动恢复
 * （会闪一次「主机已离线 / 重连中」，不用手动操作；取舍 3）。 */
const HOST_GRACE_MS = 60_000;

/** 配对限速：无 host 的 guest 连接计到这么多次就锁定该房间的 guest 接入。 */
const THROTTLE_AFTER = 5;

/** 配对限速锁定后计数保留的时长（alarm 到点清零；持续重连会自然续期，见 alarm 注释）。 */
const THROTTLE_LOCK_MS = 5 * 60 * 1000;

/** 房间空置后的回收 alarm：没有 socket 也没有 alarm 的 DO 靠平台逐出，时序不由我们定。 */
const IDLE_REAP_MS = 10 * 60 * 1000;

const CLOSE_ROOM_EXPIRED = 4000;
const CLOSE_BAD_CODE = 4001;
const CLOSE_THROTTLED = 4403;

/** 中继合成的链路状态帧。id 固定 'relay'：与业务帧的 id 命名空间分开，日志里一眼可辨。 */
const HOST_LINK_DOWN = '{"v":2,"t":"host-link-down","id":"relay"}';
const HOST_LINK_UP = '{"v":2,"t":"host-link-up","id":"relay"}';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    const url = new URL(request.url);
    const room = url.searchParams.get('room')?.trim();
    const role = url.searchParams.get('role');
    if (!room || (role !== 'host' && role !== 'guest')) {
      return new Response('bad params', { status: 400 });
    }
    // 只做长度卫生检查，不内嵌应用侧的码表（8 位 32 进制）：中继与 App 是两套部署，
    // 猜格式只会静默分叉。128 字符远超任何合理的配对码，纯粹是防荒谬 key。
    if (room.length > 128) {
      return new Response('bad params', { status: 400 });
    }
    // room 与 role 已经带在 URL query 上，DO 的 fetch 里再取一次——为什么不拆成
    // header：stub.fetch(request) 原样转交最省事，Upgrade 头一个字节都不用动。
    const id = env.ROOM.idFromName(room);
    const stub = env.ROOM.get(id);
    return stub.fetch(request);
  },
};

interface Env {
  ROOM: DurableObjectNamespace<Room>;
}

export class Room extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const role = url.searchParams.get('role');
    if (role !== 'host' && role !== 'guest') {
      return new Response('bad params', { status: 400 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    // role 存进 attachment：hibernation 会在消息/关闭回调前把 DO 逐出内存，
    // 靠 deserializeAttachment 还原，不依赖任何实例字段（持久化由 storage 背书）。
    server.serializeAttachment({ role } satisfies Attachment);

    if (role === 'guest') {
      const hasHost = this.ctx.getWebSockets().some((s) => this.roleOf(s) === 'host');
      if (!hasHost) {
        // 房间里没有 host = 这个配对码不存在（或主机此刻不在）。计入 badAttempts：
        // 防的是「按码爆破」——拿着一个码反复试的房间会被锁 5 分钟（取舍 4）。
        // 计数放 storage 而不是内存：hibernation 下 DO 会被逐出内存，storage
        // 才能活过「房间没人碰」的空窗。
        const bad = ((await this.ctx.storage.get<number>('badAttempts')) ?? 0) + 1;
        await this.ctx.storage.put('badAttempts', bad);
        if (bad >= THROTTLE_AFTER) {
          await this.ctx.storage.setAlarm(Date.now() + THROTTLE_LOCK_MS); // 到点清零
          server.close(CLOSE_THROTTLED, 'too many attempts');
        } else {
          server.close(CLOSE_BAD_CODE, 'bad code');
        }
        // close 之后照常回 101：client 端的 onclose 会带着 code/reason 到达，
        // 这正是 guest 页 FATAL_CLOSE_CODES 分支要的东西。
        return new Response(null, { status: 101, webSocket: client });
      }
    }

    if (role === 'host') {
      const hasOtherHost = this.ctx
        .getWebSockets()
        .some((s) => s !== server && this.roleOf(s) === 'host');
      // 只在「房间里原本没有 host」时才补发 host-link-up：另一种 host 在场说明
      // 没有发生过 guest 可见的掉线（同码双开的退化场景，见文件末的多 host 说明），
      // 乱发只会让 guest 无谓重拉索引。
      if (!hasOtherHost) {
        const guests = this.ctx.getWebSockets().filter((s) => this.roleOf(s) === 'guest');
        if (guests.length > 0) {
          // host 在宽限内回来了：guest「自动恢复」的契约在这一句（取舍 3）。
          // 注意断开那一刻已经广播过 host-link-down，所以 guest 侧是先看到离线
          // 提示、再看到恢复—— 两半合起来才是完整的宽限语义，别只记这一句。
          for (const g of guests) g.send(HOST_LINK_UP);
          // 宽限 alarm 作废（无 host 时到点要 close 全体 guest 的那个）。
          // 毛边：若未到期的其实是配对限速 alarm，计数会残留——后果仅是宽限期内
          // 前几次 guest 尝试拿到 4403，host 真正回来后 hasHost 直接放行，自愈。
          await this.ctx.storage.deleteAlarm();
        }
      }
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    const role = this.roleOf(ws);
    if (!role) return;
    for (const other of this.ctx.getWebSockets()) {
      if (other === ws) continue;
      if (this.roleOf(other) === role) continue; // 同角色互不可见（host↔host、guest↔guest）
      other.send(message); // 原样转发：不 parse、不改写，坏帧也转（取舍 1）
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const role = this.roleOf(ws);
    if (role === 'host') {
      // 只在「最后一个 host 离开」时广播 down 并起宽限 alarm：同码双开的退化场景里
      // 另一个 host 还活着，guest 不该被惊动（正常单 host 房间两者等价）。
      const hasOtherHost = this.ctx
        .getWebSockets()
        .some((s) => s !== ws && this.roleOf(s) === 'host');
      if (!hasOtherHost) {
        for (const g of this.ctx.getWebSockets()) {
          if (this.roleOf(g) === 'guest') g.send(HOST_LINK_DOWN);
        }
        // 宽限 60s：host 刷新/短暂断网时重连即可取消（见 fetch 的 host 分支）。
        // 若此刻房间已空，这个 alarm 到点也会顺手清掉 badAttempts，不浪费。
        await this.ctx.storage.setAlarm(Date.now() + HOST_GRACE_MS);
      }
      return;
    }
    // 最后一个 socket 走了（host 不在场，否则上面已经挂过宽限 alarm）：
    // 补一个空闲回收 alarm，让没人碰的房间连 badAttempts 一起清掉。已有 alarm
    // （宽限 / 限速）时不动它——alarm 只有一个槽，别把更要紧的那个顶掉。
    const sockets = this.ctx.getWebSockets();
    if (sockets.length === 0 && (await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + IDLE_REAP_MS);
    }
  }

  async alarm(): Promise<void> {
    // —— 简化说明（alarm 双用途为何不区分）——
    // DO 只有一个 alarm 槽，却有两个用途：host 宽限（60s）与配对限速清零（5min）。
    // 逐意图区分要多存一个标记、多几条分支，而两种意图在「无 host」这个前提下
    // 动作本来就一致：清计数 + 收房间。宽限到点要 close 剩余 guest（4000），顺手
    // 清计数无副作用（房间即将回收）；限速到点要清 badAttempts，此时房间里若还有
    // socket（只可能是宽限期内新连的 guest，或限速期内 host 来过又走了），close
    // 掉同样正确——没有 host 的房间留着 socket 也没有意义。有 host 时一律 no-op：
    // 主机活着，房间就不该被收。
    // 两个已知毛边（都可自愈，不阻塞）：
    //   1. 限速的 5 分钟窗口不是硬窗口：被 4403 挡回的连接要重新付一次
    //      「建连→计数→close」的代价，重试窗口由这个代价自然形成；持续重打会把
    //      alarm 一直往后推、计数也就不清零——对防爆破恰恰是要的（打得更狠锁得越久）。
    //   2. host 带着 guest 重连时 deleteAlarm() 可能清掉未到期的限速 alarm，
    //      计数残留到下一次宽限窗口（见 fetch 的 host 分支注释）。
    const hasHost = this.ctx.getWebSockets().some((s) => this.roleOf(s) === 'host');
    if (hasHost) return;
    for (const ws of this.ctx.getWebSockets()) {
      ws.close(CLOSE_ROOM_EXPIRED, 'room expired');
    }
    await this.ctx.storage.delete('badAttempts');
  }

  // —— 内部 ─────────────────────────────────────────────────────────────

  private roleOf(ws: WebSocket): Role | undefined {
    return ws.deserializeAttachment<Attachment>()?.role;
  }
}

// —— 已知退化场景（不在本 Task 范围内，记录备查）——
// 同配对码两个 host（同一台机器开两个标签页，或故意把码透露给第二台机器）：
// 中继不踢旧 host，两个 host 都会收到 guest 的请求并各自应答。同机同库时数据
// 一致、无害；两台不同机器时 rid 空间都是从 0x80000000 起算的同一起点，guest
// 侧可能把两边的分片混进同一个 rid——表现为单元拉取报错（坏 gzip），不会静默
// 错数据。host.ts 的 guests 计数也会两边各算各的。（host-link-down/up 的广播
// 已按「最后一个 host」守卫，双 host 时一个离开不会惊动 guest；剩下没解的只有
// 重复应答与 rid 撞车。）真要支持「一码多主」，该做的是 host 发现/选举，不是
// 中继里加踢人逻辑。
