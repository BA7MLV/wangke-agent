# UI/UX 迁移到 mdui（Material Design 3）设计

日期：2026-09-10
状态：**阶段 0、1、2 已落地，并完成 Material You 保真度补强**（阶段 0 见「九」，阶段 1 见「十」，阶段 2 见「十一」，保真度见「十二」）；阶段 3~5 待实现

## 背景与目标

现状：三页（Library / Player / Settings）+ 播放页面板，UI 层是 `antd 6.6.2` + `@ant-design/x 2.9.0`，20 个文件、约 6100 行 TSX、约 2800 行 CSS。

目标：把视觉与交互语言整体换成 [mdui 2](https://www.mdui.org/zh-cn/docs/2/)（基于 Material Design 3 的 Web Components 组件库，50+ 组件、动态取色、内置深色模式），并**按 MD3 重排信息架构**（不是等量替换 antd 组件）。

已确认的路线：

1. 先建适配层，试点一页跑通，再逐页放量（不做一次性全量重写）。
2. 换骨：按 MD3 骨架重排页面（TopAppBar / NavigationBar / FAB / Drawer / BottomSheet）。
3. 先升级 React 19 —— 因为实测它能把 Web Components 的绑定税砍掉大半（见「二」）。

## 一、资产盘点（迁移前必须知道的三件事）

| 项 | 实测结论 | 影响 |
| --- | --- | --- |
| `@ant-design/x-markdown` | `peerDependencies` 只有 react/react-dom，`dependencies` 是 clsx / dompurify / html-react-parser / katex / marked，**不依赖 antd** | 流式 markdown + mermaid 渲染链（围栏闭合判定、`htmlLabels` 中文换行、`render()` 串行化、DOMPurify 禁用策略）**原封不动保留**，这是迁移中最大的好消息 |
| `@vidstack/react` | 与 antd 无耦合，peer 为 `react ^18 \|\| ^19` | 播放器完全不动 |
| CSS 层 | 约 2800 行里，直接引用 `.ant-` 类的只有 **14 处**（theme.css 13 + cards.css 1） | 样式层耦合极轻，可平滑迁移；硬编码色值（`#f5f5f5` / `#fff` / `#f0f0f0`）改为 mdui 设计令牌 |

必须替换的：`@ant-design/x` 的 `Bubble` / `Sender`（peer 依赖 `antd ^6.1.1`）。二者只是布局容器，用 `mdui-card` + `mdui-text-field` + `mdui-button` 自搭即可。

### 回归安全网的风险

43 个 `scripts/*.mjs` 里，**23 个**用 antd 的 DOM 结构或类名定位元素（`.ant-space-compact button`、`[role="tabpanel"]`、`.anticon-*` 等）—— 原写 24，阶段 0 逐脚本复核后修正为 23，完整清单见 `docs/plans/2026-09-10-mdui-phase0-e2e-baseline.md`。这些脚本是抓「字幕不居中」「幽灵字幕轨」这类隐蔽缺陷的网。**迁移中期它们会集体变红，等于拆掉安全网做手术**，必须逐页改造、同步改脚本、跑绿再进下一页（见「六」）。

## 二、阶段 0 可行性验证结论（已实测）

验证装置：`/Users/ba7mlv/.workbuddy/binaries/node/workspace/mdui-check/`（React 18 与 React 19 两个对照工程 + Playwright 驱动脚本，可重复执行）。

### 2.1 React 19 让 Web Components 的绑定税大幅下降

mdui 是 Web Components，官方文档只给 `ref + addEventListener` 一种写法。实测 React 18 与 React 19 的差异：

| 写法 | React 18 | React 19 |
| --- | --- | --- |
| `<mdui-button onClick={fn}>` | 触发 | 触发 |
| `<mdui-button ref>` + `addEventListener('click')` | 触发 | 触发 |
| `<mdui-switch onChange={fn}>` | **不触发** | 触发 |
| `<mdui-checkbox onChange={fn}>` | **不触发** | 触发 |
| `<mdui-text-field onInput={fn}>` | 触发 | 触发 |
| `<mdui-text-field onChange={fn}>` | **不触发** | 触发 |
| `<mdui-dialog onopened={fn}>`（**全小写**） | **不触发** | 触发 |
| `<mdui-dialog onOpened={fn}>`（驼峰） | 不触发 | **不触发** |
| `<mdui-dialog onOpen={fn}>`（驼峰） | 不触发 | **不触发** |
| `<mdui-dialog ref>` + `addEventListener('opened')` | 触发 | 触发 |

绑定规则（实测得出，与文档不一致，以实测为准）：

1. React 19 会为自定义元素上的 `on*` prop 调用 `addEventListener`，但事件名取 **prop 去掉 `on` 后的原样字面量，不做驼峰转换**。所以只有**全小写**写法有效：`onopened` ✅ / `onOpened` ❌。多词事件同理（`overlay-click` 对应 `onoverlay-click`）。
2. React 18 完全不支持自定义元素的自定义事件，只有标准委托事件（click / input）能生效，`change` 都不行。
3. 结论：**标准名事件（click / change / input）声明式写；mdui 自定义名事件一律走 `ref + addEventListener`**，驼峰写法不要用。

### 2.2 React 19 会把值写成 JS property，React 18 只写 attribute

| 探针 | React 18 | React 19 |
| --- | --- | --- |
| `<mdui-switch defaultChecked={true}>`（只有 JS property、无对应 HTML 属性） | `defaultChecked === false`（**未生效**） | `defaultChecked === true`（生效） |
| `<mdui-text-field value={v}>` 变更后 | property 与 attribute 都更新 | **只更新 property，不写 attribute** |

影响：只在 JS property 上存在的取值（`defaultChecked`，以及将来传入对象/数组的 prop）在 React 18 下无法声明式使用；React 19 正常。反过来说，React 19 下**不要再依赖 attribute 做受控值**。

### 2.3 mdui 官方 JSX 类型声明在 React 19 下失效（必须自建）

mdui 的 `jsx.zh-cn.d.ts` 用的是全局增强：

```ts
declare global { namespace React { namespace JSX { interface IntrinsicElements { 'mdui-xxx': {...} } } } }
```

- React 18：生效，`<mdui-button>` 等标签有完整类型。
- React 19：**也生效**（已复核）。机制：`@types/react` 的 `index.d.ts` 里有 `export = React; export as namespace React;`，
  `export as namespace` 把 `React` 暴露成 **UMD 全局**，而 UMD 全局命名空间**可以从模块内被 `declare global` 增强**，
  且 `React.JSX` 在「模块」与「全局」两个视角下是同一份声明，所以增补落到了正确的位置。
- 会真正卡住的是 `ref`，见上方修正说明。

补救（阶段 0 的交付物之一）：自建 `src/types/mdui-jsx.d.ts`，用模块增强写法把 mdui 的标签声明并进 React 19 的 JSX 命名空间：

```ts
import type { DetailedHTMLProps, HTMLAttributes } from 'react';

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'mdui-button': DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
        variant?: 'elevated' | 'filled' | 'tonal' | 'outlined' | 'text';
        disabled?: boolean;
        loading?: boolean;
        // ...
      };
      // 其余组件按需补齐，可直接从 mdui/jsx.zh-cn.d.ts 摘取字段定义
    }
  }
}
```

另：mdui 的官方类型**不含自定义事件**（连 `onOpened` 都没有），所以自定义事件的类型也要一并自建 —— 这也正是「自定义事件统一走 `ref + addEventListener`」的一个额外理由：类型和运行时行为一致，不依赖未定义行为。

### 2.4 React 19 与现有依赖共存实测（真实版本，非纸面判断）

在 React **19.3.0** 下同时加载项目真实的依赖副本（不复制代码，直接指向项目 `node_modules`），实测结果：**零控制台错误，全部正常挂载**。

| 依赖 | 版本 | 结果 |
| --- | --- | --- |
| react / react-dom | 19.3.0 | 页面运行时确认 `React.version === 19.3.0` |
| antd | 6.6.2 | Button（渲染为 `确 定`，两字按钮插空格的既有现象照旧）、Card、Progress、Segmented、Tabs、**Modal（点击可打开，`role="dialog"` 出现）** |
| @ant-design/x | 2.9.0 | `Bubble` 内容正常、`Sender` textarea 正常 |
| @ant-design/x-markdown | 2.9.0 | markdown 渲染出 `<h1>标题</h1>` |
| @vidstack/react | 1.15.6 | 播放器完整初始化（`data-media-player` / `data-media-type="video"` / `data-load="visible"`） |
| mdui | 2.1.5 | 自定义元素全部注册成功并渲染 |

peer 范围也全部放行：antd 6 / x / x-markdown 均为 `react >=18.0.0`，vidstack 为 `^18 || ^19`。

顺带记录：antd 6 的 Modal 容器类是 `.ant-modal-container`（不是 antd 5 的 `.ant-modal-content`），e2e 脚本如按类名定位需注意。

### 2.5 组件缺口盘点

用到的 antd 组件约 28 种（Button / Space / Typography / Progress / Tag / Modal / Input / Card / Tooltip / Segmented / Popconfirm / List / Alert / Select / Form / Empty / Checkbox / Upload / Tabs / Switch / Spin / Radio / Popover / Dropdown / InputNumber / AutoComplete / ConfigProvider / App）。

| 类别 | 组件 |
| --- | --- |
| mdui 直接有对应 | Button / ButtonIcon / Card / Dialog / Tooltip / Dropdown + Menu / Select / TextField / Switch / Checkbox / Radio + RadioGroup / Tabs + Tab / List + ListItem / Chip（替 Tag）/ SegmentedButton / Badge / Avatar / Collapse / Divider / LinearProgress + CircularProgress（替 Progress、Spin）/ Snackbar（替 message）/ Layout + TopAppBar / NavigationBar / NavigationRail / NavigationDrawer / Fab |
| 需要自建（约 6 个） | Upload 拖拽区、AutoComplete、Form 校验编排、Popconfirm（`confirm()` 函数基本够用）、Empty、Typography（用 `mdui-prose` 类 + 设计令牌） |
| 无等价物但有替代路径 | ConfigProvider（locale 用 `setLocale('zh-cn')`，主题用设计令牌）、App 的 message/notification（用 `snackbar()` 函数） |

## 三、MD3 信息架构（换骨方案）

### 3.1 页面骨架映射

**Library（首页）**
- `mdui-top-app-bar`（标题 + 搜索/导入 action）
- 课程列表：`mdui-list` + `mdui-list-item`（移动端）/ `mdui-card`（宽屏网格）
- 主操作：`mdui-fab`（导入课程）——antd 的「上传」入口从页面中部移到右下角 FAB
- 底部导航：`mdui-navigation-bar`（首页 / 设置），宽屏退化为 `mdui-navigation-rail`
- 空状态：自建 Empty（MD3 风格插画 + 主操作按钮）

**Player（播放页）**
- `mdui-top-app-bar`（返回 + 课程标题 + 溢出菜单：设置/导出/删除）
- 播放器区域保持 vidstack 不变
- 面板切换：`mdui-tabs`（字幕 / 讲义 / 卡片 / 问答 / 弹幕）
- 面板容器：窄屏用底部抽屉（BottomSheet 形态的 `mdui-navigation-drawer` 或自建）+ 拖拽把手；宽屏用常驻分栏
- 既有键盘拦截逻辑（按 `PLAYER_KEY_RE` 白名单拦 `onKeyDownCapture`）需要重新验证：mdui 的 Dialog / Drawer 也会把自己的键盘监听挂在 document 上

**Settings（设置页）**
- `mdui-top-app-bar` + `mdui-list` + `mdui-list-item`（右侧 `mdui-switch`）
- 数值型设置用 `mdui-slider` / `mdui-text-field`
- 危险操作确认：`mdui-dialog` 或 `confirm()` 函数（替 Popconfirm）

### 3.2 主题与设计令牌

- `theme.css` 里的硬编码色值（`#f5f5f5` / `#fff` / `#f0f0f0`）全部替换为 mdui 设计令牌（`--mdui-color-surface*` / `--mdui-color-on-surface*` 等），深色模式因此近乎白送。
- 字体、圆角、间距同样改走令牌（`--mdui-shape-corner-*`、`--mdui-typescale-*`）。
- 进阶（可选）：用 `getColorFromImage()` 从课程封面提取主色 → `setColorScheme()` 让整个应用的配色随课程变化。这是 antd 方案做不到、且对网课场景体验提升明显的一点。
- 需要保留的自定义令牌：`--vvh`（`useMobileGlobals` 同步 visualViewport 高度，用于键盘弹出时收缩页面）继续保留，接在 mdui Layout 容器上。

## 四、适配层设计（阶段 0 交付物 → 已按此实现，实际 API 以本节为准）

目录：`src/ui/`（新）

1. **事件绑定 hook** —— `src/ui/useMduiEvent.ts`
   ```ts
   // 用法：const ref = useMduiEvent('mdui-dialog', 'opened', (e, el) => { /* el 是 Dialog */ });
   //       <mdui-dialog ref={ref} />
   export function useMduiEvent<Tag extends MduiTag, Name extends MduiEventName<Tag>>(
     tag: Tag,                       // 标签名以字面量传入，用来把 ref 收敛成具体元素类
     event: Name,                    // 事件名被约束为该标签真实支持的事件（写错编译失败）
     handler: (e: MduiElementEventMap[Tag][Name], el: MduiElementClassMap[Tag]) => void,
   ): RefObject<MduiElementClassMap[Tag] | null>;
   ```
   统一处理「挂载时 addEventListener / 卸载时 removeEventListener / handler 用 ref 保持最新」。
   自定义名事件（opened / closed / overlay-click / action-click …）一律走它 —— 对应地，
   **JSX 上不要写 `onOpened` 这类驼峰 handler，它静默失效**。
   实现细节：effect **故意不写依赖数组**，因为元素可能是本组件提交之后才挂上的（条件渲染 / 弹层懒挂载），
   没有依赖项能观察这件事；且先 remove 后 add 在同一次提交里同步完成，中间不可能有事件派发。
   *（原稿签名 `useMduiEvent<T extends HTMLElement>(event, handler)` 无法工作：`T` 无法从事件名字面量推断，
   且 `extends HTMLElement` 约束会被 TextField 卡死 —— 见 2.3。）*

2. **受控值同步 hook** —— `src/ui/useMduiProperty.ts`
   ```ts
   // 把 React 的值写进 mdui 元素的 JS property（不是 attribute）
   export function useMduiProperty<T extends object, K extends keyof T>(
     ref: RefObject<T | null>, prop: K, value: T[K],
   ): void;
   ```
   用 `useLayoutEffect`（绘制前写入，避免先画默认值再跳变）、等值守卫（同值不写，不打断用户输入）。
   **约束刻意放宽成 `T extends object` 而非 `T extends HTMLElement`**，理由同 2.3。
   注意：React 19 已会把自定义元素上的属性写成 JS property，**多数场景直接用 JSX 属性即可**，
   只有「property 名与业务值不对应」「需要在提交后确定性再写一次」时才需要它。

3. **反馈 API 适配** —— `src/ui/feedback.ts`
   - `toast.info/success/warning/error(msg)`：替 antd `message.*`，底层 `snackbar()`，同队列串行、置顶（避开移动端底部 Tab 栏）。
     注意 mdui 的 snackbar **没有语义色变体**，四个方法外观一致，只有停留时长不同 —— 需要视觉区分时用页面内组件（如 `PersistentError`）。
   - `confirmDialog(opts): Promise<boolean>`：替 antd `Modal.confirm`（把 mdui `confirm()` 的 resolve/reject 收敛成布尔）。
   - `alertDialog(opts): Promise<void>`：替 `Modal.info/error`。

   > 原稿计划的「薄包装组件 `MduiButton` / `MduiDialog` / `MduiSnackbar`」**未实现，且不打算实现**：
   > 有了上面两个 hook 之后，直接写 mdui 原生标签（`<mdui-button onClick={...}>` 这类标准事件直接声明式写）
   > 已经足够简洁，再包一层会引入「包装组件 API 与 mdui 属性集不同步」的长期维护成本。
   > 若要恢复这个计划，请先给出一个 hooks 无法优雅解决的用例。

4. **类型声明**：`src/types/mdui-jsx.d.ts` + `src/types/mdui-elements.d.ts`，均由
   `scripts/gen-mdui-types.mjs` 生成（见 2.3），**请勿手改产物**。

5. **统一导入入口**：`src/ui/mdui.ts` —— 集中 `import 'mdui/mdui.css'`、按需注册 46 个自定义元素、
   配置中文语言包、再导出函数式 API（`snackbar` / `confirm` / `setTheme` / `getColorFromImage` …）。
   业务代码不要各自深链 `node_modules`。由 `src/main.tsx` 引入一次。
   入口 `src/ui/index.ts` 只导出 hook 与反馈 API，不 re-export 副作用模块。

## 五、落地顺序

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| 0 | 升 React 19（`package.json` + `@types`）+ 建 `src/ui/` 适配层 + mdui JSX 类型声明 + theme.css 令牌化（暂不换页面） | `tsc -b` 通过；现有 43 个 e2e 在 React 19 下全绿 —— **这是升级 React 的真正的门**，比任何 sandbox 测试都可靠 |
| 1 | 试点 Settings 页（470 行，交互最少）换成 MD3 骨架 | `e2e-storage-card` / `e2e-migration` 等涉及设置页的脚本改写并跑绿；确认适配层的写法手感 |
| 2 | Library 页（971 行）+ 全局骨架（TopAppBar / NavigationBar） | 相关 e2e 跑绿；移动端 e2e（`e2e-mobile.mjs`）跑绿 |
| 2 ✔ | **已完成（2026-09-10）**：Library 整页换 MD3 + 窄屏底部 `mdui-navigation-bar`；顺带修掉了 10.6 记录的内置技能重复竞态。见「十一」 | `e2e-mobile` 已转绿；全量无 key 套件零新增回归 |
| 2.5 ✔ | **Material You 保真度补强（2026-09-10）**：Roboto 字体 / Material Symbols 图标 / 去掉列表分隔线 / 深色模式 / 动态取色。见「十二」 | 新增 `e2e-material-you`（18 条断言）全绿；全量零新增回归 |
| 3 | Player 页与各面板（SubtitlePanel / HandoutPanel / CardsPanel / DanmakuPanel / QuizCard 等） | 字幕相关 e2e（`e2e-live-subs` / `e2e-resume`）跑绿；键盘拦截回归 |
| 4 | ChatPanel 外壳（992 行，只换 Bubble/Sender 容器，**渲染管线不动**） | `e2e-chat*` / `e2e-chat-mermaid` 跑绿 |
| 5 | 移除 antd 依赖 | `grep -r "from 'antd'"` 为空；构建产物体积对比 |

每阶段结束都必须是「可运行、e2e 全绿」的状态，不允许出现中间态破坏主干。

## 六、e2e 迁移策略

1. **一律改用 `data-testid`**（这是项目里已经写进经验的更稳做法），不再依赖类名与 DOM 层级。新增/改写的测试优先 `data-testid`。
2. 选择器映射参考：
   | antd | mdui |
   | --- | --- |
   | `.ant-space-compact button` | `[data-testid="..."]` |
   | `[role="tabpanel"]:visible` | `[data-testid="panel-xxx"]`（mdui-tab-panel 有 `active` 属性可断言） |
   | `button:has(.anticon-setting)` | `[data-testid="btn-settings"]` |
   | `.ant-modal-container` | `mdui-dialog[open]` |
   | `.ant-message` | `.mdui-snackbar` 或 `[data-testid="snackbar"]` |
3. **一个页面一改，脚本同步改，跑绿再下一页**。禁止「先全改完再统一修测试」。
4. 涉及 headless 环境的注意：需要页面的测试走 `npm run preview`（4173，生产构建）；要在页面里拿应用同一份 Dexie 实例时走 dev（5173）。区分逻辑不变。
5. 顺带修一处历史包袱：两字中文按钮的「插空格」问题在 mdui 下不复存在（不是文字节点拼接），但仍建议统一用 `data-testid`。

## 七、风险与回滚

| 风险 | 说明 | 应对 |
| --- | --- | --- |
| React 19 升级引入回归 | 主要风险落在 antd 6 / @ant-design/x / vidstack 的运行时细节上（sandbox 实测通过，但真实应用的组合远更复杂） | 阶段 0 用现有 43 个 e2e 做门；不通过就不进入阶段 1，直接回退 `package.json` |
| e2e 安全网失效 | 24/43 个脚本依赖 antd 选择器 | 逐页迁移、同步改写、跑绿再进；绝不允许长期红着 |
| mdui 自定义事件命名坑 | 驼峰 prop 静默不触发（实测），容易写出「看着对但不工作」的代码 | 适配层统一收口；code review 检查 `on` + 大写字母的用法；自定义事件一律走 `useMduiEvent` |
| Shadow DOM 样式定制受限 | mdui 组件内部样式在 shadow root 内，只能改 CSS 自定义属性 / `::part()` | 只用官方暴露的 CSS 变量与 part；必要时用 `part` 选择器；**不要**试图用全局 CSS 覆盖内部类名 |
| 动态字幕 / 播放器相关回归 | 播放器不动，但其周围的 Tab 容器、键盘拦截、面板布局会变 | 阶段 3 单独验收；`e2e-live-subs` 是核心回归项 |
| 依赖体积变化 | mdui 按需导入后通常小于全量 antd，但两库并存期间会变大 | 阶段 4/5 后再做体积对比 |

回滚方式：每个阶段一个提交（或分支），阶段内任一 e2e 失败即回退该阶段。

## 八、待决问题

1. ~~阶段 0 结束后，React 19 是否保留？~~ **已决（2026-09-10）：保留。** 门禁通过且零新增回归（见「九.3」），
   无需走「React 18 + 全量 ref 适配层」的备选路线。（原先另列的第 4 问「自建类型的必要性」也已修正：
   卡点不是 JSX 命名空间而是 `ref` 类型，见「九.1」。）
2. Player 页窄屏的面板容器：用 `mdui-navigation-drawer`（modal 形态）还是自建 BottomSheet（MD3 规范里 BottomSheet 是独立模式，mdui 未提供该组件）。
3. ~~是否采用动态取色（课程封面取主色）。~~ **已决（2026-09-10）：采用。** 从抽帧里的幻灯片帧取主色，
   只作用在播放页根元素上，设置页有开关（默认开）。实现与已知不一致见「十二.3」。
4. ~~Material Symbols 图标字体体积与按需图标方案的取舍。~~ **已决（2026-09-10）：按需生成 SVG 图标元素，
   不引图标字体。**（原稿此处还把 `public/fonts` 下的 187 个 woff2 当成了图标字体 —— 那其实是讲义预览的朱雀仿宋分包，
   与图标无关，见「十」的订正。）做法见「十二.2 ②」。

---

## 九、阶段 0 实施记录（2026-09-10，已完成）

### 9.1 复核并推翻了原稿的一处错误结论

原稿 §2.3 断言「官方 `declare global { namespace React { namespace JSX } }` 写法在 React 19 下失效」。
**该断言不成立**，已用隔离工程（`/tmp/mdui-aug-check`：软链本仓 `node_modules`，一份全局增强探针 + 一份模块增强探针，
故意多写一个不存在的属性 `bar` 作为判别信号）复核：

- 两种写法都**生效**（都精确报出「`bar` 不存在」，说明增补确实落进了 JSX 的 `IntrinsicElements`）。
- 机制：`@types/react/index.d.ts` 有 `export = React; export as namespace React;` —— `export as namespace` 把 `React`
  暴露成 **UMD 全局**，而 UMD 全局命名空间**可以从模块内被 `declare global` 增强**；且 `React.JSX` 在「模块」与
  「全局」两个视角下是同一份声明，所以增补落到了正确的位置。

**真正必须自建类型的理由是 `ref`**：

- 官方把每个标签收尾成 `} & HTMLElementProps;`，而 `HTMLElementProps` 把 `ref` 定死为 `Ref<HTMLElement>`；
- mdui 部分元素类**结构上不可赋值给 `HTMLElement`** —— 实测 `TextField` 声明了 `autocorrect?: string`，
  而 lib.dom 的 `HTMLElement.autocorrect` 是 `boolean`，于是 `RefObject<TextField>` 连 `Ref<HTMLElement>` 都满足不了；
- 后果：`<mdui-text-field ref={r} />` 与任何接收 mdui ref 的泛型（含适配层 hook）**一律编译报错**。
- 修法见 9.2 生成物。**连带结论**：适配层 hook 的泛型约束不要写 `extends HTMLElement`（会被 TextField 卡死），
  `useMduiProperty` 用 `extends object`。

这个坑值得记一笔：**`"编译通过" 没能暴露它** —— 只有拿真实使用形态（探针里写 `<mdui-text-field ref>`）去试才会现形。
阶段 1 起每接入一个新页面，都应保留这种「先写探针再改页面」的动作。

### 9.2 交付物

| 文件 | 作用 |
| --- | --- |
| `scripts/gen-mdui-types.mjs` | 零依赖生成器（幂等，重复执行产物字节一致）。从已安装的 mdui 生成下面两个类型文件，升级 mdui 后重跑即可，避免手工类型漂移 |
| `src/types/mdui-jsx.d.ts` | 46 个 `mdui-*` 标签的 JSX 类型（生成物，勿手改） |
| `src/types/mdui-elements.d.ts` | `MduiElementClassMap`（标签→元素类）、`MduiElementEventMap`（46 标签 / **135 条事件，事件类型全部为真类型，0 条退化成 `unknown`**）、`HTMLElementTagNameMap` 全局增强（生成物，勿手改） |
| `src/ui/locale.ts` | 语言包：**必须最先执行**（`loadLocale` 未调用时 `setLocale` 抛 `uninitializedError`）；静态 import `zh-cn` 避免首次渲染多一次分包往返 |
| `src/ui/useMduiEvent.ts` | `useMduiEvent(tag, event, handler)`：自定义事件收口，返回收敛了元素类型的 ref |
| `src/ui/useMduiProperty.ts` | `useMduiProperty(ref, prop, value)`：把值写进 JS property（等值守卫，不打断输入） |
| `src/ui/feedback.ts` | `toast.*` / `confirmDialog` / `alertDialog`，替 antd `message` / `Modal.confirm` |
| `src/ui/mdui.ts` | 统一接入点：`mdui.css` + 46 个组件注册 + 语言包 + 函数式 API 再导出。由 `main.tsx` 引入一次 |
| `src/ui/index.ts` | 业务侧统一 import 入口（只出 hook 与反馈 API，不 re-export 副作用模块） |
| `scripts/e2e-mdui-adapter.mjs` | **阶段 0 验收脚本**（已接入 `scripts/e2e-all.mjs` 的 preview 档），见 9.4 |
| `src/main.tsx` | 改为 `mduiLocaleReady.finally(render)`。**不能用顶层 await**：`vite.config.ts` 的 `build.target` 是 `es2020` |

### 9.3 升级 React 19 的门禁结果：通过，且零新增回归

对照 `docs/plans/2026-09-10-mdui-phase0-e2e-baseline.md`（React 18 基线）：

| 档 | React 18 基线 | React 19 + mdui | 差异 |
| --- | --- | --- | --- |
| none（纯 Node） | 14 通过 / 2 失败 | 14 通过 / 2 失败 | 无 |
| **preview（权威档）** | **12 通过 / 2 失败** | **12 通过 / 2 失败** | 无 |
| dev | 2 通过 / 2 失败 | 2 通过 / 2 失败 | 无 |
| 合计 | 28 / 6 / 9 跳过 | 28 / 6 / 9 跳过 | 无 |

失败的 6 个与基线**完全同一批**（`render-handout-fixture`、`test-migration`、`e2e-mobile`、`motion-components-test`、
`e2e-frames-hires`、`e2e-preview-fonts`），即全部是升级前就已存在的问题，**没有一个是 React 19 或 mdui 引入的**。
最关键的回归项 `e2e-live-subs`（动态字幕 / 画面字幕居中）通过；`e2e-chat-mermaid` 通过（markdown + mermaid 管线未受影响）。

### 9.4 阶段 0 验收脚本（新增的常驻安全网）

`scripts/e2e-mdui-adapter.mjs` 断言 6 组共 13 项，preview 档与 dev 档均已跑绿：

1. **启动健康**：`#root` 已挂载、无 pageerror、无非 antd 类 `console.error`（antd 弃用警告属于既有噪声，排除——基线里
   `e2e-preview-fonts` 就是被它误判成红的）；
2. **React 版本**：dev 档 `import('/@id/react')` 取真实版本（＝19.3.0）；preview 档断言入口 bundle 含 `version="19.3.0"` 标记；
3. **46 个自定义元素全部已注册** —— 这是最值得守的一条：Web Components **漏注册是静默失败**，标签渲染成空白、不报错、不进控制台；
4. **设计令牌可用**（`--mdui-color-*` / `shape` / `elevation` / `typescale` 抽查，且颜色是 `R,G,B` 三元组形式）；
5. **未污染既有 antd 界面**：`html` 字号仍 16px、`#root` 背景仍是应用自有 `#f5f5f5`、`.page` 高度链未断、页面上仍有 `.ant-` 节点；
6. **中文语言包**（dev 档）：`getLocale() === 'zh-cn'` 且 `mduiLocaleReady` 已 resolve。

> 为什么 5 值得专门守：`mdui.css` 是全局样式表且会给 `:root` 挂 `color/background-color/color-scheme`。
> 经核它**没有全局元素 reset**（22.8KB 里顶层规则只有 `:root` 变量、`.mdui-*` 工具类、`mdui-*` 选择器），
> 但迁移期与 antd 并存，这条断言就是「还没换的页面观感不能被悄悄改掉」的守门员。

### 9.5 体积（两库并存期）

| 项 | React 18 基线 | React 19 + mdui | 变化 |
| --- | --- | --- | --- |
| 入口 JS | 2,895,320 B（gzip 893,915） | 3,317,803 B（gzip 993,259） | **+422KB / gzip +99KB（+14.6% / +11.1%）** |
| 入口 CSS | 91,604 B（gzip 17,702） | 114,306 B（gzip 21,131） | +22.7KB / gzip +3.4KB（增量≈`mdui.css` 全量） |

这是 antd 与 mdui **同时在场**的必然结果；阶段 5 移除 antd 后应显著回落。届时应重测并回填本表。

### 9.6 与原稿的偏差（有意为之）

1. **`theme.css` 令牌化推迟到阶段 1**。原稿把它列在阶段 0，但改色会**立刻改变还没迁移的 antd 界面观感**，
   与「阶段 0 暂不换页面」自相矛盾，也会污染升级门禁的对照基准。
2. **不做薄包装组件**（原稿 §4.3 的 `MduiButton` / `MduiDialog` / `MduiSnackbar`）。有了两个 hook 之后，
   直接写 mdui 原生标签已足够简洁，再包一层会引入「包装组件 API 与 mdui 属性集不同步」的长期维护成本。
   若要恢复该计划，请先给出一个 hooks 无法优雅解决的用例。
3. **`useMduiEvent` 签名调整**：原稿 `<T extends HTMLElement>(event, handler)` 无法工作（`T` 无法从事件名字面量推断，
   且约束会被 TextField 卡死）。实际为 `(tag, event, handler)`，用标签字面量换取完整的元素类型与事件名校验。

### 9.7 回退方式（已验证可用）

`.workbuddy/backup/phase0/` 下有三份材料，覆盖即回到 React 18 基线：

```
cp .workbuddy/backup/phase0/package.json.bak       package.json
cp .workbuddy/backup/phase0/package-lock.json.bak  package-lock.json
npm install
mv dist /tmp/dist-r19 && cp -r .workbuddy/backup/phase0/dist-react18 dist   # 或直接重建
```

`dist-react18/` 是 39MB 的完整产物备份，可瞬间恢复基线对照，不必依赖网络重装。

---

## 十、阶段 1 实施记录：设置页换成 MD3（2026-09-10，已完成）

### 10.1 交付物

| 文件 | 作用 |
| --- | --- |
| `src/ui/layout.tsx` + `layout.css` | MD3 骨架原语：`PageShell`（`.page` + `mdui-layout` + `mdui-top-app-bar` + 内容区）/ `SectionCard`（替 antd Card）/ `Field`（替 Form.Item 的纵向布局） |
| `src/ui/icons.ts` | 图标注册入口（`@mdui/icons`）。**只改这一个文件，然后重跑类型生成器** |
| `src/types/mdui-jsx.d.ts` | 生成物新增 9 个图标标签的 JSX 类型（`@mdui/icons` 自己不带 JSX 类型） |
| `src/pages/Settings.tsx` | 整页重写为 MD3（顶栏 + 分区卡片 + mdui 表单控件） |
| `src/components/StorageCard.tsx` / `MigrationCard.tsx` / `SkillsCard.tsx` | 同步迁移（三个卡片都在设置页上） |
| `scripts/e2e-settings-skills.mjs` | **新增**：技能列表 + 新建对话框交互（含「关掉又弹回」的回归断言） |
| `package.json` | 新增 `@mdui/icons@1.0.4` |

**新增依赖 `@mdui/icons` 解决了「八、待决问题 4」的图标悬案。** 顺带纠正原稿的一个误读：
`public/fonts` 下那 187 个 woff2 **全是讲义预览的朱雀仿宋分包**，与 Material Symbols 无关；
`mdui-icon name="xxx"` 走的是 Material Icons **字体**，本项目没有那个字体，会渲染成文字。
`@mdui/icons` 每个图标是一个渲染内联 SVG 的自定义元素（`mdui-icon-arrow-back`），不依赖字体、不联网、可 tree-shake。

### 10.2 mdui API 的坑（本阶段实测，构建与类型检查都抓不到）

按踩到的顺序记录 —— **后续阶段请先读这一节**：

1. **`mdui-list-item` 没有 `headline` 命名插槽**，但官方 JSX 注释里写着「也可以通过 `slot="headline"` 设置」。
   实现里命名插槽只有 `description` / `end-icon`（`headline` 只是默认插槽的 `part` 名）。
   写成 `slot="headline"` 的内容会被**静默丢弃** → 存储卡片的五个分类名整列不渲染、技能行只剩按钮。
   标题走**默认插槽**。
2. **`mdui-list-item` 的 `custom` 插槽是覆盖式的**：源码是 `<slot name="custom">…整套预设内容…</slot>`，
   只要放一个 `slot="custom"` 的子元素，预设的 icon / headline / description / end-icon **全部不再渲染**。
   所以「标题 + 描述 + 开关 + 两个按钮」这种行不能靠预设布局拼，只能自建那一行。
3. **`mdui-layout-main` 的 `padding` 归 mdui 的布局助手管**：它用**内联样式**写
   `paddingTop/Right/Bottom/Left`（避让 `mdui-layout-item` 占的空间），内联优先级更高，
   写在类里的 `padding` 会被整个抹成 0。内容内边距要放到里面的 `.page-inner`。
4. **`mdui-top-app-bar` 默认 `position: fixed`，会让 `mdui-layout-item` 高度为 0**：
   布局助手靠 `item.offsetHeight` 量标题栏占位，里面塞个 fixed 元素就量成 0 → `main` 拿到的偏移也是 0，
   同时多出一截文档滚动（实测 `document.scrollHeight` 比视口多 64px）。
   **修法是把它改回文档流**（`position: relative`）—— 已实测文档树 CSS 能覆盖 `:host`。
5. **`mdui-top-app-bar` 的 `:host` 是 `flex: 0 0 auto`**，而父级 `mdui-layout-item` 是 flex →
   不显式 `width: 100%` 的话标题栏只有内容那么宽（实测 116px），背景与阴影盖不满整行。
6. **`mdui-card` 的默认变体没有背景色**（computed 是 `rgba(0,0,0,0)`），必须显式给 `variant`。
7. **`mdui-chip` 的 `variant` 只有 `assist` / `filter` / `input` / `suggestion`**（没有 filled / 语义色）。
   需要「危险/警告」这类语义时只能靠文字与颜色令牌，别指望 chip 变体。
8. **`mdui-text-field` 没有 `type="textarea"`**：多行的判定是 `rows > 1 || autosize`，给 `rows` 就行。
   另外它的 `invalidStyle` / `error` / `focusedStyle` 在 `.d.ts` 里是 **private**，
   官方注释写明「**该属性仅供 mdui 内部使用，当前 select 组件使用了该属性**」—— 不该依赖。
   错误态改用**覆盖设计令牌**（`--mdui-color-primary` / `--mdui-color-on-surface-variant` 指向
   `--mdui-color-error`），这是官方支持的定制方式。
9. **`mdui-dialog` 的 `close-on-esc` / `close-on-overlay-click` 默认 false**，而 antd 的 Modal 默认是 true。
   不显式打开就会出现「功能对等性悄悄丢失」：对话框只能靠按钮关。已显式打开。
10. **受控 `open` 必须接 `closed` 事件同步回 state**：mdui 自己响应 Esc / 点遮罩时只把 `open` 属性拿掉，
    React 的 state 不知道 → 下一次渲染又把 `open` 加回去，表现为「关掉又自己弹回」。
    `scripts/e2e-settings-skills.mjs` 里有这条的回归断言。

### 10.3 两条对后续阶段同样重要的通用结论

1. **文档树 CSS 优先于 shadow DOM 里的 `:host` 规则**，包括 `display` / `position` 这类同属性覆盖
   （实测：`mdui-card` 的 `:host{display:inline-block}` 与 `mdui-top-app-bar` 的 `:host{position:fixed}` 都被外部规则覆盖掉了）。
   所以宿主布局属性可以放心用普通 CSS 调整；**改不到的只有 shadow 内部**（那部分走 CSS 变量与 `::part()`）。
2. **mdui 的 shadow root 是 `open` 的**，**Playwright 的 CSS 选择器会穿透 shadow DOM**：
   `[data-testid="rate-input"] input` 能直接 fill 到 `mdui-text-field` 内部的 `<input>`，
   `[data-testid="rate-chip-1.25x"] mdui-icon-clear` 能点到 `mdui-chip` 内部的删除图标。
   这意味着 e2e **不需要**为了组件库改写成 `evaluate` 注入值，按 testid + 内部标签即可。

### 10.4 e2e 的同步改动（迁移纪律：改一页 → 同步改脚本 → 跑绿）

| 脚本 | 改动 |
| --- | --- |
| `e2e-player-enhance.mjs` | 第 8 步（设置页自定义倍速）全部改 `data-testid`；`isDisabled()` 换成读 `.disabled` 属性（mdui-button 的 disabled 是反射 attribute 的自定义元素，`isDisabled()` 不可靠） |
| `e2e-storage-card.mjs` | 改 `data-testid`；**新增两条回归断言**：每个分类行必须有中文标签（守住 10.2.1 那个坑）、必须有体积数字 |
| `motion-smoke.mjs` | 等 `[data-testid="api-key"]` 宿主而不是 `input[type="password"]`（真实 input 在 shadow DOM 里）；点按钮改 testid；**新增**：错误态必须把 `--mdui-color-primary` 换成 error 色（红框原来由 antd 的 `status="error"` 提供） |
| `e2e-settings-skills.mjs` | **新增**（见 10.1） |
| `src/pages/Player.tsx` / `Library.tsx` | 各加一个 `data-testid`（`nav-back` / `nav-settings`）—— 迁移期同一功能的标签在 antd 页与 mdui 页不同，只有 testid 跨页面稳定 |

`transitions.css` 的动效钩子（`.t-input` / `.t-input-wrap` / `.t-error-msg` / `.is-shaking`）**原样保留**：
它本身就是与 UI 库无关的插值层，注释里也写明「边框颜色由业务侧提供」——迁移只需把颜色从 antd 的
`status="error"` 换成设计令牌。

### 10.5 与原稿的有意偏差

1. **设置页用「分区卡片」而不是 `mdui-list` + `mdui-list-item`**（原稿 §3.1 的设想）。本站内容形态是
   四个模型输入框、滑块、分段按钮、勾选列表、表格化的存储明细 —— 列表项预设布局装不下，
   硬套只会到处碰到 10.2.2 那个覆盖式 `custom` 插槽。
2. **模型输入框不是自建的 combobox**，而是「自由输入 + 按需展开的可筛选列表」：输入框仍是唯一值来源
   （粘贴任意模型 id 的行为不变），列表用 `mdui-list` 而不是绝对定位的弹层 ——
   手机上不必担心 popover 被软键盘顶飞或定位漂移。`AutoComplete` 的完整等价物仍是缺口（见 10.7）。
3. **三个卡片也一并迁移了**（原本可留到后续）：它们都在设置页上，只迁页面会让同屏出现两套视觉语言。

### 10.6 顺带发现的一处既有问题（**不在本阶段修**）

**dev 下内置写作技能会重复一整套**（实测：dev 12 行 / 生产构建 6 行，名字两两重复）。
根因是 `src/skills/store.ts` 的 `ensureBuiltinSkills()` 是「先查后插」的竞态：
React StrictMode 在 **dev** 下会把 `useEffect` 触发两次 → 两次并发调用都查到空 → 各插一遍。
与本次迁移无关（该文件未被改动；迁移前的生产构建同样是 6 行）。
修法是给 `ensureBuiltinSkills` 加一个模块级 in-flight Promise 守卫。
**没有顺手改**：阶段 1 的 diff 应保持只含迁移本身，便于 review 与回退。

> **已修（2026-09-10，阶段 2 开头）**：加了模块级 in-flight Promise 守卫，并把整个补齐过程放进
> 一个 rw 事务（IndexedDB 会串行化同库的 rw 事务，跨调用也能兜住）。
> 同时新增常驻回归脚本 `scripts/e2e-skills-dedupe.mjs` —— **它只能跑 dev 档**，
> 因为这个 bug 只在 StrictMode 下显形，跑 preview 的断言没有牙齿（详见「十一.4」）。

### 10.7 本阶段未被 e2e 覆盖的部分（与原因）

- **模型收藏夹**（`mdui-tabs` + 勾选列表）：只有 `listModels()` 成功返回后才会渲染，
  需要真实 API key → 无法在无 key 的套件里跑到。改由阶段 3 的带 key 用例覆盖，或补一个自播种版本。
- **导入迁移包对话框**：需要一份真实的迁移 zip 才能走到「预览 + 确认导入」。
- `mdui-dialog` 的**点遮罩关闭**只做了人工核对，e2e 只断言 Esc 路径。

### 10.8 阶段 1 测试结果

| 项 | 结果 |
| --- | --- |
| `tsc -b` | 通过 |
| `vite build` | 通过；主包 3,317,803 → **3,226,530** B（gzip 993,259 → **980,490**）—— 设置页去掉 antd 后树摇掉了一批模块，抵消并超过了图标包的增量 |
| `e2e-mdui-adapter` / `e2e-storage-card` / `motion-smoke` / `e2e-player-enhance` / `e2e-settings-skills` | 全部 ✅ |
| 全量无 key 套件 | **30 通过 / 6 失败 / 9 跳过**（45 个，通过率 66.7%） |

失败的 6 个与阶段 0 基线（`docs/plans/2026-09-10-mdui-phase0-e2e-baseline.md` 第三节）**完全同一批**：
`render-handout-fixture`、`test-migration`（Node 直跑无法解析无扩展名 `.ts` 导入）、
`e2e-mobile`（panel-slot 期望 3 实际 5）、`motion-components-test`（`#/motion-test` 路由未渲染）、
`e2e-frames-hires`（缺 fixture 视频）、`e2e-preview-fonts`（antd 弃用警告被误判为错误）。
**没有一个是阶段 1 引入的**；脚本总数从 43 增至 45（多出的两个是本阶段新增且都通过）。
设置页相关的三条链（存储卡片 / 动效 / 自定义倍速）与核心回归项 `e2e-live-subs` 均为绿。

---

## 十一、阶段 2 实施记录：Library 换成 MD3 + 全局骨架（2026-09-10，已完成）

### 11.1 交付物

| 文件 | 说明 |
| --- | --- |
| `src/pages/Library.tsx` | 整页重写（原 971 行 antd → MD3）。业务逻辑逐行保留，只换壳 |
| `src/ui/layout.tsx` | `PageShell` 新增 `wide`（860 内容宽）与 `bottomNav`；新增 `EmptyState`、`Banner` 两个原语 |
| `src/ui/layout.css` | 新增：投放区 / 导入任务行 / 分组头 / 视频行 / 拖拽卡片 / 空状态 / 提示条 / 底部导航 / 危险确认按钮 |
| `src/ui/feedback.ts` | `confirmDialog` / `alertDialog` 改为直接调 mdui 的 `dialog()`（见 11.2），新增 `danger`、`copyText` 选项 |
| `src/ui/icons.ts` | 新增 14 个图标（drag-indicator / play-circle / more-vert / folder(-open) / create-new-folder / link / settings / expand-more / chevron-right / warning / close / cloud-upload / home） |
| `scripts/e2e-library.mjs` | **新增**：首页自身交互回归（31 条断言，见 11.5） |
| `scripts/e2e-skills-dedupe.mjs` | **新增**：内置技能补齐幂等性（**只能跑 dev 档**，见 11.4） |
| `src/theme.css` | 删掉随 Upload.Dragger 一起失效的三条死规则 |

### 11.2 mdui API 的坑（本阶段新增，同样是构建与类型检查都抓不到的）

1. **`mdui-navigation-bar` 的 `:host` 也是 `position: fixed`** —— 与阶段 1 的 `mdui-top-app-bar` 是**同一个坑的第二次出现**：
   父级 `mdui-layout-item` 高度被量成 0 → 布局助手给内容区补的 `padding-bottom` 也是 0 → 列表最后一段被导航栏盖住。
   实测（390px 视口）：不覆盖时 `item.offsetHeight = 0`、`main` 的 padding 只有 `64px 0 0 0`；覆盖 `position: relative` 后变成 `64px 0 0 80px`。
   > **可推广的判据**：任何 mdui 组件只要 `:host` 是 `position: fixed`（top-app-bar、navigation-bar…），
   > 放进 `mdui-layout-item` 就必然量不到高度，必须外部把它拉回文档流。
2. **`mdui-navigation-bar-item` 的图标必须走插槽**：`icon` / `active-icon` **属性**的值是 Material Icons 字体里的字形名，
   本项目没装那个字体 → 会渲染成文字。而 shadow 里的 `::slotted([slot=icon])` 会给插槽元素 `font-size: inherit`（= 16px），
   外层再包一层 span 的话图标就只有 16px —— 需要在自定义 CSS 里把 `.bottom-nav [slot='icon']` 的 `font-size` 补回 `1.5rem`。
   （外层文档树的规则优先于 `::slotted()`，这条覆盖生效。）
3. **`mdui-navigation-bar-item` 的 `active` 不在官方 JSX 类型里**（官方 `jsx.zh-cn.d.ts` 是手写的，落后于 `custom-elements.json` 的 `attributes`）。
   而且**不需要自己传**：`mdui-navigation-bar` 会按自己的 `value` 给各项打 `active`。
   > **教训**：官方 JSX 类型不是完整的属性清单，`tsc` 报「属性不存在」时先去 `custom-elements.json` 核对一遍再决定怎么做。
4. **`mdui-linear-progress` 的 `value` 未定义时是不确定态（indeterminate）** —— 正好一对一替掉 antd `Progress` 的 `status="active"`。
   用它的时候要记得 `max={100}`（`max` 默认是 `1`）。
5. **`mdui-dialog` 的 `headline` / `description` 渲染在 shadow DOM 里**：对宿主元素取 `innerText` 拿不到这两个字段。
   e2e 里要用能穿透 shadow 的文本定位（`locator(sel).getByText('...')`，Playwright 的文本引擎会穿透 open shadow root），
   或者直接读 `el.headline` 属性。`mdui-button[slot="action"]` 这些是 light DOM，`innerText` 正常。
6. **mdui 的 `dialog()` / `confirm()` 会自己 `new` 一个组件塞进 `body`，外面插不进属性** —— 所以没法给它们加 `data-testid`。
   解法：用 `dialog()` 的 `body` 选项塞一个零尺寸标记元素（`<span data-testid="confirm-dialog">`），
   再 `mdui-dialog:has([data-testid="confirm-dialog-danger"])` 定位；危险色则靠 `:has()` 选中最后一个 action 按钮后覆盖 `--mdui-color-primary`。
   > 顺带纠正一处认知：`dialog()` 的 action 回调 **返回 `false` 是「不关闭」**，返回 `undefined` 才关闭。
   > 「复制详情」按钮正是靠返回 `false` 实现「复制完不关窗」。
7. **`mdui-radio-group` / `mdui-text-field` / `mdui-menu` 的值都要从元素上读**：`change` / `input` 事件的 payload 是空的 `CustomEvent<void>`，
   真正可用的形态是 `useMduiEvent('mdui-radio-group', 'change', (_e, el) => setMoveTarget(el.value))`。
8. **`mdui-menu` 的菜单项用逐项 `onClick` 比绑 `change` 更稳**：`change` 依赖菜单的单选语义（`selects`），
   而 `click` 是标准合成事件、React 直接绑定即可；菜单的收起由 `mdui-dropdown` 负责（`stay-open-on-click` 默认 false）。
9. **在 `mdui-dropdown` 的触发器上阻止冒泡要用 React 的 `onClick` + `stopPropagation`**：
   嵌套在可点击的分组头里时（点 ⋯ 不应触发展开/折叠），React 的合成事件会按组件树顺序派发，
   子元素的 `stopPropagation` 能挡住祖先的 React handler；而 mdui 自己的原生监听挂在触发器上，仍会正常切换下拉。
10. **`mdui-text-field` 的 Enter 直接用 React `onKeyDown` 即可**（keydown 是 composed 事件，会穿出 shadow root），
    不用额外接 mdui 的 `keydown` 事件。

### 11.3 两条可复用的做法

1. **「一行里有四组内容」时不要用 `mdui-list-item`**：它的 `custom` 插槽是**覆盖式**的，
   而 `headline` 是**默认插槽**（官方 JSX 注释里写的 `slot="headline"` 并不存在，写进去会被静默丢弃）。
   本阶段的视频行（拖拽手柄 + 标题/元信息 + 标签 + 三个按钮）与阶段 1 的技能行都是自建 flex 行，
   视觉上用 `border-top: 1px solid var(--mdui-color-outline-variant)` 与 MD3 列表行对齐。
2. **对话框的「受控 open + `closed` 事件同步」是每处都要写的固定套路**：mdui 的 dialog 自己处理 Esc / 点遮罩时
   只把 `open` 拿掉，React 不知道 → 不接 `closed` 就会「关掉又自己弹回」。本页 4 个对话框各接了一个 ref。

### 11.4 顺带修掉的既有问题：内置写作技能重复（原 10.6）

- 修法：`ensureBuiltinSkills()` 加**模块级 in-flight Promise 守卫**（并发调用收敛成一次），
  并把整个补齐过程放进一个 `rw` 事务（IndexedDB 会串行化同库的 rw 事务，跨调用/跨标签页也能兜住）。
- **回归脚本 `scripts/e2e-skills-dedupe.mjs` 只能跑 dev 档**：这个 bug 是 StrictMode 双调用引发的，
  生产构建根本不触发 —— 跑 preview 的断言是**没有牙齿**的。脚本因此做两层：
  (a) 页面自身加载后不得有重复内置行；(b) **显式并发调用 3 次**（确定性复现，不依赖 StrictMode 时机），
  并顺带断言「同名用户副本不被补齐过程改动」。
- **验证过测试有牙齿**：把实现临时退回原样后跑，5 项转红并复现出 `12 行 / 并发后 18 行` 的真实症状，恢复后全绿。

### 11.5 e2e 的同步改动（迁移纪律）

- **18 个脚本**改用新 testid：`.ant-list-item` → `[data-testid="video-item"]`（17 个）、
  `button:has-text("学习")` → `[data-testid="btn-play"]`（13 个）、`.ant-upload-wrapper` → `[data-testid="drop-zone"]`、
  `.ant-popconfirm .ant-btn-primary` → 危险确认框的最后一个 action 按钮。
- **`e2e-mobile.mjs` 的两处**：第 2 步（手机端 ⋯ 菜单）整段按新 testid 重写；
  第 5 步是一条**陈旧断言**（写死 3 个 `panel-slot`，实际 5 个：字幕/讲义/问答/弹幕/卡片），改对之后这个脚本转绿。
- **新增 `scripts/e2e-library.mjs`**：既有 17 个脚本只把首页当「进播放页的跳板」，首页自身的交互没人管。
  新脚本覆盖：空状态、导入任务行、行结构四组内容、Enter 保存的重命名、新建文件夹、
  **拖拽移入文件夹（Pointer Events 全链路 + 悬浮卡片 + 投放高亮）**、移动弹窗、分组折叠与 localStorage 持久化、
  文件夹 ⋯ 菜单的重命名/删除、**两步删除**（先删文件留记录 → 再彻底删除）、删除后回到空状态。

### 11.6 与原稿的有意偏差

1. **没有做 `mdui-fab`。** 原稿设想「导入入口从页面中部移到右下角 FAB」。
   实际保留并 MD3 化了页面中部的虚线投放区，理由有两条：
   (a) **拖拽导入是真实工作流**（iPad 上从「文件」App 拖进来），FAB 只能打开系统选择器，会丢掉这条路径；
   (b) 17 个既有脚本都靠投放区里的隐藏原生 `input[type="file"]` 注入测试视频（现在全页唯一一个）。
   作为补偿，把标题栏的三个文字按钮拆开了：**「从 B 站导入」变成投放区的次级按钮、**「新建文件夹」进列表工具条，
   标题栏只留「设置」—— 390px 下三个文字按钮放不进标题栏。
2. **底部导航只在窄屏，宽屏不做 NavigationRail**：宽屏继续用标题栏的「设置」图标按钮（窄屏该按钮被 CSS 隐藏，避免重复入口）。
3. **转写状态标记不用 `mdui-chip`，用 `.tag-mini` + MD3 语义色**：chip 没有 `default/processing/success/error` 这类语义色变体，
   且标签文字颜色在 shadow DOM 里、无法按状态分别上色；`.tag-mini` 是阶段 1 已确立的「静态标记」做法。
4. **删除确认合并成一条路径**：原来桌面端是行内 `Popconfirm`、手机端是 ⋯ 菜单里的 `modal.confirm`，
   现在两条路径都走 `confirmDialog`，文案与结果完全一致。
5. **`confirmDialog` 的底层实现从 mdui 的 `confirm()` 换成直接调 `dialog()`**：API 与语义未变（仍是 `Promise<boolean>`），
   换来的是 (a) 可给 e2e 一个稳定锚点、(b) MD3 危险操作的错误色确认按钮、(c) 不再需要 `try/catch` 处理 reject。
6. **报错弹窗丢掉了「保留换行 + 可选中」**：antd 版用的是 `Typography.Paragraph copyable` + `whiteSpace: pre-wrap`；
   现在是 `alertDialog` 的 description（会折叠空白）+ 一个「复制详情」按钮 —— **一键复制原文仍然保留**，只是弹窗里显示的排版变紧凑了。

### 11.7 本阶段未被 e2e 覆盖的部分（与原因）

- **B 站导入对话框的真实链路**：需要自建代理地址，无 key 环境下走不通。
- **HTML5 拖放（`onDrop`）**：脚本走的是隐藏 input 注入，`onDrop` 分支（桌面从「文件」App 拖入）只做了人工核对。
  **Pointer Events 拖拽是自动覆盖的**（`e2e-library` 第 6 步）。
- 移动弹窗里的**「新建并选中」**（当场建文件夹）只做了人工核对。

### 11.8 阶段 2 测试结果

| 项 | 结果 |
| --- | --- |
| `tsc -b` | 通过 |
| `vite build` | 通过；主包 3,226,530 → **3,176,922** B（gzip 980,490 → **950,005**）—— 首页去掉 antd 的 Upload / List / Dropdown / Radio / Popconfirm / Empty 后再小一截 |
| `e2e-library`（新增） / `e2e-skills-dedupe`（新增，dev） / `e2e-mobile` | 全部 ✅ |
| 全量无 key 套件 | **33 通过 / 5 失败 / 9 跳过**（47 个，通过率 70.2%） |

失败的 5 个与阶段 1 的 6 个相比**少了一个**（`e2e-mobile` 已转绿），剩下 5 个仍是阶段 0 基线里的那批历史红灯：
`render-handout-fixture`、`test-migration`、`motion-components-test`、`e2e-frames-hires`、`e2e-preview-fonts`。
**没有一个是阶段 2 引入的**（阶段 2 的净效果是「零新增回归 + 修好 1 个历史红灯」）。

> 一次值得记录的假警报：全量跑时曾出现 `e2e-chat-export` 失败（`ChatPanel` 报 `Cannot destructure 'scrollHeight'`），
> 单独复跑与后续两次全量跑都通过 —— 属播放页的偶发时序问题（阶段 3/4 的范围内），不是首页迁移引入的。

---

## 十二、Material You 保真度补强（2026-09-10，已完成）

### 12.1 起因：一次「这是不是还在用 MD2」的质疑

质疑是有价值的，因为**确实有 5 处偏离**；但组件库本身没有选错。先把证据摆清楚，避免以后再翻这笔账。

**证据 A：mdui 2.1.5 就是 Material Design 3 / Material You。**

- `package.json` 自述：「实现 material you 设计规范的 Web Components 组件库」。
- **令牌体系逐项都是 MD3 独有**（值取自本机 `node_modules/mdui/mdui.css`）：

  | 维度 | MD2 | mdui 2.1.5（MD3） |
  | --- | --- | --- |
  | 颜色角色 | primary / secondary / background / surface / error | 多出 **tertiary**、**\*-container** 四组、**surface-container 五档**、surface-dim/bright/tint、**outline / outline-variant**、inverse-\*、scrim |
  | 字阶 | h1–h6 / subtitle1-2 / body1-2 / button / caption / overline | **display / headline / title / body / label × L·M·S**（15 级） |
  | 形状 | 只有按组件尺寸给的圆角档 | extra-small → extra-large ＋ full |
  | 动效 | standard / decelerate / accelerate | short·medium·long·extra-long 各 1–4 级 ＋ **emphasized / -decelerate / -accelerate** |
  | 高程 | 只有 dp 数值 | elevation level0–5 |
  | 组件 | —— | **segmented-button**（MD3 才有）、navigation-bar 用 secondary-container 做活动指示器、navigation-rail、chip 的 assist/filter/input/suggestion、card 的 elevated/filled/outlined、top-app-bar 的 center/small/medium/large、fab 的 primary/secondary/tertiary ＋ extended |
  | Material You 能力 | 无 | **setColorScheme / getColorFromImage**（动态取色） |

- **基线主色是 `#6750A4`**（`--mdui-color-primary-light: 103,80,164`）—— 这是 MD3 的基线紫；MD2 的基线是 `#6200EE`。这个值不是我们配的，是出厂值。

**证据 B：候选的替代方案都不如现在这条路。**（用来一次性了结「要不要换库」）

| 路径 | 真是 MD3 吗 | 外壳组件 | 代价 |
| --- | --- | --- | --- |
| `@material/web`（Google 官方） | ✅（但无 Expressive） | ❌ **缺 10 个**：top app bar / navigation bar·rail·drawer / card / segmented button / snackbar / bottom sheet / badge / tooltip | 官方 `material.io` 原文：**「in maintenance mode. No updates are currently being made to this library. Material 3 Expressive is not implemented on Web.」**；路线图把这些列在「components we have not built yet」并注明「维护模式下不再计划任何新功能」 |
| MUI（React 生态最主流） | ❌ | 组件多，但 MD3 独有组件没有 | 官方文档自称「**The primary Material UI package (`@mui/material`) currently implements Material 2**」，MD3 落在半成品 `@mui/material-next`；第三方 Material You 主题包作者原话：「MUI currently implements Material Design 2, and we don't expect a Material You-compatible version to be released in 2025 (or in 2026)，所以我们自己把组件重刷了一遍」 |
| **mdui + React 19（本方案）** | ✅ MD3 / Material You | ✅ 46 个，外壳齐 | 需要 React ↔ Web Components 的边界纪律（已沉淀成适配层 + skill） |

另外：Vuetify 是 Vue、Angular Material 是 Angular，对 React 项目直接出局。
本项目还有三条更硬的约束 —— **离线优先 PWA**（不能用 CDN 字体）、**按需 tree-shake**、**中文本地化** —— 同时满足的只有 mdui。

**术语上的准确**：mdui 是 **MD3 / Material You**，但不是 **MD3 Expressive**（2025 年那版更活泼的演进）；
`mdui.css` 里没有任何 expressive 令牌。material-web 官方同样没有 Expressive，只有社区分支加了 expressive 令牌版本。
要 Expressive 的话是一个独立话题。

### 12.2 真正偏离 Material You 的五处，以及怎么改的

| # | 问题 | 性质 | 处理 |
| --- | --- | --- | --- |
| ① | **字体没上 Roboto**：`theme.css` 没有任何 `font-family`，`index.html` 也没引字体 → 全程渲染的是 macOS 系统字体（SF Pro + 苹方）。这是「看着不像 Material」的**头号原因** | 漏做 | 加 `@fontsource/roboto` 的 **latin 子集**（400/500，约 21KB/文件，离线可用）。中文继续走系统字体栈（PingFang SC → 微软雅黑等）：思源黑体全量好几 MB，中文应用引 Web 字体不划算，且平台自带中文字形更贴合各系统习惯。**mdui 不设 `font-family`（也没有 `--mdui-font-*` 变量），组件全部继承页面字体**，所以 `theme.css` 一条声明就覆盖了整套 UI |
| ② | **图标集用的是 MD2 的**：`@mdui/icons` 自述「Material Icons 的所有图标」——那是 MD2 时代的图标集，每个图标只有实心一种形态 | 我选错了 | 换成 **Material Symbols**（MD3 的图标集）。新增生成器 `scripts/gen-material-symbols.mjs` 从 `@material-symbols/svg-400` 生成 21 个图标元素（`<mdui-sym-xxx>`，带 `filled` 属性切实心）；**卸载 `@mdui/icons`**。最直观的收益：底部导航现在做到了「**未选中描边、选中实心**」 |
| ③ | **列表行之间的 1px 分隔线**：我从 antd `List` 的视觉惯性搬过来的，**MD3 的列表默认没有分隔线** | 我的惯性 | 去掉分隔线，改用留白（纵向内边距 8→12px）＋ 悬停态层（`surface-container-high`）── 这才是 MD3 区分列表条目的方式 |
| ④ | **没有深色模式**：令牌体系早就备好了深浅两套，只是没人去接 | 漏做 | 新增 `src/ui/theme.ts`（`applyTheme` / `useResolvedDark`）＋ `settings.theme`（跟随系统/浅色/深色，默认跟随系统）＋ 设置页「外观」卡片。**`<html>` 上挂 `mdui-theme-{light\|dark\|auto}` 类**即可切换整套色板（`auto` 走 `prefers-color-scheme`，纯 CSS，不需要 JS 监听） |
| ⑤ | **没有动态取色**：`setColorScheme` / `getColorFromImage` 一直躺在库里 | 待决已决 | 见 12.3。从课程封面提取主色，**只作用在播放页的根元素上** |

顺带做了两件配套的事：
- **`theme.css` 与面板 CSS 全面令牌化**：`#fff` / `#f5f5f5` / `#333` 等硬编码色换成 MD3 令牌（`surface-container-*` / `on-surface*` / `outline-variant` / `primary` / `error`…），深浅两套因此自动成立。
- **补了应用自己的语义色**：MD3 的语义色**只有 error 一种**（success / warning / info 都不在规范里），所以按 MD3 的色板结构自己补了 `--app-color-success(-container)` / `--app-color-on-success-container`，浅深各一套。
  **约定**：值同样写成 `R,G,B` 三元组，用的时候包 `rgb()` —— 与 mdui 的颜色令牌保持同一种写法（混用两种约定是维护陷阱，第一版写成 hex 后立刻改掉了）。

### 12.3 动态取色（Material You 的招牌能力）的设计

- **作用域**：`setColorScheme(hex, { target })` 支持指定元素 —— 配色挂在**播放页根节点**上，离开播放页自动失效，首页始终是默认配色。
  配色是「这一门课」的属性，不该全局生效。
- **深浅兼容**：mdui 内部用 `Scheme.light(source)` 与 `Scheme.dark(source)` **各算一遍**，所以动态取色与深色模式可以叠加，不打架。
- **色彩来源**：这个应用没有「封面」字段，最接近的是抽帧里的**幻灯片帧**（`frames.kind === 'slide'`，通常是课件首页）；
  没有幻灯片帧就退用最早的一帧，一帧都没有就保持默认配色。
- **失败必须静默**：取色依赖「帧存在 → 能解码 → 色彩量化能出结果」，任何一步失败都只是「没用上动态配色」，
  **绝不能影响播放** —— 所以 hook 里的 `catch` 是刻意吃掉的。代价是失败时没有任何信号，因此**必须有 e2e 断言兜底**（见 12.5）。
- 设置页「外观」卡片里有开关（默认开）。**当前已知不一致**：播放页的面板还是 antd（阶段 3 的活），
  antd 控件不读 mdui 令牌 —— 实测「生成字幕」按钮与 Tabs 选中条在动态取色下仍是 antd 蓝 `#1677ff`，
  只有 mdui 的面层（页面底色、侧栏）跟着染。这一处不一致会随阶段 3 的面板迁移自然消失。

### 12.4 本阶段新的坑（同样是构建与类型检查都抓不到的）

1. **`mdui-dialog` 的 `headline` / `description` 渲染在 shadow DOM 里** —— 对宿主元素取 `innerText` 拿不到。
   e2e 要对它做文本断言就得用能穿透 shadow 的文本定位（`locator(sel).getByText('...')`），或直接读 `el.headline`。
2. **`mdui-navigation-bar` 的 `:host` 也是 `position: fixed`** —— 与阶段 1 的 `mdui-top-app-bar` 是同一个坑的第二次出现（见 11.2 第 1 条）。
3. **官方 JSX 类型不是完整属性清单**：`jsx.zh-cn.d.ts` 是手写的、落后于 `custom-elements.json` 的 `attributes`。
   这次是 `mdui-navigation-bar-item` 的 `active` 不在类型里（而且它本来也不用手动传，`navigation-bar` 会按自己的 `value` 打标记）。
   **`tsc` 报「属性不存在」时，先去 manifest 核对一遍再决定怎么写。**
4. **`@material-symbols/svg-400` 的文件名是下划线（`arrow_back.svg`），不是 kebab**；且 fill 变体是**同目录的 `-fill.svg`**，
   不是单独目录。另外 **viewBox 是 `0 -960 960 960`**（不是 Material Icons 的 `0 0 24 24`）—— 照抄旧图标写法会整张图错位。
   还有 `expand_more` 在 Symbols 里已改名 `keyboard_arrow_down`（Symbols 也没有纵向 chevron）。
   生成器对这些都做了**断言**：名字对不上、viewBox 不统一、路径里出现会破坏转义的字符，一律**直接报错**而不是产出空图标。
5. **`useDynamicColor` 一开始用 `RefObject` 是错的** —— 目标元素比数据晚挂上（播放页先渲染加载态、再渲染真正的根节点），
   effect 读一次 `.current` 拿到 null，之后依赖项不再变化、effect 也不重跑，于是**永远错过**：
   全程无报错、配色就是不生效。改成**返回 callback ref**（元素挂载/卸载时天然触发）从根上消除这类竞态。
   > 这条可推广：**「把某个 DOM 节点作为可选依赖传给 hook」时，`RefObject` 会漏掉「节点晚于数据出现」的情况。**

### 12.5 e2e 的同步改动

- **新增 `scripts/e2e-material-you.mjs`（18 条断言，只能跑 dev）**：字体已加载 / 三个主题档位真的换色板（用**相对亮度**断言，不依赖具体色值）/
  Material Symbols 全部已注册且渲染出路径 / viewBox 统一 / 颜色走 `currentColor` / 底部导航的双态（描边路径 ≠ 实心路径）/
  动态取色端到端（种一帧青绿封面 → 播放页主色变成青色且**只作用在播放页**、根元素仍是默认紫 → 关掉开关后复原）。
  跑 dev 的原因：动态取色那段要往 IndexedDB 种封面帧，需要拿到应用同一份 Dexie 实例。
- **`e2e-mdui-adapter.mjs` 第 5 节重写**：原来断言「`#root` 背景仍是 `#f5f5f5`」（保护尚未迁移的 antd 界面）——
  现在外壳走 MD3 令牌了，那条断言改成「**`#root` 底色等于 `--mdui-color-background` 的计算值**」，
  并新增：字体栈以 Roboto 开头、`<html>` 上有主题类、**翻转主题类后底色亮度必须掉一半以上且文字变浅**（preview / dev 两档都能验）。

### 12.6 阶段 2 补强的测试结果

| 项 | 结果 |
| --- | --- |
| `tsc -b` | 通过 |
| `vite build` | 通过 |
| `e2e-material-you`（新增） / `e2e-mdui-adapter` / `e2e-library` / `e2e-skills-dedupe` / `e2e-mobile` | 全部 ✅ |
| 全量无 key 套件 | **34 通过 / 5 失败 / 9 跳过**（48 个，通过率 70.8%） |

失败的 5 个仍是阶段 0 基线里那批历史红灯（`render-handout-fixture`、`test-migration`、
`motion-components-test`、`e2e-frames-hires`、`e2e-preview-fonts`），**零新增回归**；脚本总数 47 → 48。

**体积代价（诚实记录）**：主包 3,176,922 → **3,215,157** B（gzip 950,005 → **959,175**），
即 JS +38KB（21 个图标的描边/实心两套路径数据占大头）；
另有 4 个 Roboto 字体文件（woff2 + woff 各两个字重）约 86KB 进预缓存。
两处都是「换来 MD3 图标双态与 Roboto 拉丁字形」的明码标价 —— 阶段 5 去掉 antd 后会大幅回落。

---

## 十三、阶段 3 实施记录：Player 与五个面板全部换成 MD3；antd 退场（2026-09-10，已完成）

### 13.1 交付物

| 文件 | 说明 |
| --- | --- |
| `src/pages/Player.tsx` | 整页重写：`PageShell`（TopAppBar + fill 内容区）+ 桌面/横屏 `mdui-tabs`、竖屏底部 `mdui-navigation-bar`；视频窗格、常驻字幕轨、断点续播、动态取色逐行保留 |
| `src/ui/panel.tsx` + `panel.css` | **新**：五面板共享骨架（`Panel` / `PanelBar` / `PanelBody` / `PanelProgress` / `PanelPlaceholder` / `PanelSpinner` / `CueRow`），颜色全部令牌化 |
| `src/components/SubtitlePanel.tsx` 等 11 个 | 五个面板 + HandoutDocView + SwipeDeck + QuizCard + MermaidBlock + ModelPicker + PersistentError + CaptionSizeButton 全部去 antd |
| `src/components/chat-panel.css` 等 3 个 | **新**：chat-panel.css / subtitle-danmaku.css / handout-panel.css |
| `src/theme.css` | 删除 `.page-header` / `.mobile-tabbar` / `.panel-column` / `.ant-app` 等被取代的规则；播放页布局接进 PageShell 的 fill 模式 |
| `src/main.tsx` | **antd 外壳整体移除**（ConfigProvider / App / darkAlgorithm 同步层全部不再需要） |
| `package.json` | **卸载 `antd` / `@ant-design/x` / `@ant-design/icons`**（`@ant-design/x-markdown` 保留，peer 仅 react） |
| `scripts/e2e-*`（18 个） | 面板切换 / 气泡 / 输入区 / 弹窗 / toast 的定位全部换成 testid 契约（见 13.5） |

**迁移至此全部完成**：三页 + 五面板 + 全局骨架都已是 Material You，`src/` 里没有任何 antd / @ant-design（icons / x）引用。设计文档 §5 的「阶段 4 ChatPanel 外壳、阶段 5 去 antd」实际在阶段 3 一并落地。

### 13.2 架构决策

1. **面板切换两档共用一套 testid**：桌面/横屏是 `mdui-tabs`（`variant="secondary"`，MD3 里「切换一组相关内容」的用法；`placement` 显式传 `top-start` —— `:host([placement^=top])` 的 flex 方向靠属性选择器生效，不传就拿不到），竖屏是底部 `mdui-navigation-bar`（描边/实心双态图标）。两档的触发元素都挂 `data-testid="panel-tab-<key>"`，e2e 一个选择器通吃，不再按断点分支。
2. **面板容器统一带 `role="tabpanel"`**：`e2e-live-subs` / `e2e-danmaku` / `e2e-cards` 都用 `[role="tabpanel"]:visible .sub-item` 定位「当前面板的条目行」——桌面 `mdui-tab-panel` 与竖屏 `.panel-slot` 都补上这个 role 后，三个关键回归脚本的选择器零改动。`.sub-item` 类名同理保留（见 ui/panel.tsx 注释）。
3. **横屏行为改为「保持当前面板」**：原实现（未完成的 `.panel-column` + 自动跳问答）在代码里并没有接通；现在横屏与桌面共用侧栏 + `mdui-tabs`，旋转不强制切面板 —— 自动跳问答会打断正在看讲义的人。
4. **竖屏保活语义不变**：`.panel-slot` 仍是 `hidden` 属性切 display:none，五面板 DOM 常驻。
5. **ChatPanel 的气泡 / 输入区自搭**：`Bubble` / `Sender` 换成 `mdui-card` 系自建（MD3 聊天气泡的标志是**靠对话侧小圆角、另一侧全圆角**）；`XMarkdown` 渲染链原样保留。

### 13.3 本阶段的坑（构建与类型检查都抓不到）

1. **hook 不能放在提前 return 之后**（React #310，页面直接白屏）：ChatPanel 的三个 `useMduiEvent` 一度写在 `if (!hasSubtitles) return …` 之后 —— 无字幕 → 有字幕状态翻转时 hook 数量变化，整个面板树崩溃。已把「hook 顺序审计」跑过全部面板组件（写有临时审计脚本，按「组件级 return 之后不得再出现 hook」扫描）。
2. **`Playwright 的 isDisabled() 对 mdui-button 恒为 false`**：mdui 把原生 `<button disabled>` 放在 shadow DOM 里、宿主不带 `aria-disabled`，Playwright 的可交互性检查不穿透。断言一律改读宿主反射的 `disabled` 属性（`el.hasAttribute('disabled')` / `el.disabled`），`e2e-player-enhance` 在阶段 2 就踩过同款。
3. **`mdui-tabs` 组件不带任何 ARIA 角色**（tablist / tab / tabpanel 都没有，`custom-elements.json` 与实现里均无）：`getByRole('tab')` 会找不到。已在 JSX 上手动补 `role="tablist"` / `role="tab"`（面板容器另有 `role="tabpanel"`）。
4. **`mdui-dialog` 在弹窗内连续点击后会自发关闭**（未解之谜，已记录）：复现序列 = 打开大图 → 点「放大」→ 点「复位」→ ~300ms 后弹窗自行关闭（事件时间线里有两轮 close/closed，`open=false` 的写入来自 React 提交 —— 即 `zoomOpen` 状态被翻转，触发源未定位；单独点「放大」或单独点「下载」都正常）。e2e 已把下载断言挪到缩放操作之前规避；**产品影响**：大图里连点缩放再想下载，可能要重新打开弹窗。列入待查。
5. **`mdui-select` / `mdui-menu-item` 的官方 JSX 类型落后于 manifest**：`mdui-menu-item` 的 `selected` 在 manifest 里有、类型里没有 —— 不硬塞属性，改用 `mdui-menu selects="single" value=…` 让菜单自己标选中态。
6. **`mdui-button-icon` 没有 `text` 变体**（standard / filled / outlined / tonal），关态用 `standard`。
7. **`::part(panel)` 是改 mdui-dialog 尺寸的正道**：面板宽高在 shadow 里（`.panel{max-width:35rem}`），Mermaid 大图弹窗用 `.mermaid-zoom-dialog::part(panel){width:92vw;max-width:1400px}` 保持原 antd Modal 的观感。
8. **`disabled` 状态反射**：mdui 组件的布尔 prop 会反射成 attribute，所以 e2e 与纯 DOM 判断都能用 `hasAttribute('disabled')`。

### 13.4 e2e 的同步改动

- **面板切换**：`.ant-tabs-tab:has-text("X")` / `.ant-tabs-nav >> text=X` / `.mobile-tabbar button` → `[data-testid="panel-tab-<key>"]`（17 处）。
- **气泡与输入区**：`.ant-bubble-start` → `[data-testid="chat-msg-ai"]`、`.ant-bubble-end` → `[data-testid="chat-msg-user"]`、`.ant-sender` → `[data-testid="chat-composer"]`。
- **弹窗**：`.ant-modal-confirm` → `mdui-dialog:has([data-testid="confirm-dialog-danger"])`（action 按钮顺序固定为先取消后确认）；`.ant-modal-wrap`（mermaid 大图）→ `[data-testid="mermaid-zoom-dialog"][open]`（**必须带 `[open]`**：现在三个 mermaid 块各自有一个弹窗，关闭的也在 DOM 里）。
- **toast**：`.ant-message-success` / `.ant-message-error` → `mdui-snackbar` 出现。
- **面板按钮**：`button:has-text("生成字幕"等)` → testid（mdui-button 的可见文字在 light DOM 插槽里，`button:has-text` 依赖穿透 shadow 的内部按钮，不稳定）。
- **`e2e-preview-fonts` 转绿**：它当年就是被 antd 弃用警告误判成红的（`e2e-mdui-adapter` 里的注释早有记录），antd 移除后自然恢复。
- **`e2e-mdui-adapter` 第 5 节反转**：从「antd 界面仍在」改为「antd 已完全移除（残留 0 个 .ant- 节点）」。

### 13.5 测试结果

| 项 | 结果 |
| --- | --- |
| `tsc -b` | 通过 |
| `vite build` | 通过；主包 3,215,157 → **2,485,567** B（gzip 959,175 → **719,162**，**-240KB / -25%**）—— antd + @ant-design/x 退场的全额收益 |
| 全量无 key 套件 | **35 通过 / 4 失败 / 9 跳过**（48 个，通过率 72.9%） |

失败的 4 个全部是阶段 0 基线里的历史红灯（`render-handout-fixture`、`test-migration`、`motion-components-test`、`e2e-frames-hires`），与 UI 迁移无关；`e2e-preview-fonts`（当年被 antd 警告误判）与 `e2e-mobile` 均已转绿。**零新增回归**。

### 13.6 已知问题 / 待办

1. **`mdui-dialog` 自发关闭**（见 13.3.4）：复现序列、事件时间线、React 写入证据都已记录，待定位。规避：连续操作弹窗内的按钮后如需下载，重新打开弹窗即可。
2. **横屏矮视口的 mdui-tabs 密度**：320px 宽的右栏放 5 个 secondary tab，标签贴边（`e2e-mobile` 第 16 步只量了栏宽，未量标签溢出）。视觉可接受，若后续觉得挤可改 `variant="primary"` 或缩字号。
3. 带 key 的用例（`e2e-chat` / `e2e-chat-frames` / `e2e-chat-image` / `e2e-quiz` / `debug-*`）本轮未跑，需要真实 API key 的场景（流式回答、截图提问、出题）建议你按 README 用 `--with-key` 档跑一遍。
