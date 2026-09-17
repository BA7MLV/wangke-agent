/**
 * Mermaid 渲染引擎：懒加载 + 串行队列 + 安全净化。
 *
 * 选型：官方核心库 mermaid（mermaid-js/mermaid，v11）。理由见 docs/plans/2026-09-10-chat-mermaid-design.md：
 * 90k★、仍在发版、15+ 图种，是 GitHub/Notion 的原生实现。
 *
 * 三个必须守住的点（都是实测/源码结论）：
 * 1. mermaid.render() 不可并发 —— 内部往 document.body 塞临时容器、按 id 查询再删除，并发会互相踩。故串行化。
 * 2. 围栏没闭合时不要渲染 —— 内容还在增长，parse 必然失败、还会让整块反复重建。由调用方用 streamStatus 拦。
 * 3. 中文标签要能换行 —— `flowchart.htmlLabels:false` 走 SVG <text>，mermaid 按空白切词，中文不换行会溢出方框；
 *    保持 htmlLabels:true（foreignObject + HTML）交给 CSS 换行。
 */

/** 与 antd 主体一致的字体栈；显式带中文字体，避免落到浏览器兜底字体导致图内中文观感不一致。 */
const FONT_FAMILY =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Source Han Sans SC", sans-serif';

type MermaidApi = typeof import('mermaid').default;

let loader: Promise<MermaidApi> | null = null;
let seq = 0;
/** 渲染链：所有 render 串到同一条 Promise 链上，保证同一时刻只有一次 mermaid 渲染在进行。 */
let chain: Promise<unknown> = Promise.resolve();

/** 懒加载并初始化 mermaid（只初始化一次；mermaid 打包后约 1.5MB，动态 import 落到独立 chunk）。 */
export function loadMermaid(): Promise<MermaidApi> {
  if (!loader) {
    loader = import('mermaid').then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        // 严格模式：mermaid 自带 DOMPurify 清洗标签内的 HTML。绝不放宽成 loose/antiscript。
        securityLevel: 'strict',
        theme: 'default',
        fontFamily: FONT_FAMILY,
        fontSize: 14,
        themeVariables: {
          fontFamily: FONT_FAMILY,
          fontSize: '14px',
          // 贴近 antd 的主色（#1677ff）与中性灰
          primaryColor: '#e6f4ff',
          primaryTextColor: '#1f2329',
          primaryBorderColor: '#91caff',
          lineColor: '#8c8c8c',
          secondaryColor: '#f5f5f5',
          tertiaryColor: '#fafafa',
        },
        // 图宽自适应容器；htmlLabels 保持默认 true（见文件头第 3 点）
        flowchart: { useMaxWidth: true, htmlLabels: true, curve: 'basis', padding: 12 },
        sequence: { useMaxWidth: true, wrap: true },
        gantt: { useMaxWidth: true },
        class: { useMaxWidth: true },
        state: { useMaxWidth: true },
        er: { useMaxWidth: true },
      });
      return mermaid;
    });
    // 加载失败时清掉缓存，下次还能重试（否则永久卡在 rejected 的 Promise 上）
    loader.catch(() => {
      loader = null;
    });
  }
  return loader;
}

/**
 * 安全闸门：**不对 SVG 做二次 DOMPurify**。
 *
 * 实测结论（probe-mermaid3）：mermaid 的 `securityLevel:'strict'` 已经把标签里的
 * `<script>` / `on*=` / `javascript:` / `<iframe>` 全部清掉了；而拿 DOMPurify 再净化一遍
 * 产出的 SVG，**无论怎么配都会把 foreignObject 里的标签文字整段删掉**（htmlLabels 的
 * 流程图节点直接变空框）。
 *
 * 所以这里只做「危险特征检测」：命中就抛错回退源码，绝不重写 SVG。
 */
const DANGEROUS_RE = /<\s*(script|iframe|object|embed|form)\b|\son[a-z]+\s*=|\bjavascript:|\bdata:text\/html/i;

function assertSafeSvg(svg: string): void {
  if (DANGEROUS_RE.test(svg)) {
    throw new Error('图表输出包含不安全内容，已阻止渲染');
  }
}

/** 渲染结果缓存：流式/重挂时同一份源码不重复跑 mermaid（顺带解决 XMarkdown 每次重渲染可能重建组件的问题）。 */
const CACHE_MAX = 40;
const cache = new Map<string, string>();

function cacheGet(code: string): string | undefined {
  return cache.get(code);
}
function cacheSet(code: string, svg: string) {
  cache.set(code, svg);
  if (cache.size > CACHE_MAX) {
    // Map 迭代顺序即插入顺序，删最早的
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/** 已缓存的直接返回（避免闪烁 + 省掉一次异步） */
export function peekMermaid(code: string): string | undefined {
  return cacheGet(code);
}

/**
 * 渲染一段 mermaid 源码为 SVG 字符串。
 * 串行入队；parse 先于 render（校验失败直接抛，不往 DOM 里塞错误块）。
 */
export function renderMermaid(code: string): Promise<string> {
  const cached = cacheGet(code);
  if (cached) return Promise.resolve(cached);

  const job = chain.then(async () => {
    const mermaid = await loadMermaid();
    const id = `xmd-mm-${++seq}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      // parse 抛错时说明语法不合法：直接冒泡，交给调用方回退源码
      await mermaid.parse(code);
      const { svg } = await mermaid.render(id, code);
      assertSafeSvg(svg);
      cacheSet(code, svg);
      return svg;
    } catch (e) {
      // render 失败路径下 mermaid 可能把临时容器留在 body 里，手动清干净
      document.getElementById(`d${id}`)?.remove();
      document.getElementById(id)?.remove();
      throw e;
    }
  });
  // 单个任务失败不能掐断队列
  chain = job.catch(() => undefined);
  return job;
}

/** 取出 SVG 的自然尺寸（viewBox），供下载与全屏缩放使用 */
export function svgIntrinsicSize(svg: string): { width: number; height: number } {
  const vb = svg.match(/viewBox="([\d.\-\s]+)"/);
  if (vb) {
    const p = vb[1].trim().split(/[\s,]+/).map(Number);
    if (p.length === 4 && p.every(Number.isFinite)) return { width: p[2], height: p[3] };
  }
  return { width: 800, height: 600 };
}

/**
 * 从渲染后的 SVG 字符串导出可独立打开的 .svg 文件内容（补 xml 头 + 显式尺寸）。
 *
 * 只在**根标签内部**改 width / height / xmlns —— 不能全串替换：
 * mermaid 的产出根节点必然带 width，全串 `\swidth="…"` 恰好命中的就是它；
 * 但模型手写的 SVG 经常**根节点不写 width**（只给 viewBox），此时全串替换会打到
 * 某个子元素（如 `<rect width="100">`）上，把图形几何改坏。
 */
export function toStandaloneSvg(svg: string): string {
  const { width, height } = svgIntrinsicSize(svg);
  const sized = svg.replace(/<svg\b[^>]*>/i, (tag) => {
    const attrs = tag
      .replace(/\swidth\s*=\s*"[^"]*"/i, '')
      .replace(/\sheight\s*=\s*"[^"]*"/i, '');
    // 缺 xmlns 时补上：独立打开的文件必须是 SVG 命名空间，靠 HTML 解析器兜底的那套在这里不成立
    const head = /xmlns\s*=/i.test(attrs) ? '<svg' : '<svg xmlns="http://www.w3.org/2000/svg"';
    return attrs.replace(/<svg\b/i, `${head} width="${Math.round(width)}" height="${Math.round(height)}"`);
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n${sized}`;
}
