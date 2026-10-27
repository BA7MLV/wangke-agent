# Telegram 聊天界面：源码依据与落地

研究日期：2026-10-27。主界面参考 Telegram Web A；粒子删除复用项目已有的 Telegram Android WebGL2 移植。两者来源不同。

## 固定版本与阅读入口

Web A 仓库：<https://github.com/Ajaxy/telegram-tt>，本次读取版本 `6002824b6532f3d913997ce496d9ab5f9b86bc22`。

- [`src/components/left/main/Chat.tsx`](https://github.com/Ajaxy/telegram-tt/blob/6002824b6532f3d913997ce496d9ab5f9b86bc22/src/components/left/main/Chat.tsx)：`Avatar`、`info-row`、`LastMessageMeta`、`subtitle`、`ChatBadge` 组成一行；输入状态与末条消息摘要共用副标题位置，菜单动作独立于打开会话。
- [`Chat.scss`](https://github.com/Ajaxy/telegram-tt/blob/6002824b6532f3d913997ce496d9ab5f9b86bc22/src/components/left/main/Chat.scss)：标题与摘要分别布局、摘要省略、桌面选中行统一主色与前景色、移动端保持独立处理。
- [`src/components/middle/message/Message.scss`](https://github.com/Ajaxy/telegram-tt/blob/6002824b6532f3d913997ce496d9ab5f9b86bc22/src/components/middle/message/Message.scss)：`own` 控制发言方向与独立底色；`first-in-group` / `last-in-group` 控制对话侧的小圆角；操作入口在悬停时显现；普通删除 `is-deleting` 是缩小到 `0.3`、向对应方向偏移并淡出，**不是粒子效果**。
- [`src/components/middle/MessageList.scss`](https://github.com/Ajaxy/telegram-tt/blob/6002824b6532f3d913997ce496d9ab5f9b86bc22/src/components/middle/MessageList.scss)：日期标签、消息内容列，以及与输入区联动的底部预留空间。
- [`src/components/common/Composer.scss`](https://github.com/Ajaxy/telegram-tt/blob/6002824b6532f3d913997ce496d9ab5f9b86bc22/src/components/common/Composer.scss)：当前 `is-chat-composer` 使用紧凑的 pill，输入自动增高，主操作按钮有固定位置；语音、发送、停止等状态共享主操作槽。

Android 仓库：<https://github.com/DrKLO/Telegram>，已移植版本 `68c6775ac373f4bdb30ae9986282dd5ec0407756`。

- [`ThanosEffect.java`](https://github.com/DrKLO/Telegram/blob/68c6775ac373f4bdb30ae9986282dd5ec0407756/TMessagesProj/src/main/java/org/telegram/ui/Components/ThanosEffect.java)：本次在线核对 blob 为 `9d7ace888fd6082a6b207c2dcf0848a907158a7e`，与项目 NOTICE 一致。`longevity=1.5`、`timeScale=1.15`、`uvOffset=.6`；Transform Feedback 更新粒子位置、速度和寿命，`time > longevity + .9` 结束。
- 原始顶点与片元着色器位于 `TMessagesProj/src/main/res/raw/thanos_{vertex,fragment}.glsl`。项目用 Git blob SHA-1 校验原文，完整来源与许可证见 `src/third-party/telegram-thanos/NOTICE.md`。

## 项目实现

- `src/components/useRecentChats.tsx`：一次 IndexedDB 只读事务读取会话活动时间与末条消息；返回简短纯文本摘要。置顶优先、最近活动排序；回复中/等待作答显示对应状态，不订阅每个流式 token。
- `src/ui/layout.tsx`、`layout.css`：48px 会话标识、标题/时间与摘要/状态两行布局；搜索标题和末条摘要、Escape 清空、空结果提示；继续使用已有 ListBox 的键盘选择、行尾菜单与触屏抽屉。
- `src/pages/CourseChat.tsx`、`course-chat.css`：有方向性的收发气泡、常显消息时间、按本地日期分隔；同角色、同日、相隔不足五分钟的消息收紧对话侧圆角。五分钟是本项目分组策略，不是照搬 Telegram 的分组算法。
- 输入区沿用已存在的单行自动增高、附件与模型入口、语音/发送/停止切换，调整表面与圆角；继续支持中文输入法、排队投递和可交互问题卡。
- `src/components/useMessageDeletion.ts`：必须先完成可见消息截图，再提交删除，再播放粒子。截图与删库并行会让源节点提前卸载，`prepareMessageDust` 的有效性检查随即放弃特效。截图失败/超时、减少动态效果或 WebGL2 不可用时照常删除；切换会话和卸载会取消准备与释放 GPU。
- `src/utils/messageDust.ts`：优先截取实际气泡和附件表面，避免给整条空白消息行分配纹理；保留原生着色器与资源清理逻辑。

## 适配边界

这次是源码指导的 Web 界面适配，未搬入 Telegram 的协议、Teact 状态管理或通信功能。AI 回答需要容纳代码、讲义、引用和嵌入组件，因此仍允许较宽的阅读列。会话搜索范围是标题和末条消息摘要，并非历史全文搜索。课程播放器侧栏继续复用删除效果；本轮气泡与日期布局应用于课程问答主页。

## 验证入口

开发服务器启动后，将 `BASE_URL` 指向对应端口：

```sh
npx tsc -p tsconfig.app.json --noEmit
BASE_URL=http://localhost:5186 node scripts/e2e-telegram-chat.mjs
BASE_URL=http://localhost:5186 node scripts/e2e-message-deletion.mjs
BASE_URL=http://localhost:5186 node scripts/test-telegram-thanos.mjs
```

像素对照是同一浏览器内的原生算法参考宿主与项目宿主的对照，覆盖 DPR 1/2、60/120Hz 的 28 个固定帧，不代表与 Android 真机截图逐像素一致。

本次上述类型检查、聊天界面回归、删除回归与着色器对照均通过，Vite 生产构建成功。额外运行旧 `e2e-chat-virtual.mjs` 时，需使用页面实际加载的 HMR 模块 URL 才能访问同一个 store；修正运行时导入后，千条消息窗口、向前分页锚点、触顶加载、无缺失重复四项通过。其后旧脚本引用已不存在的 `.reasoning-chain__blur--top`，因此该旧脚本整体未通过。
