# 问答技能范围（会话级限定）设计

日期：2026-09-18
状态：已实现

## 背景与目标

问答面板目前对技能**没有任何手动控制**：

- 发送前 `loadEnabledSkillMeta()` 取全部启用技能，把 `名称：用途` 清单塞进 system prompt；
- 模型自己判断该不该调 `use_skill`，用户无从干预；
- 而同一面板的讲义侧（`HandoutPanel`）早就有手动覆盖了 —— 齿轮对话框里每个技能一个「自动 / 必用 / 排除」三段控件，存 `video.skillOverride`，由 `routeHandoutSkills` 消费。

于是出现一个不对称：**同一门课，讲义能控制用哪些写作规范，问答不能。**

目标：问答也能限定「这次会话只准用哪几个技能」。

### 已定口径（2026-09-18 确认）

| 维度 | 结论 |
|---|---|
| 作用范围 | **每个会话独立**，存 `ChatSessionRow` |
| 选择语义 | **白名单限定** —— 收窄可选集合，模型仍在集合内自主决定用不用 |
| 入口 | `chat-model-bar` 里 `ModelPicker` 旁的图标按钮 → 对话框多选 |

### 为什么不是「与讲义共用 `video.skillOverride`」

讲义路由**明确排除出图类技能**：`PROMPTS.routeSkills` 第 2 条写着「讲义正文按公文结构化渲染（IR 块），**不解析图表围栏**；只服务问答讲解与题目解析的出图类技能不要选」。而问答恰恰是出图技能的主战场 —— `diagramming` 这个内置技能就是为问答讲解和题目解析加的（见 `skills/builtin.ts` 的注释）。

两者共用一份覆盖必然互相污染：在问答里 pin 了出图技能，下次生成讲义就可能被 router 拉进去。虽然它只是白烧 token（围栏不渲染），但语义已经错了。所以**独立存储**，代价只是多一个字段。

### 为什么不做「必用 / 强制注入正文」

讲义用三段式（自动 / 必用 / 排除）是因为**讲义要落成一份确定格式的文档**，「我就是要公文格式」是个明确诉求，值得强制。

问答不同：它是一问一答的探索过程，同一个会话里前一句问「这段怎么理解」、后一句问「帮我画个图」，需求本来就在变。强制注入正文会把某套写作规范钉死在整个会话上，反而限制了它。**限定范围**（模型自己决定用不用）更贴合问答的节奏，交互也更轻 —— 一个多选列表，不需要理解三种状态的区别。

## 不变量

1. **未限定 = 与现在完全一致。** 老会话零迁移，新会话默认不限定。任何回归都意味着老用户的问答行为被改了。
2. **白名单是硬边界，不能只在提示词层收窄。** 元数据清单只是「告诉模型有哪些」，`use_skill` / `read_skill_reference` 才是真正把正文取出来的地方 —— 必须在工具层拒绝集合外的技能。否则模型从历史消息里记得技能名，照样能调成功（`tools.ts` 现有的 `use_skill` 只校验 `skill.enabled`，不校验任何范围），白名单形同虚设。
3. **只影响问答。** 不写 `video.skillOverride`，不碰 `routeHandoutSkills`。
4. **禁用技能不进候选，且自动失效。** 候选来自 `loadEnabledSkillMeta()`（与设置页的启用状态同源）。技能被禁用后，即使它还在某个会话的白名单里，也必须失效 —— 靠取交集天然满足，不要另写一套判断。
5. **会话切换即跟随。** 切到另一个会话，UI 状态与实际生效的清单都要跟着变，不能残留上一个会话的选择。

## 设计

### 数据：`ChatSessionRow.skillIds`

```ts
export interface ChatSessionRow {
  id?: number;
  videoId: string;
  title: string;
  createdAt: number;
  /** 会话级技能白名单（非索引字段，无需升版本）。
   *  - undefined = 不限定，全部启用技能可用（现状，也是默认值）
   *  - []        = 限定，且一个技能都不给
   *  - [id, ...] = 限定为该集合（与启用状态取交集后才生效） */
  skillIds?: number[];
}
```

非索引字段，Dexie **不需要升版本** —— 有多个先例：`HandoutRow.usedSkills`、`HandoutRow.sectionsJson`、`SegmentRow.cues`、`ChatRow.images`（`db.ts` 里都标了「非索引字段，无需升级版本」）。

#### ⚠️ `[]` 与 `undefined` 必须区分开

