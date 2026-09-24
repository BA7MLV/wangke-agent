/* eslint-disable no-console */
// 统一 e2e 编排器：升级前基线用的「一键跑分」工具。
// 设计约束：只用 node: 内置模块 + playwright；不碰 build/dist；长驻服务（preview/dev）
// 由本脚本负责启停，端口已占用则复用，跑完只关自己启动的。
//
// 用法：
//   node scripts/e2e-all.mjs                 # 无需 key 的全量（跳过硬依赖 SF_KEY 的脚本）
//   node scripts/e2e-all.mjs --with-key      # 含 key 的全量（需自行 export SF_KEY=...）
//   node scripts/e2e-all.mjs --only=e2e-import,e2e-mobile
//   node scripts/e2e-all.mjs --filter='^e2e-'# 正则过滤脚本名
//
// 输出：scripts/.cache/e2e-report.json + scripts/.cache/e2e-report.md
// 退出码：有 failed 则非 0。

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CACHE_DIR = join(__dirname, '.cache');
mkdirSync(CACHE_DIR, { recursive: true });

// ───────────────────────────── 元数据库（分类结果硬编码） ─────────────────────────────
// service: 'none' | 'preview'(4173) | 'dev'(5173)
// key:     是否硬/软依赖 SF_KEY（true → 无 key 档跳过）
// testFile: 是否注入 TEST_FILE
// antd:    是否依赖 antd 的 DOM/类名选择器（迁移 mdui 时会集体变红）
// diagnostic: 诊断脚本，输出仅供人工参考。
//             ⚠️ **不是「总以 0 退出」**：probe-svg-sanitize / probe-controls-hover /
//             probe-quiz-option-shift / probe-rail-pages 失败时都会 exit 非 0，
//             而 runScript 是按退出码判 passed/failed 的 —— 所以探针挂了同样会让整轮
//             跑分变红。这是有意保留的：探针坏掉值得显式看见，不该被「仅供参考」掩盖。
// base:    读取 BASE_URL（编排器会按服务注入正确地址）
// timeout:  单脚本超时（秒）
// video:   优先注入的测试视频
// skip:     非空的跳过原因（整脚本跳过）
const META = {
  // ── 纯 Node（无服务）──
  'render-handout-fixture': { service: 'none', antd: false, timeout: 120 },
  'test-anki-cards': { service: 'none', antd: false, timeout: 120 },
  'test-apkg': { service: 'none', antd: false, timeout: 120 },
  'test-bilibili-api': { service: 'none', antd: false, timeout: 120 },
  'test-bilibili-index': { service: 'none', antd: false, timeout: 120 },
  'test-bilibili-pages': { service: 'none', antd: false, timeout: 120 },
  'test-bilibili-parse': { service: 'none', antd: false, timeout: 120 },
  'test-bilibili-subtitle': { service: 'none', antd: false, timeout: 120 },
  'test-bilibili-transport': { service: 'none', antd: false, timeout: 120 },
  'test-bilingual': { service: 'none', antd: false, timeout: 120 },
  // 构建信息纯逻辑：时间补零 / 本地时区（不是 UTC）/ commit 缺失降级 / dev 分支。
  // 「注入有没有真的通到产物与 DOM」由 e2e-build-info 覆盖，两者不重叠。
  'test-build-info': { service: 'none', antd: false, timeout: 120 },
  'test-builtin-skills': { service: 'none', antd: false, timeout: 120 },
  'test-chat-export': { service: 'none', antd: false, timeout: 120 },
  'test-chat-frames': { service: 'none', antd: false, timeout: 120 },
  // 评论区（AI 生成的同学讨论）纯逻辑：模型输出解析 / 时间戳钳制 / 角色与作者归一 /
  // 跨块去重 / 两档排序 / 两层分组（含孤儿回复）。提示词契约（角色名单同一份来源）也在里面。
  // 「数据 → 渲染 → 时间戳跳转」由 e2e-comments 覆盖，两者不重叠。
  'test-comments': { service: 'none', antd: false, timeout: 120 },
  // Dexie 建表版本：v13 删除两张向量表。**删表是唯一会丢数据且改不回来的改动**，
  // schema 写错会让整个库打不开（应用白屏而不是某个功能坏掉），所以必须有这道守卫。
  // 覆盖全新安装（v1→v13 最终 schema）与老库升级（v12 带向量数据 → 表与数据一起消失）。
  'test-db-schema': { service: 'none', antd: false, timeout: 120 },
  // 图表导出：只改根标签，不碰子元素几何（原生 svg 围栏的根节点常常不带 width）
  'test-diagram-export': { service: 'none', antd: false, timeout: 120 },
  'test-error-text': { service: 'none', antd: false, timeout: 120 },
  'test-handout-ir': { service: 'none', antd: false, timeout: 120 },
  'test-handout-prompts': { service: 'none', antd: false, timeout: 120 },
  // 后台任务文案（转写 / 解析）—— 库页状态标签的纯函数部分
  'test-library-job-copy': { service: 'none', antd: false, timeout: 120 },
  // 词法检索：分词（CJK unigram+bigram / 拉丁整段成词）、BM25 打分、覆盖率加成、排序稳定性。
  // 守的是「稠密检索移除后检索仍然找得到东西」这条底线 ——
  // 尤其是编号 / 英文缩写这类字面命中，以及单字查询能命中更长中文词。
  // 「数据 → 渲染 → 时间戳跳转」由 e2e-chat / e2e-material-you 覆盖，两者不重叠。
  'test-lexical': { service: 'none', antd: false, timeout: 120 },
  // 阅读材料的纯逻辑：引用标记 / 分块与扫描件判定 / Word 抽取 / Markdown 抽取 / 框选几何。
  // 都不依赖 DOM，所以能进这一档（materials/docx.ts、md.ts 刻意与渲染分离，就是为了这个）
  'test-material-chunk': { service: 'none', antd: false, timeout: 120 },
  'test-material-docx': { service: 'none', antd: false, timeout: 120 },
  'test-material-md': { service: 'none', antd: false, timeout: 120 },
  'test-material-region': { service: 'none', antd: false, timeout: 120 },
  'test-material-units': { service: 'none', antd: false, timeout: 120 },
  'test-migration': { service: 'none', antd: false, timeout: 120 },
  // 在 Node 里用 pdf.js 抽 fixture 的中文文本（确认「fixture 可解析」，e2e 失败时好分清
  // 是 fixture 的问题还是阅读器的问题）。纯 Node，不起服务。
  // ⚠️ 暂 skip：它 `await import('pdfjs-dist/legacy/build/pdf.mjs')`，而这个文件和
  //    `@mdui/jq/functions/param.js` 一样被宿主的文件审批拦着（同生产构建那个根因）。
  //    在**非交互**子进程里没人应答审批，表现不是报错而是**无限挂起** ——
  //    实测 20s 无任何输出、进程仍活着，编排器里会白烧满 120s 超时再报红。
  //    那种红跟「探针真的查出问题」长得一模一样，会把人训练成忽略红色，
  //    所以这里显式跳过并写明原因。**审批放行后请把 skip 去掉。**
  'probe-pdf-fixture': { service: 'none', antd: false, diagnostic: true, timeout: 120, skip: '依赖 pdfjs-dist/legacy/build/pdf.mjs，该文件被宿主审批拦住（同生产构建），非交互下无限挂起' },
  'test-ort-config': { service: 'none', antd: false, timeout: 120 },
  'test-quiz': { service: 'none', antd: false, timeout: 120 },
  'test-rate': { service: 'none', antd: false, timeout: 120 },
  // 学习时长纯逻辑：本地日期键（UTC 陷阱）/ 跨零点切分 / 热力图网格几何 / 统计与连续天数
  'test-study-log': { service: 'none', antd: false, timeout: 120 },
  // 主页进度条纯逻辑：材料的 null / 非法时长的 null / finished 优先于比例 / 1% 阈值两侧
  'test-video-progress': { service: 'none', antd: false, timeout: 120 },
  // 重采样契约：跨帧不丢相位（91 分钟短 7.6s 那个 bug 的守门员）
  'test-pcm-resample': { service: 'none', antd: false, timeout: 120 },
  // 问答技能范围的三态语义：undefined（不限定）/ []（一个都不给）/ [id]。
  // 全是零依赖纯函数，所以能进这一档 —— 拆出 skills/scope.ts 就是为了这个。
  'test-qa-skill-scope': { service: 'none', antd: false, timeout: 120 },
  // 云端同步的单元寻址：id 构造/解析往返、名字编码无歧义、分片边界、畸形 id 不抛、
  // 设置白名单与排除项无交集（含「apiKey / bilibiliCookie 永不可同步」）。零依赖纯函数。
  // ⚠️ 它**不**覆盖「新字段有没有被归类」—— 那条由编译期守门员负责
  // （src/sync/units.ts 的 ALL_SETTINGS_FIELDS_CLASSIFIED / ALL_VIDEO_FIELDS_CLASSIFIED，
  // `npm run build` 的 tsc 会拦），两者不重叠。
  'test-sync-units': { service: 'none', antd: false, timeout: 120 },
  // 抽音频的坏帧容忍：自己造损坏样片、自己起虚拟静态服务器（page.route），不依赖任何常驻服务
  'e2e-audio-corrupt-frame': { service: 'none', antd: false, timeout: 300 },

  // ── preview(4173)：生产构建档 ──
  // 注意：本注释与下面 e2e-mdui-adapter 的说明在 mdui 迁移期间才成立
  // 需要直连 B 站（地区/网络相关），默认跳过：用 node scripts/e2e-bilibili-subtitle.mjs 单独跑
  'e2e-bilibili-subtitle': { service: 'dev', antd: false, timeout: 600, skip: '需要直连 B 站' },
  'debug-import-perf': { service: 'preview', antd: true, testFile: true, diagnostic: true, timeout: 300, video: '/tmp/wangke-test.mp4' },
  'e2e-cards': { service: 'preview', antd: true, base: true, timeout: 300 },
  'e2e-chat-export': { service: 'preview', antd: true, base: true, timeout: 300 },
  'e2e-chat-frames': { service: 'preview', antd: true, key: true, testFile: true, timeout: 300, video: '/tmp/wangke-test.mp4' },
  'e2e-chat-image': { service: 'preview', antd: true, key: true, testFile: true, timeout: 300, video: '/tmp/wangke-test.mp4' },
  'e2e-chat': { service: 'preview', antd: true, key: true, testFile: true, timeout: 300, video: '/tmp/wangke-test.mp4' },
  'e2e-chat-mermaid': { service: 'preview', antd: true, testFile: true, base: true, timeout: 300, video: '/tmp/wangke-mermaid-test.mp4' },
  // 评论区（视频下方的讨论区）：折叠条 → 展开 → 渲染 → 点时间戳跳播放器 → 排序切换 →
  // 展开时播放器让出高度 → 收起，外加移动端可达性。
  // 自播种评论（不调真实 API）；需要真实视频是因为「点时间戳」那条断言要读 media-player.currentTime。
  'e2e-comments': { service: 'preview', antd: false, testFile: true, base: true, timeout: 300 },
  // 题卡解析的出图链路：mermaid 与 svg 两种围栏各一个脚本（自播种题卡，不调真实 API）
  'e2e-quiz-mermaid': { service: 'preview', antd: false, testFile: true, base: true, timeout: 300 },
  'e2e-svg-fence': { service: 'preview', antd: false, testFile: true, base: true, timeout: 300 },
  // 阅读材料（PDF / Word）+ 选区提问：走**真实导入路径**（setInputFiles），不播种 OPFS，
  // 所以整条 isImportable → 写盘 → 解析 → 建索引 都被覆盖。不需要 key。
  // 在 preview 档跑还顺带验「构建产物里的 pdf.js worker 与 /pdfjs/cmaps/ 是否齐」——
  // fixture 刻意用未内嵌字体的 STSong-Light，插件没生效就会在「文本层渲染出中文」那条炸。
  'e2e-materials': { service: 'preview', antd: false, base: true, timeout: 300 },
  // 封面（covers 表）：导入即有封面 / 小图档位 / PDF 材料首页 / 刷新后仍在 / 删除不残留。
  // 读库的交叉验证在 preview 下自动跳过，核心断言全部走 DOM，故 preview 档可用。
  'e2e-covers': { service: 'preview', antd: false, testFile: true, base: true, timeout: 300 },
  // mdui 迁移基建验收（React 19 生效 / 46 个自定义元素已注册 / 设计令牌可用 / 未污染 antd 界面）。
  // 本档验不了「React 版本」与「中文语言包」两项（生产构建拿不到模块句柄），
  // 需要时手动补跑 dev 档：BASE_URL=http://localhost:5173 node scripts/e2e-mdui-adapter.mjs
  'e2e-mdui-adapter': { service: 'preview', antd: false, base: true, timeout: 120 },
  // 阶段 1 起新增：设置页写作技能列表 + 新建对话框交互（不依赖 antd 选择器，全部 data-testid）
  // 设置页页脚的构建信息：验证「构建期 define 注入 → 产物字面量 → DOM」这条链路。
  // ⚠️ 跑的是**当前 dist**，改了注入逻辑要先 npm run build ——
  //    它会断言页面显示的 commit 与 git HEAD 一致，dist 陈旧时会红并写明原因。
  // 不需要 key，也不需要测试视频（空库就能验）。
  'e2e-build-info': { service: 'preview', antd: false, base: true, timeout: 180 },
  'e2e-settings-skills': { service: 'preview', antd: false, base: true, timeout: 180 },
  'e2e-danmaku': { service: 'preview', antd: true, key: 'optional', testFile: true, timeout: 300, video: '/tmp/wangke-test.mp4' },
  'e2e-handout-edit': { service: 'preview', antd: true, base: true, timeout: 300 },
  'e2e-handout': { service: 'preview', antd: true, key: true, testFile: true, timeout: 300, video: '/tmp/wangke-test.mp4' },
  'e2e-import-insecure': { service: 'preview', antd: true, testFile: true, timeout: 300, video: '/tmp/wangke-test.mp4' },
  'e2e-import': { service: 'preview', antd: true, testFile: true, timeout: 300, video: '/tmp/wangke-test.mp4' },
  // 首页自身交互（分组 / 移动 / 折叠 / 两步删除 / 拖拽）—— 既有脚本只把首页当跳板，没覆盖这些
  'e2e-library': { service: 'preview', antd: false, testFile: true, timeout: 300, video: '/tmp/wangke-test.mp4' },
  // 库页「长说明收进问号」：点问号不能冒泡开文件选择器 / 气泡不能塌成竖条 / 长说明不能铺回正文。
  // 不需要 key，也不需要测试视频（空库就能验），所以不带 testFile。
  'e2e-library-copy': { service: 'preview', antd: false, base: true, timeout: 180 },
  // 主页卡片进度条：该画的画、不该画的不画（没看过 / 不足 1% / 阅读材料），
  // 并实测填充层宽度真的等于比例（只断言 data-ratio 抓不到 CSS 没生效）。
  // 自播种 videos（原生 IndexedDB），不需要 key，也不需要测试视频。
  'e2e-library-progress': { service: 'preview', antd: false, base: true, timeout: 180 },
  'e2e-mobile': { service: 'preview', antd: true, testFile: true, timeout: 300, video: '/tmp/wangke-test.mp4' },
  'e2e-player-enhance': { service: 'preview', antd: true, testFile: true, timeout: 300, video: '/tmp/wangke-test.mp4' },
  'e2e-quiz': { service: 'preview', antd: true, key: true, testFile: true, timeout: 300, video: '/tmp/wangke-test.mp4' },
  'e2e-resume': { service: 'preview', antd: true, testFile: true, timeout: 300, video: '/tmp/wangke-test.mp4' },
  'e2e-smoke': { service: 'preview', antd: true, key: true, testFile: true, timeout: 600, video: '/tmp/wangke-test.mp4' },
  'e2e-bili-cookie': { service: 'preview', antd: false, timeout: 120 },
  'e2e-userscript-charset': { service: 'preview', antd: false, timeout: 60 },
  'e2e-storage-card': { service: 'preview', antd: true, timeout: 300 },
  // 学习时长热力图：网格几何 / 档位 / 悬浮提示 / 区间切换 / 最近 30 天 / **真等 80s 验计时与落库** /
  // 设置页卡片。自播种 studyDays（原生 IndexedDB），不需要 key，也不需要 dev 档。
  'e2e-study': { service: 'preview', antd: false, base: true, timeout: 300 },
  // 动效组件（TextSwap / ThinkLine / StreamParagraph / SuccessCheck）的 DOM 断言。
  // ⚠️ 暂 skip：脚本打开 `/#/motion-test`，而这个路由在 src 里**从未存在**过 ——
  //    `src/components/motion.tsx` 是动效组件本身，没有与之对应的页面组件；
  //    `git log -S "/motion-test"` 只能查到本脚本自己，App.tsx 的历史里没有注册记录。
  //    页面空渲染 → `.t-text-swap` 必然等到超时，红得没有信息量。
  //    它是**阶段 0 就存在的已知失败**（docs/plans/2026-09-10-mdui-phase0-e2e-baseline.md
  //    第 115 行），不是回归 —— 别把这条红算到新改动头上。
  //    真修有两条路，都需要先做决定：① 补一个只给测试用的 `/#/motion-test` 页面（会进生产包）；
  //    ② 让脚本自带 fixture 页面、不依赖生产路由（改脚本，更像组件测试该有的样子）。
  //    决定前让它红着只会训练人忽略红色，所以照 probe-mermaid 的先例显式跳过。
  //    **那两条路任选其一落地后，请把这个 skip 去掉。**
  'motion-components-test': { service: 'preview', antd: false, timeout: 120, skip: '缺失 /#/motion-test 路由（src 中从未有过该页面组件），页面空渲染、.t-text-swap 必然超时；阶段 0 基线已知失败' },
  'motion-smoke': { service: 'preview', antd: true, timeout: 120 },

  // ── dev(5173)：从 node_modules 重编译，当前已是 React 19，非升级前基线 ──
  'debug-player': { service: 'dev', antd: true, key: true, testFile: true, diagnostic: true, timeout: 300, video: '/tmp/wangke-test.mp4' },
  'debug-transcribe': { service: 'dev', antd: true, key: true, testFile: true, diagnostic: true, timeout: 300, video: '/tmp/wangke-test.mp4' },
  'e2e-frames-hires': { service: 'dev', antd: false, timeout: 300 },
  'e2e-live-subs': { service: 'dev', antd: true, testFile: true, timeout: 300, video: '/tmp/e2e-live.mp4' },
  // 后台转写（L1 任务外置 / L2 续跑）：要拿应用同一份 store 句柄，只能跑 dev；不调真实 API
  'e2e-bg-transcribe': { service: 'dev', antd: false, testFile: true, timeout: 300, video: '/tmp/wangke-test.mp4' },
  'e2e-preview-fonts': { service: 'dev', antd: true, timeout: 300 },
  // 只能跑 dev：守的是 StrictMode 双调用引发的并发竞态，生产构建不触发（见脚本头注释）
  'e2e-skills-dedupe': { service: 'dev', antd: false, timeout: 120 },
  // 用 dev 而不是 preview：脚本只覆盖 UI 与持久化，不依赖生产构建的任何差异，
  // 这样免掉「先 npm run build」。它自己造样片、自己播种字幕（没有字幕时问答面板
  // 只渲染占位符，工具条整个不出现），所以不注入 key、不调真实 API。
  'e2e-chat-skill-scope': { service: 'dev', antd: false, testFile: true, timeout: 300, video: '/tmp/wangke-skill-scope-test.mp4' },
  // 只能跑 dev：动态取色那段要往 IndexedDB 种封面帧，得拿应用同一份 Dexie 实例
  'e2e-material-you': { service: 'dev', antd: false, testFile: true, timeout: 300, video: '/tmp/wangke-test.mp4' },
  'probe': { service: 'dev', antd: false, diagnostic: true, timeout: 120 },
  // 控制栏 hover 显隐（悬停出现 / 移出收起，含未播放过 / 播放中 / 暂停中三态），要 TEST_FILE
  'probe-controls-hover': { service: 'preview', antd: false, testFile: true, base: true, diagnostic: true, timeout: 300 },
  // 播放器的 YouTube 式细节第二档：中央大播放按钮（不随控制栏显隐、点完要交焦点给播放器）/
  // 键盘步长（←/→ 5s、j/l 10s、Home/End、连按累加）/ 进度条 hover 缩略图预览 / 控制栏细节。
  // 失效方式多为「看着还在但取错帧 / 焦点丢了」，所以必须用探针量而不是靠截图。
  'probe-yt-player': { service: 'preview', antd: false, testFile: true, base: true, diagnostic: true, timeout: 300 },
  // 讨论区展开时的高度预算：视频栏内容溢出 / 整页被撑出滚动条 / 讨论区被裁掉，三种都要量到坐标。
  // 失效方式是**静默裁切**（.player-layout 是 overflow:hidden），所以必须单独量几何。
  'probe-comments-geometry': { service: 'preview', antd: false, testFile: true, base: true, diagnostic: true, timeout: 300 },
  // 题卡作答后的几何位移（作答前后各选项位置必须一致，守「整屏跳动」那个 bug）
  'probe-quiz-option-shift': { service: 'preview', antd: false, base: true, diagnostic: true, timeout: 300 },
  // 下面两个侧栏探针的地址走 `process.argv[2]`、默认 5174 / 4174（vite 抢不到 5173 时的备用端口），
  // **不读 BASE_URL** —— 编排器注入不了地址，跑起来必然连不上。只能手动跑，故显式跳过并写明原因。
  'probe-rail': { service: 'dev', antd: false, diagnostic: true, timeout: 120, skip: '地址走 argv、默认 5174，不读 BASE_URL，编排器注入不了' },
  'probe-rail-pages': { service: 'dev', antd: false, diagnostic: true, timeout: 120, skip: '地址走 argv、默认 4174，不读 BASE_URL，编排器注入不了' },
  'probe-mermaid': { service: 'dev', antd: false, diagnostic: true, timeout: 120, skip: '缺失 public/probe-mermaid.html，页面 404，无法加载' },
  // 模型直出 SVG 的净化契约（白名单 / 外部引用 / viewBox 大小写）—— 必须真解析器，dev 档
  'probe-svg-sanitize': { service: 'dev', antd: false, diagnostic: true, timeout: 120 },
};

