# Recent 会话操作菜单（右键 + 单颗「更多」图标）设计

日期：2026-10-15
状态：**已落地**（`ui/layout.tsx` / `ui/feedback.tsx` / `store/courseChat.ts` / `pages/CourseChat.tsx` / 设置「已归档会话」卡 + `scripts/e2e-recent-menu.mjs`；实测记录见「六」）

## 背景与目标

侧栏 Recent 那一列会话，此前**只有删除**一个动作：行尾一颗垃圾桶图标，悬停 / 键盘聚焦 / 选中时显形。

需求侧补齐四个动作：**重命名 / 归档 / 置顶 / 删除**。

这里真正的问题不是「缺功能」，而是**四个动作往哪放**：

- 全做成行尾图标 → 一行里四颗等权重的图标，紧贴标题，**没有重心**，
  眼睛不知道该看标题还是看图标，行尾还把长标题挤成省略号；
- 全塞进右键菜单 → 触屏没有右键（窄屏侧栏走 Drawer），功能在手机上直接消失；
- 全塞进「更多」 → 窄屏可达，但宽屏上要多一次点击，还丢掉了右键这个肌肉记忆。

目标：**四个动作进同一个菜单**，菜单有**两个入口**（宽屏右键 / 行尾单颗「更多」），
行尾**只留一颗图标**作为视觉重心。

## 一、实测：HeroUI `Dropdown` 能不能接右键

HeroUI 3.2.6 导出 `Dropdown`（`Root/Trigger/Popover/Menu/Item`），但**没有** `ContextMenu`
（也没有 `MenuTrigger` —— 它被包在 `Dropdown.Root` 里了）。

逐层翻包源码（`node_modules/@heroui/react/dist/components/dropdown/dropdown.js`），
`Dropdown` 是 RAC 的薄封装：`Root → MenuTrigger`、`Popover → RAC Popover`（套 `SurfaceContext`）、
`Menu → RAC Menu`、`Item → MenuItemRoot`，样式全部来自 `@heroui/styles` 的
`dropdownVariants`。**结论：能直接用，不必自己写菜单样式。**

右键的处理要看 RAC（`react-aria-components` 1.22.1）的
`useMenuTrigger`（`react-aria/dist/private/menu/useMenuTrigger.mjs`）：

```js
if (trigger === 'press')        interactionProps = { ...pressProps,  ...keyboardProps }
else if (trigger === 'longPress') interactionProps = { ...longPressProps, ...keyboardProps }
else if (trigger === 'contextMenu') interactionProps = contextMenuProps
```

关键点：`contextMenuProps`（在指针位置开菜单）**只在 `trigger === 'contextMenu'` 时才接上**，
而那一档会把 `pressProps` 整个换掉 —— 也就是**「原生右键」与「原生点击」二选一，不能兼得**。

（`MenuTrigger` 还把 `offset` 在 `contextMenu` 档设成 0，因为菜单要贴着指针而不是贴着按钮。）

于是有三条路：

| 方案 | 做法 | 取舍 |
| --- | --- | --- |
| A. `trigger="contextMenu"` + 受控 | 换成右键档，再自己给 `Trigger` 补 `onPress` | 顺带被剥掉 `aria-haspopup` / `aria-expanded` / `aria-controls`（RAC 源码里明确为了不误导读屏而删的），按钮语义打折 |
| B. 默认 `trigger` + 行级 `onContextMenu` 受控打开 | `isOpen` / `onOpenChange` 受控，行上挂 `onContextMenu` 直接 `setOpenId(item.id)` | 菜单锚在**那颗「更多」按钮**上，不是指针位置 |
| C. 自己算指针位置传给 Popover | 复制 RAC 的 `setPoint` 逻辑 | 要重写 overlay 定位，等于自己实现一遍 |

**选 B。** 理由不只是省事：

- 按钮保住完整菜单语义（`aria-haspopup="menu"`、Enter / Space / ArrowDown 都能开），
  键盘和读屏用户拿到的是标准 menu button，不是方案 A 那种半吊子；
- **两个入口锚在同一个点上**。菜单要么总出现在按钮下方，要么总出现在指针下 ——
  「同一个菜单，因入口不同而落在不同位置」比「它没跟着我的右键出现」更容易适应；
