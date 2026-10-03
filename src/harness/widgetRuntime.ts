/**
 * 沙箱 widget 的运行时：拼出 iframe 里那份**完全自足**的文档。
 *
 * ## 为什么需要这一层
 *
 * 图形真正上屏有两条路：
 *
 * 1. 正文里的 ```svg / ```mermaid 围栏 —— 走 `components/mermaid/svgRender.ts` 的
 *    **白名单**净化，禁掉 script / foreignObject / image / 外链。这条覆盖 diagram 与 art，
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
 * 与宿主的唯一通道是 `postMessage`，且宿主侧会校验 `event.source === iframe.contentWindow`，
 * 拿到的只是一个字符串（prompt 文本）或一个数字（高度）。
 */

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
} as const;

/**
 * 注入 iframe 的桥接脚本。
 *
 * 它是 widget 唯一能碰到宿主的方式，且只能做两件事：报高度、发一句话。
 * 刻意**不**暴露任何别的能力（没有读数据、没有弹窗、没有跳转）。
 */
const BRIDGE = `
(function () {
  // ⚠️ 必须排在 widget 自己的 <script> **之前**（本函数被插在 <head> 里）。
  // 经典脚本按文档顺序同步执行：bridge 放在 body 里的话，widget 脚本运行时
  // window.__wbw 还不存在，于是 sendPrompt / reportHeight 直接抛 undefined。
  // 这里的初始 report() 测不到 body（还没建）也没关系 —— clamp 到下限，
  // 随后的 load 与 ResizeObserver 会把真实高度补上。
  var post = function (type, payload) {
    try { parent.postMessage({ __wbw: type, payload: payload }, '*'); } catch (e) {}
  };
  var raf = 0;
  function report() {
    raf = 0;
    var d = document.documentElement, b = document.body;
    var h = Math.max(d ? d.scrollHeight : 0, d ? d.offsetHeight : 0, b ? b.scrollHeight : 0);
    post(${JSON.stringify(WIDGET_MSG.height)}, Math.max(80, Math.ceil(h)));
  }
  function schedule() { if (!raf) raf = requestAnimationFrame(report); }
  window.__wbw = {
    reportHeight: report,
    sendPrompt: function (text) {
      post(${JSON.stringify(WIDGET_MSG.prompt)}, String(text == null ? '' : text).slice(0, 2000));
    },
    theme: function (dark) {
      document.documentElement.setAttribute('data-wbw-theme', dark ? 'dark' : 'light');
      try { window.matchMedia('(prefers-color-scheme: dark)').matches; } catch (e) {}
    }
  };
  new ResizeObserver(schedule).observe(document.documentElement);
  window.addEventListener('load', function () { report(); schedule(); post(${JSON.stringify(WIDGET_MSG.ready)}, 1); });
  document.addEventListener('click', function (e) {
    var t = e.target;
    while (t && t !== document.body) {
      if (t.hasAttribute && t.hasAttribute('data-wbw-prompt')) {
        window.__wbw.sendPrompt(t.getAttribute('data-wbw-prompt'));
        return;
      }
      t = t.parentNode;
    }
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
 * 字号不低于 12px，字重只有 400/500 —— 免得 widget 里没写样式时出现 10px 细字。
 */
export async function buildWidgetDocument(payload: WidgetPayload): Promise<string> {
  const libs = payload.libs ?? [];
  const sources = await Promise.all(
    libs.map(async (name) => {
      const load = LIBS[name];
      if (!load) throw new Error(`未知的库：${name}`);
      return `<script>/* ${name} (vendored) */\n${await load()}</script>`;
    }),
  );

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<style>
  html { color-scheme: light dark; }
  body {
    margin: 0; padding: 4px 2px;
    font-family: Roboto, -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', sans-serif;
    font-size: 13px; font-weight: 400; line-height: 1.6;
    color: #2C2C2A; background: transparent;
    -webkit-font-smoothing: antialiased;
  }
  html[data-wbw-theme="dark"] body { color: #D3D1C7; }
  html[data-wbw-theme="dark"] body :where(input,select,textarea,button) {
    background: #2C2C2A; color: #D3D1C7; border-color: #5F5E5A;
  }
  /* 控件默认继承宿主观感，widget 不必各自描边设色 */
  input, select, textarea, button { font: inherit; color: inherit; }
  button { cursor: pointer; padding: 4px 12px; border-radius: 8px;
           border: 1px solid #B4B2A9; background: #F1EFE8; }
  input, select, textarea { padding: 4px 8px; border-radius: 8px;
           border: 1px solid #B4B2A9; background: transparent; }
  table { border-collapse: collapse; }
  th, td { border: 1px solid #D3D1C7; padding: 4px 8px; text-align: left; }
</style>
<script>${BRIDGE}</script>
${sources.join('\n')}
</head>
<body>
${payload.html}
</body>
</html>`;
}