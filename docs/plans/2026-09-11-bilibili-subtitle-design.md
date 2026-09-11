# B 站字幕导入（主/副分工 + 中英对照）设计

日期：2026-09-11
状态：已实现

## 背景与目标

现状：B 站导入只拿视频流，字幕要靠本地 ffmpeg 抽音 + VAD + ASR 转写（分钟级、花钱、有错字）。
但 B 站自己就有字幕（UP 上传的 CC 字幕 + AI 自动生成字幕），网课类视频命中率很高。

目标：

1. 导入时能选要哪几个语言的字幕；
2. **主语言**（默认中文）写进现有 `segments` 表 —— 讲义/卡片/弹幕/检索/embedding 全链路不动；
3. **其余语言**只喂显示，字幕面板可切换「对照语言」，中英**同屏两行**；
4. 没有 B 站字幕时，保持原有 ASR 流程不变（面板「生成字幕」按钮照旧）。

## 一、接口实测结论（决定实现形态）

在真机（未登录）实测：

| 接口 | 匿名可用 | 说明 |
|---|---|---|
| `GET api.bilibili.com/x/player/v2` / `x/player/wbi/v2` | ❌ | `need_login_subtitle: true`，`subtitles: []` |
| `GET api.bilibili.com/x/web-interface/view?aid=&cid=` | ❌ | `subtitle.list` 有条目但 `is_lock: true`、`subtitle_url: ""`（URL 被抠空） |
| `POST app.biliapi.net/bilibili.community.service.dm.v1.DM/DmView` | ✅ | **不用 Cookie 就能拿到带签名的字幕直链** |

DmView 细节（已实测，含多语言）：

- body = `[0x00][4 字节大端长度][DmViewReq protobuf]`，也支持 `0x01 + gzip`；
  `DmViewReq = { 1: pid(aid), 2: oid(cid), 3: type=1, 4: spmid="main.ugc-video-detail.0.0" }`
- 响应 `DmViewReply.3(subtitle)` → `.3(subtitles)[]`，每项：
  `1=id, 2=id_str, 3=lan, 4=lan_doc, 5=subtitle_url, 6=author, 7/9/10=AI 标记, 8=简化语言名`
- `lan` 取值：`ai-zh`（中文·自动生成）、`ai-en`/`ai-ja`/`ai-es`…（自动翻译）、
  `zh-CN`/`zh-Hans`/`zh-Hant`/`en-US`…（UP 上传的 CC）
- 直链形如 `http://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/xxx.json?auth_key=...`，
  **裸 curl 可下**（无需 Referer/Cookie），JSON：`{ font_size, body: [{ from, to, location, content, ... }] }`
- `auth_key` 名义 TTL 极短，实测 70s 后仍可下载 —— 仍然「取到就立刻拉」
- 实测命中：BV1d7wAzsE8V（线性代数·宋浩）`ai-zh` 481 行 + 5 种自动翻译；
  BV1eY4y1W7Gd `ai-zh` 888 行；番剧/课程走不了 aid/cid（需 intl 接口），不在本期范围

## 二、方案（方案 A：主/副分工）

导入对话框改成两步：

```
点「解析」 → 显示标题/时长 +（多 P 时）分 P 多选 + 字幕语言多选
          → 点「开始导入」→ 逐个分 P 拉视频流 + 拉所选字幕
```

- 选中语言里的第一项（按优先级 `zh-* / ai-zh` → `en*` → 其余）作**主语言**
- 主语言 → `db.segments`（`status = 1`，一条 B 站 cue 一段；`cues` 存该 cue 自身，保留精确时间轴）
- 全部选中语言（含主语言）→ 新表 `db.subtitleTracks`，仅用于显示与对照
- 视频 `status` 直接置 `transcribed`，讲义/卡片/弹幕立刻可用

显示侧：字幕面板加「对照语言」下拉（默认「关闭」）；选中后把两条 cue 按**时间重叠**合成两行
（主语言在上、对照在下，重叠不上就单独一行），玩家侧 `\n` 由 media-captions
的 `text.split(LINE_TERMINATOR_RE)` 渲染成两行，面板侧拆行加 `<br/>`。

不选任何语言 / 该视频没有字幕 → 行为与现状完全一致（导入后点「生成字幕」走 ASR）。

### 多分 P（合集 / 系列课）

实测一门课能到 **94 分 P / 57.9 小时**（BV1h7pteyEww），而且**每个分 P 是独立 cid**
（播放流与字幕各拉各的）；原先只有 URL 里的 `?p=` 生效，粘裸 BV 链接会静默导入 P1
（这个例子里 P1 是 3 分钟的「说明」页）。

