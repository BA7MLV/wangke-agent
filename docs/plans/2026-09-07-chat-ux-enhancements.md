# 问答面板增强 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 问答面板增加视频截图上下文（多图+时间轴）、思考深度开关、面板级模型切换、上下文用量提示器。

**Architecture:** 纯浏览器 PWA，无后端。截图经 canvas 从 `<video>` 抓帧，按「问答模型是否多模态」三级降级进 agent loop；模型收藏夹存 zustand settings，面板下拉写全局槽位；思考参数透传 OpenAI 兼容接口并解析 reasoning_content 流；上下文用量字符估算。

**Tech Stack:** React 18 + TS + antd 6 / @ant-design/x 2.9（Sender 有 prefix/header/footer 属性）+ Vidstack + Dexie + zustand。

**设计文档:** `docs/plans/2026-09-07-chat-ux-enhancements-design.md`（决策依据以此为准）

**注意:** 本目录不是 git 仓库，每个 Task 的收尾检查点为 `npx tsc -b` 通过（而非 commit）。项目无单测框架，测试约定为 playwright e2e（真实 API）+ 手动验证，见 README。

---

### Task 1: 模型能力启发式 `src/api/modelCaps.ts`

**Files:**
- Create: `src/api/modelCaps.ts`

**Step 1: 实现**

```ts
/** 模型能力启发式：接口不返回模态/窗口元数据，按模型名推断，收藏时可人工修正 */

const VISION_RE = /(vl|vision|gpt-4o|gpt-5|gemini|claude|qwen3-vl|internvl|minicpm-v|glm-4v|step-1v|kimi-latest|moonshot-v1-.*-vision)/i;
const THINK_RE = /(r1|qwen3|qwq|glm-z1|hunyuan-t1|thinking|reasoner|deepseek-v3\.2|k2-thinking)/i;

export function isVisionModel(id: string): boolean {
  return VISION_RE.test(id);
}

export function supportsThinking(id: string): boolean {
  return THINK_RE.test(id);
}

/** 常见模型上下文窗口对照表（tokens），未知兜底 131072 */
const WINDOW_TABLE: [RegExp, number][] = [
  [/deepseek/i, 131072],
  [/qwen3-vl/i, 262144],
  [/qwen3/i, 131072],
  [/qwen2\.5/i, 131072],
  [/glm/i, 131072],
  [/kimi|moonshot/i, 131072],
  [/gpt-4o|gpt-5/i, 128000],
  [/claude/i, 200000],
  [/gemini/i, 1048576],
];

export function guessContextWindow(id: string): number {
  for (const [re, win] of WINDOW_TABLE) if (re.test(id)) return win;
  return 131072;
}
```

**Step 2: 检查点**

Run: `npx tsc -b` — Expected: 通过

---

### Task 2: settings store 扩展

**Files:**
- Modify: `src/store/settings.ts`

**Step 1: 实现**

`Settings` 接口增加两字段；persist 浅合并会自动给老数据补默认值，无需迁移：

```ts
export type ModelSlot = 'chat' | 'vision' | 'asr' | 'embed';

export interface Settings {
  apiKey: string;
  baseUrl: string;
  asrModel: string;
  llmModel: string;
  embedModel: string;
  visionModel: string;
  /** 按用途分组的收藏模型列表（面板下拉的候选） */
  favorites: Record<ModelSlot, string[]>;
  /** 上下文窗口（tokens），自动探测默认值，可手改 */
  contextWindow: number;
}
```

初始 state 增加：

```ts
favorites: { chat: [], vision: [], asr: [], embed: [] },
contextWindow: 131072,
```

`getSettings()` 返回值透传这两个字段。

**Step 2: 检查点**

Run: `npx tsc -b` — Expected: 通过（Settings.tsx 中 `listModels({...})` 调用处需补 `favorites`/`contextWindow` 字段，直接展开 `getSettings()` 结果或补空值）

---

### Task 3: API 层思考参数 + reasoning_content 解析

**Files:**
- Modify: `src/api/siliconflow.ts`

**Step 1: ChatOptions 扩展 + 请求体透传**

```ts
/** 思考深度档位（UI 三档：低/高/最大） */
export type ReasoningEffort = 'low' | 'high' | 'max';

export interface ChatOptions {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  temperature?: number;
  max_tokens?: number;
  signal?: AbortSignal;
  /** 开启思考（仅支持的模型） */
  enable_thinking?: boolean;
  /** 思考深度档位（仅 DeepSeek-V4 系 / GLM-5.2 生效） */
  reasoning_effort?: ReasoningEffort;
  /** 思考预算 tokens（多数推理模型生效），128~32768 */
  thinking_budget?: number;
}
```

