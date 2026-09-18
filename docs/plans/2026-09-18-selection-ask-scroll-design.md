# 划词浮层被一次滚动永久吃掉（SelectionAsk scroll）

**状态：已实现 + 已验证**（2026-09-18）。变更：改写 `src/components/SelectionAsk.tsx` 的滚动处理，
新增回归用例两条（`scripts/e2e-materials.mjs` 第 4 节末尾）。

## 起因：iPad 上报「只有第一页能划词提问」

用户原话：「当前文档好像只有第一页可以滑动提问？」

不是 PDF 渲染问题——第 2 页的文本层、`data-askable`、选区反查全都是好的。
问题出在**全局划词浮层对滚动事件的处理**上，而且对 PDF / Word / 讲义 / 字幕四个来源一视同仁。

## 根因（实测）

起 `preview`（真 dist）用 Playwright 跑 `scripts/fixtures/sample-zh.pdf`（3 页），逐项量：

| 操作 | 结果 |
|---|---|
| 第 1 页划词 | ✅ 浮层出现，`第 1 页` |
| 第 2 页划词 | ✅ 浮层出现，`第 2 页` |
| 第 2 页划词后**滚动 1px** | ❌ 浮层消失，**2.5s 后仍不回来**，而选区还在 |
| 滚动后手动派发一次 `selectionchange` | ✅ 浮层回来，位置正确跟随（上移 60px） |

渲染层是好的：每页都挂了 `data-askable`，第 2 页文本层 20 个 span，
`.textLayer` 与 canvas 尺寸一致（748×1057）。**所以这是一个纯交互层的 bug。**

出问题的代码是 `SelectionAsk.tsx` 的滚动处理：

```ts
const onScroll = () => {
  setHit(null);   // ← 无条件清空
  hideBar();
};
document.addEventListener('scroll', onScroll, true);
```

而浮层**只在 `selectionchange` 事件里重算**（140ms 防抖）。滚动清空之后不会再有新的
`selectionchange`——选区没变——于是浮层再也不回来。

原注释写的理由是「滚动后锚点失效 → 直接收起（选区本身还在，重选成本很低）」。
**这个假设只在鼠标端成立**：鼠标滚轮滚动时选区不会被系统碰，用户重新划一次就行。
触摸端不成立——**iOS 长按划词本身就会带动滚动**（选区贴边时 auto-scroll、
原生选择菜单弹出时调整视口），于是"重选一次"这个退路也被堵死：每一次重选都会再触发一次滚动。

## 为什么恰好是「第一页」

第 1 页在滚动容器顶部，长按划词时系统想带动滚动也无处可去
（`.mr-scroll` 还设了 `overscroll-behavior: contain`，连橡皮筋都吃掉），所以**不产生 `scroll` 事件**；
一旦滚到第 2 页，划词时的任何一点滚动都会命中这条路径。

这也解释了为什么 e2e 一直没抓到：`e2e-materials.mjs` 第 4 节的划词用例只测了第 1 页
（`selectPageText(0)`），而且用 Selection API 模拟选区，**本身不产生任何滚动**。

## 修复

滚动中仍然隐藏（锚点已失效，浮层跟着滚会飘），但**停止后重算一次**：

```ts
const onScroll = () => {
  // 框选浮层是「一次性投递」，没有 DOM 选区可重算 —— 滚动后照旧收起、不恢复
  const wasRegionBar = !!useSelectionAsk.getState().bar;
  hideBar();
  setHit(null);            // 滚动中不显示：锚点是视口坐标，跟着滚会飘
  window.clearTimeout(scrollTimer);
  if (wasRegionBar) return;
  scrollTimer = window.setTimeout(() => setHit(readSelection()), 120);
};
```

**`wasRegionBar` 那个守卫不是防御性编程，是补一个真实会被触发的怪象**：
「划词 → 不点浮层按钮、直接去点框选」是真实路径，此时**旧选区并没有被清掉**
（`onPointerDown` 只 `setHit(null)`，不 `removeAllRanges()`）。
少了守卫的话，框选浮层在滚动后会被那个残留选区"顶替"，用户看到浮层**从框选内容变成划词内容**——
一次莫名其妙的变身。旧实现里滚动是把两者一起清掉的，所以这是本次修复**新引入**的行为，必须一并收住。

为什么是「重算」而不是别的：

- `readSelection()` 每次都会重新取 `range.getBoundingClientRect()`，所以位置天然跟着更新，
  **不需要额外记滚动偏移**——实测已证明（滚动 60px，浮层跟着上移 60px）。
- 为什么不用「滚动距离阈值」区分「划词带动的小滚动」与「用户主动滚动」：
  阈值是魔法数，且用户主动滚一点也会想保留浮层。**判据用「选区还在不在」比「滚了多少」更本质。**
- 为什么滚动中先 `setHit(null)`：不这么做的话，滚动期间浮层会停在旧锚点上，
  快速滚动时表现为"浮层在页面上乱飘"，观感比"暂时收起"差。

**一处有意的行为变化**：用户主动滚走后，如果**划词**的选区还在，浮层会在滚动停止后重新出现。
取舍理由——选区还在就说明提问意图还在；浮层容器是 `pointer-events: none`，
不挡正文，点空白处（`pointerdown`）即可收起。（框选浮层不在此列，见上面的守卫。）
若将来觉得「滚走了还弹回来」烦，改法是加「滚动距离超过视口高度一半就不恢复」的条件——
但那是魔法数，一期不做。

## 验证

`scripts/e2e-materials.mjs` 新增三条（第 4 节两条、第 5 节一条），无需 API key：

