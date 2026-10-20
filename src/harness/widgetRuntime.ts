/**
 * 沙箱 widget 的运行时：拼出 iframe 里那份**完全自足**的文档。
 *
 * ## 为什么需要这一层
 *
 * 图形真正上屏有两条路：
 *
 * 1. 正文里的 ```svg / ```mermaid / ```diagram 围栏 —— 走 `components/mermaid/svgRender.ts` 的
 *    **白名单**净化（diagram 的渲染器产出物也过同一道，见 sanitizeSvgFragment），禁掉
 *    script / foreignObject / image / 外链。这条覆盖 diagram 与 art，
 *    是默认路径，**没有因为本模块而放松分毫**。
 * 2. `html` 形态的 widget —— 覆盖 mockup / interactive / chart。这三者需要 HTML+JS，
 *    白名单净化做不到，只能真的执行脚本。于是问题变成「凭什么让它执行」。
 *
 * ## 威胁模型（这不是假想，代码里写着）
 *
 * 送进模型的文本里混着**课程字幕、用户提问、PDF/Word 材料**，全是第三方可写入的内容。
 * 一段被投毒的字幕就能改写模型的指令。若 widget 里的脚本在**应用自己的源**下执行，
 * 它能读到父页面的 DOM、IndexedDB（全部课程、字幕、问答、材料）、localStorage，
 * 还能往外发请求 —— 一次投毒等于整个本地数据被搬走。
 *
 * ## 三道闸，缺一道就前功尽弃
 *
 * 1. **不透明源**：`sandbox="allow-scripts"` 且**绝不给** `allow-same-origin`。
 *    iframe 拿到的是一个不透明源，与应用不同源，于是读不到父页面任何东西，
 *    也无法访问本应用的 IndexedDB / localStorage / cookie。
 *    （对比 `HtmlReader.tsx` 的阅读视图是反过来的：`allow-same-origin` 且不给
 *    `allow-scripts`。两个方向各自成立，别抄错。）
 * 2. **文档内 CSP**：`connect-src 'none'`、`img-src data:`、`frame-src 'none'`、
 *    `form-action 'none'`。sandbox 挡的是「访问宿主」，CSP 挡的是「往外发数据」——
 *    没有这一条，脚本仍能把字幕内容 fetch 到任意域名，两道闸就等于只挡了一半。
 * 3. **只内联自带库**：CDN 全部禁掉（`default-src 'none'` 且无任何外部来源），
 *    Chart.js 由宿主把源码**内联**进去。第三方 CDN 既是供应链面，也是绕过 CSP 的洞。
 *
 * 与宿主的唯一通道是 `postMessage`，且宿主侧会校验 iframe window 与 opaque origin，
 * 仅交换高度、主题、受限 JSON 状态和待用户确认的追问，不暴露检索或执行工具。
 */

import { WIDGET_STYLES } from './widgetStyles.ts';
import { normalizeWidgetState, type WidgetState } from './widgetState.ts';
import type { WidgetTheme } from './widgetTheme.ts';

/** widget 可以声明需要的宿主库；只有被声明的才会内联进去，避免每张图都背上 200KB */
export type WidgetLib = 'chart.js';

const LIBS: Record<WidgetLib, () => Promise<string>> = {
  // `?raw` 拿到的是**源码字符串**，不会把 Chart.js 的执行体打进主 chunk。
  // 只有真的有 widget 要画图表时才付出这 204KB。
  // 走相对路径而不是 `chart.js/dist/chart.umd.js`：chart.js 的 exports 只放行
  // `.` / `./auto` / `./helpers` 三个 ESM 入口，深路径会被解析器拒掉
  // （vite 别名也吃不到 `?raw` 后缀）。UMD 而非 ESM 的原因：只有 UMD 会挂全局
  // `window.Chart`，widget 自己的内联 <script>（经典脚本）才能直接用到它。
  'chart.js': () => import('../../node_modules/chart.js/dist/chart.umd.js?raw').then((m) => m.default as string),
};