`chatOnce` 与 `chatStream` 的 body 中追加（undefined 字段 JSON.stringify 会自动省略）：

```ts
enable_thinking: opts.enable_thinking,
reasoning_effort: opts.reasoning_effort,
thinking_budget: opts.thinking_budget,
```

**请求构造时剥离 reasoning_content**（推理模型的思维链不回传，避免多轮 loop 重复计费）：

```ts
messages: opts.messages.map(({ reasoning_content: _drop, ...m }) => m),
```

**档位→参数映射（2026-09-07 按硅基流动官方文档核实）**：`reasoning_effort` 仅 DeepSeek-V4 系/GLM-5.2 支持且 low/medium 被映射为 high；多数推理模型用 `thinking_budget`。故在 `modelCaps.ts` 加：

```ts
const EFFORT_MODELS_RE = /(deepseek-v4|glm-5\.2)/i;
const BUDGET_BY_EFFORT: Record<ReasoningEffort, number> = { low: 2048, high: 8192, max: 32768 };

/** 按模型生成思考参数：effort 模型传 reasoning_effort，其余推理模型传 thinking_budget */
export function thinkingParams(model: string, effort: ReasoningEffort) {
  return EFFORT_MODELS_RE.test(model)
    ? { enable_thinking: true, reasoning_effort: effort }
    : { enable_thinking: true, thinking_budget: BUDGET_BY_EFFORT[effort] };
}
```

**Step 2: chatStream 解析 reasoning_content**

签名加第 4 参 `onReasoning?: (text: string) => void`；SSE 解析处增加：

```ts
if (delta.reasoning_content) onReasoning?.(delta.reasoning_content as string);
```

返回的 assistant msg 增加非标准字段 `reasoning_content`（拼接完整值），`ChatMessage` 接口加 `reasoning_content?: string`。

**Step 3: 检查点**

Run: `npx tsc -b` — Expected: 通过

---

### Task 4: 上下文工具 `src/harness/context.ts`

**Files:**
- Create: `src/harness/context.ts`

**Step 1: 实现**

```ts
import type { SegmentRow } from '../store/db';

/** 粗略 token 估算：中文为主，字符数 × 0.7；仅用于 UI 提示与历史截断 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length * 0.7);
}

/** 按 token 预算从最新往最旧选取历史消息（替代硬切最近 20 条） */
export function fitHistoryToBudget<T extends { content: string }>(rows: T[], budgetTokens: number): T[] {
  const out: T[] = [];
  let used = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const t = estimateTokens(rows[i].content);
    if (used + t > budgetTokens && out.length > 0) break;
    used += t;
    out.unshift(rows[i]);
  }
  return out;
}

/**
 * 截图时刻的字幕上下文：从 ts 所在段起，向前后按完整 VAD 段扩展，
 * 累计 maxChars 字封顶。多时刻窗口重叠时合并（调用方去重 idx）。
 */
export function subtitleWindow(segments: SegmentRow[], ts: number, maxChars = 800): SegmentRow[] {
  if (segments.length === 0) return [];
  let center = segments.findIndex((s) => ts >= s.start && ts < s.end);
  if (center < 0) {
    center = segments.reduce(
      (best, s, i) => (Math.abs(s.start - ts) < Math.abs(segments[best].start - ts) ? i : best),
      0,
    );
  }
  const picked = new Set<number>([center]);
  let total = segments[center].text.length;
  let lo = center - 1;
  let hi = center + 1;
  // 交替向前后扩展，直到超预算
  for (;;) {
    const nextHi = hi < segments.length ? segments[hi] : null;
    const nextLo = lo >= 0 ? segments[lo] : null;
    if (!nextHi && !nextLo) break;
    // 优先扩展离 ts 更近的一侧
    const dHi = nextHi ? Math.abs(nextHi.start - ts) : Infinity;
    const dLo = nextLo ? Math.abs(ts - nextLo.end) : Infinity;
    const cand = dHi <= dLo ? nextHi : nextLo;
    if (!cand || total + cand.text.length > maxChars) {
      if (cand === nextHi) { hi = segments.length; } else { lo = -1; }
      if ((hi >= segments.length || total + segments[hi].text.length > maxChars) &&
          (lo < 0 || total + segments[lo].text.length > maxChars)) break;
      continue;
    }
    picked.add(cand.idx);
    total += cand.text.length;
    if (cand === nextHi) hi++; else lo--;
  }
  return segments.filter((s) => picked.has(s.idx));
}
```

