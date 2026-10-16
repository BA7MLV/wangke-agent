# 设置界面全面 HeroUI 化：去自写 CSS + `#/settings` 恢复可达

- 状态：**已实现**（tsc / 构建 / 探针见 §5；未跑通的历史脚本见 §6）
- 日期：2026-10-14
- 需求：`2026-10-14-app-shell-heroUI-design.md` 把应用外壳换成了 HeroUI 组件 +
  Tailwind 语义令牌，但设置这一块仍在用三份自写 CSS 描述版式：
  `components/settings-modal.css`（320 行，弹窗骨架）、
  `components/settings/models.css`（629 行，模型模块内部）、
  `ui/layout.css` 里的内容原语段（`section-card` / `field` / `row` / `stack` /
  `help-tip` / `banner` / `empty-state` / `skill-row` …）。
  要求：**设置界面全部改用 HeroUI 组件实现，不再有自写 CSS**。
  同时修掉一个附带问题：`#/settings` 已退化成重定向，9 个已登记脚本进不去设置。

---

## 0. 一句话方案

设置面（弹窗骨架 + 6 个模块 + 4 张数据卡）的版式与配色全部改写为 HeroUI 组件 +
Tailwind 工具类；五个共享内容原语（`SectionCard` / `Field` / `EmptyState` /
`Banner` / `HelpTip`）**保留组件名与既有 props，内部改渲染 HeroUI 组件**，
于是其他页面（库页 / 播放页 / 学习页 / 对话页）不改一行代码也跟着换掉。
三份 CSS 里的设置相关规则整段删除。`#/settings` 改成「打开设置弹窗，
模块由 hash 指定」。

## 1. 改动清单

| 位置 | 改动 |
|---|---|
| `src/ui/layout.tsx` | `SectionCard` → `Card` + `Card.Header`/`Title`(h2)/`Description`/`Content`；`Field` 新增 `layout` 变体（`row` \| `block`），去掉 `field--stack` 逃生口；`EmptyState` → HeroUI `EmptyState` + `Typography`；`Banner` → HeroUI `Alert`（`info→accent`、`warning→warning`、`error→danger`）；`HelpTip` 保留 `<details>` 但样式改 Tailwind |
| `src/ui/layout.css` | 删除内容原语段（第 21–350 行里的 `section-card` / `field` / `t-input` / `t-error-msg` / `skill-*` / `storage-progress-text` / `help-tip` / `banner` / `empty-state`）；保留 `.row` / `.stack` / `.text-secondary` / `.tag-mini`（其他页面还在用，见 §6） |
| `src/components/settings-modal.css` | **删除文件**。骨架改 Tailwind：`frame` / `nav` / `content` 三块与窄屏折叠全部内联到 `SettingsModal.tsx` |
| `src/components/settings/models.css` | **删除文件**。模型模块内部（槽位行 / 供应商折叠行 / 候选面板 / 能力徽标 / 状态点）改用 `Card` / `Disclosure` / `Chip` / `Popover` / `ListBox` + Tailwind |
| `src/components/settings/*.tsx` | 六个模块去掉 `field--stack`，行式设置项改 `layout="row"`；`className="row"` 等自写工具类换 Tailwind |
| `src/components/{StudyTime,Storage,Migration,Skills}Card.tsx` | 同上；`skill-row` / `tag-mini` / `storage-progress-text` 换 Tailwind + `Chip` |
| `src/App.tsx` | `#/settings` 与 `#/settings/<模块>` 改为打开弹窗（不再是 `Navigate`） |
| `src/components/SettingsModal.tsx` | 支持从 URL 读取模块；关闭时把 hash 还原成进设置前的位置 |
| `scripts/probe-app-shell-material.mjs` | 分区标题断言从 `.section-card__title` 换成 `[data-slot="card-title"]`（类名已不存在，旧选择器会**空集通过**、静默失去覆盖） |

## 2. 关键决策

### 2.1 原语保留组件名、只换内部实现

`SectionCard` 有 12 个调用点，横跨设置、库页、学习页、对话页、guest 页。
把它们的样式写死成 Tailwind 工具类再让各调用点直接用 `Card`，等于**同时重写
5 个页面的版式**，那是重写设计而不是迁移。

