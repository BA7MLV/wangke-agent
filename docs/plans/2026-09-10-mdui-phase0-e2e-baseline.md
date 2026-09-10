# 阶段 0：升级前 e2e 基线报告（React 18）

- 生成时间：2026-09-10
- 目的：在把 React 升级到 19.3.0、并把 UI 从 antd 迁移到 mdui 之前，锁定一份**真实的 e2e 基线**，
  以便升级/迁移后出现红灯时，能区分「React 19 引入的回归」还是「本来就是红的」。
- 编排器：`scripts/e2e-all.mjs`（本报告由其产出，报告落盘 `scripts/.cache/e2e-report.json` / `e2e-report.md`）
- 本次运行档位：`--with-key=false`（无 `SF_KEY` 环境，硬依赖 key 的脚本整档跳过）

---

## ⚠️ 两个必须先说清的前提（直接影响你怎么读这份基线）

### 前提 A：React 19 此刻已经装进 node_modules 了，dev 服务不是「升级前基线」

- `node_modules/react`、`react-dom` 当前版本 = **19.3.0**，`package.json` 已改为 `^19.3.0`（这些是你正在跑的 `npm install` 的结果）。
- `dist/` 的构建时间是 **11:59**，而 React 19 的安装时间是 **15:21**（`stat` 取证）→ `dist/` 是 **React 18** 的产物，**没有**被重建过。
- 因此：
  - `npm run preview`（4173）只读 `dist/` → **这是唯一可靠的升级前 React 18 基线**。本报告把 preview 批次当作权威基线。
  - `npm run dev`（5173）会从 `node_modules` 重编译 → 它现在跑的是 **React 19**，**不是**升级前基线。本次运行 5173 端口上还有一个**你事前已起的 dev 服务**被编排器复用，其 React 版本不能确定（可能早于安装=18，也可能=19）；但无论如何，dev 批次的 2 个失败都与 React 版本无关（见下），所以不影响结论。
- **绝对没有运行过 `npm run build` / `vite build`，`dist/` 只读。**

### 前提 B：设计文档里「24/43 依赖 antd」的数字不准，实测是 **23/43**

逐脚本读取+选择器提取后核实：依赖 antd 的 DOM 结构/类名（`.ant-*`、`[role="tabpanel"]`、`.anticon-*` 等）的脚本共 **23 个**，不是 24 个。
（差的那 1 个疑似把某个用 `getByText` 文本定位、或把 `role: 'user'`（消息对象字段，非 DOM 角色）的脚本误算进去了。）

---

## 一、分类表（43 个脚本逐一定性）

图例：服务 = `none`(纯 Node) / `preview`(4173, React18 dist) / `dev`(5173)；`key`=需 `SF_KEY`；`file`=需 `TEST_FILE`；
`antd`=依赖 antd 选择器；退出码 = 脚本自身约定。

