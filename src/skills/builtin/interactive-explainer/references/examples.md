# 参数探索起步示例

以下片段可作为 show_widget(format="html",code=...) 的起点，不需要 libs。根据题意改变画面与参数，切勿照搬不相关控件。它只展示一个主要变量，input 重绘，change 保存，追问由宿主确认。

```html
<section id="quadratic-explorer" aria-label="抛物线系数探索">
  <h3>抛物线的开口</h3>
  <div class="wbw-controls">
    <label class="wbw-field"><span class="wbw-field-header">系数 a <output class="wbw-value"></output></span>
      <input aria-label="系数 a" type="range" min="-3" max="3" step="0.25" value="1">
    </label>
    <button type="button" data-wbw-prompt="解释当前系数下抛物线的开口和变化">解释当前情况</button>
  </div>
  <div class="wbw-stage">
    <svg role="img" aria-label="y 等于 a 乘以 x 的平方，横轴 x，纵轴 y">
      <title>y = ax²</title>
      <desc>横轴 x 与纵轴 y 均为无量纲数值。改变系数，比较曲线在同一坐标范围内的开口。</desc>
      <rect data-chart-frame fill="none" stroke="var(--wbw-border)"></rect>
      <g data-grid fill="none" stroke="var(--wbw-border)" stroke-width="1"></g>
      <g data-ticks></g>
      <path data-curve fill="none" stroke="var(--wbw-series-1)" stroke-width="2"></path>
      <text class="axis-title" data-axis="x">x（无量纲）</text>
      <text class="axis-title" data-axis="y">y（无量纲）</text>
    </svg>
  </div>
  <p data-status role="status" aria-live="polite" class="wbw-muted wbw-small"></p>
</section>
<script>
(() => {
  const root = document.getElementById('quadratic-explorer');
  const input = root.querySelector('input');
  const svg = root.querySelector('svg');
  const status = root.querySelector('[data-status]');
  const api = window.__wbw;
  let a = 1;
  const xs = Array.from({length: 81}, (_, i) => -2 + i / 20);
  // Cover all allowed coefficients on one scale so changing a does not merely rescale the axes.
  const envelope = xs.flatMap(x => [Number(input.min) * x * x, Number(input.max) * x * x]);
  const low = Math.min(...envelope), high = Math.max(...envelope), margin = (high - low) * .08;
  const ymin = low - margin, ymax = high + margin;
  function draw() {
    const w = root.querySelector('.wbw-stage').clientWidth || 300;
    const labelSize = parseFloat(getComputedStyle(root).getPropertyValue('--wbw-font-size-small')) || 12;
    const h = 240, left = Math.max(64, labelSize * 4), right = 16;
    const top = 32, bottom = 48, plotW = w - left - right, plotH = h - top - bottom;
    const X = x => left + (x + 2) / 4 * plotW;
    const Y = y => top + (ymax - y) / (ymax - ymin) * plotH;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('width', w); svg.setAttribute('height', h);
    root.querySelector('output').textContent = a.toFixed(2);
    input.value = a;
    const frame = root.querySelector('[data-chart-frame]');
    for (const [key, value] of Object.entries({x: left, y: top, width: plotW, height: plotH})) frame.setAttribute(key, value);
    const xticks = w < 360 ? [-2, 0, 2] : [-2, -1, 0, 1, 2];
    const yticks = labelSize > 13 ? [-12, 0, 12] : [-12, -6, 0, 6, 12];
    root.querySelector('[data-grid]').innerHTML = yticks.map(y => `<path d="M${left},${Y(y)}H${w-right}" opacity="${y === 0 ? 1 : .35}"/>`).join('');
    root.querySelector('[data-ticks]').innerHTML = xticks.map(x => `<text x="${X(x)}" y="${h-bottom+20}" text-anchor="${x === -2 ? 'start' : x === 2 ? 'end' : 'middle'}">${x}</text>`).join('')
      + yticks.map(y => `<text x="${left-8}" y="${Y(y)}" text-anchor="end" dominant-baseline="middle">${y}</text>`).join('');
    root.querySelector('[data-curve]').setAttribute('d', xs.map((x, i) => {
      return `${i ? 'L' : 'M'}${X(x)},${Y(a*x*x)}`;
    }).join(' '));
    const tx = root.querySelector('[data-axis="x"]'), ty = root.querySelector('[data-axis="y"]');
    tx.setAttribute('x', left + plotW / 2); tx.setAttribute('y', h-4); tx.setAttribute('text-anchor', 'middle');
    ty.setAttribute('x', left); ty.setAttribute('y', 16);
  }
  function restore() {
    const saved = api.widgetState?.modelContent;
    const value = saved?.['系数 a'] ?? saved?.a;
    a = typeof value === 'number' && value >= -3 && value <= 3 ? value : 1;
    draw();
  }
  input.oninput = () => { a = Number(input.value); draw(); };
  input.onchange = () => {
    if (!api.persistent) return;
    api.setWidgetState({modelContent: {'系数 a': a}, privateContent: null})
      .then(() => { status.textContent = ''; })
      .catch(error => { status.textContent = error.message; });
  };
  new ResizeObserver(draw).observe(root);
  window.addEventListener('wbw:statechange', restore);
  window.addEventListener('wbw:themechange', draw);
  restore();
})();
</script>
```

## 算法单步的取舍

先用已核实的输入在本地算出步骤，保存 `{input, step}` 到 modelContent。每次「上一步 / 下一步」只更新同一个画面；边界禁用对应按钮。为旧快照校验输入、步骤范围。不要把推导长文、全部 DOM 或所有重算结果存进快照，不自动播放，不在每一步请求模型。材料未给输入时注明使用示例输入。