**Step 2: 检查点**

Run: `npx tsc -b` — Expected: 通过

---

### Task 5: agent loop 透出 reasoning

**Files:**
- Modify: `src/harness/agent.ts`

**Step 1: 实现**

`AgentCallbacks` 增加：

```ts
/** 思考过程流式增量（reasoning_content） */
onReasoningDelta?: (text: string) => void;
/** 思考深度档位；undefined = 不开启思考。内部经 thinkingParams() 映射为 API 参数 */
thinkingEffort?: ReasoningEffort;
```

`runAgentLoop` 中按当前模型构造思考参数并传入：

```ts
const thinking = cb.thinkingEffort ? thinkingParams(settings.llmModel, cb.thinkingEffort) : {};
// chatStream options 中展开 ...thinking，第 4 参传 cb.onReasoningDelta
```

注意：`onReasoningDelta` 的跨轮累计包含所有轮次的思维链，而返回消息的 `reasoning_content` 只有最后一轮——持久化必须用回调累计值，勿改为从返回消息取。

**Step 2: 检查点**

Run: `npx tsc -b` — Expected: 通过

---

### Task 6: 视频截帧 `src/media/snapshot.ts`

**Files:**
- Create: `src/media/snapshot.ts`

**Step 1: 实现**

```ts
export interface Snapshot {
  /** 送模型的大图（最长边 1280，JPEG 0.85） */
  dataUrl: string;
  /** 历史持久化用缩略图（最长边 320） */
  thumb: string;
  /** 截图时刻（秒） */
  ts: number;
}

function drawToJpeg(video: HTMLVideoElement, maxEdge: number, quality: number): string {
  const scale = Math.min(1, maxEdge / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  canvas.getContext('2d')!.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
}

/** 从 video 元素抓当前帧；视频未就绪时返回 null */
export function captureFrame(video: HTMLVideoElement, ts: number): Snapshot | null {
  if (!video.videoWidth || !video.videoHeight) return null;
  return {
    dataUrl: drawToJpeg(video, 1280, 0.85),
    thumb: drawToJpeg(video, 320, 0.7),
    ts,
  };
}

/** 从 Vidstack playerRef 解析 <video> 元素（兜底全局查询） */
export function resolveVideoEl(playerRef: { current: unknown } | null): HTMLVideoElement | null {
  const host = (playerRef?.current as { el?: HTMLElement | null } | null)?.el;
  const v = host?.querySelector('video') ?? document.querySelector('.video-pane video');
  return (v as HTMLVideoElement | null) ?? null;
}
```

**Step 2: 检查点**

Run: `npx tsc -b` — Expected: 通过

---

### Task 7: 共享模型下拉 `src/components/ModelPicker.tsx`

**Files:**
- Create: `src/components/ModelPicker.tsx`

**Step 1: 实现**

```tsx
import { Select, Tag, Tooltip } from 'antd';
import { useSettings, type ModelSlot } from '../store/settings';
import { isVisionModel, supportsThinking } from '../api/modelCaps';

interface Props {
  slot: ModelSlot;
  /** 当前值（对应的全局槽位字段名） */
  field: 'asrModel' | 'llmModel' | 'embedModel' | 'visionModel';
}

/** 面板头部的紧凑模型切换下拉：候选 = 收藏夹，为空时仅显示当前模型 */
export default function ModelPicker({ slot, field }: Props) {
  const settings = useSettings();
  const value = settings[field];
  const favs = settings.favorites[slot];
  const options = (favs.length > 0 ? favs : [value]).map((id) => ({
    value: id,
    label: (
      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{id}</span>
        {isVisionModel(id) && <Tag color="geekblue" style={{ marginInlineEnd: 0 }}>多模态</Tag>}
        {supportsThinking(id) && <Tag color="purple" style={{ marginInlineEnd: 0 }}>可思考</Tag>}
      </span>
    ),
  }));
  return (
    <Tooltip title={favs.length === 0 ? '收藏夹为空，可在设置页拉取并收藏模型' : '切换模型'}>
      <Select
        size="small"
        variant="borderless"
        value={value}
        options={options}
        onChange={(v) => settings.update({ [field]: v })}
        popupMatchSelectWidth={false}
        style={{ maxWidth: 220 }}
        showSearch
        filterOption={(input, opt) => String(opt?.value).toLowerCase().includes(input.toLowerCase())}
      />
    </Tooltip>
  );
}
```

