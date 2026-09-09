# 问答内交互式答题卡片（单选题）设计

日期：2026-09-08
状态：已实现（2026-09-08）

## 背景

问答 agent 现有 4 个工具（search_transcript / get_transcript_range / use_skill / read_skill_reference），均为检索与技能加载类，没有出题能力。出题本身不需要"生成工具"（题目文本模型自己就能写），真正需要补的是**结构化输出通道**：让模型把题目以 JSON 交给 UI，渲染成可点选、可判分的交互卡片，而不是一段纯文本。

## 已确认的关键决策

| 决策点 | 结论 |
|---|---|
| 形态 | 聊天流内交互式答题卡片（点选选项、判分、显示解析） |
| 触发方式 | Sender 旁「出题」按钮（发预设指令）+ 自然语言（"考考我"等由模型自行判断） |
| 出题方式 | 新增 agent 工具 `present_quiz`：模型先 search_transcript 检索字幕，再以工具参数输出结构化题目 JSON |
| 作答后 | 纯本地判分 + 即时解析（解析由模型出题时写好，含时间戳可跳转），不自动回传 AI |
| 题型 | 仅单选（4 选项）；结构上 options 数组 + answer 下标，未来可扩多选 |
| 默认题量 | 3 道（按钮预设指令指定；自然语言时模型可按用户要求调整） |
| 持久化 | ChatRow 增加非索引字段 `quiz`（无需 Dexie 升版本，与 images/reasoning 同机制） |

## 一、Agent 层

### 新工具 `present_quiz`（`src/harness/tools.ts`）

```ts
{
  name: 'present_quiz',
  description: '当用户要求出题/测验/考考我时调用。先用 search_transcript 检索相关字幕，再基于字幕内容出单选题。题目以结构化 JSON 展示为可作答的题卡。',
  parameters: {
    questions: [{
      stem: string,            // 题干
      options: [string × 4],   // 4 个选项，不含 "A." 前缀
      answer: number,          // 正确选项下标 0~3
      explanation: string,     // 解析，引用内容带 [mm:ss] 时间戳
      time?: string,           // 考点对应的字幕时间戳 mm:ss
    }]  // 1~5 题
  }
}
```

- **执行器**：`createToolExecutor(videoId, onQuiz?)` 增加可选回调。收到调用后做结构校验（1~5 题、每题恰好 4 个非空选项、answer ∈ [0,3]、题干/解析非空），通过则 `onQuiz(quiz)` 并返回「题卡已展示，请用一句话说明考查点」；校验失败返回具体错误描述，agent loop 天然让模型重试一轮。
- **系统提示词**（`PROMPTS.qaSystem`）追加规则：用户要求出题/测验时，先检索相关字幕再调用 `present_quiz`；题目必须基于字幕实际讲到的内容，选项要有干扰性（常见误解/相近概念），解析引用时间戳。

## 二、QuizCard 组件（新文件 `src/components/QuizCard.tsx`）

- 每题：题干 + 4 个选项按钮（A/B/C/D 前缀由组件生成）
- 交互：点选即判（单选题无提交按钮，一步到位）——选对选项变绿 ✓；选错所选变红 ✗、正确项变绿；随后展开该题解析（时间戳经 linkifyTimestamps 可跳转）
- 全部作答后底部显示得分「答对 2/3」
- 受控组件：`picks` + `onAnswer`，状态由 ChatPanel 持有以便回写持久化（是否答完由 picks 派生）

## 三、ChatPanel 集成（`src/components/ChatPanel.tsx`）

- `ChatMsg` 增加 `quiz?: { data: QuizData; picks: number[] }`（picks[i] = -1 表示未作答）
- `createToolExecutor(videoId, (data) => patchAi({ quiz: { data, picks: data.questions.map(() => -1) } }))`
- AI 气泡 `contentRender`：markdown 正文（引导语）下方渲染 `<QuizCard>`；`onToolStart` 增加 hint「正在出题…」
- Sender prefix 区加「出题」按钮（相机按钮旁），点击 `send('根据课程内容出 3 道单选题考考我，选项要有干扰性')`；disabled 逻辑同发送（索引未就绪 / loading 中禁用）
- 作答回调：`patchAi` 更新 picks，并 `db.chats.update(id, { quiz })` 回写（需保留落库返回的行 id）

## 四、持久化（`src/store/db.ts`）

```ts
export interface QuizQuestion { stem: string; options: string[]; answer: number; explanation: string; time?: string }
export interface QuizData { questions: QuizQuestion[] }

interface ChatRow {
  // ...现有字段
  /** 答题卡（非索引字段，无需升级版本）：题目 JSON + 用户作答（picks[i] = -1 表示未作答，全部作答由 picks 派生） */
  quiz?: { data: QuizData; picks: number[] };
}
```

- 历史加载时恢复 `quiz` 字段，刷新后题卡及已答状态保留
- 进模型上下文的历史仍只发 `content` 文本（引导语），quiz JSON 不进上下文

## 五、边界与失败

- 模型输出结构非法 → 执行器返回错误描述，模型重试；重试仍败则最终文本回答兜底（agent loop 现有机制）
- 流式中断发生在 `present_quiz` 之后 → 题卡已上屏可正常作答（纯本地交互），正文标「回答中断」
- 重复出题 → 每次调用生成独立题卡消息，互不影响
- 移动端：选项按钮按触控目标 ≥40px，纵向排列

## 六、测试

- `scripts/test-quiz-tool.mjs`（Node 直跑，无需 API key）：执行器校验逻辑（合法 JSON 通过并触发 onQuiz；缺选项/answer 越界/空题干返回错误且不触发）
- e2e（参考 e2e-chat.mjs）：`SF_KEY=... node scripts/e2e-quiz.mjs`——点出题按钮 → 题卡出现 → 点选判分 → 刷新后状态保留
