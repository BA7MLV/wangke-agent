# 生成式教学 UI：实现与验证（2026-10-25）

## 交付

- `ask_user.presentation.html` 复用 HTML 校验与 WidgetBlock；可选展示无效时保留结构化原题。页面草稿与原生输入共用状态，宿主再次校验稳定 ID/数量/文本并从原题计算标签。视觉提交必须在原生确认框确认，随后走原 `answerAsk` / `TurnResume`，不是新 prompt。取消确认不取消原问题；待答消失、停止、过期、组件卸载和确认超时会失效回执。正式 quiz 不开放视觉直接提交。
- 增加语义选项/分段、对比表、状态、图例、错误样式及短示例；颜色来自宿主语义令牌，图表必须同时用线型/标签区分系列。
- 有界版本高度记忆、ready 前隐去空 frame、可缩小的正常流测量、横向滚动条补偿；滚动阅读意图进入既有自动跟随控制。限长选区经宿主“引用提问”适配现有追问确认入口，包含消息/组件/源码版本，不开放 DOM 或通用宿主能力。
- 修正云同步口径：本机事务/outbox ACK 不等于云端 ACK；privateContent 不自动给模型，不表示不上服务器。
- 修复实际发现的停止死锁：等待用户工具时 `stop()` 需要主动调用已有 `releasePending`，否则只 abort 请求无法走到 finally。

## 本次修改文件

功能：

- `src/harness/askUser.ts`
- `src/harness/libraryAssistant.ts`
- `src/harness/widgetRuntime.ts`
- `src/harness/widgetReading.ts`（新增）
- `src/harness/widgetStyles.ts`
- `src/harness/widgetTheme.ts`
- `src/components/AskCard.tsx`
- `src/components/WidgetBlock.tsx`
- `src/components/widget-block.css`
- `src/components/useChatScroll.ts`
- `src/pages/CourseChat.tsx`（给当前提问绑定身份，提交前检查仍是同一待答问题）
- `src/store/courseChat.ts`（仅停止等待工具处；本文件还有其他会话的改动）

说明：

- `docs/interactive-explainers.md`
- `docs/generative-ui-validation-2026-10-25.md`
- `src/skills/builtin/interactive-explainer/SKILL.md`
- `src/skills/builtin/interactive-explainer/references/runtime.md`

验证：

- `scripts/test-ask-visual.mjs`（新增）
- `scripts/e2e-ask-visual.mjs`（新增）
- `scripts/e2e-widget-reading.mjs`（新增）
- `scripts/e2e-all.mjs`（登记新增测试）
- `scripts/e2e-widget-style-isolation.mjs`（支持隔离 Vite 缓存路径；比较正文时排除原本刻意更换为 MdTable 的 table display/margin，保留单元格及后续表格独立断言）
- `scripts/probe-widget-sandbox.mjs`（更新受限 API 白名单，含既有 answerInput/display/setAnswerDraft 与新增 submitAnswer）

未提交 commit、未加依赖、未使用真实模型凭据。工作中发现其他会话同时修改 MCP 等文件，全部保留，不计入本次实现。

## 已运行验证

通过：

```sh
node scripts/test-widget.mjs                       # 22 passed
node scripts/test-course-chat-tools.mjs            # 18 passed
node scripts/test-ask-visual.mjs                   # passed
npx tsc -b --pretty false                         # passed（最终改动后）
npm run build                                    # passed，含 i18n/API/runtime/TS/Vite/PWA
npm run build:api                                # passed（最终改动后）
git diff --check                                 # passed
```

已有状态/产物测试直接 tsx 运行会碰到已有 `src/api/base.ts` 的 `import.meta.env` Node 环境缺失；未改无关生产代码，使用测试专用 runtime 配置：

```sh
node --import tsx --input-type=module -e "globalThis.window=globalThis; window.__WANGKE_CONFIG__={apiBaseUrl:'http://test.invalid'}; await import('./scripts/test-widget-state.mjs');"
node --import tsx --input-type=module -e "globalThis.window=globalThis; window.__WANGKE_CONFIG__={apiBaseUrl:'http://test.invalid'}; await import('./scripts/test-artifact-edit.mjs');"
```

两者通过。必须分进程执行，因为第一个测试会删除/关闭 Dexie 数据库。

浏览器测试使用独立上下文、模拟模型、独立测试数据；Chrome 加 `--disable-features=MacAppCodeSignClone`。最终使用 `BASE_URL=http://127.0.0.1:5191`（较早通过的 widget-state 用 5188）。服务通过 Vite `createServer` 设置 `hmr:false, watch:null`，独立 cacheDir，避免其他会话文件更新和依赖重优化重载弹出窗口。

通过脚本：

```sh
node scripts/e2e-ask-visual.mjs
node scripts/e2e-widget-reading.mjs
node scripts/e2e-widget-state.mjs
node scripts/e2e-widget-layout.mjs
node scripts/e2e-widget-style-isolation.mjs
node scripts/e2e-question-bank.mjs
node scripts/probe-widget-sandbox.mjs
```

旧脚本的启动参数在临时 Node wrapper 中给 chromium.launch 追加禁用 Mac clone 的参数，不修改已有启动习惯。新增两个浏览器脚本内置该参数。