| 断言 | 说明 |
|---|---|
| 滚到第 2 页后划词 → 浮层标 `第 2 页` | 覆盖「非首屏页也能划词」——原用例只测第 1 页 |
| 划词后滚动 40px → 浮层仍在，**且位置跟着动了** | ⭐ 同时锁住「没被永久吃掉」与「确实重算过」：只断言"浮层存在"会在旧实现下漏报（旧实现里浮层已经消失），所以必须再断言 `boundingBox().y` 变化 |
| 框选浮层滚动后**收起**（不变成划词浮层） | 锁住 `wasRegionBar` 守卫。用例先刻意留一个残留选区（划完词直接去点框选），否则滚动后的重算本来就返回 `null`，测不出守卫 |

第二条刻意不用「先消失再出现」的中间态断言：重算延迟 120ms 与 `waitForFunction` 的轮询
窗口接近，靠它判存在会时灵时不灵。**用位置变化来证明重算，比用存在性证明时序更稳。**

另外，因为这次修的是**触摸端才暴露**的 bug，另跑了一档触摸视口验证（`hasTouch: true`，
iPad 768×1024 与 iPhone 390×844 两个视口，覆盖浮层的两条渲染分支）——
结论与明细见「已知未做」第 1 条。**e2e-materials 那三条全跑在 1440×900 桌面视口，
对这一档零覆盖。**

## 实施记录

1. **`npm run build` 被宿主文件审批拦住，所以正式档（preview / 真 dist）没跑成。**
   `tsc -b` 通过、`vite build` 跑到 2865 个模块、PWA 生成了 `dist/sw.js`，然后报：

   ```
   Could not load …/node_modules/pdfjs-dist/build/pdf.mjs (imported by src/materials/pdf.ts):
   Sensitive content approval timed out. The operation was not authorized and was blocked.
   ```

   与 §12.14 记的 `@mdui/jq/functions/param.js` 是同一类问题，**不是代码问题**。
   **重试一次，同样被拦**（第二次耗时 4m16s，报错逐字相同）——所以不是偶发超时。

   **两次失败构建都没有损坏产物**：`dist/assets/*` 仍是上一次成功构建的（10:06），
   而新写的 `dist/sw.js` 里 89 条预缓存清单**磁盘缺失 0 条**——因为 workbox 是拿
   `globPatterns` 扫 `dist` 目录，产物没被覆盖，清单自然与磁盘一致。
   代价是**产物里不含本次修复**，所以 preview 档跑出来的红不能当回归看（同 §12.14）。

   副作用：`dist/index.html` 停在 10:06 而 `dist/sw.js` 是 12:17，**两者版本不一致**。
   对本地 `preview` 无影响（它直接读磁盘、不看 SW 清单），但**这份 dist 不该拿去部署**——
   要部署得先让 build 成功。

2. **验证是在 dev 档（5173）完成的，32 条全绿。** 按 §8 那句「必须走 preview 才算数」，
   这次修复的产物形态验收**仍是欠账**——待审批放行后 `npm run build` +
   `node scripts/e2e-all.mjs --only=e2e-materials` 补上。
   不过本修复不碰构建产物形态（只改一个组件的运行时逻辑），dev 档对它的信息量是充分的。

## 已知未做

1. **没有 iPad 实机验证。** 实测全部在 Chromium 完成，分两档视口：
   桌面（1440×900）+ **触摸档（`hasTouch: true`）**。
   触摸档是新补的——这个 bug 只在触摸端暴露，只在桌面视口验证本身是错位的。
   两条渲染分支都跑过，都通过：

   | 视口 | `useIsMobile()` | 浮层分支 | 结果 |
   |---|---|---|---|
   | iPad 竖屏 768×1024 | **false** | 跟随选区 | 划词标「第 2 页」；滚动后仍在，y 168 → 128（跟滚 40px） |
   | iPhone 竖屏 390×844 | true | 贴底固定条 | 划词标「第 2 页」；滚动后仍在 |

   ⚠️ **顺带订正一个记错的假设：iPad 竖屏走的是「跟随选区」，不是「贴底固定条」。**
   `useMobile.ts` 的判据是 `max-width: 640px` 或「横屏且矮高」，768px 的 iPad 竖屏两条都不满足。
   所以主设计文档 §11 里「必要时把 iPad 的浮层改成贴底固定条」这个备选方案，
   **实际影响面是全部平板而不是手机** —— 真要做得重新权衡，别按那条记录当成小改动。

   仍然没做的：真机上 iOS 长按划词的 auto-scroll 行为、原生选择菜单是否遮挡浮层。
   这两件只有真机能验。

2. **滚动重算没有 rAF 节流**。`scroll` 事件频率高，每次 `clearTimeout` + `setTimeout` 是标准的
   "滚动停止"检测，代价可忽略；`readSelection()` 只在停止后跑一次。
   若将来在低端机上量到问题，再上 `requestAnimationFrame` 合并。

3. **触摸档的验证没有固化成 e2e**。它跑在临时探针里（视口 / 断言 / 预期值都记在上面那张表里，
   照着重跑即可），没有进 `scripts/`、也没登记 `e2e-all.mjs` 的 META。
   理由：核心逻辑（滚动后重算）已被 `e2e-materials` 的两条断言锁住，触摸档验证的是**同一条逻辑
   在不同视口下的表现**；而把移动端视口固化进 `e2e-materials` 需要另建 context，
   会让那个脚本的结构变形。若将来触摸端再出问题，再把它提成独立脚本。
