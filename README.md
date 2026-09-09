# 网课学习助手

纯浏览器端 PWA：上传网课视频 → 自动生成字幕 → 一键生成公文格式图文讲义（DOCX）→ 基于课程内容的 AI 问答（RAG）。零后端，手机 / iPad / Mac / PC 浏览器均可用（iPad Safari 为主力验证平台）。

## 功能

- **库与文件夹**：首页视频按文件夹分组管理（新建/重命名/删除/折叠持久化，视频可移动归类，删文件夹视频回到未分类）
- **字幕**：本地抽取音频 → VAD 分段 → 硅基流动 ASR 并发转写（断点续做），播放器内字幕轨 + 字幕列表点击跳转，可导出 VTT/SRT；播放进度自动记忆，重开视频断点续播；控制栏倍速快捷键（1/1.5/2/3x，窄屏折叠为循环按钮）、双击画面两侧 ±10s（涟漪反馈，连击累加）、字幕字号四档可调（持久化）
- **讲义**：自动抽帧 → 视觉模型筛选教学画面 → 生成公文格式讲义（封面/目录/页眉、A4 公文版式、仿宋正文黑体章节、单双页码、三线表、插图带章节号图注），DOCX 下载 + 网页预览。内容层为结构化 IR：模型输出块级 JSON（主旨段/小节/列表/表格/配图/提示），排版样式由渲染器按样式表统一生成，编号全自动。插图双轨抽帧：VL 识图用 640px 低清（省 token），实际进文档的图按原视频 1600px/q0.92 定点重抽。**块级编辑**：讲义预览为结构化 IR 渲染，文字块（含概述/节标题/小节/列表/表格文字）支持左滑（移动端）或悬停（桌面）露出「AI 改写 / 编辑」——AI 改写提供预设指令（更精简/更详细/更口语化/换个说法）+ 自由输入，先预览再接受；手动编辑原地修改列表可增删条目、表格弹窗改文字；修改后从 IR 实时重建 DOCX 落盘（图片优先 1600px 高清重抽，视频不在则用 640px 抽帧兜底）。网页预览经 @font-face 名字对齐还原文档公文字体：local() 优先命中各平台系统仿宋/楷体/黑体/宋体（含 PostScript 名变体），无公文字体的设备按需下载开源朱雀仿宋 woff2 分包（OFL，unicode-range 按真实 cmap 重算，SW CacheFirst 缓存）
- **写作技能（Skills）**：Agent Skills 规范（SKILL.md + references/），渐进式披露——讲义生成前由 LLM 路由按课程内容自动选用（讲义面板可按视频手动覆盖），问答 agent 通过 `use_skill` / `read_skill_reference` 工具按需加载正文与参考文档；设置页可导入 .md 单文件或 zip 包，内置 6 个技能（公文讲义写作/公文版式规格/数学/编程/公考行测/公考申论，含 references）
- **问答**：字幕 embedding 索引 + agent loop（function calling 检索工具），流式回答，引用时间戳可点击跳转播放器；截图提问（多图 + 时间轴上下文，多模态直读 / 视觉模型描述 / 不支持则拦截引导，三级降级）；画面引用（已有讲义抽帧时注册 `list_frames` 工具，agent 按画面描述选图并以 `[图@mm:ss]` 标记引用，气泡内渲染幻灯片缩略图、点击跳转）；一键出题 / 对话式出题生成单选题卡（`present_quiz` 工具输出结构化题目，气泡内渲染可点选答题卡，点选即判、解析带时间戳跳转、作答状态持久化）；思考深度低/高/最大可调（支持模型显示开关）；Sender 下方实时上下文用量提示；整会话一键复制 Markdown / 导出 .md（含思考过程与题卡答案折叠、作答对错标记）
- **弹幕**：基于字幕一键生成 AI 思考题弹幕（启发式为主、回忆式为辅，宁缺毋滥），播放时在画面顶部记顶弹出（暂停跟随暂停，seek 回退可重看）；控制栏「弹」开关持久化；「弹幕」页可重新生成、列表点击时间戳跳转
- **卡片（Anki）**：一键从字幕提炼知识点生成问答候选卡（一卡一事实/自包含/答案唯一，带时间戳来源）→ Tinder 式滑动审核（右滑保留/左滑丢弃/点击翻面/撤销，移动端触摸拖拽 + 桌面按钮与键盘 ←/→/空格/⌫）→ 保留卡导出 .apkg（本地生成 collection.anki2 旧版包，Anki 桌面/AnkiMobile/AnkiDroid 均可导入；sql.js 懒加载 + PWA 预缓存，离线可导出）
- **面板级模型切换**：字幕/讲义/问答/弹幕面板头部下拉即换模型，候选来自设置页模型收藏夹
- **PWA**：添加到主屏幕离线可用外壳；长任务自动保持屏幕常亮（Wake Lock）；视频文件存 OPFS（流式写入、导入带进度），元数据/字幕/讲义存 IndexedDB
- **移动端**：≤640px 手机断点——播放页改为「视频 + 全屏面板 + 底部 Tab 栏」（字幕/讲义/问答/弹幕/卡片，display:none 保活切换不丢草稿）；safe-area 避让刘海与 Home 条；键盘弹出经 `interactive-widget` + visualViewport 同步收缩页面避免遮挡输入框；输入框 16px 防 iOS 聚焦缩放；触控目标 ≥40px；库页低频操作收进 ⋯ 菜单；讲义 DOCX 预览按屏宽等比缩放