**Step 2: 检查点**

Run: `npx tsc -b` — Expected: 通过

---

### Task 8: ChatPanel 截图 chips + 三级降级发送链路

**Files:**
- Modify: `src/store/db.ts`（ChatRow 加字段）
- Modify: `src/components/ChatPanel.tsx`

**Step 1: db.ts 类型扩展（Dexie 非索引字段，无需 version 迁移）**

```ts
export interface ChatImage {
  ts: number;
  thumb: string; // 320px dataURL
}

export interface ChatRow {
  // ...existing
  images?: ChatImage[];
  reasoning?: string; // 思考过程（历史回放折叠展示）
}
```

**Step 2: ChatPanel 状态与截图处理**

```tsx
import { CameraOutlined, CloseOutlined } from '@ant-design/icons';
import { captureFrame, resolveVideoEl, type Snapshot } from '../media/snapshot';

// state
const [shots, setShots] = useState<Snapshot[]>([]);

const addShot = () => {
  const video = resolveVideoEl(playerRef);
  const t = playerRef.current?.currentTime ?? 0;
  if (!video) return message.warning('视频未就绪');
  const snap = captureFrame(video, t);
  if (!snap) return message.warning('截图失败，请稍候重试');
  setShots((prev) => (prev.length >= 4 ? prev : [...prev, snap]));
  if (shots.length >= 3) message.info('最多附带 4 张截图');
};
```

**Step 3: send() 改造（核心）**

```ts
const send = async (question: string) => {
  const q = question.trim();
  if ((!q && shots.length === 0) || loading) return;
  if (!indexReady) { message.warning('问答索引尚未就绪'); return; }

  const settings = getSettings();
  const curShots = [...shots].sort((a, b) => a.ts - b.ts); // 按时间戳排序
  setInput(''); setShots([]); setLoading(true);

  // —— 三级降级 ——
  let contentParts: ContentPart[] | null = null;   // tier1: 多模态直发
  let descBlock = '';                              // tier2: 视觉描述文本
  if (curShots.length > 0) {
    if (isVisionModel(settings.llmModel)) {
      contentParts = [
        ...curShots.map((s): ContentPart => ({ type: 'image_url', image_url: { url: s.dataUrl } })),
        { type: 'text', text: '' }, // 占位，后面填
      ];
    } else if (settings.visionModel) {
      // 并行描述，prompt 携带用户问题
      const results = await Promise.allSettled(
        curShots.map((s) =>
          chatOnce(settings, {
            model: settings.visionModel,
            messages: [{
              role: 'user',
              content: [
                { type: 'image_url', image_url: { url: s.dataUrl } },
                { type: 'text', text: PROMPTS.shotDescribe(q) },
              ],
            }],
            max_tokens: 512,
          }),
        ),
      );
      descBlock = results
        .map((r, i) => {
          const ts = fmtTime(curShots[i].ts);
          if (r.status === 'fulfilled') return `[截图@${ts} 画面：${textOf(r.value)}]`;
          return `[截图@${ts}]（画面描述失败，仅参考时间戳与字幕）`;
        })
        .join('\n');
    } else {
      message.error('当前模型不支持图片，请在设置中配置视觉模型或切换多模态模型');
      setLoading(false);
      return;
    }
  }

  // —— 截图时间轴字幕（按段扩展，多图合并去重） ——
  let subBlock = '';
  if (curShots.length > 0) {
    const segs = await db.segments.where('videoId').equals(videoId)
      .filter((r) => r.status === 1 && !!r.text).sortBy('idx');
    const picked = new Map<number, SegmentRow>();
    for (const s of curShots) for (const row of subtitleWindow(segs, s.ts)) picked.set(row.idx, row);
    subBlock = [...picked.values()].sort((a, b) => a.idx - b.idx)
      .map((r) => `[${fmtTime(r.start)}] ${r.text}`).join('\n');
  }

  const marker = curShots.map((s) => `[截图@${fmtTime(s.ts)}]`).join('');
  const userText = [
    marker, q,
    descBlock && `\n${descBlock}`,
    subBlock && `\n截图时刻前后字幕：\n${subBlock}`,
  ].filter(Boolean).join('');

  // UI 消息（气泡显示纯文本+缩略图，不显示拼接的描述/字幕块）
  const userKey = nextKey(); const aiKey = nextKey();
  setMsgs((prev) => [...prev,
    { key: userKey, role: 'user', content: `${marker}${q}`, images: curShots.map((s) => ({ ts: s.ts, thumb: s.thumb })) },
    { key: aiKey, role: 'ai', content: '', streaming: true },
  ]);
  await db.chats.add({ videoId, sessionId, role: 'user', content: `${marker}${q}`,
    images: curShots.map((s) => ({ ts: s.ts, thumb: s.thumb })), createdAt: Date.now() });

  // 历史：纯文本（含 marker），按 token 预算截断（Task 10 接入，此处先保持 slice(-20)）
  const history = await db.chats.where('videoId').equals(videoId).sortBy('createdAt');
  const recent = history.slice(-20);
  const messages: ChatMessage[] = [
    { role: 'system', content: PROMPTS.qaSystem(videoName) },
    ...recent.slice(0, -1).map((r) => ({ role: r.role, content: r.content }) as ChatMessage),
  ];
  // 当前问题：tier1 用多模态数组，tier2/纯文本用拼接文本
  if (contentParts) {
    contentParts[contentParts.length - 1] = { type: 'text', text: `${q}\n${subBlock}` };
    messages.push({ role: 'user', content: contentParts });
  } else {
    messages.push({ role: 'user', content: userText });
  }
  // …后续 runAgentLoop 调用与持久化逻辑不变，ai 消息持久化时加 reasoning 字段（Task 9）
};
```