| 脚本 | key | file | 服务 | env 覆盖 | antd 选择器依赖 | 退出码约定 |
| --- | --- | --- | --- | --- | --- | --- |
| debug-import-perf | – | ✓ | preview | – | 是 `.ant-progress` `.ant-list-item` | 诊断(恒0) |
| debug-player | ✓(软) | ✓ | dev | – | 是 `.ant-list-item` | 诊断(恒0) |
| debug-transcribe | ✓(软) | ✓ | dev | – | 是 `.ant-list-item` | 诊断(恒0) |
| e2e-cards | – | – | preview | BASE_URL | 是 `.ant-tabs-tab` `.ant-modal-confirm` `.ant-btn` | exitCode=1 |
| e2e-chat-export | – | – | preview | BASE_URL | 是 `.ant-tabs-tab` `.ant-message-success` `button:has(.anticon-plus)` | exitCode=1 |
| e2e-chat-frames | ✓ | ✓ | preview | – | 是 `.ant-list-item` `.ant-tabs-tab` `.ant-bubble-start img` | exit(0/3) |
| e2e-chat-image | ✓ | ✓ | preview | – | 是 `.ant-list-item` `.ant-tabs-tab` `.ant-sender img` `.ant-bubble-end img` | exit(0/3) |
| e2e-chat-mermaid | – | ✓ | preview* | BASE_URL | 是 `.ant-list-item` `getByRole('tab','问答')` `.ant-bubble` `.ant-modal-wrap` | exit(failed?0:1) |
| e2e-chat | ✓ | ✓ | preview | – | 是 `.ant-list-item` `.ant-tabs-tab` | exit(0/3) |
| e2e-danmaku | ✓(可选) | ✓ | preview | – | 是 `.ant-list-item` `.ant-tabs-tab` `[role="tabpanel"]:visible .sub-item` | exitCode=1 |
| e2e-handout-edit | – | – | preview | BASE_URL | 是 `.ant-tabs-nav` `.ant-message-error` | exitCode=1 |
| e2e-handout | ✓ | ✓ | preview | – | 是 `.ant-list-item` `.ant-tabs-tab` | exit(0/3) |
| e2e-import-insecure | – | ✓ | preview | – | 是 `.ant-list-item` | exitCode=1 |
| e2e-import | – | ✓ | preview | – | 是 `.ant-progress` `.ant-list-item` `.ant-btn-dangerous` `.ant-popconfirm` | exitCode=1 |
| e2e-live-subs | – | ✓ | dev | BASE_URL | 是 `[role="tabpanel"]:visible` `getByRole('tab')` `.ant-list-item` | exit(0/3) |
| e2e-mobile | – | ✓ | preview | – | 是 `.ant-list-item` `.anticon-more` `.ant-dropdown-menu-item` `.ant-tabs` | exitCode=1 |
| e2e-player-enhance | – | ✓ | preview | – | 是 `.ant-list-item` `.anticon-setting` `.ant-card` `.ant-input-number` `.ant-space-compact` `.ant-tag` | exitCode=1 |
| e2e-preview-fonts | – | – | dev | – | 是 `.ant-tabs-tab` | exit(failed/errors?0:1) |
| e2e-quiz | ✓ | ✓ | preview | – | 是 `.ant-list-item` `.ant-tabs-tab` | exit(0/3) |
| e2e-resume | – | ✓ | preview | – | 是 `.ant-list-item` | exitCode=1 |
| e2e-smoke | ✓ | ✓ | preview | – | 是 `.ant-list-item` | exit(0/3, 真调 API, 超时600s) |
| e2e-storage-card | – | – | preview | – | 是 `.ant-card` `.ant-progress` `.ant-tag` `.ant-list-item` `.ant-typography` | exitCode=1 |
| motion-components-test | – | – | preview | – | 否 `.t-text-swap` 等自定义类 | exitCode(fail/err) |
| motion-smoke | – | – | preview | – | 是 `.ant-upload-wrapper` | exitCode=1 |
| e2e-frames-hires | – | – | dev | – | 否 直接 import `/src` | exit(failed?0:1) |
| probe | – | – | dev | – | 否 `input` | 诊断(恒0) |
| probe-mermaid | – | – | dev | BASE_URL(默认5174) | 否 `data-testid="mermaid-block"` | 诊断(恒0) |
| render-handout-fixture | – | – | none | – | 否 | exit(fail?1:0) |
| test-anki-cards | – | – | none | – | 否 | exit(fail?1:0) |
| test-apkg | – | – | none | – | 否 | exit(fail?1:0) |
| test-bilibili-api | – | – | none | – | 否(需网络) | exit(fail?1:0) |
| test-bilibili-index | – | – | none | – | 否 | exit(fail?1:0) |
| test-bilibili-parse | – | – | none | – | 否 | exit(fail?1:0) |
| test-builtin-skills | – | – | none | – | 否 | exit(fail?1:0) |
| test-chat-export | – | – | none | – | 否(`role`是消息字段非DOM) | exit(fail?1:0) |
| test-chat-frames | – | – | none | – | 否 | exit(fail?1:0) |
| test-error-text | – | – | none | – | 否 | exit(fail?1:0) |
| test-handout-ir | – | – | none | – | 否 | exit(fail?1:0) |
| test-handout-prompts | – | – | none | – | 否 | exit(fail?1:0) |
| test-migration | – | – | none | – | 否 | exit(fail?1:0) |
| test-ort-config | – | – | none | – | 否(需 wasm) | exit(fail?1:0) |
| test-quiz | – | – | none | – | 否 | exit(fail?1:0) |
| test-rate | – | – | none | – | 否 | exit(fail?1:0) |

> `e2e-chat-mermaid` 原默认 `BASE_URL=5173(dev)`，但为拿到 React 18 基线，编排器用 preview(4173) 跑它（该脚本 dev/preview 均可，走整页重载导入，不依赖 Dexie liveQuery）。

### 依赖 antd 选择器的 23 个脚本（完整清单，mdui 迁移期会集体变红）

preview 档（19）：debug-import-perf、e2e-cards、e2e-chat-export、e2e-chat-frames、e2e-chat-image、e2e-chat-mermaid、e2e-chat、e2e-danmaku、e2e-handout-edit、e2e-handout、e2e-import-insecure、e2e-import、e2e-mobile、e2e-player-enhance、e2e-quiz、e2e-resume、e2e-smoke、e2e-storage-card、motion-smoke
dev 档（4）：debug-player、debug-transcribe、e2e-live-subs、e2e-preview-fonts

---

## 二、基线运行结果汇总

运行序列：纯 Node → preview(4173) → dev(5173)；服务由编排器按需启停，端口占用则复用，跑完只关自起的。

| 服务 | 含义 | 通过 | 失败 | 跳过 | 小计 |
| --- | --- | --- | --- | --- | --- |
| none | 纯 Node（与 React/antd 无关） | 14 | 2 | 0 | 16 |
| preview | **React 18 权威基线**（读 dist） | 12 | 2 | 6 | 20 |
| dev | React 19/既有 dev 服务（非升级前基线） | 2 | 2 | 3 | 7 |
| **合计** | | **28** | **6** | **9** | **43** |