export interface WidgetPayload {
  /** 宿主生成的实例 ID，旧消息第一次打开时补齐；模型不能指定。 */
  id?: string;
  /** Stable inline reference; source revisions rotate id but retain this placement. */
  ref?: string;
  /** widget 的 HTML 片段（不含 <html>/<body>） */
  html: string;
  /** 声明需要的宿主库 */
  libs?: WidgetLib[];
}

/** 宿主 ↔ iframe 的消息类型。带 `wbw` 前缀，避免和 widget 自己的 postMessage 撞车。 */
export const WIDGET_MSG = {
  /** iframe → 宿主：内容高度变了 */
  height: 'wbw:height',
  /** iframe → 宿主：用户点了「让助手继续」 */
  prompt: 'wbw:prompt',
  /** 宿主 → iframe：主题变了 */
  theme: 'wbw:theme',
  /** iframe → 宿主：文档就绪 */
  ready: 'wbw:ready',
  state: 'wbw:state',
  sync: 'wbw:sync',
  result: 'wbw:result',
} as const;

/**
 * 注入 iframe 的桥接脚本。
 *
 * 它是 widget 唯一能碰到宿主的方式。状态写入等待持久化 ACK，追问等待用户确认；
 * 没有读取课程、调用工具、跳转或直接请求模型的能力。
 */
const BRIDGE = `
(function () {
  var initial = __WBW_INITIAL__;
  var state = initial.state;
  var pending = new Map(), sequence = 0, saves = Promise.resolve();
  function copy(value) { return JSON.parse(JSON.stringify(value)); }
  var post = function (type, payload) {
    try { parent.postMessage({ __wbw: type, payload: payload }, '*'); } catch (e) {}
  };
  function request(type, payload) {
    return new Promise(function (resolve, reject) {
      var id = ++sequence;
      var timer = setTimeout(function () {
        pending.delete(id); reject(new Error('宿主没有确认此操作，请重试'));
      }, type === ${JSON.stringify(WIDGET_MSG.prompt)} ? 300000 : 15000);
      pending.set(id, { resolve: resolve, reject: reject, timer: timer });
      post(type, { requestId: id, value: payload });
    });
  }
  function setTheme(value) {
    var dark = typeof value === 'object' && value ? value.dark === true : value === true;
    var tokens = value && value.tokens;
    if (tokens) Object.keys(tokens).forEach(function (name) {
      if (/^--wbw-[a-z-]+$/.test(name) && typeof tokens[name] === 'string')
        document.documentElement.style.setProperty(name, tokens[name]);
    });
    document.documentElement.setAttribute('data-wbw-theme', dark ? 'dark' : 'light');
    window.dispatchEvent(new CustomEvent('wbw:themechange', { detail: { dark: dark } }));
  }
  window.addEventListener('message', function (event) {
    if (event.source !== parent || !event.data) return;
    var data = event.data, value = data.payload;
    if (data.__wbw === ${JSON.stringify(WIDGET_MSG.theme)}) setTheme(value);
    if (data.__wbw === ${JSON.stringify(WIDGET_MSG.sync)}) {
      if (JSON.stringify(state) === JSON.stringify(value)) return;
      state = copy(value);
      window.dispatchEvent(new CustomEvent('wbw:statechange', { detail: { state: copy(state) } }));
    }
    if (data.__wbw === ${JSON.stringify(WIDGET_MSG.result)} && value) {
      var task = pending.get(value.requestId);
      if (!task) return;
      pending.delete(value.requestId); clearTimeout(task.timer);
      if (value.ok) task.resolve(); else task.reject(new Error(value.error || '操作未完成'));
    }
  });
  var raf = 0;
  function report() {
    raf = 0;
    var d = document.documentElement, b = document.body;
    var h = Math.max(d ? d.scrollHeight : 0, d ? d.offsetHeight : 0, b ? b.scrollHeight : 0);
    post(${JSON.stringify(WIDGET_MSG.height)}, Math.max(80, Math.ceil(h)));
  }
  function schedule() { if (!raf) raf = requestAnimationFrame(report); }
  var api = {
    get widgetState() { return copy(state); },
    get persistent() { return initial.persistent; },
    reportHeight: report,
    setWidgetState: function (next) {
      var snapshot;
      try {
        if (!initial.persistent) throw new Error('请等回答保存完成后再保存参数');
        var json = JSON.stringify(next, function (key, value) {
          if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol'
            || (typeof value === 'number' && !Number.isFinite(value))) throw new Error('状态必须是 JSON');
          return value;
        });
        if (new TextEncoder().encode(json).length > 16384) throw new Error('状态超过 16 KiB');
        snapshot = JSON.parse(json);
      } catch (error) { return Promise.reject(error); }
      saves = saves.catch(function () {}).then(function () {
        return request(${JSON.stringify(WIDGET_MSG.state)}, snapshot);
      });
      return saves;
    },
    sendPrompt: function (text) {
      if (!navigator.userActivation || !navigator.userActivation.isActive)
        return Promise.reject(new Error('请通过点击或键盘操作发起追问'));
      return saves.then(function () { return request(${JSON.stringify(WIDGET_MSG.prompt)}, text); });
    },
    theme: setTheme
  };
  Object.defineProperty(window, '__wbw', { value: Object.freeze(api), writable: false, configurable: false });
  setTheme(initial.theme || initial.dark);
  new ResizeObserver(schedule).observe(document.documentElement);
  window.addEventListener('load', function () { report(); schedule(); post(${JSON.stringify(WIDGET_MSG.ready)}, 1); });
  document.addEventListener('click', function (e) {
    var t = e.target;
    while (t && t !== document.body) {
      if (t.hasAttribute && t.hasAttribute('data-wbw-prompt')) {
        window.__wbw.sendPrompt(t.getAttribute('data-wbw-prompt')).catch(function () {});
        return;
      }
      t = t.parentNode;
    }
  });
  window.addEventListener('pagehide', function () {
    pending.forEach(function (task) { clearTimeout(task.timer); task.reject(new Error('交互讲解已关闭')); });
    pending.clear();
  });
  report();
})();
`;