注意：`db.chats` 现有记录带 `sessionId`，ChatPanel 当前代码未传（需核对当前会话逻辑，沿用现有 sessionId 获取方式）。

**Step 4: Sender 挂 chip + 相机按钮**

```tsx
<Sender
  value={input}
  onChange={setInput}
  onSubmit={send}
  loading={loading}
  disabled={!indexReady}
  placeholder={indexReady ? '输入问题，回车发送' : '等待索引就绪…'}
  prefix={
    <Button
      type="text" size="small" icon={<CameraOutlined />}
      disabled={!indexReady || shots.length >= 4}
      onClick={addShot}
      title="截取当前画面（最多 4 张）"
    />
  }
  header={
    shots.length > 0 && (
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', padding: 4 }}>
        {shots.map((s, i) => (
          <span key={i} style={{ position: 'relative', display: 'inline-block' }}>
            <img src={s.thumb} style={{ height: 48, borderRadius: 4, display: 'block' }} />
            <span style={{ position: 'absolute', left: 2, bottom: 2, fontSize: 10, color: '#fff', background: 'rgba(0,0,0,.55)', borderRadius: 2, padding: '0 2px' }}>
              {fmtTime(s.ts)}
            </span>
            <CloseOutlined
              style={{ position: 'absolute', top: -6, right: -6, fontSize: 10, background: '#fff', borderRadius: '50%', padding: 2, boxShadow: '0 0 2px rgba(0,0,0,.3)', cursor: 'pointer' }}
              onClick={() => setShots((prev) => prev.filter((_, j) => j !== i))}
            />
          </span>
        ))}
      </div>
    )
  }
/>
```

**Step 5: 用户气泡渲染缩略图**

Bubble.List 的 `role.user` 加 `contentRender`：`images` 缩略图横排 + 下方文字。历史加载时把 `r.images` 映射进 `ChatMsg`。

**Step 6: prompts.ts 增加**

```ts
/** 视觉模型描述截图（携带用户问题，聚焦相关内容） */
shotDescribe: (question: string) =>
  `这是网课视频的一帧截图。用户在问：「${question || '（未填写）'}」。请描述截图中与该问题相关的内容（公式、图表、板书、代码、幻灯片文字），客观转述，不评价。若无相关内容，简要描述画面主体。`,
```

**Step 7: 检查点**

Run: `npx tsc -b` — Expected: 通过；手动验证：截图 chip 增删、4 张上限、带图提问（按当前模型命中某级路径）

---

### Task 9: ChatPanel 思考开关 + 档位 + 思考过程渲染

**Files:**
- Modify: `src/components/ChatPanel.tsx`
- Modify: `src/store/settings.ts`（思考开关/档位 persist）

**Step 1: settings 增加（会话记忆，不按视频）**