这是本设计**最容易写错的地方**。`if (ids?.length)` 这类写法会把 `[]`（一个都不给）和 `undefined`（不限定）判成同一件事，于是「用户明确禁用了全部技能」静默退化成「全部技能可用」—— 正是这个项目最忌讳的那类静默错账。

因此判定**只走一个 helper**，不在调用点各写各的：

```ts
/** 会话是否处于「限定」模式。undefined = 不限定；[] 也是限定（一个都不给）。 */
export function isSkillLimited(ids?: number[]): boolean {
  return ids !== undefined;
}
```

工具层的放行条件同样不能用真值判断：

```ts
// 正确：undefined 放行，[] 拒绝一切
export function isSkillAllowed(id: number | undefined, allow?: number[]): boolean {
  if (!isSkillLimited(allow)) return true;
  return id != null && allow.includes(id);
}
// 错误：[] 会被当成「不限制」
// if (allow?.length && !allow.includes(id)) return '…';
```

### 这三条判定为什么单独一个文件

实现时把它们从 `store.ts` 拆到了 **`src/skills/scope.ts`**（零 import）。

原因是可测性：`skills/store.ts` 的依赖链里有 `builtin.ts`，而后者用 `import … from './builtin/x/SKILL.md?raw'` 引资源 —— esbuild / Node 都解析不了这个后缀，为它写一个 loader 插件只为了让单测能跑，代价大于收益。

拆出来之后，单测可以 `import '../src/skills/scope.ts'` 直接跑（Node 原生 TS），不用打包、不用 fake-indexeddb。装配层（会话读写、工具真的拒绝）交给 e2e。这与项目里 `materials/docx.ts` 刻意与渲染分离是同一个思路。

### 取数：`loadSessionSkillMeta()`

放在 `src/skills/store.ts`（与 `loadEnabledSkillMeta` 同处，共用 `ensureBuiltinSkills` 的前置逻辑）：

```ts
/** 会话白名单 → 实际可用的技能元数据。
 *  与启用状态取交集：技能被禁用后，白名单里的残留 id 自动失效。
 *  未限定（undefined）时等价于 loadEnabledSkillMeta()。 */
export async function loadSessionSkillMeta(skillIds?: number[]): Promise<SkillMeta[]> {
  const enabled = await loadEnabledSkillMeta();
  const usable = new Set(intersectSkillIds(enabled.map((m) => m.id), skillIds));
  return enabled.filter((m) => usable.has(m.id));
}
```

只有一条路径、没有 if 分支：不限定的时候 `intersectSkillIds` 原样返回全部 id，下面的 filter 全过。技能数是个位数，多这一次 map 换「判定逻辑只有一个出口」是划算的。

顺序很重要：**先取启用集合，再按白名单过滤**。反过来（先按白名单查库、再过滤 enabled）会多一次查询，且要重复处理 `enabled` 判断。

### 工具层硬边界

`createToolExecutor` 增加一个可选参数：

```ts
export interface ToolExecutorOptions {
  kind?: UnitKind;
  onQuiz?: (quiz: QuizData) => void;
  /** 会话级技能白名单；undefined = 不限制，[] = 全部拒绝 */
  allowedSkillIds?: number[];
}
```

执行器内部收敛成一个谓词，`use_skill` 与 `read_skill_reference` 共用：

```ts
const skillAllowed = (id: number | undefined) => isSkillAllowed(id, allowedSkillIds);

if (name === 'use_skill') {
  const skillName = String(args.name ?? '');
  const skill = await db.skills.where('name').equals(skillName).first();
  if (!skill || !skill.enabled) return `未找到技能：${skillName}（名称需与技能列表完全一致）`;
  if (!skillAllowed(skill.id)) {
    return `技能「${skillName}」不在本次会话的可选技能范围内。请改用系统提示词中列出的技能，或直接依据课程内容回答。`;
  }
  // …原逻辑
}
```

校验放在**查到技能之后**而不是之前：要先拿到 `skill.id` 才能判白名单，且「未找到技能」和「不在范围内」是两种不同的反馈，混在一起模型会不知道该怎么办。

拒绝时的文案要**明确指向可选清单**，而不是含糊地说「不允许」—— 模型收到「未找到技能」会换个名字再试一次，收到「不在可选范围内」才知道该收手。

`read_skill_reference` 同理（它是 `use_skill` 的后续步骤，理论上不会绕过，但边界要一致；漏一处就是漏洞）。

### 提示词

