# 网课学习 Agent（字幕 + 讲义 + 问答）设计文档 v2

日期：2026-09-06
状态：待确认
**架构决策：纯浏览器端 PWA（iPad Safari 本地运行，无后端服务器）**

## 1. 目标与场景

iPad 浏览器（Safari）打开即可用的网课学习工具：
1. 选择本地网课视频，自动生成带时间轴的字幕（VTT），播放器内显示，字幕列表点击跳转。
2. 视频播放（触屏友好、倍速、字幕开关）。
3. 一键生成公文格式讲义（DOCX 下载 + 网页预览），图文并茂（自动抽取 PPT/板书帧插入对应章节）。
4. 针对视频内容的 LLM 问答（RAG，回答引用时间点可点击跳转）。
5. Agent harness 架构（参考 pi-mono）：最小 agent 循环 + 工具集，LLM function calling 调度。

**关键事实（已实测）**：硅基流动 API 全端点 CORS 开放（`access-control-allow-origin: *`，允许 authorization 头），浏览器可直调 chat/completions、audio/transcriptions、embeddings。→ 不需要任何后端。

## 2. 运行形态

- 纯静态 PWA 网站。获取方式二选一：
  a. 部署到 Vercel / GitHub Pages（免费，随时随地可用）；
  b. Mac 上 `npx serve dist` 一次，iPad Safari 打开后「添加到主屏幕」（PWA 缓存，之后离线也能打开外壳）。
- API Key 在网页设置页填写，存 iPad localStorage，不出设备。
- 所有 AI 调用：浏览器 → SiliconFlow HTTPS 直调。
- 所有媒体处理：浏览器内 WASM / Web API 完成。

## 3. 模型（全部硅基流动，.env/设置页可配，启动自检 + 回退）

| 用途 | 用户指定模型 | 回退模型 |
|---|---|---|
| ASR 转写 | XingChenAGI/XingChenASR-V3.2-Ultra | FunAudioLLM/SenseVoiceSmall |
| 生成/排版 | deepseek-ai/DeepSeek-V4-Flash | deepseek-ai/DeepSeek-V3 系 |
| Embedding | Qwen/Qwen3-VL-Embedding-8B | Qwen/Qwen3-Embedding-8B |
| 视觉（帧理解） | Qwen/Qwen3-VL 系 Instruct | Qwen/Qwen2.5-VL-72B-Instruct |

**已查证的接口约束：**
- 转写接口：单文件 ≤ 1 小时、≤ 50MB，**只返回纯文本无时间戳** → 必须本地 VAD 分段，段边界即时间戳。
- 分段并发请求（限流 + 重试），1 小时网课约 200–400 段。

## 4. 技术选型（全部开源库，浏览器端）

| 功能 | 库 | 说明 |
|---|---|---|
| 前端框架 | React + Vite + TypeScript + Ant Design | |
| 对话 UI | @ant-design/x | Bubble/Sender 等 AI 聊天组件 |
| 播放器 | Vidstack | 触屏友好、字幕轨、倍速，iPad Safari 兼容好 |
| 音频抽取 | ffmpeg.wasm | 视频 → 16kHz 单声道 WAV；长视频先 `-c copy` 切 10 分钟块再逐块解码，控制 WASM 内存 |
| VAD 分段 | @ricky0123/vad-web | silero-vad ONNX（onnxruntime-web），输出语音段时间戳，合并为 3–20s 段 |
| 关键帧抽取 | `<video>` seek + canvas 截图 | 无需 ffmpeg；等间隔采样 + 像素差分去重 |
| 帧理解 | Qwen3-VL（base64 image_url） | OCR/描述，筛 PPT 帧、生成图注 |
| DOCX 生成 | docx（npm） | 浏览器端生成公文格式 DOCX，blob 下载 |
| DOCX 预览 | docx-preview | 网页内渲染 DOCX |
| 本地存储 | Dexie（IndexedDB）+ OPFS | 字幕/讲义/聊天/向量存 IndexedDB；视频文件存 OPFS（Safari 15.2+） |
| 向量检索 | 自写余弦（Float32Array） | 单视频几千 chunk，内存检索足够 |
| Agent harness | 自研 TS（~300 行） | 参考 pi-mono（同为 TS）的 agent loop：消息列表 + 工具注册表 + tool-calling 循环 + 流式事件 |
| 防熄屏 | Wake Lock API | 长任务时保持亮屏（Safari 16.4+） |
| SSE 流式 | fetch + ReadableStream 解析 | Safari 支持 |

