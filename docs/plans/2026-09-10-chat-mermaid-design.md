# 对话 Mermaid 渲染设计

日期：2026-09-10
状态：已实现

## 背景与目标

现状：问答面板的 AI 回答走 `@ant-design/x-markdown`（2.9.0，基于 marked + html-react-parser + DOMPurify）渲染。AI 一旦用 ```mermaid 围栏输出流程图/时序图，用户只能看到一坨源码。

目标：

1. 回答里的 ```mermaid 围栏自动渲染成图；渲染失败**绝不吞信息**，回退到源码 + 错误说明。
2. 流式输出时不抖：围栏没闭合前不渲染，避免每来一个 token 就 parse 失败一次。
3. 可复制源码、下载 SVG、全屏放大查看。
4. 中文标签不能被截断（CJK 换行），安全上不允许 XSS。

顺带修一处上下文缺陷：带截图提问时，送模型的内容应当**同时带图与字幕上下文，并以图为准**（见「四」）。

## 一、选型（为什么是 mermaid 核心库）

| 候选 | 结论 |
| --- | --- |
| **mermaid**（mermaid-js/mermaid） | **选它**。90k★，2026-08 仍在发版（v11.17.2），15+ 图种（flowchart / sequence / class / state / ER / gantt / pie / mindmap / timeline / quadrant / sankey / git / C4 / block / xychart / architecture）。是 GitHub、GitLab、Notion 的原生实现，事实标准。 |
| beautiful-mermaid（lukilabs） | 更漂亮、同步渲染、零 DOM 依赖，但只支持 6 种图（flowchart/state/sequence/class/ER/xychart），缺 mindmap、gantt、pie、timeline 等教学场景高频图种，生态与安全补丁链路也远不如 mermaid。作备选记录，不采用。 |
| streamdown（Vercel） | 是整套 markdown 渲染器，本项目已用 XMarkdown，替换成本高、收益低。 |

结论：**引擎用 mermaid 官方核心库**，但必须按下面的方式接进 XMarkdown，否则流式下会翻车。

## 二、接入方式

XMarkdown 的 `components` 只是「替换 HTML 元素」，markdown 解析层把围栏代码渲染成：

```html
<pre><code data-block="true" data-state="done|loading" data-lang="mermaid" class="language-mermaid">…源码…</code></pre>
```

（见 `node_modules/@ant-design/x-markdown/es/XMarkdown/core/Parser.js` 的 `configureCodeRenderer`。）

关键点：`code` 组件会额外收到三个非标准 props —— `block`(bool)、`lang`(string)、`streamStatus`('loading'|'done')。其中 `data-state` 由 **围栏是否闭合** 决定（`completeFencedCode.test(raw)`），这正是流式场景需要的信号。

所以：

- `components.code`：`block && /^mermaid\b/i.test(lang)` → 渲染 `<MermaidBlock>`；否则原样 `<code>`。
- `components.pre`：若唯一子元素是「mermaid 围栏的 code」，去掉 `<pre>` 外壳（否则图表被代码块样式包住）；否则原样 `<pre>`。

**坑**：`pre` 拿到的 `children` 是 **尚未渲染的 React 元素**，`type` 是 `MarkdownCode` 本身而不是 `MermaidBlock`（React 元素只是描述对象，要到渲染阶段才变成组件实例）。所以判定只能读它的 **props**（`block` / `lang`），不能比较 `type === MermaidBlock`。第一版就是踩了这条：图表照常渲染，但外面那层 `<pre>` 一直在。

新增文件：

```
src/components/mermaid/
  mermaidRender.ts   引擎：懒加载 + 串行渲染队列 + 主题/字体
  MermaidBlock.tsx   组件：占位 / 渲染 / 失败回退 / 工具条 / 全屏
  mermaid.css        样式（跟随 x-markdown 的代码块观感）
```

## 三、关键坑（实现时必须处理）