/**
 * 守门员：磁盘上有、但 META 里没登记的脚本。
 *
 * META 是**手工维护**的，漏登记的后果是「静默跳过」——脚本在，一键跑分却永远不执行它，
 * 报告里也看不出少了什么。阅读材料那一批就这样整整漏了一轮（4 个单测 + e2e-materials
 * + e2e-covers + test-library-job-copy 全都没登记），直到人工比对才发现。
 *
 * 覆盖范围是「按约定命名、会被当作可执行脚本」的那几类前缀：test / e2e / probe / debug
 * / render / motion / scenario。**不含** `gen-*`（代码生成）与 `.tmp-*`（本地临时件）。
 * 上一版只查了 test/e2e，于是 5 个 probe-* 又漏在网外 —— 所以这里按前缀表来，
 * 新增前缀时一并补进正则。e2e-all 自己不进 META（它是编排器）。
 */
const SCRIPT_PREFIX_RE = /^(test|e2e|probe|debug|render|motion|scenario)(-|$)/;
const unregistered = readdirSync(__dirname)
  .filter((f) => f.endsWith('.mjs') && !f.startsWith('.') && f !== 'e2e-all.mjs')
  .map((f) => f.replace(/\.mjs$/, ''))
  .filter((n) => SCRIPT_PREFIX_RE.test(n))
  .filter((n) => !(n in META));