`qaSystem` / `qaSystemMaterial` 的 `skillMetaList` 参数**签名不变**，语义本来就是「可用技能的清单」—— 传过滤后的清单即可，提示词文本不用改。

一个推论：限定成空集时 `skillMetaList` 为空串/undefined，那段「可用技能」规则根本不注入，模型不知道有技能这回事，也就不会去调 `use_skill`。工具层的拒绝是**第二道保险**，两者叠加才算闭环。

### UI：`SkillPicker`

`chat-model-bar` 里 `ModelPicker` 之后放一个图标按钮，形态与 `ModelPicker` 同构（`mdui-tooltip` + 图标按钮，点击开对话框）：

| 状态 | 图标 | tooltip |
|---|---|---|
| 未限定 | 标准态 | `技能：自动（全部启用技能）` |
| 限定中 | `filled` 态 | `技能：已限定 N 项` |

**为什么用 `filled` 表示限定中**：MD3 的 `filled` 就是「非默认态」的视觉语言，项目里 `chat-thinking-toggle` 已经这么用了（`variant={thinking ? 'filled' : 'standard'}`），保持一致。窄面板放不下文字，图标形态是唯一能表达状态的通道。

**为什么图标要新加 `extension`**：`tune` 在 `HandoutPanel` 已经代表「生成参数（模型 + 技能覆盖）」。问答这边如果复用同一图标、内容却不同，会形成「同一图标两种含义」的不一致。`extension`（拼图块）是 skill / 插件的通用隐喻，语义最直白。

新增图标按项目约定：只改 `src/ui/symbols.ts`，然后**按顺序**重跑两个生成器（顺序不能反，第二个要读第一个的产出）：

```bash
node scripts/gen-material-symbols.mjs && node scripts/gen-mdui-types.mjs
```

### 对话框交互

`mdui-dialog`（复用讲义面板的判断：内容是多个复选控件、不是「点一下就关」的单选项，用 dialog 比 dropdown 合适）：

```
技能范围
  仅勾选的技能可供本次会话使用；全部勾选即「不限定」。

  ☑ 公文写作        公文体的正式书面表达规范
  ☑ 公文格式        GB/T 9704 排版要求
  ☐ 出图规范        图表围栏的使用规范
  …
  （一个都没勾选时：本次会话不会向模型提供任何技能）

  [全选]  [清空]                    [完成]
```

**归一化规则**：勾选集 == 全部启用技能时，写回 `undefined`（不限定），而不是写出全部 id 的数组。否则「全部勾选」会变成一个快照 —— 之后在设置页新增技能，这个会话不会自动包含它，而用户看到的界面明明是「全选了」。这个不一致很隐蔽，归一化掉最省事。

初始态：`skillIds` 为 `undefined` → 全勾选（视觉上等价于「全部可用」）。

写入时机：勾选即写（`db.chatSessions.update`），与讲义面板的 `setSkillMode` 一致，不搞「完成才提交」—— 多一步确认就多一次「我明明选了怎么没生效」的机会。「完成」只负责关对话框。

### 发送链路

`ChatPanel.send()` 里两处改动：

```ts
// 原来
const skillMetas = await loadEnabledSkillMeta();
// 改为
const skillMetas = await loadSessionSkillMeta(skillIds);

// 原来
const executeTool = createToolExecutor(videoId, { kind, onQuiz });
// 改为
const executeTool = createToolExecutor(videoId, { kind, onQuiz, allowedSkillIds: skillIds });
```

⚠️ **两处必须传同一个 `skillIds`**：清单收窄、工具放行，是同一件事的两面。只改一处会得到「模型看不到某技能、但调了却能成功」或「模型看得到、调了被拒」的错配状态。

`ChatPanel` 里 `skillIds` 的来源：切会话的 effect 里 `db.chatSessions.get(activeId)` 读该行的 `skillIds`。

**从库里现查，而不是读 `sessions` state**：会话行可能刚被别处改过；更重要的是这样 effect 只依赖 `activeId`，不会因为 `sessions` 数组变化（改标题、新建会话）而把整个历史消息重载一遍。

`SelectionAsk`（划词提问）走 zustand store 把引用交给 `ChatPanel` 统一发送，**只有一个发送入口**，自动继承范围，不需要单独改。

## 涉及文件