## 快速开始

```bash
npm install
npm run dev        # 开发（局域网可访问，iPad 打开 Mac 的局域网 IP）
npm run build      # 构建到 dist/
npm run preview    # 预览生产构建（端口 4173）
```

首次使用在「设置」页填写硅基流动 API Key（仅存本机 localStorage），并可一键检查模型可用性。

部署：把 `dist/` 扔到任意静态托管（Vercel / GitHub Pages），或 Mac 上 `npx serve dist` 后 iPad Safari「添加到主屏幕」。

## 默认模型（硅基流动，设置页可改）

| 用途 | 模型 |
|---|---|
| ASR 转写 | XingChenAGI/XingChenASR-V3.2-Ultra |
| 文本生成 | deepseek-ai/DeepSeek-V4-Flash |
| Embedding | Qwen/Qwen3-VL-Embedding-8B |
| 视觉 | Qwen/Qwen3.6-35B-A3B |

设置页可拉取模型列表并按用途收藏（供各面板下拉选用）；上下文窗口/多模态/思考能力来自 models.dev 实时元数据（本地缓存 7 天，设置页可手动刷新），未收录模型回退名称启发式，上下文窗口也可手动修改。

## 技术栈

React 18 + Vite + TypeScript + Ant Design 6 / @ant-design/x · @ant-design/x-markdown 流式 Markdown 渲染（marked + DOMPurify）· Vidstack 播放器 · mediabunny 抽音频 · @ricky0123/vad-web（onnxruntime-web 自托管 wasm）· docx 公文排版 + docx-preview · Dexie(IndexedDB) · zustand · vite-plugin-pwa

## 目录结构

```
src/
  api/siliconflow.ts   # OpenAI 兼容客户端（SSE 流式 + tool_calls）
  api/modelMeta.ts     # models.dev 模型能力元数据（拉取/缓存/TTL），modelCaps.ts 查询入口
  harness/             # agent 层：agent.ts(循环) tools.ts prompts.ts search.ts(向量检索) quiz.ts(题卡校验) ankiCard.ts(卡片清洗/去重)
  pipelines/           # 流水线：transcribe.ts handout.ts handoutEdit.ts(块级 AI 改写/手动编辑落盘) embedIndex.ts danmaku.ts(思考题弹幕) cards.ts(Anki 制卡)（重试/并发池/断点续做）
  media/               # audio.ts(抽音频) vad.ts frames.ts(抽帧) wav.ts
  handout/             # 公文 DOCX：ir.ts(IR 类型/解析/兜底) styles.ts(版式样式表) render.ts(IR→排版) docx.ts(组装/补丁)
  anki/                # .apkg 导出：apkgCore.ts(最小写入器核心，Node 可测) apkg.ts(浏览器封装，sql.js wasm 懒加载)
  skills/              # 写作技能：types.ts(frontmatter) builtin/(6 个内置 SKILL.md+references) builtin.ts(?raw 加载) store.ts(升级/导入) router.ts(讲义路由) zip.ts(zip 解析)
  components/          # SubtitlePanel / HandoutPanel / HandoutDocView(IR 渲染+左滑编辑+AI 改写) / ChatPanel / QuizCard(答题卡) / DanmakuPanel(弹幕) / DanmakuLayer(飘屏层) / CardsPanel(制卡面板) / SwipeDeck(滑卡审核) / SkillsCard / StorageCard(设置页存储占用)
  pages/               # Library / Player / Settings
  store/               # db.ts(Dexie schema) settings.ts(zustand persist) fileStore.ts(视频文件 OPFS 存储) storageStats.ts(占用统计)
scripts/               # playwright e2e（真实 API）：e2e-import / e2e-smoke / e2e-handout / e2e-chat / e2e-chat-image / e2e-chat-frames
```