- `MenuTrigger` 的内部 `triggerRef` 由 `PressResponder` 无条件挂在按钮上，
  所以受控打开时 Popover 照样能定位，不需要我们碰它的 ref。

## 二、`RecentItem` 的形状

```ts
export interface RecentAction {
  key: string;          // 菜单项 id，同时是 Menu.Item 的 key
  label: string;
  icon: ReactNode;
  onAction: () => void;
  /** 危险动作：文字染 danger 色 */
  danger?: boolean;
  isDisabled?: boolean;
}

export interface RecentItem {
  // …原有字段…
  /** 行尾菜单项。传了就渲染「更多」按钮并接上右键 */
  menu?: RecentAction[];
}
```

**`onDelete` 保留**，不并进 `menu`：它有两个消费者 —— 菜单里的「删除」项，
以及侧栏那圈 `Delete` / `Backspace` 快捷键（ListBox 是复合控件，行尾按钮 Tab 走不到，
键盘用户没有别的路径删某一条，见 `ui/layout.tsx` 里 `focusedRecentId` 的注释）。
删掉它会让快捷键失去判据。

**为什么不做「悬停浮出工具条」**（hover toolbar）：那正是「全都放上图标」的那个版本，
只是把它们从常驻改成悬停 —— 悬停态行尾宽度会跳，且触屏仍然没有。

## 三、触发方式

| 场景 | 入口 |
| --- | --- |
| 宽屏鼠标 | 右键整行 · 或点行尾「更多」 |
| 触屏 | 点行尾「更多」（窄屏**常驻显形**，不跟着悬停） |
| 键盘 | `ContextMenu` / `Shift+F10` 开菜单 · `Delete` / `Backspace` 直接删 |

图标显形条件见 §3.1（初版与现状不同）。

`Shift+F10` / `ContextMenu` 是 WAI-ARIA 规定的「打开上下文菜单」键；
只给右键不给它，右键菜单对键盘用户就是不存在。

### 3.1 行尾图标什么时候显形（同日修订）

初版沿用了删除按钮那套「`group-hover` / `data-[focused]` / `data-[selected]` **任一成立就显形**」，
**外加窄屏常驻**。落地当天用户要求**只留悬停**，于是砍掉后两档：

| 条件 | 现在 | 初版 | 为什么 |
| --- | --- | --- | --- |
| 鼠标悬停该行 | ✅ | ✅ | 宽屏唯一的鼠标入口 |
| 窄屏（≤900px） | ✅ | ✅ | 触屏没有 hover，藏起来这个入口就不存在了 |
| 菜单正开着的那一行 | ✅ | — | 菜单锚在这颗按钮上；锚点跟着鼠标移开而隐身，会变成「菜单浮在空气里」 |
| 该行是当前选中会话 | ❌ | ✅ | 宽屏上总有一颗省略号不请自来地亮着 |
| 键盘焦点在该行 | ❌ | ✅ | **那颗按钮 Tab 根本到不了**（ListBox 是复合控件，整组只占一个 tab 停靠点）。焦点行上让它显形，等于摆一颗「看得见、点不到」的按钮 |

**去掉后两档没有减少键盘用户的任何路径**：他们的入口本来就是 §三 那张表里的
`ContextMenu` / `Shift+F10` 与 `Delete`，从来不是这颗按钮。

「菜单开着的那一行」是这次修订**顺带补上的**：初版有 `data-[selected]` 兜着，
打开菜单的行往往正好是当前会话，所以锚点隐身这个瑕疵被盖住了；
去掉那两档之后它会立刻显形，所以必须显式补回来。

## 四、数据：置顶与归档

`ChatSessionRow` 加两个**非索引**字段（与 `contextCourseIds` / `skillIds` 同款，不升 db 版本）：

```ts
pinned?: boolean;
archived?: boolean;
```

- **置顶**：排序时置顶项在前。组内仍按 `createdAt` **升序**（旧→新）——
  现状如此，这轮不动。排序放在展示层（`CourseChat` 里 `useMemo`），
  **不改 store 里 `sessions` 的顺序**：`bootstrap` 与 `deleteSessionById` 都用
  `sessions[sessions.length - 1]` 取「最新的那条」，一换序这两个默认选中就会跳到错的会话。