if (unregistered.length > 0) {
  console.warn(`⚠️  ${unregistered.length} 个脚本没有登记进 META，本次不会被跑到：`);
  console.warn(`    ${unregistered.join('、')}`);
  console.warn('    补上 META 条目后它们才会进入「一键跑分」。\n');
}

// ───────────────────────────── 参数解析 ─────────────────────────────
const argv = process.argv.slice(2);
const withKey = argv.includes('--with-key');
const onlyArg = argv.find((a) => a.startsWith('--only='));
const filterArg = argv.find((a) => a.startsWith('--filter='));
const onlySet = onlyArg ? new Set(onlyArg.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean)) : null;
const filterRe = filterArg ? new RegExp(filterArg.slice('--filter='.length)) : null;

// ───────────────────────────── 工具函数 ─────────────────────────────
function portFree(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    s.setTimeout(800);
    s.once('connect', () => { s.destroy(); resolve(false); });
    s.once('error', () => { s.destroy(); resolve(true); });
    s.once('timeout', () => { s.destroy(); resolve(true); });
  });
}

async function waitForPort(port, ms = 120000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!(await portFree(port))) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// 找一个现成的测试视频，没有就用 ffmpeg 造一个
//
// ⚠️ 必须用 node 的 `spawnSync`（真同步）。这里曾经套了个自写的 `spawnSyncSafe`，
// 但它返回的是 **Promise**、却被当返回值用（`if (r !== 0)` 恒真）—— 结果就是
// 兜底生成**从来没成功过**，只在日志里留一句「ffmpeg 生成失败」，然后所有
// 声明了 testFile 的脚本被静默 skip。发现时已经影响 e2e-comments 的首次验证。
//
// `-t 40` 而不是 `-duration 40`：后者不是 ffmpeg 的 CLI 选项（本机 ffmpeg 8.1 直接
// 报 `Unrecognized option 'duration'`），旧版也没有，属于一直写错但没被触发的那类。
function resolveVideo(preferred) {
  const candidates = [preferred, '/tmp/wangke-test.mp4', '/tmp/e2e-live.mp4', '/tmp/wangke-mermaid-test.mp4']
    .filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  // 兜底：ffmpeg 造 40s 测试视频
  const made = '/tmp/wangke-test.mp4';
  console.log(`  [video] 无现成测试视频，用 ffmpeg 生成 ${made}`);
  const r = spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25', '-t', '40',
    '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '40', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', made], { stdio: 'ignore' });
  if (r.status !== 0) {
    console.error('  [video] ffmpeg 生成失败');
    return null;
  }
  return made;
}