```ts
thinkingEnabled: boolean;        // 默认 false
thinkingEffort: 'low' | 'high' | 'max'; // 默认 'high'
```

**Step 2: 面板头部行（模型下拉 + 思考开关）**

ChatPanel 顶部加一条 header row：`ModelPicker slot="chat" field="llmModel"` + 思考开关（仅 `supportsThinking(llmModel)` 时渲染）：

```tsx
{supportsThinking(llmModel) && (
  <Space size={4}>
    <Tooltip title="开启思考">
      <Button size="small" type={thinking ? 'primary' : 'text'} icon={<BulbOutlined />}
        onClick={() => update({ thinkingEnabled: !thinking })} />
    </Tooltip>
    {thinking && (
      <Segmented size="small" value={effort}
        options={[{ label: '低', value: 'low' }, { label: '高', value: 'high' }, { label: '最大', value: 'max' }]}
        onChange={(v) => update({ thinkingEffort: v as 'low' | 'high' | 'max' })} />
    )}
  </Space>
)}
```

**Step 3: runAgentLoop 传入思考参数 + reasoning 回调**

```ts
await runAgentLoop(messages, QA_TOOLS, executeTool, {
  thinkingEffort: thinking ? effort : undefined,
  onReasoningDelta: (t) => { reasoning += t; patchAi({ reasoning }); },
  onDelta: /* 不变 */,
  onToolStart: /* 不变 */,
});
```

模型报错不认参数时**直接报错**（现有 catch 已透出 message，确认错误文案可读即可，不做静默重试）。

**Step 4: 思考过程渲染**

`ChatMsg` 加 `reasoning?: string`。ai 气泡 `contentRender` 改为：

```tsx
<div>
  {m.reasoning && (
    <details open={info.status === 'updating' && !m.content} style={{ marginBottom: 8, opacity: 0.75 }}>
      <summary style={{ cursor: 'pointer', fontSize: 12, color: '#888' }}>思考过程</summary>
      <div style={{ fontSize: 12, whiteSpace: 'pre-wrap', borderLeft: '2px solid #ddd', paddingLeft: 8 }}>{m.reasoning}</div>
    </details>
  )}
  <XMarkdown ... />
</div>
```

注意：`contentRender(content, info)` 的 info 不含自定义字段——需通过 `items` 渲染闭包取 `m`（Bubble.List items 的 contentRender 第二参数含 item 数据，核对 antd-x 2.9 类型；若取不到，则把 reasoning 内联进 content 字符串用特殊标记分隔，或改用自定义渲染列表项）。

ai 消息持久化：`db.chats.add({ ..., reasoning: reasoning || undefined })`；历史加载映射 `reasoning`。

**Step 5: 检查点**

Run: `npx tsc -b` — Expected: 通过；手动验证：可思考模型出现开关，开启后流式显示思考区块，完成后可折叠

---

### Task 10: 上下文提示器 + token 预算历史截断

**Files:**
- Modify: `src/components/ChatPanel.tsx`

**Step 1: 历史截断替换**

send() 中 `history.slice(-20)` 改为：

```ts
const budget = settings.contextWindow - estimateTokens(PROMPTS.qaSystem(videoName)) - estimateTokens(userText) - 4096;
const recent = fitHistoryToBudget(history.slice(0, -1), Math.max(2000, budget));
```

**Step 2: 指示器（Sender 下方右对齐小字）**

```tsx
const ctxEst = useMemo(() => {
  const sys = estimateTokens(PROMPTS.qaSystem(videoName));
  const hist = msgs.reduce((s, m) => s + estimateTokens(m.content) + (m.reasoning ? estimateTokens(m.reasoning) : 0), 0);
  const cur = estimateTokens(input) + shots.length * 1200; // 每张图约 1.2k tokens
  return sys + hist + cur;
}, [msgs, input, shots, videoName]);
const ctxWin = useSettings((s) => s.contextWindow);
const ratio = ctxEst / ctxWin;
const color = ratio > 0.9 ? '#ff4d4f' : ratio > 0.7 ? '#fa8c16' : '#bbb';

<div style={{ textAlign: 'right', fontSize: 11, color, paddingTop: 2, fontVariantNumeric: 'tabular-nums' }}>
  ≈{(ctxEst / 1000).toFixed(1)}k / {Math.round(ctxWin / 1000)}k
  {ratio > 0.9 && ' · 建议开启新话题'}
</div>
```

