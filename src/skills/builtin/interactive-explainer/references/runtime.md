# 浏览器教学组件运行时

宿主在片段脚本前注入 window.__wbw。每个片段使用唯一根 ID，查询和自定义 CSS 限定到根；不访问 parent 的数据。宿主仅允许内联脚本，不能 eval、加载外部资源或请求网络。

## 状态 API

```js
const api = window.__wbw;
const saved = api.widgetState; // null 或 { modelContent, privateContent }
// 两部分均为 JSON 值或 null；省略即 null，每次替换整个快照。
if (api.persistent) {
  await api.setWidgetState({
    modelContent: { coefficient: 2, step: 1 },
    privateContent: { detailsOpen: false }
  });
}
```

- api.persistent 表示此组件绑定了已保存消息，不代表每次写入一定成功。catch 错误并显示在操作旁；没有持久化能力时不声称保存成功。
- 只接受 JSON：有限数字、字符串、布尔值、数组、普通对象或 null。不要存 undefined、函数、Date、DOM、循环引用。嵌套最多 16 层，UTF-8 序列化后总计最多 16 KiB。
- 在 change、步骤切换等有意义的操作结束后保存。input/拖动期间只重绘，不逐帧保存；也不要在 load 或状态恢复事件里保存。
- 宿主完成 IndexedDB 事务后才确认写入。刷新、列表重新挂载、同一组件的独立预览可以恢复快照；更换源码则旧快照失效。
- 快照不自动发送模型，不触发新一轮生成。云模式的完整 chats 同步会包含 modelContent 和 privateContent；保存回执只确认本机事务/outbox，不代表云端确认或双设备已一致。不要存秘密。

```js
function restore() {
  const candidate = api.widgetState?.modelContent?.coefficient;
  coefficient = typeof candidate === 'number' && candidate >= -3 && candidate <= 3 ? candidate : 1;
  render();
}
restore();
window.addEventListener('wbw:statechange', restore);
window.addEventListener('wbw:themechange', render);
```

主题变化不重载 iframe。颜色、强调色、宿主字号、字体和圆角通过真实所在表面的令牌同步；独立预览保留原表面的样式。CSS 变量会自动更新；canvas/Chart.js 需在 wbw:themechange 中重新读取颜色和字号后重绘，无需自己向 parent 发消息。

## 用户主动追问

```js
button.onclick = () => {
  api.sendPrompt('请解释当前参数下的变化').catch((error) => {
    status.textContent = error.message;
  });
};
```

- 必须从真实点击或键盘动作调用；不能从定时器、加载或调参回调调用。
- API 等待此前排队的状态保存，然后打开宿主确认框。确认框以易读的“当前情况”列出 modelContent，原始数据可按需展开；用户可修改问题或取消。取消不请求模型。
- 确认后只附带这份 modelContent，并标记为不可信数据；宿主不附带 privateContent、HTML 或内联库。
- Promise 成功表示追问已交给聊天入口，不表示模型已经完成回答。生成中、失效或只读入口会拒绝。
- 静态追问按钮也可直接写 `<button type="button" data-wbw-prompt="解释当前情况">解释当前情况</button>`，同样需要宿主确认。不同时为同一按钮绑定两种追问方式。

宿主没有通用工具调用、读文件或业务写入 API；不要虚构这些能力。

## 正文位置

show_widget 的成功回执包含 `wbw-widget` 围栏，围栏内是宿主给出的引用 ID，不是 HTML。把完整引用原样放在相关文字之间。每次调用保存独立画面、独立快照；后图不覆盖前图。引用只能展示当前消息自身的载荷，不能读取其他消息。旧消息或遗漏引用的载荷在正文末尾兼容显示，不依赖模型完美输出才能保住图形。

## 可视化 ask_user（不是正式 quiz）

给 ask_user 增加可选 `presentation:{html}`，原 question/options 仍为真相。页面通过 `api.answerInput` 读取 `{answer,submitted,question}`，监听 `wbw:answerchange` 恢复选择；草稿刷新后不保留，已提交答案由宿主恢复。`setAnswerDraft` 同步原生输入，`submitAnswer` 打开宿主原题/答案确认，确认后才交给原等待工具。用户取消确认时 Promise 拒绝；不要用 sendPrompt 假装回答。正式 quiz 仍只可填草稿，由宿主提交和判分。

下例作为 presentation.html，要求原问题含 `id:"short"` 与 `id:"deep"`：

```html
<section id="study-route">
  <fieldset class="wbw-options"><legend>选择学习路线</legend>
    <label class="wbw-choice"><input type="radio" name="route" value="short">快速回顾 · 15 分钟</label>
    <label class="wbw-choice"><input type="radio" name="route" value="deep">深入练习 · 45 分钟</label>
  </fieldset>
  <button type="button">提交所选路线</button><p class="wbw-error" role="alert"></p>
</section>
<script>
(() => {
  const root = document.querySelector('#study-route'), api = window.__wbw;
  function answer(chosen) {
    return {status:'answered',mode:'selection',selectedIds:[chosen.value],selectedLabels:[],text:'',note:''};
  }
  function restore() {
    const input = api.answerInput;
    root.querySelectorAll('input').forEach(el => {
      el.checked = input?.answer?.selectedIds?.includes(el.value) ?? false;
      el.disabled = input?.submitted ?? true;
    });
    root.querySelector('button').disabled = input?.submitted ?? true;
  }
  root.querySelector('button').onclick = async () => {
    const chosen = root.querySelector(':checked');
    const error = root.querySelector('[role="alert"]');
    if (!chosen) { error.textContent = '请选择路线'; return; }
    try {
      await api.submitAnswer(answer(chosen));
    } catch (reason) { error.textContent = reason.message; }
  };
  root.onchange = () => {
    const chosen = root.querySelector(':checked');
    if (chosen) api.setAnswerDraft(answer(chosen)).catch(reason => root.querySelector('[role="alert"]').textContent = reason.message);
  };
  restore(); window.addEventListener('wbw:answerchange', restore);
})();
</script>
```

`.wbw-segmented` 可替换 options 外层，保留原生单选键盘行为。对比数据用 `<div class="wbw-table" tabindex="0" role="region" aria-label="路线对比"><table><caption>学习路线对比</caption><thead><tr><th scope="col">路线</th><th scope="col">时间</th></tr></thead><tbody><tr><th scope="row">快速回顾</th><td class="wbw-num">15 分钟</td></tr></tbody></table></div>`。

状态例子：`<span class="wbw-badge" data-tone="success">已完成</span>`。图例例子：`<div class="wbw-legend"><span><i class="wbw-swatch" aria-hidden="true"></i>方案 A（实线）</span><span><i class="wbw-swatch" style="--series-color:var(--wbw-series-2);border-top-style:dashed" aria-hidden="true"></i>方案 B（虚线）</span></div>`，图上的线型必须与图例一致。