// 启动服务；若端口已占用则复用，否则启动并返回子进程（需本脚本负责关闭）
async function ensureService(service) {
  if (service === 'none') return null;
  const port = service === 'preview' ? 4173 : 5173;
  if (!(await portFree(port))) {
    console.log(`  [svc] 端口 ${port} 已占用，复用现有 ${service} 服务`);
    return { port, child: null, reused: true };
  }
  console.log(`  [svc] 启动 ${service} 服务（端口 ${port}）…`);
  const child = spawn('npm', ['run', service], {
    cwd: ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  const ok = await waitForPort(port);
  if (!ok) {
    console.error(`  [svc] ${service} 在 120s 内未就绪，中止`);
    try { child.kill('SIGTERM'); } catch {}
    throw new Error(`${service} 启动超时`);
  }
  console.log(`  [svc] ${service} 已就绪`);
  return { port, child, reused: false };
}

function stopService(svc) {
  if (svc && svc.child) {
    try { svc.child.kill('SIGTERM'); } catch {}
    console.log(`  [svc] 已关闭自起的 ${svc.child ? '服务' : ''}`);
  }
}

// 运行单个脚本，返回 { status, durationMs, exitCode, tail }
function runScript(name, meta, svc) {
  return new Promise((resolve) => {
    const file = join(__dirname, `${name}.mjs`);
    const env = { ...process.env };
    if (meta.testFile) {
      const v = resolveVideo(meta.video);
      if (v) env.TEST_FILE = v; else { resolve({ status: 'skipped', durationMs: 0, exitCode: null, tail: ['无可用测试视频且 ffmpeg 生成失败'] }); return; }
    }
    // 只有声明了 base 的脚本才读 BASE_URL；服务复用与否端口都一样，无需分支
    if (svc && meta.base) env.BASE_URL = `http://localhost:${svc.port}`;

    const child = spawn('node', [file], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const onData = (d) => { out += d.toString(); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    const timeoutMs = (meta.timeout || 300) * 1000;
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      const tail = out.split('\n').map((l) => l.trimEnd()).filter(Boolean).slice(-20);
      resolve({ status: 'failed', durationMs: timeoutMs, exitCode: 'timeout', tail: [...tail, `⏱ 超时（>${meta.timeout}s）被强制终止`] });
    }, timeoutMs);

    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      const lines = out.split('\n').map((l) => l.trimEnd()).filter(Boolean);
      const tail = lines.slice(-20);
      let status;
      if (signal === 'SIGKILL') status = 'failed';
      else if (code === 0) status = 'passed';
      else status = 'failed';
      resolve({ status, durationMs: 0, exitCode: code ?? signal, tail });
    });
  });
}

