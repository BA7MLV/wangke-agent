import { parseMaterialImageHref } from '../materials/imageRefs.ts';

export const MAX_WIDGET_IMAGES = 6;

/** Compatibility preflight, not a sanitizer. CSP remains the runtime boundary.
 * Inspect resource-bearing syntax only; prose, comments and script strings may
 * legitimately contain sample URLs. Dynamic/computed requests are diagnosed at runtime.
 */
export function widgetResourceError(html: string): string | undefined {
  const uncommented = html.replace(/<!--[\s\S]*?-->/g, '');
  for (const script of uncommented.matchAll(/<script\b[^>]*>([\s\S]*?)(?:<\/script\s*>|$)/gi)) {
    // Catch ordinary unsupported API calls, not text containing examples. This
    // intentionally does not attempt to prove arbitrary JavaScript network-free.
    const body = script[1].replace(/"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g, ' ');
    if (/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\s*\(/.test(body)) return '脚本使用了网络请求 API；请把绘图所需数据放在片段中，材料原图使用 data-wbw-image，不要在预览中 fetch/XHR/联网';
    if (/\b(?:eval|Function)\s*\(/.test(body)) return '脚本使用了动态求值 eval/Function；请改写为普通函数，公式计算使用显式运算，不要动态执行字符串';
    if (/\bimport\s*(?:\(|[\w*{])/.test(body)) return '脚本使用了模块导入；请使用内联脚本，需要 Chart.js 时声明 libs:["chart.js"]';
  }
  const markup = uncommented.replace(/<script\b[^>]*>[\s\S]*?(?:<\/script\s*>|$)/gi, '');
  const styles: string[] = [];
  for (const match of markup.matchAll(/<style\b[^>]*>([\s\S]*?)(?:<\/style\s*>|$)/gi)) styles.push(match[1]);
  const tags = markup.replace(/<style\b[^>]*>[\s\S]*?(?:<\/style\s*>|$)/gi, '');
  let images = 0;
  for (const tag of tags.matchAll(/<([a-z][\w:-]*)\b((?:"[^"]*"|'[^']*'|[^'">])*)>/gi)) {
    for (const attr of tag[2].matchAll(/([^\s=/'"<>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
      const name = attr[1].toLowerCase(), value = attr[2] ?? attr[3] ?? attr[4] ?? '';
      if (name === 'src' && /(?:^|\s)data-wbw-image\s*=/i.test(tag[2])) return '材料图片只设置 data-wbw-image 和 alt，不同时设置 src；图片数据由宿主提供';
      if (name === 'style') styles.push(value.replace(/&quot;|&#34;/gi, '"').replace(/&apos;|&#39;/gi, "'"));
      if (name === 'srcset' || name === 'imagesrcset') return '图片不支持 srcset；请使用单个内联图片 src，材料原图用 <img data-wbw-image="#source-image/材料ID/图片key" alt="说明">，不要编造 Base64';
      if (name === 'poster' || name === 'background' || name === 'xlink:href') {
        if (value && !/^(?:#|data:image\/)/i.test(value)) return `${name} 引用了外部资源；请使用内联 SVG/CSS 绘图或已有图片数据`;
      }
      if (name === 'data-wbw-image') {
        if (tag[1].toLowerCase() !== 'img' || !parseMaterialImageHref(value)) return 'data-wbw-image 只能用于 img，值必须是已有的 #source-image/材料ID/图片key 引用；不要填写网址或文件路径';
        if (++images > MAX_WIDGET_IMAGES) return `每个作品最多引用 ${MAX_WIDGET_IMAGES} 张材料图片，请拆分作品`;
      }
    }
  }
  for (const raw of styles) {
    const css = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\\([a-f\d]{1,6})\s?|\\([^\r\n])/gi,
      (_match, hex: string | undefined, char: string | undefined) => hex ? String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff)) : char ?? '');
    if (/@import\b/i.test(css)) return 'CSS @import 需要外部样式；请把所需 CSS 内联到 <style>，使用系统字体';
    for (const match of css.matchAll(/\burl\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi)) {
      const value = (match[1] ?? match[2] ?? match[3] ?? '').trim();
      if (!/^(?:#|data:)/i.test(value)) return 'CSS url() 引用了外部或相对路径资源；背景图请改为内联 SVG/CSS 绘图，材料图片用 img 的 data-wbw-image，字体使用系统字体';
    }
    // image-set permits bare strings as URLs, without a surrounding url().
    if (/(?:-webkit-)?image-set\(\s*["']/i.test(css)) return 'CSS image-set 图片依赖不受支持；请改用内联 SVG/CSS 绘图或单个图片';
  }
}
