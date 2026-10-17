---
name: 讲解配图
description: 讲解与题目解析的出图规范：判断什么内容值得画图、按场景选图种（流程/时序/状态/思维导图/饼图/函数图像）、节点文案与数量上限，以及 mermaid 与 diagram（JSON 中间层）两种围栏怎么写。仅用于问答讲解与题目解析，讲义正文不渲染图表。
---

【先判断该不该画】
1. 只有「关系比文字更清楚」时才画：流程、时序、状态流转、层级结构、占比、函数关系。
2. 一句话能说清的不画。概念定义、公式推导、单点结论一律不画。
3. 一段回答最多一张图。图的前后各用一句话说明它在讲什么，不要只丢一张图。

【图种选择】
- 步骤、分支、因果、架构、层级、状态关系 → ```diagram 的 graph（方向 TB 或 LR）
- 多方按时间来回交互（请求响应、握手、问答） → sequenceDiagram
- 必须表达专用开始/结束状态语义 → mermaid stateDiagram-v2
- 柱状对比、折线趋势、占比 → ```diagram 的 chart（kind: bar / line / pie）
- 函数图像、几何图形、坐标轴、自由曲线 → ```diagram 围栏的 plot（mermaid 表达不了，别硬套 flowchart）
- 图布局和路由全部交给渲染器，不输出像素坐标、SVG 路径或自写 HTML 图表。

【围栏名是硬契约】
1. 围栏名必须写 ```mermaid 或 ```diagram。写成 ```dot / ```plantuml / ```graphviz 前端不认，
   会原样显示成一坨源码，比不画更糟。
2. ```diagram 里只放一个 JSON 对象，不包围栏以外的任何说明文字。
3. 每张图都在围栏名后面给一个标题：```mermaid title="三次握手" / ```diagram title="抛物线开口方向"。
   标题写 2~12 个字、点明这张图讲什么，不要复述正文句子，不要以句号结尾；
   **不要写进 JSON 里**（title 不是图元字段，会报未知字段）。标题显示在图块左上角，也是下载的文件名。
4. 写图前先调用 show_widget 预检（format 传 "mermaid" / "diagram"，并带上 title），
   把它回的围栏原样贴进正文。

【```diagram 的 JSON schema】
先写 type，再写 direction / kind / x / y 等配置，最后追加数组项；完整项到达即可预览，结束时严格校验。不要重复字段、写注释或尾逗号。
渲染器负责坐标、布局、连线、刻度与采样，你只描述「有什么、怎么连、函数与范围」。
**不要手算任何坐标** —— schema 里也没有绝对坐标字段。字段名大小写敏感，不要发明字段。
（标题不在这里：它写在围栏参数上，见上一条。JSON 里出现 title 会按未知字段被拒。）

▸ plot —— 函数图像 / 几何图形 / 坐标轴
{
  "type": "plot",
  "x": [-10, 10],            // 横轴范围，建议显式给；缺省按几何外延或 [-10,10]
  "y": [-3, 3],              // 纵轴范围，建议显式给；缺省自动（曲线按百分位、几何按外延）
  "axes": true,              // 缺省 true；false 时只画曲线与图元
  "curves": [                // 曲线：fn 是 x 的表达式，采样由渲染器做
    { "fn": "x^2", "label": "y=x²", "color": "#1677ff", "domain": [-3, 3] }
  ],
  "points":    [ { "at": [0, 0], "label": "O" } ],                    // 关键点（红点+标签）
  "segments":  [ { "from": [0, 0], "to": [3, 4], "label": "d", "dashed": false } ],
  "polygons":  [ { "points": [[0,0],[4,0],[2,3]], "label": "三角形" } ],
  "circles":   [ { "center": [0, 0], "r": 2, "label": "圆" } ],
  "labels":    [ { "at": [1, 2], "text": "顶点", "anchor": "middle" } ]
}
示例（抛物线）：
```diagram
{"type":"plot","x":[-3,3],"y":[-1,5],"curves":[{"fn":"x^2","label":"y=x²"}],"points":[{"at":[0,0],"label":"顶点"}],"labels":[{"at":[2.2,4],"text":"开口向上"}]}
```

▸ graph —— 节点 + 连线的结构图
{
  "type": "graph",
  "direction": "TB",         // TB 纵向（缺省）/ LR 横向
  "nodes": [
    { "id": "a", "label": "客户端", "shape": "box" }   // shape: box(缺省)/round/ellipse/diamond
  ],
  "edges": [ { "from": "a", "to": "b", "label": "请求" } ]
}
示例（请求链路）：
```diagram
{"type":"graph","direction":"LR","nodes":[{"id":"c","label":"客户端"},{"id":"s","label":"服务端"},{"id":"d","label":"数据库"}],"edges":[{"from":"c","to":"s","label":"请求"},{"from":"s","to":"d","label":"查询"}]}
```

▸ chart —— 柱状 / 折线 / 饼图（最多 12 项；饼图建议不超过 6 项）
```diagram title="学习进度"
{"type":"chart","kind":"bar","data":[{"label":"已学","value":8},{"label":"待学","value":4}]}
```
字段仅有 type、kind、data、可选 y（柱/折图的 [最小值,最大值]，必须包含所有数据）。
data 每项仅 label（最多 12 字）和 value（有限数字）。pie 必须非负且至少一项大于零，不能给 y。
不要为了普通数据图生成 HTML/Chart.js 或 SVG；导出 JSON 与 SVG 由前端提供。

▸ fn 表达式支持的范围
数字、x、+ - * / ^ %、括号；常量 pi / e / tau；
函数 sin cos tan asin acos atan sinh cosh tanh exp ln log log2 log10 sqrt cbrt abs floor ceil round sign min max pow atan2 hypot；
支持隐式乘法（2x、2sin(x)）。**不支持**自定义变量、分段函数、求和求极限 ——
分段曲线就写多条 curve（各自给 domain），别硬凑一个表达式。

【数量与文案上限（校验层硬闸门，超了预检不过）】
1. 节点文字不超过 10 个字：写「资源分配」不写「负责为进程分配内存与 IO 资源」。
2. graph 不超过 10 个节点、16 条边。超了说明该拆成两张，或者本来就该用列表。
3. plot 不超过 4 条曲线、12 个关键点、12 条线段、6 个多边形/圆、8 段自由标注。
4. 节点文案沿用课程里的原词，不自造术语、不自造缩写。
5. 图里不塞长句、不塞推导过程；公式与演算写在正文里，图只呈现结构。
6. 标签文本按纯文本写：渲染器会转义，写 HTML 标签也只会原样显示成文字。

【常见错误】
- 把整段解析塞进节点或标签，图变成一张排过版的文字。
- 在 JSON 里发明字段（colour、vertexs、xAxis…）：未知字段会被拒绝并列出可用字段，照它改。
- 把标题写进 JSON（{"type":"plot","title":"…"}）：标题是**围栏参数**（```diagram title="…"），
  写进 JSON 会被当成未知字段拒掉。
- 忘写 title，或者把标题写成一句完整的话：图块左上角会空着，或标题栏被撑成两行。
- fn 漏右括号、拼错函数名：报错会带字符位置，照着改。
- edge 的 from/to 指向不存在的节点 id：报错会列出全部可用 id。
- 同一张图里混两种图种（比如 graph 里嵌时序逻辑）：拆开。
- 在讲义里画图。讲义按公文 IR 渲染，不解析图表围栏，画了只会变成源码文字 ——
  本技能只服务问答讲解与题目解析两条链路。