/** iframe 内的 CSP。**每一项都是有意收紧的**，改之前先想清楚在放行什么。 */
const CSP = [
  "default-src 'none'",
  // widget 自带的内联脚本 + 我们内联的库，都在 'unsafe-inline' 里。
  // 不给 'unsafe-eval'：widget 不需要 eval，而 eval 是把字符串变代码的入口。
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data:',
  'font-src data:',
  // 断掉一切外发通道：fetch / XHR / WebSocket / sendBeacon 全废。
  // 这条是「投毒的字幕不能把数据搬走」的最后一道闸。
  "connect-src 'none'",
  // connect-src 不管 document navigation；支持该 CSP 指令的浏览器也会禁止
  // widget 自己导航到外部页面。参数校验还会在更早一层挡住导航 API。
  "navigate-to 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

/**
 * 拼出 iframe 的完整 HTML 文档。
 *
 * 外壳样式只做「让内容看得清」：透明背景交给宿主（与 SVG 那条一致的取向），
 * 正文字号跟随宿主，次要标注不低于 11px，字重只有 400/500。
 */
export async function buildWidgetDocument(payload: WidgetPayload, options: {
  dark?: boolean; theme?: WidgetTheme; state?: WidgetState | null; persistent?: boolean;
} = {}): Promise<string> {
  const libs = payload.libs ?? [];
  const sources = await Promise.all(
    libs.map(async (name) => {
      const load = LIBS[name];
      if (!load) throw new Error(`未知的库：${name}`);
      return `<script>/* ${name} (vendored) */\n${await load()}</script>`;
    }),
  );

  // Escape '<' as well as line separators: saved strings must never terminate the bootstrap script.
  const initial = JSON.stringify({ dark: options.dark === true, theme: options.theme, persistent: options.persistent === true,
    state: options.state == null ? null : normalizeWidgetState(options.state) })
    .replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<style>
${WIDGET_STYLES}
</style>
<script>${BRIDGE.replace('__WBW_INITIAL__', () => initial)}</script>
${sources.join('\n')}
</head>
<body>
${payload.html}
</body>
</html>`;
}
