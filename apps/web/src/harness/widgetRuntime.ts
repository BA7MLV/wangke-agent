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
 *    `form-action 'none'`。sandbox 挡的是「访问宿主」，CSP 限制资源与网络请求。
 *    注意：navigate-to 支持不完整，不能宣称已彻底阻止所有 iframe 自导航/外发。
 * 3. **只内联自带库**：CDN 全部禁掉（`default-src 'none'` 且无任何外部来源），
 *    Chart.js 由宿主把源码**内联**进去。第三方 CDN 既是供应链面，也是绕过 CSP 的洞。
 *
 * 与宿主的唯一通道是 `postMessage`，且宿主侧会校验 iframe window 与 opaque origin，
 * 仅交换高度、主题、受限 JSON 状态、题目草稿和待用户确认的追问，不暴露检索或执行工具。
 */

import { WIDGET_STYLES } from './widgetStyles.ts';
import { normalizeWidgetState, type WidgetState } from './widgetState.ts';
import type { WidgetTheme } from './widgetTheme.ts';
import { MAX_WIDGET_DIAGNOSTICS } from './widgetDiagnostics.ts';

/** widget 可以声明需要的宿主库；只有被声明的才会内联进去，避免每张图都背上 200KB */
export type WidgetLib = 'chart.js';