1. **`mermaid.render()` 不可并发。** 它内部往 `document.body` 塞临时容器、按 id 查询再删除；并发调用会互相踩。→ 所有渲染串行化：`queue = queue.then(job)`，单飞。
2. **未闭合围栏不要渲染。** 流式时围栏内容还在增长，parse 必然失败，且会导致整个回答块反复重建。→ `streamStatus === 'loading'` 时只显示「图表生成中…」+ 源码预览；转为 `done` 才入场。
3. **渲染失败要把源码露出来。** 图表 DSL 比普通代码更容易因为模型少写一个词就解析失败；留白会让用户以为是产品坏了。→ 失败态显示错误摘要（截断）+ 可展开源码 + 「重试」。
4. **中文换行。** `flowchart.htmlLabels: false` 走 SVG `<text>`，mermaid 按空白切词换行，中文没有空格 → 长标签会溢出方框。→ 保持默认 `htmlLabels: true`（foreignObject + HTML），用 CSS 控制换行。代价是导出的 SVG 依赖 foreignObject（Chrome/Safari/Firefox 都能看，不保证所有矢量工具）。
5. **字体。** 默认 `trebuchet ms, verdana, arial` 里没有 CJK。→ 显式给 `fontFamily` 传系统中文字体栈，否则图里中文会落到浏览器兜底字体，观感不统一。
6. **安全：不要对 SVG 做二次 DOMPurify。** 实测（探针 `securityLevel:'strict'` 渲染含 `<script>` / `<img onerror>` / `<a href=javascript:>` / `<iframe>` 的标签）：mermaid 自带的清洗把这些全部清掉了，标签文字照常保留。而拿 DOMPurify 再净化一遍产出的 SVG，**无论怎么配（`USE_PROFILES:{svg,html}`、`ADD_TAGS:['foreignObject']`、不传 profile 的默认配置）都会把 `foreignObject` 里的标签文字整段删掉** —— htmlLabels 的流程图节点直接变空框。所以最终只保留 `securityLevel:'strict'`，另加一道「危险特征检测」（命中 `<script|iframe|object|embed|form`、`on*=`、`javascript:`、`data:text/html` 就抛错回退源码），绝不重写 SVG。
7. **`linkify` 必须先绕开代码块。** `linkifyTimestamps` / `linkifyFrames` 是作用在整篇 markdown 上的正则替换，` ```mermaid ` 里出现 `A[03:25]` 会被改写成 markdown 链接，图表源码当场损坏（普通代码块同理）。改法是按行扫描围栏（``` / ~~~，校验长度与闭合）分段，非代码段再跳过行内 `` ` `` span。
8. **体积。** mermaid 打包后 ~1.5MB，**必须动态 import**，落到独立 chunk，只有真出现图表时才拉。PWA 预缓存 glob 是 `**/*.{js,css,svg,wasm}`，会把这个 chunk 也预缓存进去 —— 首装体积变大但离线可用，符合本应用「离线可用」的取向，保留。
9. **id 冲突。** 每次 `render` 用自增序号 + 随机串做 id，避免同一份源码多次渲染（列表重挂）时 mermaid 内部按 id 缓存出脏结果。渲染失败路径下 mermaid 可能把临时容器留在 `document.body`（`#d<id>`），catch 里手动清掉。

## 四、带截图提问：图 + 上下文，以图为准

现状（`ChatPanel.send`）：

- tier 1（主模型有视觉）：把图 + `[截图@mm:ss]` 时间戳 + 字幕窗口一起送过去，但**提示词里没有声明截图是最高优先级证据**，模型有可能拿字幕压过画面。
- tier 2（主模型无视觉）：用视觉模型把图转成文字描述，描述提示词里**没有给字幕上下文**，视觉模型只能凭空看图，容易把画面里的小字认错。

改法：

1. `PROMPTS.qaSystem` 增加一条规则（仅在带截图时注入）：本轮附带 N 张 `[截图@mm:ss]` 截图，**冲突时以截图为准**，字幕只作背景。
2. tier 2 的描述提示词带上该时刻的字幕窗口，让视觉模型带着上下文认图，且明确「画面没写的不许补」。
3. tier 1 / tier 2 的 `currentText` 都前置一句「以图为准」的说明（tier 1 说明图与 `[截图@mm:ss]` 的对应关系，tier 2 说明后面那段是逐字转述）。
4. 实现上把「截图时刻字幕窗口」的计算从看图**之后**前移到**之前**（结果按时刻存 Map），tier 2 才能拿到上下文。

## 五、验收

- `scripts/e2e-chat-mermaid.mjs`（真浏览器 chrome channel，自播种数据、不调真实 API）：导入测试视频 → 播种子表/向量/会话 → 断言
  - 只对 mermaid 围栏建块（普通代码块不建）；`<pre>` 外壳已剥离；流程图走 foreignObject 且中文节点标签完整；
  - 工具条齐全；正文 `[03:25]` 仍被 linkify；代码块内的时间戳**没有**被 linkify；
  - 非法语法 → 错误提示 + 源码 + 重试；未闭合围栏 → 停在「图表生成中」+ 源码预览；
  - 复制源码进剪贴板；大图弹层渲染 SVG 且放大/复位生效；下载的 .svg 带 xml 头与显式宽度、含中文、能被浏览器独立打开渲染。
- `scripts/test-chat-frames.mjs` 增补契约测试：linkify 跳过围栏/未闭合围栏/行内 code；`qaSystem` 在 shotCount>0 时注入「以截图为准」、编号连续；`shotDescribe` 带上下文时声明「以画面为准」。
- 一次性探针（已删）确认了 mermaid `securityLevel:'strict'` 的清洗效果与 DOMPurify 二次净化的破坏性，结论写进「三·6」。