## 5. Harness 设计（浏览器内 agent 层）

```
src/harness/
  agent.ts    # AgentLoop: messages + tools + tool-calling 循环 + 流式事件
  tools.ts    # 工具注册表（JSON schema + 执行函数）
  prompts.ts  # 系统提示词
```

工具集：
- `get_video_info(video_id)`
- `run_transcription(video_id)` → VAD 分段 + 并发转写，返回字幕统计
- `extract_keyframes(video_id)` → canvas 抽帧 + 差分去重 + VL 筛选
- `search_transcript(video_id, query)` → embedding 检索（含时间戳）
- `get_frame_image(video_id, timestamp)` → 截图供 VL 看图
- `compose_handout(video_id)` → 大纲 → 分节写作 → 配图 → DOCX
- `export_handout(video_id)` → 触发下载

两种用法：
1. **流水线模式**：按钮触发固定编排（可靠、进度可视、断点续做）。
2. **Agent 模式**：问答对话，AgentLoop 自主调用工具，流式输出。

## 6. 数据流

### 6.1 字幕流水线
选视频 → ffmpeg.wasm 抽 16k 单声道音频（长视频分块）→ vad-web 切分（合并 3–20s）→ 并发调转写（限流+重试+断点续做）→ segments → VTT → IndexedDB → 播放器 track + 字幕列表。

### 6.2 讲义流水线
canvas 等间隔抽帧 + 差分去重 → Qwen3-VL 逐帧 OCR/描述筛 PPT 帧 → DeepSeek 组织 transcript 成公文大纲（JSON schema）→ 分节写作（嵌帧+图注）→ docx 库渲染公文样式 → 下载 + docx-preview 预览。

### 6.3 问答
transcript 分段 embedding 入库 → 提问 → AgentLoop：search_transcript 检索 →（可选）get_frame_image 看图 → 流式回答，引用 `[12:34]` 点击跳转。

## 7. 公文格式规范（docx 库实现）

- 大标题：方正小标宋/黑体 二号 居中；一级「一、」黑体三号；二级「（一）」楷体_GB2312 三号；三级「1.」仿宋加粗三号
- 正文：仿宋_GB2312 三号，首行缩进 2 字符，行距固定 28 磅
- 插图居中，图注「图 1 ×××」楷体小四居中；页码居中
- 字体缺失时 Word/WPS 自动替换，不影响结构

## 8. iPad 兼容性要点与风险

| 风险 | 对策 |
|---|---|
| 大视频解码内存 | ffmpeg.wasm 先 `-c copy` 切 10 分钟块再逐块处理；16k mono WAV 约 115MB/小时，可控 |
| IndexedDB/OPFS 配额与清理 | 申请 navigator.storage.persist()；提供字幕/讲义导出 |
| 长任务熄屏/后台节流 | Wake Lock + 提示保持前台；任务断点续做 |
| ffmpeg.wasm 体积 ~30MB | PWA 缓存，仅首次加载 |
| API key 在浏览器 | 个人自用可接受；不要把站点公开给他人使用 |
| 指定模型未上架 | 启动调 /v1/models 自检，回退链 + 明确提示 |

## 9. 分阶段实施计划

| 阶段 | 内容 | 验收 |
|---|---|---|
| M1 脚手架 | Vite+React+TS+antd 工程、PWA 配置、设置页（API key/模型）、模型自检 | iPad 打开首页、key 可保存 |
| M2 播放+存储 | 选视频、OPFS 存储、Vidstack 播放 | iPad 选视频可播放 |
| M3 字幕流水线 | ffmpeg.wasm 抽音频、vad-web 分段、并发转写、VTT、字幕列表点击跳转 | 1 小时视频转写成功、时间轴合理 |
| M4 讲义流水线 | 抽帧、VL 筛选、大纲+分节写作、DOCX 导出+预览 | 公文格式 DOCX、图文并茂 |
| M5 问答 Agent | embedding 索引、harness agent loop、Ant Design X 对话、时间戳跳转 | 问答正确、流式输出 |
| M6 收尾 | 错误处理、进度 UI、Wake Lock、PWA 打磨、README | 全流程 iPad 跑通 |

## 10. 开发方式

开发在 Mac 上进行（vite dev / build），iPad 通过局域网访问 dev/preview 服务器调试；最终产物为纯静态文件。