覆盖：真实 ask_user 挂起→草稿/原生输入双向同步→真实题面标签确认→取消→刷新恢复→原工具结果一次续跑→已答重载；错误答案与错误 source/origin 拒绝、原生降级提交、停止时关闭确认并不续跑；正常调参/参数 ACK/存储错误/私有参数隔离/主题不重建/独立预览同步及原窗口关闭错误；多图穿插/局部编辑/刷新/分支/窄屏；正式题库桌面+手机的 HTML 草稿、宿主提交/判分/错题和原图链路；尺寸缩小/固定 tooltip/横向表格/重挂缓存/选区身份版本/真实 wheel 和 PageUp 阅读意图；沙箱不透明源和禁网。

构建保留现有 CSS `:is()` 压缩警告、静态/动态 import 同时使用的分包警告；不影响构建成功。

## 截图

- `e2e-shots/ask-visual-confirm-mobile.png`
- `e2e-shots/ask-visual-answered-mobile.png`
- `e2e-shots/widget-reading-quote.png`
- `e2e-shots/widget-reading-mobile.png`
- `e2e-shots/widget-state-dark.png`
- `e2e-shots/widget-follow-up-mobile.png`

## 未验证边界

- 未用两个真实云客户端实测跨设备并发/离线合并；文档不承诺已验证一致性。
- 未实测 Safari/iOS 长按选区（有 pointerup/keyup 受限桥，桌面 Chrome 选区验证已通过）；未做所有辅助技术实测。
- 未实际等待 280 秒测试确认超时；实现超时先于 iframe 300 秒超时，避免迟到确认。
- 任意生成脚本仍可能自行画出错误内容或 UI；宿主原生题面/答案确认和原生输入才是可信层，HTML 预检不保证教学内容正确。生成页面需正常流高度，不保证修复任意恶意/自反馈 CSS。

## 复核修复（本轮追加）

复核指出的四项问题均成立，已针对性修复；未重新运行全量套件，保留其他会话 MCP 改动。

1. 新增 `normalizeAskDraft`，与最终 `validateAskAnswer` 分开。草稿允许多选不足最低数量、零选择和空文本，保留正在输入的空格；仍验证格式、mode/权限、稳定 ID、重复、上限和文本/备注长度。标签从原问题取。`AskCard.applyDraft` 只规范化草稿，`requestSubmit` 先严格验证完整答案，再更新同一份原生状态并进入原确认流程。
2. 草稿与最终答案都显式构造标准六个字段，不再 spread 外部答案。未知大对象、循环额外字段和伪造 selectedLabels 均不进入结果/工具 JSON，原字符串输入兼容。选项 ID 上限/合法性检查也适用于非 selection 模式传入的 IDs。
3. 高度测量从 body 自身尺寸加后代可见 box 边界计算，正常流溢出和 absolute 边缘提示会计入；沿祖先传递裁切下界，hidden/clip/auto/scroll 不因内部溢出撑高 iframe；fixed 子树整体排除。不使用根 scrollHeight，因此旧 viewport 不阻止收缩。新增浏览器测试使用真实 `buildWidgetDocument` 与自动回写 iframe 高度，覆盖 160px 父容器中的 260px 可见子内容（报告约 264px）、absolute 提示、hidden/auto 有意裁切、absolute 裁切、fixed 提示、横向滚动条及 168→608→168 后稳定，限制反馈次数。
4. 引用附带最多 240 字的附近上下文，并标记为同一不可信引用。高度缓存改成 memoized 身份+短源码版本+源码长度+库声明键，不再保留完整 HTML；精确 React source key 和桥接授权检查未改，非密码 hash 仅作可丢弃的高度提示。阅读测试现改成只选“当前候选”短词，并断言引用仍含“为什么保留”等上下文。

新增 `scripts/e2e-widget-corrections.mjs`（已登记编排器）；更新 `scripts/test-ask-visual.mjs` 与 `scripts/e2e-widget-reading.mjs`。其余本轮修改为 `src/harness/askUser.ts`、`src/components/AskCard.tsx`、`src/harness/widgetRuntime.ts`、`src/components/WidgetBlock.tsx` 和相关说明。

本轮命令与结果：

```sh
node scripts/test-ask-visual.mjs                  # PASS，含0→1→2→1→0、清空、额外循环/大字段、字符串兼容
node scripts/test-course-chat-tools.mjs           # 18 passed, 0 failed
BASE_URL=http://127.0.0.1:5192 node scripts/e2e-widget-corrections.mjs # PASS
BASE_URL=http://127.0.0.1:5192 node scripts/e2e-widget-reading.mjs     # PASS
npx tsc -b --pretty false                         # PASS
```

浏览器仍为隔离 Chrome 上下文、禁用 Mac clone、无模型 API 请求；5192 测试服务禁 HMR/文件监视，沿用独立依赖缓存。没有更改用户资料或增加依赖。

### 最终集成断言修正

`scripts/e2e-ask-visual.mjs` 的非法 ID 断言从旧的“请选择”更新为准确诊断“选项 ID 无效、重复或超过数量上限”，保留非法回答不打开确认框的断言。仅重跑：

```sh
BASE_URL=http://127.0.0.1:5192 node scripts/e2e-ask-visual.mjs
# PASS: real ask_user visual draft, trusted canonical confirmation/cancel,
# theme retention, refresh TurnResume, one original tool result,
# answered replay and 320px.
```

沿用独立 Vite 缓存、禁 HMR/文件监视服务及隔离浏览器测试数据；原 ask_user 挂起→TurnResume 续跑→已答重载完整集成回归通过。测试服务已关闭；未重跑其他套件，未改功能或提交 commit。