- **归档**：Recent **只渲染未归档的**；归档项从设置 → 数据里那张卡走。

⚠️ **归档必须有落脚点**。只把行藏起来而不给查看入口，归档就等于「软删除」——
用户按了归档就再也找不回那条会话（本轮就有这个坑：初版设计把归档项折叠进 Recent 底部，
等于让侧栏多一个分组来承载用户低频的东西）。所以设置里要有「已归档会话」。

**动作的禁用规则**：重命名 / 置顶**生成中也允许**（只改标题与排序位，不碰消息）；
归档 / 删除**生成中禁用**（store 会拒绝，且这两条会改变当前会话的归属）。

## 五、变更清单

| 文件 | 改动 |
| --- | --- |
| `src/store/db.ts` | `ChatSessionRow` 加 `pinned?` / `archived?` |
| `src/store/courseChat.ts` | `renameSession` / `setPinned` / `setArchived` / `archivedSessions` / `refreshArchived`；`sessions` 顺序**不动** |
| `src/ui/icons.tsx` | 加 `archive` / `archive_restore` / `pin` / `pin_off` |
| `src/ui/feedback.tsx` | 加 `promptDialog`（重命名要一个带输入框的对话框，现有的 confirm/alert 都没有输入位） |
| `src/ui/layout.tsx` | `RecentAction`；Recent 行接右键 + 「更多」菜单；`ContextMenu` 键 |
| `src/ui/index.ts` | 导出 `RecentAction` |
| `src/pages/CourseChat.tsx` | 组装四个动作；过滤已归档；置顶排前 |
| `src/components/settings/ArchivedSessionsCard.tsx` | **新增**：已归档会话 + 恢复 / 删除 |
| `scripts/e2e-recent-menu.mjs` | **新增**：菜单四个动作 + 右键 + 归档过滤 |

## 六、实测与验证

`scripts/e2e-recent-menu.mjs`（Playwright，1440×900 + 一档窄屏，**不需要 API key** —— 全在渲染与交互层）。
初版连跑 4 次 **10/10**；§3.1 修订后（加第 2、6 两条）又连跑 2 次 **12/12 全过**，无 flake：

| # | 断言 | 结果 |
| --- | --- | --- |
| 1 | Recent 渲染出至少一条会话 | ✅ |
| 2 | **宽屏行尾「更多」只认悬停**：选中行 / 焦点行都不常驻（§3.1） | ✅ |
| 3 | **每行只有一颗行尾图标**（重心就是这一颗） | ✅ |
| 4 | 点「更多」→ 菜单打开，四个动作都在 | ✅ |
| 5 | **右键整行 → 同一个菜单打开，且 `document.activeElement` 落在菜单里** | ✅ |
| 6 | **菜单开着时锚点按钮不隐身**（指针挪到菜单上再读 `opacity`） | ✅ |
| 7 | 点菜单外面 → 菜单关掉 | ✅ |
| 8 | 重命名 → 回车 → 侧栏标题变了 | ✅ |
| 9 | 置顶 → 该行排到 Recent 最前 | ✅ |
| 10 | 归档 → 该行从 Recent 消失 | ✅ |
| 11 | 设置 → 数据 → 已归档会话：能看到并恢复 | ✅ |
| 12 | 窄屏：行尾「更多」**常驻显形**（`opacity === 1`） | ✅ |

第 2 条刻意挑**选中行**来断言，而不是随便挑一行：只测「鼠标移开 → 全是 0」的话，
把 `data-[selected=true]` 那条例外加回去照样能过 —— 那条断言必须钉在**改动本身**上。

第 4 条是 §1 那个判断的落点：右键开出来的菜单**焦点确实进了菜单容器**，
方向键能走到第一项、Escape 能关 —— 不是「只能看不能用」的浮层。
（实测 `ArrowDown` 之后 `activeElement` = `[role=menuitem][data-testid=chat-recent-1-menu-rename]`。）

### 6.1 落地时被 e2e 揪出来的两个真 bug