// 记录耗时
function withTiming(p) {
  const t0 = Date.now();
  return p.then((r) => ({ ...r, durationMs: Date.now() - t0 }));
}

// ───────────────────────────── 主流程 ─────────────────────────────
const allNames = Object.keys(META);
const selected = allNames.filter((name) => {
  const meta = META[name];
  if (onlySet && !onlySet.has(name)) return false;
  if (filterRe && !filterRe.test(name)) return false;
  if (meta.skip) return false; // 整脚本跳过
  if (!withKey && meta.key === true) return false; // 无 key 档跳过硬依赖 key 的
  return true;
});

// 按服务分三批：none → preview → dev（同一时间只起一个服务）
const batches = [
  { service: 'none', names: selected.filter((n) => META[n].service === 'none') },
  { service: 'preview', names: selected.filter((n) => META[n].service === 'preview') },
  { service: 'dev', names: selected.filter((n) => META[n].service === 'dev') },
];

const results = [];
const skipped = allNames
  .filter((n) => META[n].skip)
  .map((n) => ({ name: n, status: 'skipped', reason: META[n].skip }));

console.log(`\n=== e2e-all 编排开始（withKey=${withKey}）===`);
console.log(`选中 ${selected.length} 个脚本，跳过（损坏/需key）${skipped.length + allNames.filter((n) => !withKey && META[n].key === true && !META[n].skip).length} 个\n`);