const LIBS: Record<WidgetLib, () => Promise<string>> = {
  // `?raw` 拿到的是**源码字符串**，不会把 Chart.js 的执行体打进主 chunk。
  // 只有真的有 widget 要画图表时才付出这 204KB。
  // Vite 的精确别名按依赖实际安装位置解析 UMD，避免假定 workspace 内有 node_modules。
  // chart.js 的 exports 不放行此深路径；别名显式匹配 ?raw 且不参与依赖预打包。
  // UMD 而非 ESM 的原因：只有 UMD 会挂全局
  // `window.Chart`，widget 自己的内联 <script>（经典脚本）才能直接用到它。
  'chart.js': () => import('@widget/chart-runtime?raw').then((m) => m.default as string),
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
  display: 'wbw:display',
  /** iframe → 宿主：文档就绪 */
  ready: 'wbw:ready',
  diagnostic: 'wbw:diagnostic',
  state: 'wbw:state',
  sync: 'wbw:sync',
  persistent: 'wbw:persistent',
  result: 'wbw:result',
  answerDraft: 'wbw:answer-draft',
  answerSync: 'wbw:answer-sync',
  answerSubmit: 'wbw:answer-submit',
  selection: 'wbw:selection',
  scroll: 'wbw:scroll',
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
  var answerInput = initial.answerInput || null;
  var display = { width: 0, height: 560 };
  var pending = new Map(), sequence = 0, saves = Promise.resolve();
  function copy(value) { return JSON.parse(JSON.stringify(value)); }
  var post = function (type, payload) {
    try { parent.postMessage({ __wbw: type, instance: initial.instance, payload: payload }, '*'); } catch (e) {}
  };
  var diagnostics = new Set();
  function diagnostic(kind, message) {
    message = String(message || '未知运行错误').slice(0, 500);
    var key = kind + ':' + message;
    if (diagnostics.has(key) || diagnostics.size >= ${MAX_WIDGET_DIAGNOSTICS}) return;
    diagnostics.add(key);
    post(${JSON.stringify(WIDGET_MSG.diagnostic)}, { kind: kind, message: message });
  }
  window.addEventListener('error', function (event) {
    if (event.target && event.target !== window) {
      var tag = event.target.tagName;
      if (['SCRIPT', 'LINK', 'IMG'].includes(tag)) diagnostic('resource', tag + ' 资源未能加载；外部依赖可能被隔离策略阻止');
    } else diagnostic('script', event.message || '脚本运行失败');
  }, true);
  window.addEventListener('unhandledrejection', function (event) {
    var reason = event.reason;
    diagnostic('promise', typeof reason === 'string' ? reason : reason && reason.message || '异步操作失败');
  });
  document.addEventListener('securitypolicyviolation', function (event) {
    // Actual enforced violations only, not console warnings about unsupported directives.
    if (event.disposition !== 'enforce') return;
    var directive = event.effectiveDirective || '';
    if (!/^(script-src|style-src|img-src|font-src|connect-src|frame-src|child-src|form-action|base-uri|object-src|navigate-to)/.test(directive)) return;
    diagnostic('policy', '隔离策略阻止了 ' + directive + '；请使用内联代码、数据图片或宿主提供的库');
  });
  function request(type, payload) {
    return new Promise(function (resolve, reject) {
      var id = ++sequence;
      var timer = setTimeout(function () {
        pending.delete(id); reject(new Error('宿主没有确认此操作，请重试'));
      }, [${JSON.stringify(WIDGET_MSG.prompt)}, ${JSON.stringify(WIDGET_MSG.answerSubmit)}].includes(type) ? 300000 : 15000);
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
    if (event.source !== parent || !event.data || event.data.instance !== initial.instance) return;
    var data = event.data, value = data.payload;
    if (data.__wbw === ${JSON.stringify(WIDGET_MSG.theme)}) setTheme(value);
    if (data.__wbw === ${JSON.stringify(WIDGET_MSG.persistent)}) initial.persistent = value === true;
    if (data.__wbw === ${JSON.stringify(WIDGET_MSG.display)} && value &&
        Number.isFinite(value.width) && value.width > 0 && Number.isFinite(value.height) && value.height > 0) {
      if (display.width !== value.width || display.height !== value.height) {
        display = { width: value.width, height: value.height };
        document.documentElement.style.setProperty('--wbw-available-height', value.height + 'px');
        window.dispatchEvent(new CustomEvent('wbw:displaychange', { detail: copy(display) }));
        schedule();
      }
    }
    if (data.__wbw === ${JSON.stringify(WIDGET_MSG.sync)}) {
      if (JSON.stringify(state) === JSON.stringify(value)) return;
      state = copy(value);
      window.dispatchEvent(new CustomEvent('wbw:statechange', { detail: { state: copy(state) } }));
    }
    if (data.__wbw === ${JSON.stringify(WIDGET_MSG.answerSync)}) {
      answerInput = copy(value);
      window.dispatchEvent(new CustomEvent('wbw:answerchange', { detail: copy(answerInput) }));
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
    var b = document.body;
    if (!b) return;
    // Root scrollHeight is floored at the old viewport. Measure visible boxes
    // instead, including overflowing/absolute descendants but respecting explicit
    // clipping and excluding fixed overlays (and their entire subtrees).
    var h = Math.ceil(Math.max(b.offsetHeight, b.getBoundingClientRect().height));
    function measure(element, clipBottom) {
      var style = getComputedStyle(element);
      if (style.position === 'fixed' || style.display === 'none') return;
      var rect = element.getBoundingClientRect();
      var bottom = rect.bottom + window.scrollY;
      if (rect.width || rect.height) h = Math.max(h, Math.min(bottom, clipBottom));
      if (/^(hidden|clip|auto|scroll)$/.test(style.overflowY))
        clipBottom = Math.min(clipBottom, rect.top + window.scrollY + element.clientTop + element.clientHeight);
      for (var child = element.firstElementChild; child; child = child.nextElementSibling) measure(child, clipBottom);
    }
    measure(b, Infinity);
    var gutter = Math.max(0, window.innerHeight - document.documentElement.clientHeight);
    post(${JSON.stringify(WIDGET_MSG.height)}, Math.max(80, h + gutter));
  }
  function schedule() { if (!raf) raf = requestAnimationFrame(report); }
  var api = {
    get display() { return copy(display); },
    get widgetState() { return copy(state); },
    get persistent() { return initial.persistent; },
    get answerInput() { return copy(answerInput); },
    setAnswerDraft: function (answer) {
      if (!answerInput || answerInput.submitted) return Promise.reject(new Error('此处不能修改题目作答'));
      if (!navigator.userActivation || !navigator.userActivation.isActive)
        return Promise.reject(new Error('请通过点击或键盘操作提交草稿'));
      return request(${JSON.stringify(WIDGET_MSG.answerDraft)}, answer);
    },
    submitAnswer: function (answer) {
      if (!answerInput || answerInput.submitted) return Promise.reject(new Error('本次提问已结束'));
      if (!navigator.userActivation || !navigator.userActivation.isActive)
        return Promise.reject(new Error('请通过点击或键盘操作提交回答'));
      return request(${JSON.stringify(WIDGET_MSG.answerSubmit)}, answer);
    },
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
  document.addEventListener('DOMContentLoaded', function () {
    new ResizeObserver(schedule).observe(document.body);
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
    schedule();
  });
  // Only bounded, local selection text crosses the boundary. The host owns identity
  // and the actual quote action; no parent DOM access or generic RPC is exposed.
  function selection(event) {
    if (!event.isTrusted) return;
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) { post(${JSON.stringify(WIDGET_MSG.selection)}, null); return; }
    var node = sel.anchorNode && sel.anchorNode.parentElement;
    if (!node || node.closest('input,textarea,[contenteditable]')) return;
    var text = sel.toString().trim().slice(0, 1600);
    var context = (sel.getRangeAt(0).commonAncestorContainer.textContent || '').trim();
    var index = context.indexOf(text);
    post(${JSON.stringify(WIDGET_MSG.selection)}, { text: text, context: index < 0 ? '' : context.slice(Math.max(0, index - 100), index + text.length + 100) });
  }
  document.addEventListener('pointerup', selection);
  document.addEventListener('keyup', selection);
  function scrollIntent(event, direction) {
    if (!event.isTrusted || !direction) return;
    for (var node = event.target instanceof Element ? event.target : null; node && node !== document.body; node = node.parentElement) {
      if (/auto|scroll/.test(getComputedStyle(node).overflowY) &&
        (direction < 0 ? node.scrollTop > 0 : node.scrollTop + node.clientHeight < node.scrollHeight - 1)) return;
    }
    post(${JSON.stringify(WIDGET_MSG.scroll)}, direction < 0 ? -1 : 1);
  }
  document.addEventListener('wheel', function (event) { if (!event.ctrlKey) scrollIntent(event, event.deltaY); }, { passive: true });
  var touchY;
  document.addEventListener('touchstart', function (event) { touchY = event.touches.length === 1 ? event.touches[0].clientY : undefined; }, { passive: true });
  document.addEventListener('touchmove', function (event) {
    if (touchY == null || event.touches.length !== 1) return;
    var next = event.touches[0].clientY;
    if (Math.abs(touchY - next) > 1) scrollIntent(event, touchY - next);
    touchY = next;
  }, { passive: true });
  document.addEventListener('keydown', function (event) {
    if (event.target.closest('input,textarea,select,[contenteditable]')) return;
    if (['ArrowUp','PageUp','Home'].includes(event.key) || event.key === ' ' && event.shiftKey) scrollIntent(event, -1);
    else if (['ArrowDown','PageDown','End',' '].includes(event.key)) scrollIntent(event, 1);
  });
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
  // widget 自己导航到外部页面。工具参数的正则检测只是预检，不是完整的导航隔离。
  "navigate-to 'none'", // Not implemented in all browsers; never a complete navigation boundary.
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
  instance?: string;
  dark?: boolean; theme?: WidgetTheme; state?: WidgetState | null; persistent?: boolean;
  /** Only a draft, not a grading/persistence capability. Never include answer keys. */
  answerInput?: { answer: unknown; submitted: boolean; question?: unknown };
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
  const initial = JSON.stringify({ instance: options.instance ?? '', dark: options.dark === true, theme: options.theme, persistent: options.persistent === true,
    answerInput: options.answerInput,
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