## 测试

```bash
# 讲义单元级（无需 API key / 无需起服务，Node 直接跑）
node scripts/test-handout-ir.mjs        # IR 解析/校验/兜底
node scripts/test-handout-prompts.mjs   # 提示词输出契约
node scripts/test-builtin-skills.mjs    # 内置 skill 资产（frontmatter/预算/references）
node scripts/test-chat-frames.mjs       # 问答画面引用：linkify/清单格式化/qaSystem 规则注入
node scripts/test-chat-export.mjs       # 会话导出 Markdown：结构/折叠块/题卡作答/文件名清洗
node scripts/test-quiz.mjs              # 答题卡：present_quiz 参数校验/清洗
node scripts/test-anki-cards.mjs        # 制卡：LLM 输出清洗/时间戳钳制/去重
node scripts/test-apkg.mjs              # .apkg 生成：zip + SQLite 结构断言（Node 直跑）
node_modules/.bin/esbuild scripts/render-handout-fixture.mjs --bundle --platform=node --format=esm --packages=external --outfile=scripts/.cache/render-handout-fixture.mjs && node scripts/.cache/render-handout-fixture.mjs   # DOCX 渲染 XML 断言 + 输出样本

# 高清抽帧（无需 API key，需 dev server；先 ffmpeg 生成测试视频：ffmpeg -y -f lavfi -i "testsrc2=size=1920x1080:rate=30" -t 10 -c:v libx264 -pix_fmt yuv420p public/.tmp-frames.mp4）
npm run dev &   # 5173
node scripts/e2e-frames-hires.mjs && rm -f public/.tmp-frames.mp4
node scripts/e2e-preview-fonts.mjs   # 讲义预览字体：local 链/woff2 分包两条路径断言 + 截图（无需 API key）
BASE_URL=http://localhost:4173 node scripts/e2e-handout-edit.mjs   # 讲义块级编辑：结构化渲染/手动编辑落盘+DOCX 重建/AI 面板/旧版回退/移动端左滑（无需 API key，自播种 IR）

npm run preview &   # 先起 4173
TEST_FILE=/path/to/lecture.mp4 node scripts/e2e-import.mjs                    # 导入链路（无需 API key）
TEST_FILE=/path/to/lecture.mp4 node scripts/e2e-resume.mjs                    # 断点续播链路（无需 API key）
TEST_FILE=/path/to/lecture.mp4 node scripts/e2e-player-enhance.mjs           # 播放器增强：倍速按钮/双击 ±10s/字幕字号（无需 API key）
TEST_FILE=/path/to/lecture.mp4 node scripts/e2e-mobile.mjs                   # 移动端 UI：底部 Tab/面板保活/触控尺寸/断点回退（无需 API key）
node scripts/e2e-chat-export.mjs                                              # 会话复制/导出 Markdown（无需 API key，自播种数据）
node scripts/e2e-cards.mjs                                                    # 滑动制卡：审核/撤销/导出 .apkg（无需 API key，自播种数据）
TEST_FILE=/path/to/lecture.mp4 node scripts/e2e-danmaku.mjs                  # 弹幕链路：飘屏/开关持久化/seek 重发（无需 API key；加 SF_KEY 含 LLM 生成）
SF_KEY=sk-... TEST_FILE=/path/to/lecture.mp4 node scripts/e2e-smoke.mjs    # 字幕链路
SF_KEY=sk-... TEST_FILE=/path/to/lecture.mp4 node scripts/e2e-handout.mjs  # 讲义链路
SF_KEY=sk-... TEST_FILE=/path/to/lecture.mp4 node scripts/e2e-chat.mjs     # 问答链路
SF_KEY=sk-... TEST_FILE=/path/to/lecture.mp4 node scripts/e2e-chat-image.mjs  # 截图提问链路
SF_KEY=sk-... TEST_FILE=/path/to/lecture.mp4 node scripts/e2e-chat-frames.mjs # 画面引用链路（帧数据播种进 IndexedDB）
SF_KEY=sk-... TEST_FILE=/path/to/lecture.mp4 node scripts/e2e-quiz.mjs     # 出题题卡链路：出题/判分/作答持久化
```

注意：转写接口单文件 ≤1 小时、≤50MB；视频/字幕数据只存在本机浏览器，清除站点数据会丢失。旧版本存 IndexedDB 的视频会在首次打开时自动迁移到 OPFS。