- 整体通过率（含跳过）：**65.1%**（28/43）。
- **权威 React 18 基线（仅 preview 档，排除 6 个需 key 跳过的）= 12 通过 / 2 失败**。
- 跳过 9 个 = 8 个硬/软依赖 `SF_KEY`（e2e-chat-frames、e2e-chat-image、e2e-chat、e2e-handout、e2e-quiz、e2e-smoke、debug-player、debug-transcribe）+ 1 个损坏（probe-mermaid，缺 `public/probe-mermaid.html`）。

---

## 三、升级前就已经是红的脚本（重点：判断 React 19 回归的唯一依据）

下面 6 个在本基线（React 18 / 当前 node_modules）下即失败。**升级后出现红灯时，先比对这份清单：命中即说明不是 React 19 引入的回归。**

| 脚本 | 服务 | 失败原因初判 | 类别 |
| --- | --- | --- | --- |
| render-handout-fixture | none | `ERR_MODULE_NOT_FOUND: Cannot find module 'src/utils/vtt'`（从 `src/handout/docx.ts` 经 Node 直跑，无法解析无扩展名 `.ts` 导入） | 脚本/环境过时（Node 直跑缺 TS 解析） |
| test-migration | none | `ERR_MODULE_NOT_FOUND: Cannot find module 'src/store/db'`（同上，`src/store/migration.ts` 的无扩展名导入） | 脚本/环境过时 |
| e2e-mobile | preview | 断言「应有 3 个 panel-slot，实际 5」（移动端面板结构/测试期望不符，可能受进行中的 antd→mdui 改动影响） | 真 bug / 脚本过时 |
| motion-components-test | preview | `.t-text-swap` 等待超时（#/motion-test 路由未渲染出动效组件） | 页面/路由缺失或未挂载 |
| e2e-frames-hires | dev | `视频加载失败`：`fetch('/.tmp-frames.mp4')` 404，缺测试 fixture 视频 | 环境缺 fixture |
| e2e-preview-fonts | dev | **假红**：20 项断言全过(20 passed,0 failed)，但因捕获到 antd6 弃用 `console.error`（`[antd: Alert] message is deprecated`）被计入 errors → exit 1 | 脚本误判（antd6 弃用警告当错误） |

备注：
- `e2e-frames-hires`、`e2e-preview-fonts` 跑在 5173 既有 dev 服务上；其失败原因（缺 fixture / antd 弃用警告）均与 React 版本无关，即便该 dev 服务是 React 18 也照红。
- `e2e-preview-fonts` 是「假红」——功能断言全过，只是把 antd 的 `console.error` 警告当失败。迁移到 mdui 后该警告消失，反而可能变绿。
- `render-handout-fixture` / `test-migration` 的失败是 **Node 直接执行 TS 时无法解析无扩展名导入**（其余 14 个纯 Node 脚本不触发此问题所以通过）。若日常靠 vitest/tsx 跑，请用对应 runner；用裸 `node` 跑这 2 个会稳定失败。

---

## 四、编排器用法

```
# 无需 key 的全量（跳过硬依赖 SF_KEY 的脚本）—— 本次基线用的就是这条
node scripts/e2e-all.mjs

# 含 key 的全量（需先 export SF_KEY=sk-...；否则 key 脚本会自然失败）
node scripts/e2e-all.mjs --with-key

# 只跑指定脚本
node scripts/e2e-all.mjs --only=e2e-import,e2e-mobile

# 正则过滤脚本名
node scripts/e2e-all.mjs --filter='^e2e-'
```

行为要点：
- 按 `none → preview → dev` 三批串行执行，同批内脚本串行（避免抢端口/抢 IndexedDB）。
- 自动判断并启动所需服务：`npm run preview`(4173) / `npm run dev`(5173)；**端口已占用则复用**，跑完只关自己启动的。
- 自动为需 `TEST_FILE` 的脚本注入可用视频：优先复用 `/tmp/wangke-test.mp4`(1.2MB)、`/tmp/e2e-live.mp4`(3MB)、`/tmp/wangke-mermaid-test.mp4`(610KB)；都没有才用 ffmpeg 现造。
- 单脚本超时：默认 300s，`e2e-smoke` 600s；超时强杀并记 failed。
- 退出码：有 failed 则非 0。
- 产出：`scripts/.cache/e2e-report.json`（机读）+ `scripts/.cache/e2e-report.md`（人读，含失败脚本末 20 行）。
- 约束遵守：仅用 `node:` 内置 + `playwright`；**从不 build，只读 `dist/`**；不修改 `src/`/`package.json`。

> 建议后续：把 `render-handout-fixture`/`test-migration` 改成经 tsx/vitest 运行（或补 `.ts` 扩展名），并把 `e2e-preview-fonts` 的 `errors` 收集排除 antd 弃用类 `console.error`，可让基线更干净。