let activeSvc = null;
try {
  for (const batch of batches) {
    if (batch.names.length === 0) continue;
    activeSvc = await ensureService(batch.service);
    for (const name of batch.names) {
      const meta = META[name];
      process.stdout.write(`▶ ${name} [${batch.service}] … `);
      const r = await withTiming(runScript(name, meta, activeSvc));
      const dur = (r.durationMs / 1000).toFixed(1);
      const tag = r.status === 'passed' ? '✅' : '❌';
      console.log(`${tag} ${r.status} (${dur}s, exit=${r.exitCode ?? '-'})`);
      results.push({ name, service: batch.service, antd: meta.antd, diagnostic: !!meta.diagnostic, key: meta.key || false, status: r.status, durationMs: r.durationMs, exitCode: r.exitCode, tail: r.tail });
    }
    stopService(activeSvc);
    activeSvc = null;
  }
} finally {
  if (activeSvc) stopService(activeSvc);
}

// 把因「需 key」跳过的也记进结果
for (const n of allNames) {
  const meta = META[n];
  if (!withKey && meta.key === true && !meta.skip && !results.find((r) => r.name === n)) {
    results.push({ name: n, service: meta.service, antd: meta.antd, diagnostic: !!meta.diagnostic, key: true, status: 'skipped', reason: '无 SF_KEY（无 key 档跳过）', durationMs: 0, exitCode: null, tail: [] });
  }
}
for (const s of skipped) {
  results.push({ name: s.name, service: META[s.name].service, antd: META[s.name].antd, diagnostic: !!META[s.name].diagnostic, key: META[s.name].key || false, status: 'skipped', reason: s.reason, durationMs: 0, exitCode: null, tail: [] });
}