- 解析时一次 `x/web-interface/view` 拿全 `pages[]`（page / cid / part / duration，零额外成本）
- 对话框列出全部分 P（chip，可滚动），可多选、全选、清空，实时显示「已选 N P · 合计 X」
- **默认勾选策略**（`src/bilibili/pages.ts`）：URL 显式带 `?p=` → 只勾它；分 P ≤ 3 → 全勾；
  否则只勾第一 P（防手滑）
- **防手滑**：已选 > 10 P 或合计 > 6 小时时弹一次确认
- 字幕语言列表**跟着「第一个选中的分 P」刷新**（切 P 会重新拉一次 DmView，如实反映「这集没字幕」）；
  导入时按用户勾的 lan 与各 P 实际可用语言取交集，某路失败/缺失就跳过它
- 逐个下载，**每完成一个 P 立刻回调入队**：下一个 P 的下载与上一个 P 的 OPFS 写入并行；
  每个 P 存成一条独立视频记录，命名 `总标题 P{n} 分P名`（分 P 名为空则只带序号）
- 进度文案「P2 1.1 二三阶行列式 · 2/5」+ 总进度条

## 三、改动清单

| 文件 | 改动 |
|---|---|
| `src/bilibili/wire.ts` | 极小 protobuf 编解码（varint / length-delimited / 字段遍历） |
| `src/bilibili/dmview.ts` | DmView gRPC 请求 + 响应解析 → 字幕语言列表；字幕 JSON → cues |
| `src/bilibili/pages.ts` | 多分 P 纯逻辑：默认勾选策略 / 命名 / 合计 / 标签 |
| `src/bilibili/subtitle.ts` | 语言优先级、cues → `SegmentRow` / `subtitleTracks` 负载 |
| `src/bilibili/transport.ts` | 桥/代理支持 POST + 二进制 body + 自定义头；桥新增 `getCookie()` |
| `src/bilibili/api.ts` | `fetchVideoInfo` → `fetchVideoView`（返回全部分 P）；新增 `BiliPageInfo` |
| `src/bilibili/index.ts` | 拆成 `resolveBiliTarget()`（解析 + 分 P + 首个 P 的字幕列表）与 `importBiliPages()`（逐 P 下载并回调） |
| `src/store/db.ts` | 新表 `subtitleTracks`（version 8） |
| `src/utils/bilingual.ts` | 双语 cue 合成（纯函数，可单测） |
| `src/pages/Library.tsx` | 导入对话框两步化 + 分 P 多选 + 语言勾选；导入任务带字幕负载，写库并置 `transcribed` |
| `src/components/SubtitlePanel.tsx` | 「对照语言」下拉 + 双语渲染 |
| `src/pages/Settings.tsx` | Cookie 字段旁「读取本机 Cookie」按钮 + 登录态反馈 |
| `userscript/wangke-bili-bridge.user.js`、`public/wangke-bili-bridge.user.js` | POST/body/headers 透传 + `GM_cookie` 读取（两份同步，版本 2.1.1） |
| `cloudflare-worker/bili-proxy.js` | POST 透传 + `app.biliapi.net` / `*.hdslb.com` 白名单 |

## 四、实现后的实测（2026-09-11）

真实接口跑通的链路：

| 视频 | 解析 | 主语言 | 对照 | 备注 |
|---|---|---|---|---|
| BV1d7wAzsE8V（线性代数·宋浩） | 6 路 | ai-zh 481 条 | ai-en 463 条 | 网课类命中「中文（自动生成）」 |
| BV1GJ411x7h7（音乐 MV） | 12 路 | zh-CN 47 条 | en-US 50 条 | 默认勾选 = 中文 + 英文 |
| BV1h7pteyEww（线性代数 2.0） | 94 P / 57.9h | P1 ai-zh 75 条 | — | 多 P：默认只勾 P1；实测导入 P1+P48（P48 无字幕，自动跳过） |

- `node .tmp-verify-*.mjs`（临时脚本，不入库）跑通 `resolveBiliTarget → importBiliVideo`：视频重封装成 8.6MB mp4，mediabunny 读回 hevc 853x480 + aac 正常
- `node scripts/e2e-bilibili-subtitle.mjs`（真浏览器 + Node 侧转发桥）：对话框默认勾选 → 导入落库（47 segments + 2 轨，只有一路 primary）→ 播放页切对照语言 → 面板与画面字幕都变成两行
- 纯逻辑测试：`scripts/test-bilibili-subtitle.mjs`（42 项，含真实响应 fixture 与 64 位 aid 往返）、
  `scripts/test-bilingual.mjs`（12 项）；顺带修好了 `scripts/test-migration.mjs`
  （它自述要 esbuild 打包但代码里没有，一直跑不起来）并补了字幕轨的迁移用例