所以：**名字与 props 不变，内部换成 HeroUI 组件**。设置面因此自动 HeroUI 化，
其他页面不改代码也拿到同一套令牌 —— 这正是上一轮 §2.3 里被推迟的那件事
（「要彻底去掉，需要先给它们设计变体 API，再改设置弹窗与四个调用点」）。

### 2.2 `Field` 用 `layout` 变体替掉 `field--stack`

旧实现里「行式（左标题 + 右控件）」是**设置弹窗的 CSS 覆盖**
（`.settings-modal__content .field { display: grid … }`），其他页面拿到的是
纵向默认版式。这个覆盖是隐式的：同一个 `<Field>` 在不同容器里长得不一样，
而调用方看不出来。

新实现把版式变成显式参数：

- `layout="block"`（默认）：标签 → 控件 → 说明，纵向。库页 / 讲义面板用。
- `layout="row"`：`[标签 + 说明] | [控件]` 两列，控件右对齐。设置面用。

`field--stack` 随之消失 —— 它当年的唯一用途就是**逃出**那个隐式行式覆盖
（`grid-template-columns: 1fr` 把它压回单列）。有了显式 `layout` 之后，
「控件整行铺开」就是 `block` 本身，不需要第三个档位。

窄屏回落（< 760px 行式失效）写在 `Field` 内部的 Tailwind 里：
`max-[760px]:block`，断点只出现在一个地方。

### 2.3 为什么 `Field` 的标签不用 HeroUI 的 `Label` / `Description`

两个都是 React Aria 的**字段上下文内**组件：

- `Description` 在没有 description 插槽的上下文里**直接返回 `null`**
  （`useHasTextSlot('description')`），拿来当独立的说明文字会静默不渲染；
- `Label` 需要挂在一个真正的控件上（`htmlFor` / 字段 context）。行式版式里
  标签在**左列**、控件在右列，标签不在控件内部，挂上去反而多一个没有关联
  对象的 `<label>`。

所以 `Field` 的标签与说明是普通元素 + Tailwind 令牌类，**这不是「漏用组件」**：
HeroUI 没有「标签 + 控件 + 说明」这一层的布局组件，`Fieldset` 是给
**成组**字段用的（渲染 `<fieldset>`/`<legend>`），塞单行进去语义是错的。
控件本身（`Switch` / `Select` / `Slider` / `TextField` / `ToggleButtonGroup` /
`Checkbox`）全部是 HeroUI 组件。

### 2.4 `HelpTip` 不换 `Popover`

HeroUI 的 `Popover.Trigger` 有个已知坑，本仓库已经踩过并在
`ModelsModule.tsx` 里留了记录：它渲染成 `<Pressable><div role="button" /></Pressable>`，
`Pressable` 自己 `usePress` 把 press 事件合到 children 上，与 DialogTrigger
注入的 `onPress` 互相覆盖 —— 结果是**点击没反应且不报错**。绕开它要自己画
原生 `<button>` + 受控 `isOpen` + `triggerRef`，为了一个问号气泡引入这套
机制不划算。

`HelpTip` 保持 `<details>`（无 JS 依赖、键盘可达、点外面也能收），
只把样式从 `layout.css` 搬进 Tailwind。它只被库页用到，不在设置面内。

### 2.5 `#/settings` 改成「打开弹窗」而不是重定向

上一轮把它写成 `<Navigate to="/">`，理由是「旧书签别撞空白页」。但那让
**9 个已登记脚本**（`e2e-build-info` / `e2e-bili-cookie` / `e2e-storage-card` /
`e2e-settings-skills` / `e2e-providers` / `e2e-study` / `e2e-livelink` /
`e2e-skills-dedupe` / `motion-smoke`）全部进不去设置 —— 它们都靠
`page.goto('#/settings')` 到达，而弹窗只在用户点按钮时才开。

新做法：`#/settings` 打开弹窗，`#/settings/<模块>` 直接落到该模块；
关闭时把 hash 还原成进入前的位置（默认 `/`）。这样脚本能到达设置，
深链（「设置 → 数据」的书签）也说得通。

## 3. 结构

```
SettingsModal（Modal.Root / Backdrop / Container / Dialog，全部 HeroUI）
  └ frame（flex，min-[761px]:row，padding-top 52px 给右上角关闭按钮）
      ├ 模块列 ListBox（w-[13.5rem]，窄屏折成横向标签条）
      └ 内容区（flex-1，overflow-y-auto，bg-background）
          └ <ActiveModule />
              └ SectionCard → Card + Card.Header(h2) + Card.Description + Card.Content
                  └ Field layout="row"（label/hint 左列，控件右列）
```