// ───────────────────────────── 汇总与落盘 ─────────────────────────────
const passed = results.filter((r) => r.status === 'passed').length;
const failed = results.filter((r) => r.status === 'failed').length;
const skippedN = results.filter((r) => r.status === 'skipped').length;
const total = results.length;
const passRate = total ? ((passed / total) * 100).toFixed(1) : '0.0';

console.log(`\n=== 汇总：${passed} 通过 / ${failed} 失败 / ${skippedN} 跳过（共 ${total}，通过率 ${passRate}%）===\n`);
// 把「有脚本没登记」这件事也钉在汇总上：只报警一次很容易被滚屏冲掉，
// 而它恰恰是上一轮「一键跑分全绿、材料那批压根没跑」的成因。
if (unregistered.length > 0) {
  console.warn(`⚠️  另有 ${unregistered.length} 个脚本未登记进 META、本轮未执行：${unregistered.join(', ')}\n`);
}

const reportJson = {
  generatedAt: new Date().toISOString(),
  withKey,
  react18BaselineVia: 'preview(4173)=dist(React18); dev(5173)=node_modules(React19, 非升级前基线)',
  summary: { passed, failed, skipped: skippedN, total, passRate: Number(passRate) },
  // 未登记脚本（按约定前缀命名却没进 META）—— 不为空即说明「一键跑分」有盲区
  unregisteredScripts: unregistered,
  results,
};
writeFileSync(join(CACHE_DIR, 'e2e-report.json'), JSON.stringify(reportJson, null, 2), 'utf8');