- `src/store/db.ts`：`ChatSessionRow.skillIds` 字段
- `src/skills/scope.ts`：新增。`isSkillLimited()` / `intersectSkillIds()` / `isSkillAllowed()`（零依赖）
- `src/skills/store.ts`：`loadSessionSkillMeta()`
- `src/harness/tools.ts`：`ToolExecutorOptions.allowedSkillIds` + `use_skill` / `read_skill_reference` 校验
- `src/components/SkillPicker.tsx` + `skill-picker.css`：新增（图标按钮 + 多选对话框）
- `src/components/ChatPanel.tsx`：`chat-model-bar` 挂载、state 与持久化、发送链路
- `src/ui/symbols.ts` + 两个生成器的产出：新增 `extension` 图标
- `README.md`：功能一览 / 问答能力表 / 目录结构 / 测试命令四处
- `scripts/test-qa-skill-scope.mjs`：Node 单测
- `scripts/e2e-chat-skill-scope.mjs`：e2e
- `scripts/e2e-all.mjs`：登记 META（**漏登记 = 脚本永远不跑**）

## 验证

两层，分工明确：

- **单测**（`test-qa-skill-scope.mjs`，纯 Node，直接 import `scope.ts`）：
  - `isSkillLimited` 三态（`undefined` / `[]` / `[id]`）；
  - `intersectSkillIds`：不限定 → 全量；限定 → 子集；白名单含**已禁用 / 已删除**的 id → 自动剔除（不变量 4）；白名单全是死 id → 空集；结果保持启用集合顺序；不改入参；
  - `isSkillAllowed`：`undefined` 放行一切、`[]` **拒绝一切**（`[]` / `undefined` 混淆的高危点）、集合内外、id 缺失。
- **e2e**（`e2e-chat-skill-scope.mjs`，dev 档）：导入样片 → 播种字幕 → 进问答面板 → 打开对话框取消勾选一项 → **刷新后限定仍在**（持久化）→ 「全选」归一化回不限定 → 新开会话归位。不注入 key、不调真实 API。

> 单测覆盖 `[]` 语义是刻意的：这个 bug 在 e2e 里极难构造（要先把技能全禁再观察行为），但在单测里就是一行断言。

## 验证记录（2026-09-18）

| 层 | 结果 |
|---|---|
| `scripts/test-qa-skill-scope.mjs` | 14/14 通过 |
| `tsc -b --force` | 通过 |
| `scripts/e2e-chat-skill-scope.mjs`（dev 5173） | 通过（8.4s） |
| `scripts/e2e-all.mjs --only=e2e-chat-skill-scope,test-qa-skill-scope` | 2 通过 / 0 失败 |

未跑 preview 档：本脚本用原生 IDB 读会话行，dev 与 preview 行为一致，而 preview 需要先 `npm run build`（本机构建受宿主文件审批影响，见 `2026-09-18-build-info-design.md`），不值得为一次验证付这个成本。**若后续要改成本脚本跑 preview，META 里的 `service` 改成 `preview` 并补 `base: true` 即可。**

## 已知未做 / 取舍

- **不做「必用 / 强制注入正文」**：理由见上（问答节奏多变，钉死规范反而受限）。若将来确有「这个会话就是要公文格式」的诉求，是在本设计上**叠加**一个 `pin` 维度，不是替换。
- **不做全局默认技能集**：口径定的是会话级。若将来要做，是 `settings` 里加一份默认值，新会话初始化时拷贝 —— 与 `skillIds` 不冲突。
- **不做技能内容的会话内预览**：对话框只显示 `name` + `description`（tooltip）。要看正文去设置页。窄面板里塞不下正文。
- **技能被删除时的白名单残留**：`loadSessionSkillMeta` 靠取交集自动忽略不存在的 id，但 `skillIds` 数组里的死 id 不会被清理。数据量极小（个位数），不值得为此加清理逻辑 —— 但**不要在别处把它当成「技能总数」用**。
- **dev 下会建出重复的「新会话」（既有问题，本次未修）**：`ChatPanel` 挂载时那段「查会话列表 → 空则建一个」不是幂等的。React StrictMode 在 dev 下把 effect 跑两遍，两个调用都在任何插入落库之前查完，于是建出 2 个「新会话」（实测 dev 2 个 / 生产 1 个）。这与技能范围无关，属于既有行为，**没动它**。`ensureBuiltinSkills` 用模块级 in-flight promise 闸门解决过同类问题，会话创建可以照搬同一手法 —— 但那是一次独立改动，值得单独一份设计。e2e 里的会话数断言因此写成「比之前多」而不是写死数字。
