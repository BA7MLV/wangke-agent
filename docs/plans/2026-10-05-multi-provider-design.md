# 多供应商：凭据与模型配置分离

日期：2026-10-05
状态：已落地

## 问题

`Settings` 顶层只有一对 `apiKey` + `baseUrl`，外加三个存裸模型 id 的槽位
（`asrModel` / `llmModel` / `visionModel`）。耦合是「一对凭据 = 一家供应商 = 所有模型」：
所有请求（`/chat/completions`、`/audio/transcriptions`、`/models`）都打同一个 `baseUrl`。

于是「ASR 用一家、LLM 用另一家」做不到 —— 不是配置项没做，是形状本身不允许。

## 业界怎么做

查了四个独立实现，它们收敛到同一条：**传输配置与模型身份分离，且模型身份必须带 provider**。

| 项目 | 形状 |
|---|---|
| LiteLLM | `model_list` 每条 = `model_name`（别名）+ `litellm_params: { model, api_base, api_key }`，凭据挂在部署项上 |
| Open WebUI | 两层：**Connections**（base URL + key，传输层）↔ **Models**（工作区层，每模型自己勾 Vision） |
| Continue | 扁平 `models: [{ name, provider, model, apiBase, apiKey, capabilities: [] }]` |
| OpenRouter / Cloudflare / marimo / OpenCode | 模型身份写成 `provider/model` 字符串 |

「能力」在这四家里都放在**连接/供应商**层而非模型层（Continue 是模型层，但它的
`capabilities` 也是显式声明，不是猜的）。Open WebUI 把 Vision 勾在模型上，
因为一家供应商内部不同模型能力确实不同 —— 但**端点是否存在**（有没有
`/audio/transcriptions`）是连接的属性。

## 顺带发现并修掉的现存 bug

`modelMeta.ts` 原来把 models.dev 的 `siliconflow` 与 `siliconflow-cn` **拍平成一张
`id → 能力` 表**。实测：

- 两站有 31 个同名 id，其中 **7 个能力冲突**
- 其中一个是 `Qwen/Qwen3.6-35B-A3B` —— 正是 `DEFAULT_MODELS.visionModel`：
  - 国际站：`['text']`
  - 国内站：`['text','image','video']`

拍平取到的是「后合并的那一站」（cn）的值，所以视觉识图**现在能用纯属合并顺序的巧合**。
上游改任一侧，视觉就会静默失效。

全库更大的背景：3914 个模型 id 里有 **1150 个出现在多个 provider 下**，大量上下文窗口/
模态不一致（`thinkingmachines/Inkling` 在 deepinfra 是 524288，官方只有 65536）。

## 方案

### 数据形状

```ts
export type ModelSlot = 'chat' | 'vision' | 'asr';   // 沿用，不新增

export interface Provider {
  id: string;        // 本机短 id（'sf' / 'or' / 'dm'…），槽位与收藏夹靠它引用
  name: string;      // 显示名
  baseUrl: string;
  apiKey: string;    // 凭据，永不同步
  serves: ModelSlot[];  // 这家能填哪些槽位 = 实现了哪些端点，用户手动声明
  catalogId: string;    // models.dev 上的 provider key，留空则无能力元数据
}

export interface ModelRef { providerId: string; model: string }

/** 端点 + 模型 + 能力数据源合成一体 */
export interface ModelTarget {
  providerId: string; baseUrl: string; apiKey: string; model: string; catalogId: string;
}
```

`Settings` 里 `apiKey` / `baseUrl` 两个顶层字段**消失**（不留兼容后门：留着会让
「这份 key 属于哪家」重新变得不确定，那正是要拆掉的东西）。三个槽位与 `favorites`
都从 `string` / `string[]` 变成 `ModelRef` / `ModelRef[]`。

预置一条硅基流动（`serves` 三项齐全，`catalogId: 'siliconflow-cn'`），老用户升级即用。

### 两个「能力」层次要分清

初稿把它们混成一件事了。实际是两层：

- **供应商层 = 协议端点**（这家有没有 `/audio/transcriptions`）。这是**连接**的属性。
  手动声明在 `serves`，槽位下拉只列声明支持该槽位的那些家。**代码不猜** ——
  一家纯 ASR 服务里没有任何带 `asr` 字样的模型名，靠正则猜必然错。
- **模型层 = 上下文窗口 / 视觉 / 思考 / 工具调用**。来源是 models.dev，
  **按 `catalogId` 逐家索引**（见上）。

### 端点与模型绑成一个对象

`chatOnce(settings, { model })` 允许「拿文本模型的连接去打别家的视觉模型」这种自由组合。
单供应商下它无害（只有一家），多供应商下就是**真的把请求发到错误的地址**。

所以 `ChatOptions` 里的 `model` 字段被删掉，改由 `ModelTarget` 提供：这种错配在类型上
就写不出来。`chatOnce(target, opts)` / `chatStream(target, opts)` / `transcribe(target, blob)`。

### 能力元数据按供应商索引

