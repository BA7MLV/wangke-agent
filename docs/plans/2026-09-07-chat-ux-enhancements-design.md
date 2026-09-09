# 问答面板增强设计：截图上下文 / 思考深度 / 模型切换 / 上下文提示器

日期：2026-09-07
状态：设计已确认，待实现

## 背景

当前问答面板（ChatPanel）只支持纯文本提问，模型全局唯一（`settings.llmModel`），无思考能力开关，用户对上下文占用无感知。本设计为问答体验增加四项能力，并把模型选择下沉到字幕 / 讲义 / 问答三个面板。

## 已确认的关键决策

| 决策点 | 结论 |
|---|---|
| 截图由谁回答 | 三级降级：①问答模型是多模态→图直接进 agent loop；②问答模型纯文本但有视觉模型→视觉模型带问题描述截图，描述文本进 loop；③都没有→直接报错并引导配置 |
| 截图数量 | 最多 4 张，每张带独立时间戳，发送时按时间戳排序 |
| 截图附带字幕 | 不按固定秒数，按 VAD 字幕段边界向前后扩展，累计 ~800 字封顶；agent 检索工具是兜底 |
| 思考深度 | 「开启思考」开关 + low/high/max 三档，仅模型支持时显示；模型不认参数时**直接报错**，不静默降级 |
| 思考过程展示 | 解析 `reasoning_content` 流式增量，渲染为可折叠「思考过程」区块 |
| 候选模型来源 | 设置页从 `/models` 拉全量 + 按用途分组收藏；面板下拉只显示收藏 |
| 面板切换模型 | 直接写全局槽位（不按视频记忆） |
| Embedding 模型 | 不进面板下拉（换模型需重建索引），只留设置页 |
| 上下文窗口 | 自动探测默认值（模型列表元数据 → 内置对照表 → 兜底 131072）+ 允许手改 |

## 一、模型与设置层

### Settings 扩展（`src/store/settings.ts`）

```ts
export interface Settings {
  apiKey: string;
  baseUrl: string;
  asrModel: string;
  llmModel: string;
  embedModel: string;
  visionModel: string;
  /** 新增：按用途分组的收藏模型列表 */
  favorites: { chat: string[]; vision: string[]; asr: string[]; embed: string[] };
  /** 新增：上下文窗口大小（自动探测 + 手改） */
  contextWindow: number;
}
```

### 模型能力启发式（新文件 `src/api/modelCaps.ts`）

- `isVisionModel(id)`：模型名匹配 `VL` / `vision` / `gpt-4o` / `gemini` / `claude` 等
- `supportsThinking(id)`：匹配 `R1` / `Qwen3` / `GLM-Z1` / `Hunyuan-T1` 等
- `guessContextWindow(id)`：内置常见模型对照表（如 DeepSeek 系 128k、Qwen 系 128k/256k），未知返回 131072
- 启发式是默认值，收藏时可手动修正标记（存 favorites 旁注）

### 设置页（`src/pages/Settings.tsx`）

- 新增「拉取模型列表」按钮 → `listModels()` → 按用途分 4 组展示（用启发式预分组），勾选收藏
- 新增「上下文窗口」数字输入，默认探测值
- Embedding 模型变更时提示「已建索引将失效，需重建」

### 面板头部快速切换

- **字幕面板**：紧凑下拉（ASR 收藏夹）→ 写 `asrModel`
- **讲义面板**：「模型」Popover 内两个下拉（视觉 / 文本）→ 写 `visionModel` / `llmModel`
- **问答面板**：紧凑下拉（chat 收藏夹）→ 写 `llmModel`，选项带「多模态」「可思考」标签
- 收藏夹为空时下拉仅显示当前模型，并提示去设置页配置

## 二、一键截图进问答

### 截取（新文件 `src/media/snapshot.ts`）

- 从 `playerRef` 取 `<video>` 元素 → `canvas.drawImage` → 最长边 1280 等比缩放 → `toDataURL('image/jpeg', 0.85)`
- 本地 blob URL，canvas 无跨域污染
- 同时记录 `currentTime`；另生成 ~320px 缩略图用于历史持久化

### 交互

- Sender `prefix` 放相机按钮；截图以 chip 挂在 Sender `header`（缩略图 + `[mm:ss]` + 删除 ×）
- 最多 4 张，超出时相机按钮禁用并提示
- 发送后用户气泡显示缩略图；`ChatRow` 增加非索引字段 `images?: { ts: number; thumb: string }[]`（Dexie 无需迁移，仅更新 TS 接口）