**Step 3: 检查点**

Run: `npx tsc -b` — Expected: 通过

---

### Task 11: 设置页：收藏夹 + 上下文窗口 + Embedding 变更提示

**Files:**
- Modify: `src/pages/Settings.tsx`

**Step 1: 收藏夹 Card**

「模型配置」Card 下方新增「模型收藏夹」Card：`modelOptions` 非空时显示四个 Tabs（文本/视觉/ASR/Embedding，按 `isVisionModel` 等启发式预排序），每个 Tab 内 `Checkbox.Group` 列出模型，勾选写 `favorites[slot]`；`modelOptions` 为空时显示「先点击上方检查模型可用性拉取列表」。

**Step 2: 上下文窗口**

「模型配置」Card 内加：

```tsx
<Form.Item label="上下文窗口（tokens）" extra="切换模型时按内置表自动填默认值，可手改">
  <InputNumber min={8192} step={1024} value={settings.contextWindow}
    onChange={(v) => settings.update({ contextWindow: v || 131072 })} style={{ width: '100%' }} />
</Form.Item>
```

`llmModel` 变更时联动：`settings.update({ llmModel: v, contextWindow: guessContextWindow(v) })`。

**Step 3: Embedding 模型变更提示**

`embedModel` 的 AutoComplete onChange 改为：

```ts
Modal.confirm({
  title: '更换向量模型需要重建问答索引',
  content: '将清除所有视频已建立的向量索引，下次提问时自动重建。确定更换？',
  onOk: async () => { await db.embeddings.clear(); settings.update({ embedModel: v }); },
});
```

**Step 4: 检查点**

Run: `npx tsc -b` — Expected: 通过；手动验证：拉取列表→收藏→问答面板下拉出现候选

---

### Task 12: 字幕 / 讲义面板接入 ModelPicker

**Files:**
- Modify: `src/components/SubtitlePanel.tsx`（顶部 Space 工具行）
- Modify: `src/components/HandoutPanel.tsx`（顶部 Space 工具行）

**Step 1: SubtitlePanel**

工具行 `Space` 内右侧加 `<ModelPicker slot="asr" field="asrModel" />`。

**Step 2: HandoutPanel**

工具行加 Popover「模型」按钮，内含两个下拉：`ModelPicker slot="vision" field="visionModel"`、`ModelPicker slot="chat" field="llmModel"`，各带一行小字说明用途（抽帧筛选 / 讲义写作）。

**Step 3: 检查点**

Run: `npx tsc -b` — Expected: 通过

---

### Task 13: e2e + 文档收尾

**Files:**
- Create: `scripts/e2e-chat-image.mjs`
- Modify: `README.md`

**Step 1: e2e-chat-image.mjs**

仿照 `scripts/e2e-chat.mjs` 流程（先读它保持一致）：上传测试视频 → 等字幕+索引就绪 → 进入问答 Tab → `video.currentTime = 60` 并暂停 → 点击相机按钮（断言 chip 出现且含时间戳）→ 输入问题发送 → 断言 ai 气泡出现非空回答、用户气泡含 `<img>`。三级路径按当前配置模型自动命中其一，脚本只断言「不报错且有回答」。

Run: `npm run preview &` 后 `SF_KEY=sk-... TEST_FILE=/path/to/lecture.mp4 node scripts/e2e-chat-image.mjs` — Expected: 全绿

**Step 2: README 更新**

功能列表加：截图提问（多图+时间轴）、思考深度、面板级模型切换、上下文用量提示；默认模型表下方加一行「设置页可拉取模型列表并收藏，各面板可快速切换」。

**Step 3: 全量检查**

Run: `npm run build` — Expected: 通过

---

## 手动验证总清单

- [ ] 截图 chip：增删、4 张上限、时间戳角标、发送后气泡与刷新后历史均显示缩略图
- [ ] 三级降级：多模态模型直答 / 纯文本+视觉模型走描述 / 无视觉模型明确报错
- [ ] 截图回答能引用时间戳且可点击跳转
- [ ] 思考开关仅对支持模型出现；开启后思考区块流式展开、完成可折叠；不认参数的模型直接报错
- [ ] 上下文指示器随输入增长变色（灰→橙→红）
- [ ] 设置页拉取模型→收藏→三个面板下拉生效；Embedding 更换有确认弹窗并清索引
- [ ] 长对话历史按 token 预算截断（不再硬切 20 条）
