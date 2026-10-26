# 交互式讲解

普通聊天与课程问答复用 `show_widget(format="html")`，新增内置「交互式讲解」技能。静态结构、函数和普通数据图继续使用 diagram / Mermaid；只有参数探索、算法单步等确实有助于理解时才生成交互件。

## 交互与费用边界

- 调参和步骤切换只在 iframe 内重绘，不调用模型。
- `window.__wbw.widgetState` 读取快照，`setWidgetState({modelContent,privateContent})` 保存当前参数。
- 用户点击追问后出现可取消、可改写问题的确认框，以“当前情况”展示本次发送的参数，原始数据按需展开；确认前不调用聊天发送入口。
- 独立预览的追问会等待原会话接收回执；原窗口关闭或暂不能发送时明确报错，不会声称已经送达。
- 只附带 `modelContent`，并标记为不可信数据。不自动附带 `privateContent`、HTML、库源码或操作历史；普通输入消息也不自动注入组件快照。
- `privateContent` 的含义是“宿主不自动发送模型”，**不是不上服务器**，也不是秘密保险箱。生成的组件脚本能看到自己的整个快照，因此两部分都不要存秘密。用户显式导出数据时，快照可随消息一起导出。

## 持久化

快照首先写入当前浏览器 IndexedDB 的消息行。云模式安装 `installCloudCache` 后，`chats` 属于 `CLOUD_TABLES`，完整聊天记录的 before/after（含快照两部分）会进入 outbox 并由通用云同步链路上传。`saveWidgetState` 成功只确认本机事务及云模式下的 outbox 写入，**不表示服务器已经确认，也不保证另一设备此时可见**；跨设备一致性尚未做双设备实测。通过宿主分配的 widget ID、消息 ID、会话和源码绑定，iframe 不能指定要访问的记录。旧消息第一次打开时补齐实例 ID，无须数据库索引迁移。

保存只更新快照，不覆盖正文、思考或工具记录。宿主在事务提交后 ACK；失败会拒绝 Promise 并显示错误。缺少持久消息的临时组件不能声称已经保存。源码修改会更换 ID 并清空快照，避免重放不兼容状态；旧 iframe 的迟到写入、已删除消息的写入会被拒绝。分支新消息不会继承原消息快照。

刷新、虚拟列表重挂和独立预览可恢复快照；同一组件的窗口通过数据库订阅同步，整份快照以最后成功提交为准。主题变化通过消息与 CSS 变量同步，不重载 iframe。组件通过 `wbw:statechange` 恢复、通过 `wbw:themechange` 重绘 canvas；恢复事件不得触发保存。

快照只接受 JSON，两部分合计不超过 16 KiB（UTF-8），嵌套最多 16 层。宿主只提供小型控件样式，不新增任意工具调用、文件访问或宿主数据读取能力。`sandbox="allow-scripts"`、不透明源、禁外网 CSP 与本地按需内联库保持不变。

## 当前范围

### 可视化提问

`ask_user` 可附带 `presentation: {html}`，使用同一 HTML 校验、沙箱、主题与 UI kit；非法可选 HTML 被丢弃，原生问题仍可回答。结构化 question/type/options（稳定 ID）是唯一题面来源，HTML 不能改变它们。

页面从 `window.__wbw.answerInput` 读取 `{answer, submitted, question}`，监听 `wbw:answerchange`。`setAnswerDraft(answer)` 更新原生题卡的同一份草稿；`submitAnswer(answer)` 要求点击/键盘动作，并在可信宿主中展示从原问题校验得到的文案，用户再点“确认回答”后调用原 `answerAsk`，解除原工具挂起并按既有 `TurnResume` 续跑。它不是 `sendPrompt`。宿主校验来源、可见性、iframe 焦点、当前待答状态及重复请求；最终确认不依赖 iframe 对用户激活的自证。

原生输入始终可用。页面只传稳定 selectedIds 或 text/note，selectedLabels 由宿主重新计算；答案不得含宿主操作权限。取消视觉确认只回到修改，不结束问题；停止、在聊天里回复、过期和重载恢复沿用原提问状态机。已提交答案随原问题保存并回放；未提交草稿是易失的，刷新后重新填写。正式 `present_quiz` 只允许 `setAnswerDraft`，不能使用 `submitAnswer` 绕过宿主提交、判分和错题链路。