模型模块内部：
```
Card（选择模型）
  └ 槽位行 Card variant="secondary"（图标 + 槽位名/说明 + Select + 模型按钮）
      └ Popover（受控 isOpen + 原生 button triggerRef）
          └ SearchField + ListBox（收藏分组 / 供应商分组，Header 用 react-aria-components）
Card（模型供应商）
  └ 供应商行 Disclosure（Trigger = 摘要行；Content = 地址 / Key / 能力 / 能力数据源）
      └ Chip（能力标记）、状态点（Tailwind + 令牌）
```

## 4. 不变量（改完必须仍成立）

1. **设置面不出现自写类名**：`settings-modal.css` / `models.css` 删除，
   设置相关的 `layout.css` 规则删除。
2. **`data-testid` 全部保留**，且**读 `.value` 的那些 testid 必须挂在真正的
   `<input>` 上**（`e2e-providers.fieldValue`、`e2e-bili-cookie`、
   `e2e-livelink` 都是 `locator('[data-testid=x]').evaluate(el => el.value)`）——
   挂到 `TextField` 包装层上会读到 `undefined`。
3. **分区标题是原生 `<h2>`**（`probe-app-shell-material` 的断言）。
4. **一次只渲染一个模块**（「模型」模块会拉能力元数据、「内容源」会探测 B 站
   登录态，不能因为用户只是来看倍速就发这些请求）。
5. **设置不是路由**：关闭后回到进入前的页面。
6. `#/settings` 与 `#/settings/<模块>` 都能到达设置。

## 5. 验证

| 手段 | 覆盖 |
|---|---|
| `tsc -b` | 全量类型检查 |
| `vite build` | 生产构建 |
| `probe-app-shell-material.mjs` | 三路由 × 三视口 × 明暗（外壳不回归；分区标题断言改 `[data-slot="card-title"]`） |
| `probe-settings-heroUI.mjs`（新增） | 设置面：弹窗开合、模块切换只渲染一个、无自写类名残留、六模块与四卡都渲染出 h2 分区标题、`#/settings/<模块>` 深链、关闭后 hash 还原 |
| `e2e-settings-skills.mjs` | 写作技能列表 + 对话框开 / 存 / 拦 / 关（脚本按 HeroUI 的 DOM 更新） |
| `e2e-storage-card.mjs` | 存储占用六分类 + 配额 + 持久化（`.storage-progress-text` → `data-testid`） |

## 6. 已知未做

- **`.row` / `.stack` / `.text-secondary` / `.tag-mini` 仍留在 `layout.css`**：
  它们被库页、学习页、卡片面板、`ModelPicker` 大量使用，删掉要同时改 6 个
  非设置文件。设置面已经不再用它们（改 Tailwind），但整仓去掉这四个工具类
  属于「全仓清理」，与本次「设置面 HeroUI 化」是两件事。
- **`.skill-list` / `.skill-row` / `.storage-progress-text` / `.t-input` /
  `.t-error-msg` 已删除**（只被设置面使用）。
- **一批设置相关的历史脚本是 mdui 时代写的、与当前 DOM 早已不符**，
  本次只更新了能真实跑通的几个（见 §5）。明确记录、不假装绿：
  - `e2e-providers.mjs`：断言 `mdui-list-item` / `mdui-menu-item` /
    `#model-llmModel-options` / `fav-tab-chat` / `model-llmModel-pick` /
    `provider-asrModel-nocap` —— 这些结构在「模型」模块改成检索面板那一轮
    （`2026-10-05-multi-provider-design.md`）就已不存在，**与本次改动无关**，
    需要单独一轮重写。
  - `e2e-player-enhance.mjs` 的 `[data-testid="rate-input"] input`：testid 现在
    挂在 `<input>` 自身，后代选择器命中 0 个。
  - `e2e-livelink.mjs` 的 `[data-testid="live-relay"] input` 同理。
- 设置面**没有截图比对**：`e2e-shots/` 里的设置截图仍是旧版，需要人工看一次
  （`Card` 的默认底色/内边距与旧的 `.section-card` 不完全一致）。
