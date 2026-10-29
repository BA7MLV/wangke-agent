# 一套 UI：对话主页 + Bot 辅助栏

2026-10-28 起，界面只有一套外壳（`ui/layout.tsx` 的 `PageShell`，HeroUI）：

- **主页永远是对话**（`#/`、`#/chat`、`#/course-chat`）。左侧是 HeroUI 导航：新会话 / 资料 / 项目，最近会话，底部设置。不再有 Telegram 式的搜索顶行、筛选标签和悬浮新建按钮。
- **Bot 是主页的一项功能**：顶栏 Bot 按钮开合右侧辅助栏（`PageShell` 的 `aside`）。≥1100px 与主列并排；更窄时进右侧 Drawer，≤640px 铺满全屏。宽屏记住开合状态，手机每次从关闭开始（`store/botPanel.ts`）。
- **Bot 栏**：标题即会话切换器（pull-down 菜单），右侧三颗 44pt 按钮：新对话、更多、关闭。消息样式与课程问答一致（`pages/bot.css`），没有气泡尾巴、送达勾、浮动日期。
- `#/bot?thread=…` 不再是页面：打开 Bot 栏并切到该线程，然后回到主页（网关「打开对话」与旧书签都走这里）。
- **项目页**也在 `PageShell` 里：顶栏返回 / 项目设置 / 更多 / 新会话；手机上列表与对话是两屏，顶栏返回键先回列表。
- 已删除：`ModeShell`（第二套竖栏外壳）、`ChatSidebarHeader`、`bot-home.css`、`bot-workspace.css`。

## 设置

| 模块 | 内容 |
| --- | --- |
| Bot（仅云端） | 等待批准、权限（即时保存，没有「保存」按钮）、信任的 Bot、正在运行的任务、Bot 管理 |
| 消息渠道（仅云端） | 微信 iLink / 飞书。列表 → 添加 / 详情，在同一面板里推入返回 |
| 数据 | 本机：存储、迁移包、已归档；云端：服务器存储、同步、旧数据导入、已归档、Passkey、退出、重置 |

行级控件统一用 `components/settings/controls.tsx`（HeroUI Select / Switch / Input），不再有原生 `<select>` / checkbox。

## 微信 iLink 接入

1. 添加 → 微信：渠道立即创建并拉取二维码。
2. 扫码：网页自动长轮询（服务端 30 秒收线视为「仍在等待」），状态依次为「用微信扫一扫 → 在手机上确认登录 → 已登录」；过期自动换码 3 次，之后显示「刷新」。
3. 绑定：生成 `/pair XXXXXXXX`（8 位 Crockford Base32，10 分钟有效，忽略大小写），拷贝后发给 Bot；绑定成功后该区块自动变为「已绑定」。

服务端：`getupdates` 遵循平台下发的 `longpolling_timeout_ms`；飞书 `tenant_access_token` 按 `expire` 缓存，令牌失效码会清缓存。

## 验证

```sh
npx tsc -p tsconfig.app.json --noEmit && npx tsc -p tsconfig.api.json --noEmit
npm run check:i18n
npx vite build && npx vite preview --port 4173 &
BASE_URL=http://localhost:4173 node scripts/e2e-home-bot-panel.mjs
```