// 人读 markdown
const md = [
  `# e2e 基线运行报告`,
  ``,
  `- 生成时间：${reportJson.generatedAt}`,
  `- 档位：--with-key=${withKey}`,
  `- React18 基线来源：preview(4173) 读取 dist（React18 构建）；dev(5173) 由 node_modules 重编译（当前已是 React19，**非升级前基线**）`,
  `- 汇总：**${passed} 通过 / ${failed} 失败 / ${skippedN} 跳过**（共 ${total}，通过率 ${passRate}%）`,
  ...(unregistered.length > 0
    ? [
        ``,
        `> ⚠️ **本轮有 ${unregistered.length} 个脚本没有登记进 META，未被执行**：`,
        `> ${unregistered.map((n) => `\`${n}\``).join('、')}`,
        `> 它们是按约定前缀命名、本该进「一键跑分」的脚本。请在 \`scripts/e2e-all.mjs\` 的 META 里补条目，`,
        `> 否则上面的「通过率」并不覆盖它们 —— 这正是阅读材料那批曾被静默跳过的原因。`,
      ]
    : []),
  ``,
  `## 结果明细`,
  ``,
  `| 脚本 | 服务 | antd依赖 | 诊断 | 状态 | 耗时 | 退出码 | 备注 |`,
  `| --- | --- | --- | --- | --- | --- | --- | --- |`,
  ...results.map((r) => `| ${r.name} | ${r.service} | ${r.antd ? '是' : '否'} | ${r.diagnostic ? '是' : '否'} | ${r.status} | ${(r.durationMs / 1000).toFixed(1)}s | ${r.exitCode ?? '-'} | ${r.reason || ''} |`),
  ``,
  `## 失败脚本关键输出（末 20 行）`,
  ``,
  ...results.filter((r) => r.status === 'failed').flatMap((r) => [
    `### ${r.name}（${r.service}, exit=${r.exitCode ?? '-'}）`,
    '```',
    ...(r.tail || []),
    '```',
    '',
  ]),
  `> 注：诊断脚本（debug-*/probe-*）的输出仅供人工参考，其中的 pageerror/console.error 不一定代表断言失败。`,
  `> 但它们**并非「总以 0 退出」**：probe-svg-sanitize 等失败时会以非零码退出，因而同样计入 failed`,
  `> 并让本轮整体非零 —— 这是有意保留的，探针坏掉值得显式看见。判断结论请看脚本自己最后那行总结。`,
  '',
].join('\n');
writeFileSync(join(CACHE_DIR, 'e2e-report.md'), md, 'utf8');
console.log(`报告已写入：scripts/.cache/e2e-report.json / e2e-report.md`);

process.exit(failed > 0 ? 1 : 0);
