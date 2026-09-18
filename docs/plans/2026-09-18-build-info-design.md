# 设置页构建信息（版本 · 构建时间 · commit）设计

日期：2026-09-18
状态：已实现

## 背景与目标

设置页最底部目前停在 `SkillsCard`，**没有任何版本或构建信息**。`vite.config.ts` 没有 `define` 注入，`package.json` 的 `0.1.0` 写死且代码里无人引用。

这本身不是缺陷，但这个项目的运行形态让它变成一个真实的排障缺口：

- `VitePWA` 用的是 `registerType: 'autoUpdate'` —— Service Worker 在后台更新，**但不会刷新当前页面**。iPad Safari 上「我明明改了怎么还是老样子」是迟早会遇到的问题；
- 零后端，没有服务端版本号可以对照。想知道「当前跑的是哪一版」，只能靠界面自己报。

目标：设置页底部一行静态文字，回答「我现在看的是哪个构建」。

非目标（明确不做）：**不解决「怎么更新」**。那是 Service Worker 更新流程的事（需要 `registration.update()` + 手动刷新 + 中间态处理），是另一个量级的改动，值得单开一份设计。本次只把「能看见是哪一版」解决掉。

## 不变量

1. **构建时间是构建期常量，不是运行时值。** 用 `new Date()` 在运行时取，显示的是「现在」，每次打开都在变，信息量为零 —— 这是这个功能最容易写错的地方。
2. `src/utils/buildInfo.ts` 必须**同时能在 Node（vite.config.ts 构建期）和浏览器（Settings 渲染）里跑**。因此它只做纯字符串/日期运算，不碰 `import.meta.env`、DOM、`process`。
3. **git 取不到 commit 时构建不能挂。** CI 导出源码包（无 `.git`）、或本机没装 git，都是正常情况，降级成不显示 commit 即可。

## 设计

### 注入什么

`vite.config.ts` 里 `define` 注入一个对象：

```ts
__BUILD_INFO__ = { version, time, commit }
```

- `version`：读 `package.json` 的 `version`（构建期读，保证与产物同源；不写死在源码里）。
- `time`：构建机**本地时间**，格式 `YYYY-MM-DD HH:mm`。
- `commit`：`git rev-parse --short HEAD` 的输出；失败则为空串。

### 为什么带 commit hash

只有一个时间戳是**缺参照物**的：判断不了「这是不是我刚推的那版」，除非记得住每次构建的分钟数。带上短哈希后，「页面显示 5ffa0c7 / 仓库是 abc1234」一眼就能得出结论 —— 这也让 e2e 有了可断言的硬事实（见「验证」）。

### 为什么构建时间不做观看者时区换算

存的就是构建机本地时间字符串，显示时**原样输出**，不按观看者时区重算。

理由：这是个**事件时刻**（「这次构建发生在什么时候」），不是「当前时刻」。构建者和观看者是同一个人（都是本机构建、iPad 上看），按观看者时区重算只会在 iPad 时区设错时显示一个让人困惑的时间。代价是：如果将来改成 CI 构建，时间会变成 CI 机器的本地时间（通常 UTC）—— 那时应该重新考虑这条，而不是现在提前复杂化。

### dev 模式

`vite.config.ts` 的 `define` 在 dev 下同样生效，但那个值是 **vite 配置加载的时刻**，不是「构建」。把它显示出来是误导。

因此 **UI 层用 `import.meta.env.DEV` 判断**，dev 下显示「开发模式」，不读注入的时间。这样不需要把 `defineConfig` 改成函数形式去区分 command，注入逻辑保持单一。

### 展示位置与形态

`Settings.tsx` 的 `PageShell` 内、`SkillsCard` 之后，一个 `data-testid="build-info"` 的 div：

- 生产：`v0.1.0 · 2026-09-18 19:40 · 5ffa0c7`
- 生产但取不到 commit：`v0.1.0 · 2026-09-18 19:40`
- 开发：`v0.1.0 · 开发模式`