## 五、踩到的坑（写给后来的人）

1. **addTrack 必须在 `start()` 前**（见 2026-09-11 B 站导入修复）；
2. `fastStart:'reserve'` 要求每轨给 `maximumPacketCount`；且**两路样本必须按时间戳交错写入**，
   否则 moov 创建时命中 mediabunny 的 `cslg` 断言（详见 remux.ts 注释）；
3. `StreamTarget` 往 writable 写的是 `{type:'write', data, position}` **分片**且会回填 moov →
   内存实现必须按 position 覆盖写；
4. B 站 AI 字幕语言 key 是 `ai-zh` / `ai-en`（不是 `en-US`），排序/默认勾选要先剥 `ai-`；
5. `auth_key` 直链有效期很短（名义 TTL 0s、实测 70s 仍可下），**拿到就立刻拉**；
6. 网页接口匿名拿不到字幕是**接口侧行为**（`need_login_subtitle` / `is_lock`），不是我们缺 header；
7. 视频里换行 `\n` 由 media-captions 的 `text.split(LINE_TERMINATOR_RE)` 渲染成两行，
   但面板的 `CueRow` 是普通 `<span>`，得自己拆行加 `<br/>`；
8. `mdui-chip` 的 `change` 事件 `bubbles+composed`，列表用容器代理一个 listener 就够；
9. e2e 里 `page.fill()` 对 `mdui-text-field` 无效（不是原生 input），要设属性 + 派发 `input`；
10. 「读取本机 Cookie」失败有四种互不相干的原因（没装桥 / 脚本太旧 / 扩展不给读 GM_cookie / 没登录），
    一律回一句「没读到」用户无法对症 —— 桥的 `getCookie()` 用 `null` 表示「给不了」、`''` 表示「能读但没有」，
    页面据此分开提示（回归见 `scripts/e2e-bili-cookie.mjs`，含把真实 userscript 跑在 Chromium 里的用例）。
    更阴的一条：`GM_cookie.list({})`（不带 url/domain）在部分实现里会**成功返回空数组**，
    只看它就会把「读不到明细」误判成「没登录」—— 空结果必须再按域名兜底查一遍；
    而「读到 0 项 + 桥出口已登录」要当成正常态（提示「留空即可」），不能报错色吓人；
11. 设置页那张卡片把「主路径」和「备用出口」混在一层，结果是：装了桥还登录着，用户仍要面对
    「代理地址（可选回退）+ B 站 Cookie（可选）+ 三行都在说『不用填』」的噪音。改成主路径只留一行结论
    （`已连接 v2.1.1 · 已登录：xxx` + 安装/重装按钮），代理与 Cookie 收进「备用出口」——
    **没桥时它才是主路径，默认展开；有桥时默认收起且整块不渲染**（不是 CSS 隐藏，免得键盘还能 Tab 进去）；

12. 浏览器里装的脚本副本不会自动更新（没有 `@updateURL`）：改版后必须重新安装，设置页显示桥版本号便于核对；
13. 油猴脚本被「新标签页直接打开」安装时，响应头没有 `charset` 会被 Chromium 嗅探成 GBK
    （实测 `document.characterSet === 'GBK'`，中文元数据乱码）—— dev/preview 由 vite 中间件发 charset、
    生产由 `public/_headers` 顶，回归见 `scripts/e2e-userscript-charset.mjs`。

## 六、测试

- `scripts/test-bilibili-subtitle.mjs`：wire 编解码往返（含 64 位 aid）、gRPC 帧、真实响应 fixture 解析、
  字幕 JSON → cues、语言优先级、cues → segments、bundle 组装
- `scripts/test-bilibili-pages.mjs`：多分 P 策略（默认勾选 / 命名 / 合计 / 排序）
- `scripts/test-bilingual.mjs`：双语合成（1:1 / 一对多 / 无重叠 / 半重叠 / 空白）
- `scripts/test-migration.mjs`：补字幕轨的导出→导入用例
- `scripts/e2e-bilibili-subtitle.mjs`：真浏览器 + 真接口的端到端（e2e-all 里默认 skip，需直连 B 站）
- `npx tsc -b` + `npm run build` + 现有 `scripts/test-*.mjs` 全绿