| # | 症状 | 根因 | 修法 |
| --- | --- | --- | --- |
| 1 | 归档**唯一**那条会话后停在空荡荡的对话页：Recent 空、消息区还亮、顶栏标题掉回「AI 助手」 | `setArchived` 把行踢出 `sessions` 就完事，没抄 `deleteSessionById` 那条「一个都不剩就现开一条」的规矩 | 与删除同款：一个都不剩时 `newSessionRow()` 顶上 |
| 2 | 在设置里点「恢复」，那一行**赖在归档列表里不消失** | `patchSession` 只 `map` 了一遍两个列表。恢复之后那条行根本不在 `sessions` 里，map 它什么也不会发生；`archivedSessions` 那边则被换成了 `archived: undefined` 的行 | 两边都按 `archived` 重新归位：`sessions` 过滤掉已归档的，`archivedSessions` 增删对应那条 |

第 2 个提醒的是一句通用的话：**「同步一份列表」和「这份列表该增还是该删」是两回事**。
只 map 不 filter 的写法在改名/置顶上看不出问题（那两个字段不影响归属），
到归档这种**改变归属**的动作上就露馅了。

### 6.2 测试本身踩的两个坑（都不是产品 bug，但值得记）

1. **菜单退出动画 ≈150ms**：只 `press('Escape')` 就做下一步，下一次右键会打到**正在退场**的菜单上，
   行上的 `onContextMenu` 压根没触发，菜单永远开着 —— 症状是后面每条断言连锁失败，
   报成「body intercepts pointer events」，极具误导性。`closeMenu()` 必须等 `state: 'detached'`。
2. **落库是异步的**：重命名/恢复都要先写 IndexedDB 再 `setState`，对话框关掉那一刻列表往往还是旧的。
   固定 sleep 不靠谱（慢机器不够、快机器白等），改成轮询 DOM 等**用户真正看得见的那个结果**。
   —— 顺带一提：如果按固定 sleep 写，「置顶」和「归档」两条会**假通过**：
   那时改名早已落地，`titles[0].includes('改过的标题')` 自然成立。断言必须各自等自己的前提。

### 6.3 顺带修好的一处既有断裂（与本轮无关）

`scripts/e2e-course-chat-cards.mjs` 的输入框选择器写的是 `.course-chat__input textarea`
（**后代**选择器，假定 class 在容器上），而 HeroUI 的 `TextArea` 把 `className` 落**在 textarea 元素本身**，
于是这条选择器一条都匹配不到。后果：凡是走 `typeAndSend` 的用例全部超时，
报成「输入框不可见」，看着像页面挂了。

实际影响：第 1 组（不用 `typeAndSend`）全过，第 2/3/4/5 组**整组假失败** ——
也就是跨页继续、目录整理方案卡、轮次用尽这些链路**一直没有真正的回归保护**。
改成同时收两种形态后，从 5 条失败降到 3 条（多出 2 条真实覆盖跑起来了）。

**剩余 3 条失败与本轮无关**，都在没碰过的地方：
`[data-testid="video-item"]` 等课程库页选择器同样是迁移期遗留的失效 testid、
`folders / folderId 落库后的课程库归位`、以及轮次用尽的提示文案。

## 七、⚠️ 仓库里一处与本轮无关、但会挡住 `npm run build` 的问题

`src/components/settings/SettingsContent.tsx`（1451 行）**已 `git add` 但不在 HEAD 里**，
是 HeroUI 迁移过程中的半成品：`import ... from '../store/settings'` 这类路径全部指向不存在的模块
（从 `src/components/settings/` 出发应该写 `../../store/settings`），全仓**没有任何地方引用它**。

它让 `tsc -b` 报 **159 个错**。之前 `npm run build` 是过的 —— 因为
`node_modules/.tmp/tsconfig.app.tsbuildinfo` 是一份**陈旧的增量缓存**，里面记着「这些文件查过了、没问题」，
于是 tsc 直接跳过了。**清一次缓存（或任何一次全新 clone / CI）就会炸。**

本轮没有动这个文件（它是别人的在途工作，删 1451 行不该我替用户做主），
但请尽快处置：补完路径让它编译，或直接从索引里拿掉。