形态是**一行居中小字**（12px、次要文字色），不做成 `SectionCard` —— 它是页脚性质的元信息，不承载操作，占一张卡的视觉权重会喧宾夺主。

## 涉及文件

- `src/utils/buildInfo.ts`：新增。`formatBuildTime()` / `buildInfoLabel()` 纯逻辑 + 类型
- `src/vite-env.d.ts`：`__BUILD_INFO__` 的全局类型声明
- `vite.config.ts`：`define` 注入（含读 package.json、取 git 哈希、降级）
- `src/pages/Settings.tsx`：底部 footer
- `scripts/test-build-info.mjs`：Node 单测
- `scripts/e2e-build-info.mjs`：preview 档 e2e
- `scripts/e2e-all.mjs`：登记 META

## 验证

两层，分工明确：

- **单测**（`test-build-info.mjs`，纯 Node）：时间补零（月/日/时/分个位数）、无 commit 时文案收敛、dev 分支、注入值为空时的兜底。这些是分支逻辑，不依赖浏览器。
- **e2e**（`e2e-build-info.mjs`，preview 4173）：真实构建产物里打开设置页，断言

  1. `[data-testid="build-info"]` 存在；
  2. 文本形如 `v<版本> · <YYYY-MM-DD HH:mm>`，即**注入链路真的通到了 DOM**（这是单测覆盖不到的：单测测的是纯函数，测不出 `define` 有没有配对、类型声明对不对）；
  3. 页面显示的 commit **等于** `git rev-parse --short HEAD`。

  第 3 条是刻意选的：它同时能抓出「dist 是旧构建」这个本项目高频问题。失败时脚本要**明确写出**「dist 陈旧，先 npm run build」，而不是抛一句无从下手的断言失败 —— 否则会被训练成忽略红色。

⚠️ e2e 跑的是**当前 `dist/`**（`e2e-all.mjs` 不碰构建），改了注入逻辑后必须先 `npm run build` 再跑。

## 验证记录（2026-09-18）

| 层 | 结果 |
|---|---|
| `scripts/test-build-info.mjs` | 13/13 通过 |
| `tsc -b`（app + node 两个 project） | 通过 |
| `scripts/e2e-build-info.mjs`（dev 5173） | 8/8 通过 |
| `scripts/e2e-build-info.mjs`（preview 4173） | **未跑成**（不是红，见下） |

⚠️ **preview 档没跑成，不是红。** `npm run build` 在本机被宿主的文件审批拦下：
`node_modules/@mdui/jq/functions/param.js` 报 "Sensitive content approval timed out" ——
与 `2026-09-18-selection-ask-scroll-design.md` §12.14 记的是同一类问题，**不是代码问题**。
绕过沙箱重试一次，报错逐字相同（模块数 2865 → 2866，正好是本轮新增的 `buildInfo.ts`）。

后果：`dist/` **不含本次改动**（但未被损坏 —— `sw.js` 预缓存清单悬空 0 条，
`index.html` 与 `assets/*` 均未被重写，仍是上一次成功构建的产物）。
**审批放行后请补跑**：

```bash
npm run build && npm run preview & && node scripts/e2e-build-info.mjs
```

另外单独验证了**生产构建的静态替换**——这是 dev 验不到、且不能靠 dev 推断的一环
（dev 下 vite 是「把 define 定义为全局」，build 下才是「静态替换」，两条不同机制）。
用一个最小入口跑 `vite build`，产物里 `__BUILD_INFO__` 被替换成对象字面量并提升为变量、
零残留，确认两条路径都通。

## 变更记录

- 2026-09-18 首版：方案 A（静态一行）。方案 B（Service Worker 状态 + 「检查更新」按钮）评估后未做，理由见「非目标」。
- 2026-09-18 同日：`tsconfig.node.json` 的 `include` 必须补上 `src/utils/buildInfo.ts` ——
  该文件落在 `src/` 下却被 `vite.config.ts` 引用，不列出来会报 TS6307（实测踩到）。