缓存键从裸模型 id 变成 `${catalogId}\0${modelId}`，缓存版本 2 → 3（旧缓存整体作废：
无前缀的键会被当成「catalog 为空的数据」，命中不上任何查询）。

`DOC_EFFORT_MODELS`（硅基流动文档钦定的那三条 effort 模型）也按 catalogId 分组 ——
那份文档只对硅基流动成立，接到别家时别的供应商未必认 `reasoning_effort`。

`catalogId` 为空时 `getModelMeta` 直接返回 null，**不退化成「按模型名全局查」** ——
那正是拍平表的老 bug。

### 凭据与同步的边界

供应商表**参与同步**（id / 名称 / baseUrl / serves / catalogId），`apiKey` **不参与**。
理由与旧的顶层 apiKey 同一条：同步它等于把 Key 复制到服务端，且多设备共享一个 Key
会让用量与限流互相干扰。

⚠️ **白名单管不到嵌套字段**：`SYNC_SETTINGS_KEYS` 按顶层字段名过滤，管不到
`providers[i].apiKey`。所以 `pickSyncSettings` 里有一条专门的 `stripProviderKeys`
逐条重建对象 —— 这是「凭据永不同步」的唯一执行点，由 `test-sync-units.mjs` 守着。

导入（迁移包 / 同步载荷）都按 id **合并**而不是整表替换：包里没有 key，整表替换会把本机
所有 key 清成空串，表现为「导入一次配置之后整个应用都不能用了」。

### 迁移（v1 → v2）

`migrateSettings` 整体重建而非就地改字段：就地 `delete` 在 zustand persist 的
「持久化对象浅合并到初始 state」语义下会留残骸，而顶层 `apiKey` 留着就等于多了一份
凭据副本。

两个坑，都写进了注释与 e2e：

1. **不能在 migrate 里读 `useSettings.getState()`**。persist 在 `create()` 里**同步**
   完成首次 hydrate，那时 `useSettings` 变量还没赋值（TDZ）。读了会抛 → hydrate 中断 →
   store 悄悄退回默认值 → 症状是「明明填了 key 却提示没填」，而提示里点名的偏偏是默认
   那家（硅基流动），极具误导性。默认值必须是独立函数 `initialSettings()`。
2. **`version` 与实际形状可能不一致**（手改 localStorage、跨版本回滚、测试夹具）。
   若无条件按 version < 2 走旧形状重建，会把一份已经迁好的配置连同凭据一起抹掉。
   所以 `providers` 已是数组时直接放行。

### 设置页

拆成两层：

- 「模型供应商」卡：每家一个 `ProviderCard`（名称 / 地址 / Key / 能力勾选 / 能力数据源）
- 「模型配置」卡：槽位 → 供应商下拉（只列勾了该槽位的）+ 模型输入

「检查模型可用性」**逐家**拉 `/models`：多供应商后一家的 key 过期是常态，整体失败会让
其余几家连候选都拉不出来 —— 用户为了修一家的问题得先把另外几家全弄好。

收藏夹按供应商分组（sticky 组头）：同名模型在两家都有时，没有分组就分不清勾的是哪家。

删掉一家时，指向它的槽位改指剩下的第一家、收藏项清掉 —— 否则界面上留着解析不出端点的
引用，表现为「所有请求都报供应商已被删除」。

## 测试

| 文件 | 覆盖 |
|---|---|
| `scripts/test-providers.mjs`（新增，29 例） | 目标解析、报错文案点明是哪一家、按能力筛选、`sameRef`、导入合并不覆盖凭据、v1→v2 迁移 |
| `scripts/test-sync-units.mjs`（扩） | `providers` 进白名单、**每家的 apiKey 不在载荷里**、非凭据字段照常同步、返回值不泄露本机对象引用 |
| `scripts/test-thinking-depth.mjs`（扩） | 同一模型 id 在两家能力不同时各取各的、厂商文档只对点名的那家生效、没登记 catalogId 时查不到就是查不到、只保留登记过的供应商 |
| `scripts/e2e-providers.mjs`（新增，18 例） | 迁移（**只有浏览器里才有真实条件**，persist 依赖 window）、注册表增删改、按能力筛选候选、收藏夹分组、删除清理、**运行时请求真的打到了各家的地址与凭据** |
| `scripts/e2e-agent-guard.mjs` / `e2e-course-chat-cards.mjs` | 夹具改成新形状（顺带成了迁移的额外覆盖） |
| `scripts/test-agent-loop.mjs` | 改成单入口打包（多入口会各打一份 settings.js，改 store 改的是另一份实例） |

全量：`npx tsc -b` 通过、`npm run build` 通过、46 个 `test-*.mjs` 全绿、
`e2e-providers` 与 `e2e-agent-guard` 全绿。

`e2e-course-chat-cards` 有 1 条失败（`要说清用完了几轮`），**在改动前的 HEAD 上同样失败**
（用独立 worktree 跑过基线确认），与本次改动无关。