### 阅读融合

按消息/组件/源码版本的短布局提示键缓存最近 200 个高度（80–2000px，内存中，不是数据库快照）；短版本 hash 只影响布局估计，不用于授权或 React 重挂身份，后者仍使用精确源码。重挂先占位，文档 ready 后显露 iframe，主题/状态变化不重建。测量 body 和可见后代边界而不是被旧 viewport 撑住的根 scrollHeight；包含未裁切的正常流/absolute 溢出，尊重 hidden/clip/auto/scroll 裁切，排除 fixed 子树，因此内容可缩短；横向滚动条计入高度。生成内容应有正常流根节点，浮层限制在根内，不用 100vh/height:100% 制造测高反馈。

iframe 内未被可滚动控件消费的 wheel/touch/阅读键意图会暂停聊天跟随。正文选区只桥接限长文本，不访问宿主 DOM；宿主提供“引用提问”，通过既有可编辑、可取消的追问框适配聊天入口，附带宿主消息/组件身份和源码版本标记。引用来自不可信页面，不能当材料证据。源码更新会使旧桥接与未发送选区失效。

`show_widget` 返回不含源码的 `wbw-widget` 引用围栏，模型把引用原样放在正文相应位置。多个调用按 `widgets` 顺序保留，不再互相覆盖；每幅图有独立快照。只能引用当前消息自身的载荷，重复引用只展示一次；旧消息与遗漏引用的图形仍在末尾兼容显示。`widget` 保留为最后一幅图的旧客户端兼容别名，不重复渲染。

源码局部编辑通过低干扰的“更多交互图形操作”菜单进入，与独立预览、撤销共享一个入口；编辑只失效该图的快照，保留引用位置及同消息其他图的快照。技术操作不再占据两行常驻工具栏，不依赖悬停发现。

外层透明无框，主图占据视觉中心；教学参数与设计原型调参不是同一种需求，不给模拟器自动加 Tweak 面板。字体、字号、强调色、前景、边界、表面色与控件圆角读取实际宿主表面的令牌并实时同步，独立预览保留原表面样式；不是另维护固定的深浅色板。示例图按实际宽度绘制，有数值刻度、量与单位，窄屏减少刻度而不缩字。

通用宿主设计调参面板、原型变体轮播和独立 HTML 导出未实现；这不是 ZCode 全量 API 移植。沙箱和本地内联库策略仍采用本项目更严格的离线边界，不开放原 skill 的 CDN 白名单。

## 样式边界

- 正式交互件及局部修改预览都在各自的隔离 iframe 中执行，宿主只向内同步主题令牌，不接受修改宿主 CSS 的消息。
- 正文不是另一种组件宿主。普通聊天、课程问答与 LiveLink 共用 Markdown 净化策略：移除 style/link 等标签、内联样式、class/id 和任意 data 属性；只保留公式、围栏与流式占位所需的内部字段。安全的语义 HTML 仍可阅读，已有消息源码不改写。需要样式和脚本的内容应走 show_widget，而不是混进正文。
- 流式 HTML 继续使用去样式、去脚本的静态预览。宿主编辑面板、图块与预览通过 `md-embedded-ui` 标明正文样式的终点，Markdown 的段落、列表、表格和代码块规则不再深入这些界面。

## 验证

```sh
npx tsx scripts/test-widget-state.mjs
node scripts/test-widget.mjs
node scripts/test-ask-visual.mjs
npx tsx scripts/test-artifact-edit.mjs
npx tsc -b --pretty false
# 先运行 npm run dev；以下使用独立浏览器上下文和假模型，不消耗真实 API tokens
node scripts/e2e-widget-state.mjs
node scripts/e2e-ask-visual.mjs
node scripts/e2e-widget-reading.mjs
node scripts/e2e-widget-layout.mjs
node scripts/e2e-widget-style-isolation.mjs
node scripts/probe-widget-sandbox.mjs
# 或只跑本轮新增验证（编排器会使用正确 TS loader）
node scripts/e2e-all.mjs --only=test-widget-state,e2e-widget-state,e2e-widget-layout,e2e-widget-style-isolation
```
