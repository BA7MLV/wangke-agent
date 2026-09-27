# Material You / YouTube 全站 UI 与 UX 复查

日期：2026-09-27

状态：已完成代码修改、浏览器验收和回归检查。

## 设计取向

继续以现有 MD3 / mdui 的颜色、字阶、形状及状态令牌为基础。YouTube 的参考范围是内容优先的层级、缩略图与元信息、搜索筛选、稳定导航和播放控制。保留项目既有动态取色、深浅色主题、播放器直角和学习热力图绿色的约定。

本轮核查了仓库已有设计文档和当前安装的 mdui 2.1.5 源码。官方在线规范页的读取被审批服务故障阻止，因此不把这轮工作表述为最新官方规范认证或完整无障碍合规认证。

## 问题与落实

| 区域 | 发现的问题 | 已实施的调整 |
| --- | --- | --- |
| 全局导航 | 紧凑侧栏无文字；mdui 底栏超过三项时默认隐藏未选中标签；普通页面在手机横屏失去主导航 | 紧凑侧栏保留标签与图标选中指示；底栏显式始终显示标签；普通页面矮视口恢复紧凑导航；播放页仍沿用原横屏布局 |
| 页面结构 | 页面标题、分区标题仅有视觉字阶；缺少跳过导航入口 | 使用原生 h1 / h2、main landmark、跳到主要内容入口；保持 HashRouter 的路由不变 |
| 课程库 | 无名称搜索和类型筛选；导入主操作强调不足 | 加入名称搜索、全部/视频/阅读材料/继续学习筛选、结果计数与空结果恢复；filled 导入文件、tonal B 站导入、text 新建文件夹 |
| 内容卡片与文件夹 | 缩略图和折叠组头依赖鼠标；拖拽缺少键盘替代 | 原生缩略图按钮、独立折叠按钮与展开状态、手柄键盘打开已有移动对话框；保留16:9缩略图及文件夹业务 |
| 播放与面板 | mdui Tab 缺少选中态关联和键盘导航；鼠标离开会隐藏已聚焦控件；后置样式覆盖用户要求的直角 | 补齐 ARIA、方向键/Home/End与单一 Tab 停靠点；键盘焦点保留控制栏；删除圆角冲突 |
| 课程助手与问答 | 窄屏隐藏删除会话、思考强度；高强调用户气泡与发送按钮竞争；思考内容仅可鼠标展开 | 工具栏换行保留功能；气泡使用 secondary-container / on-secondary-container；原生展开按钮、焦点与状态关联 |
| 设置 | 部分控件无明确名称；模型选项、API Key 错误、B 站 Cookie 读取提示与控件占用同一 grid 单元格 | 增加明确标签与展开状态；用列内容器顺排控件和附加内容；Cookie 复合操作使用已有的纵向表单变体 |
| 讨论与学习 | 折叠、排序、时间戳触达/选中/焦点反馈不一致；热力图不可键盘滚动 | 原生排序按钮与选中语义、48px触屏目标和焦点圈；明确AI生成来源；热力图可聚焦横向滚动 |
| 已保留卡片 | 整行可鼠标跳转，时间戳不能用键盘激活 | 时间戳改为独立原生按钮，保留整行点击和独立移除操作；补齐触屏目标及焦点圈；字幕/弹幕可点击行的焦点圈同步使用主题主色 |
| 颜色与动效 | 逗号分隔的 MD3 令牌与 slash alpha 混用，导致部分声明失效 | 改为 rgba(var(--mdui-color-*), alpha)；覆盖卡片、阅读器、讲义、选区、设置、聊天和讨论；新增交互遵循 reduced-motion |

搜索临时展开匹配的文件夹，清除筛选后恢复原折叠偏好。继续学习仅包含已经播放且未标为完成的视频。所有筛选在内存中处理，不修改记录、数据库结构或导入链路。

## 已完成的验证

- `npx tsc -b`：通过。
- `npm run build -- --outDir dist-verify`：通过。构建仍报告混合静态/动态导入和大分块警告；本轮未扩展到打包架构调整。
- `node scripts/test-video-progress.mjs`：11 项通过。
- `node scripts/test-library-job-copy.mjs`：3 项通过。
- 全部 `src/**/*.css` 经 PostCSS 解析；未发现混用逗号令牌与 slash alpha 的声明。
- 新增浏览器脚本的 Node 语法检查、`git diff --check`：通过。
- 独立代码审查覆盖 PageShell 与 Player 的导航语义、键盘行为、响应式选择器以及组件源代码的实际能力。
- 默认 mdui 浅深色的用户气泡、讨论选中态、辅助文字等配对颜色已做静态对比度计算；检查到的组合为 4.97:1–13.98:1。这个结果不覆盖课程动态取色或实际浏览器渲染。
- 浏览器验收：`probe-app-shell-material.mjs`、`e2e-library-design.mjs`、`probe-secondary-material.mjs`、`e2e-material-you.mjs`、`probe-player-semantics.mjs`、`probe-controls-hover.mjs`、`e2e-library.mjs`、`e2e-mobile.mjs`、`e2e-study.mjs`、`e2e-settings-skills.mjs` 均通过。
- 动态取色浏览器断言确认封面青绿色应用到播放页，关闭动态取色后恢复默认色；浅色/深色、390px 竖屏、800px 平板、852×393 横屏及 667×375 / 932×430 / 852×220 矮横屏均通过。
- 已查看生成的课程库浅色/深色、播放页和 390px 学习页截图；内容层级、底部导航、缩略图/元信息和播放器控制栏均保持清晰。

## 浏览器验收记录

浏览器验收已在本地开发服务器上完成，启动命令为：

```sh
npm run dev -- --host 127.0.0.1 --port 5180 --strictPort
```

回归脚本使用独立浏览器上下文、合成记录和仓库内测试视频，不接触用户浏览器中的课程数据，也不调用付费模型接口。

```sh
BASE_URL=http://127.0.0.1:5180 node scripts/probe-app-shell-material.mjs
BASE_URL=http://127.0.0.1:5180 node scripts/e2e-library-design.mjs
BASE_URL=http://127.0.0.1:5180 node scripts/probe-secondary-material.mjs
BASE_URL=http://127.0.0.1:5180 TEST_FILE=/path/to/test-video.mp4 node scripts/probe-player-semantics.mjs
```

此外运行了既有的 `e2e-library.mjs`、`e2e-mobile.mjs`、`e2e-study.mjs`、`e2e-settings-skills.mjs` 和 `probe-controls-hover.mjs`。脚本断言覆盖浅深色、移动/平板/横屏布局、焦点和键盘行为；截图用于补充视觉检查。

读屏语义仍受 mdui Shadow DOM 实现边界影响：当前组件不全面转发宿主 ARIA 属性。本轮验证了作者 DOM 中的 heading、tabpanel、tab 关联和焦点行为，没有添加未经验证的全站 Shadow DOM 改写器。

## 相关既有约定

- `docs/plans/2026-09-16-youtube-style-ui-design.md`
- `docs/plans/2026-09-10-navigation-rail-design.md`
- `docs/plans/2026-09-24-player-youtube-details-design.md`
- `docs/plans/2026-09-18-study-time-design.md`
