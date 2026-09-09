# 移动端 UI 适配 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让网课学习助手在手机竖屏（≤640px）下全功能顺手可用，桌面/平板布局零影响。

**Architecture:** 新增 640px 手机断点（现有 900px 平板竖屏断点保留）。播放页手机端用「顶部视频区 + panel-host（display:none 保活切换）+ 底部 Tab 栏」替代 antd Tabs；`useIsMobile()` hook 挂 `body.is-mobile` 类供 CSS 覆盖；键盘处理用 `interactive-widget=resizes-content` + visualViewport 同步 `--vvh` 全局页高。库页/设置页纯 CSS + 局部条件渲染微调。

**Tech Stack:** React 18 + antd 6 + Vite + Playwright（e2e）

**项目非 git 仓库：跳过一切 commit/worktree 步骤。测试基建为 Playwright e2e（无单元测试），验证以 `npm run build` + e2e 脚本为准。**

---

### Task 1: useIsMobile hook + 全局键盘适配

**Files:**
- Create: `src/utils/useMobile.ts`
- Modify: `src/App.tsx`（顶层调用一次）
- Modify: `index.html`（viewport 加 `interactive-widget=resizes-content`）
- Modify: `src/theme.css`（`.page { height: var(--vvh, 100%) }`）

**要点：**
```ts
// useMobile.ts
export function useIsMobile(): boolean  // matchMedia('(max-width: 640px)')，change 事件订阅
export function useMobileGlobals(): void  // isMobile → document.body.classList.toggle('is-mobile')；
// visualViewport.resize → documentElement.style.setProperty('--vvh', vp.height + 'px')
```

### Task 2: theme.css 手机断点样式

**Files:** Modify `src/theme.css`

**要点（全部在 `@media (max-width: 640px)` 或 `body.is-mobile` 下，不影响宽屏）：**
- safe-area：`.page-header` 顶部 padding 叠加 `env(safe-area-inset-top)`；`.mobile-tabbar` 底部 `env(safe-area-inset-bottom)`
- `.panel-host { flex:1; min-height:0; display:flex; flex-direction:column; background:#fff; border-radius:8px; padding:0 12px; }`
- `.panel-slot { flex:1; min-height:0; display:flex; flex-direction:column; } .panel-slot[hidden] { display:none; }`
- `.mobile-tabbar { flex:none; display:flex; background:#fff; border-top:1px solid #f0f0f0; }` 按钮 flex:1、高 56px、图标+文字纵向、激活态 `#1677ff`
- 触控：`body.is-mobile .ant-btn-sm { min-height:32px }`；`.page-header .ant-btn { min-width:40px; min-height:40px }`
- 防 iOS 聚焦缩放：`input, textarea { font-size: 16px !important }`（仅 640px 断点内）
- 字幕条目 `.sub-item` padding 加大；库页 `.import-task-name { min-width:0 }`；`.ant-card-head` 允许 wrap

### Task 3: Player.tsx 手机分支

**Files:** Modify `src/pages/Player.tsx`

**要点：** `const isMobile = useIsMobile()`；`activeTab` state（默认 `'subs'`）。手机端 side-pane 替换为：
```tsx
<div className="panel-host">
  <div className="panel-slot" hidden={activeTab !== 'subs'}><SubtitlePanel …/></div>
  <div className="panel-slot" hidden={activeTab !== 'handout'}><HandoutPanel …/></div>
  <div className="panel-slot" hidden={activeTab !== 'chat'}><ChatPanel …/></div>
</div>
<nav className="mobile-tabbar">三个字图标按钮</nav>
```
**保活**：用 `hidden` 而非条件卸载——保留 ChatPanel 输入草稿/截图、HandoutPanel 预览、转写进度显示。桌面/平板分支（antd Tabs）一行不动。

### Task 4: ChatPanel 头部重排（仅 mobile）

**Files:** Modify `src/components/ChatPanel.tsx`

**要点：** 思考灯泡按钮 mobile 时上移到会话行尾部；第二行 = ModelPicker +（thinking 开启时的 Segmented）。非 mobile 结构不变。

### Task 5: HandoutPanel 手机适配

**Files:** Modify `src/components/HandoutPanel.tsx`

**要点：**
- 技能 Popover 内容宽 `width: 340` → `width: 'min(340px, calc(100vw - 64px))'`（内联，零 CSS 改动）
- docx 预览等比缩放：renderAsync 完成后若 isMobile，对 `section.docx` 逐页 `transform: scale(avail/scrollWidth)` + `transform-origin: top left` + 负 marginBottom 补偿布局高度；window resize 重算

### Task 6: Library / SubtitlePanel / Settings 微调

**Files:**
- Modify `src/pages/Library.tsx`：isMobile 时 List.Item actions = [学习, ⋯Dropdown(改名/删除)]，删除确认改 `modal.confirm` 编程式；任务行文件名 span 加 `className="import-task-name"`
- Modify `src/components/SubtitlePanel.tsx`：字幕条目加 `className="sub-item"`（样式在 Task 2 的 CSS）
- Settings：零 TSX 改动，纯 Task 2 CSS（card-head wrap）

### Task 7: e2e-mobile.mjs + 全量验证

**Files:**
- Create: `scripts/e2e-mobile.mjs`（参照 e2e-player-enhance.mjs 风格）
- Modify: `README.md`（功能清单提手机适配 + 测试段加一行）

**e2e 覆盖（无需 API key）：** 390×844 视口 + hasTouch → 导入视频 → 进播放页 → `.mobile-tabbar` 存在且三按钮可切换 → 各面板占位文案正确显示 → video 可见且宽撑满 → 桌面 Tabs `.ant-tabs` 不存在。

**全量验证命令：**
```bash
npm run build                    # tsc 零报错
npm run preview &                # 4173
TEST_FILE=… node scripts/e2e-mobile.mjs
TEST_FILE=… node scripts/e2e-import.mjs           # 桌面回归
TEST_FILE=… node scripts/e2e-player-enhance.mjs   # 桌面回归（含 500px 窄屏段）
```

### YAGNI 裁剪（已确认）
不做横屏专属布局（播放器全屏兜底）、不做手势切 Tab、不做断点系统抽象、e2e-mobile 不含 SF_KEY 链路。

---

## 实施备忘（2026-09-07 完成后补记）

1. **Vidstack 顶部控制组的隐藏规则**：`[data-media-player]:not([data-started]) [data-sm] .vds-controls-group:not(:nth-child(3))` 会在「视频从未播放 + small layout（宽<576 或 高<380）」时隐藏顶部控制组（倍速按钮所在）。这导致 e2e-player-enhance 第 7 步在 reload 后断言失败——**与移动适配无关的环境行为**（用 0px 断点禁用移动分支后依旧复现）。修法：e2e 先 play→pause 置位 `data-started` 再断言。
2. **slots 引用稳定性**：`DefaultVideoLayout` 的 `slots={{...}}` 字面量每次渲染都是新对象，断点切换触发重渲染时 Vidstack 会重建 slot 内容。已用 `useMemo` 固定（Player.tsx `layoutSlots`）。
3. e2e-player-enhance 第 7 步同时补了 `mouse.move` 进播放器（视口变窄后原鼠标坐标越界，控制栏 idle 隐藏导致按钮不可见）。