### 进上下文（三级降级）

1. `isVisionModel(llmModel)` → 用户消息 `content` 为 `[image_url…, text]` 数组，直接进 agent loop
2. 纯文本问答模型 + 有 `visionModel` → N 张图**并行**调视觉模型，prompt 携带用户问题：「用户在问：xxx，请描述这张网课截图中与问题相关的内容（公式/图表/板书/代码）」→ 描述以 `[截图@mm:ss 画面：…]` 拼入用户消息，走纯文本 loop
3. 无视觉能力 → 发送拦截：「当前模型不支持图片，请在设置中配置视觉模型或切换多模态模型」

### 时间轴上下文

- 每张截图取其时刻所在字幕段，向前后按完整段扩展，累计 ~800 字封顶
- 多张截图窗口重叠时合并去重
- 以 `[截图@mm:ss 前后字幕]：…` 形式拼入用户消息

## 三、思考深度

- 问答输入框工具栏「思考」开关，仅 `supportsThinking(llmModel)` 时显示
- 开启后浮现三档分段：低 / 高 / 最大（low / high / max），默认「高」
- API 层（`ChatOptions` 增加 `enable_thinking`、`reasoning_effort`）透传；模型报错不认参数时**直接报错**给用户：「当前模型不支持思考参数，请关闭思考或更换模型」
- `chatStream` 增加解析 `delta.reasoning_content`，经 agent loop 回调透出
- 气泡渲染：可折叠「思考过程」区块（流式期间展开，完成后默认折叠）+ 下方最终答案
- 开关与档位存 zustand persist（按会话记忆，不按视频）

## 四、上下文提示器

- 位置：输入框右下角极小字，`≈12.3k / 128k`
- 估算：system + 历史 + 当前输入 + 预计工具结果的总字符数 × 0.7，标「≈」；不引入 tokenizer 库
- 分母：`settings.contextWindow`（探测默认 + 手改）
- 阈值：<70% 灰，70~90% 橙，>90% 红并提示「建议开启新话题」
- 历史截断从「硬切最近 20 条」改为**按 token 预算截断**（预算 = contextWindow − system − 当前输入 − 输出预留 4k，预算内尽量多带近期历史）

## 数据流

```
截图 → snapshot.ts → {dataURL, ts, thumb}
     → ChatPanel 附件状态（≤4）
     → 发送时：isVisionModel(llmModel)?
        ├─ 是 → content=[images..., text+字幕窗口] → agent loop
        ├─ 否+有visionModel → 并行描述(带问题) → 描述+字幕窗口 → agent loop
        └─ 否 → 拦截报错
     → ChatRow 存 content + images(缩略图)
```

## 错误处理矩阵

| 场景 | 行为 |
|---|---|
| 截图时视频未就绪 | 相机按钮禁用 |
| 模型不支持图片 | 发送拦截 + 引导配置 |
| 模型不认思考参数 | 直接报错，提示关闭思考或换模型 |
| 视觉描述调用失败 | 该图降级为仅时间戳+字幕窗口，回答后小字提示 |
| 上下文 >90% | 红色提示，不阻塞发送 |

## 改动文件清单

| 文件 | 改动 |
|---|---|
| `src/store/settings.ts` | favorites / contextWindow 字段 |
| `src/api/modelCaps.ts` | 新增：能力启发式 + 窗口对照表 |
| `src/api/siliconflow.ts` | ChatOptions 增加思考参数；chatStream 解析 reasoning_content |
| `src/media/snapshot.ts` | 新增：视频截帧 |
| `src/harness/agent.ts` | 透出 reasoning 增量回调；历史按 token 预算截断 |
| `src/components/ChatPanel.tsx` | 截图 chip、思考开关+档位、上下文指示、模型下拉、思考过程渲染 |
| `src/components/SubtitlePanel.tsx` | ASR 模型下拉 |
| `src/components/HandoutPanel.tsx` | 视觉/文本模型 Popover |
| `src/pages/Settings.tsx` | 拉取模型 + 收藏夹 + 上下文窗口 |
| `src/store/db.ts` | ChatRow.images 字段（仅类型） |

## 测试

- 沿用 e2e 方式（`scripts/` playwright 真实 API）：新增 `e2e-chat-image.mjs`（带截图提问，三级路径按当前模型自动命中其一）
- 手动验证清单：截图 chip 增删、4 张上限、思考过程折叠展示、上下文指示变色、面板切换模型后各管线生效
