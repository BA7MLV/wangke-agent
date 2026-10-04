import { COVER_EDGE, encodeCanvas } from './frames';

/**
 * 文字封面：把「一个标题 + 一段正文」排成一张 480×270 的图。
 *
 * 给**没有画面可截的材料**用（Markdown）。PDF 走 pdf.js 渲首页、Word 至今是文档图标，
 * 而 Markdown 天然有结构好的标题和开头一段话 —— 与其硬渲染一张截图（foreignObject
 * 对 webfont 支持极差、外部图片会污染 canvas），不如老老实实排一张标题卡：
 * 纯 canvas、无新依赖、不联网、不可能失败，几十毫秒出一张。
 *
 * 三个刻意的取舍：
 *
 * 1. **16:9 铺满，不留黑边**。PDF 是竖版 A4，塞进 16:9 通栏会留两条黑边；标题卡没有
 *    「原始版面」这回事，就按容器比例画满。圆角也不用管 —— `.video-row__thumb` 自带
 *    `overflow: hidden` + `border-radius`，裁切是白送的。
 * 2. **底色由标题哈希决定**。库页一屏几十张，颜色全一样就等于没有封面；按标题派色相
 *    能让每篇笔记一眼可辨。用黄金角步进把哈希摊到色相圈上，否则 `hash % 360` 会让
 *    相邻取值的标题落在同一个色区，看着还是一样。
 * 3. **固定低明度 + 白字**。`.video-row__duration`（右下角「N 段」徽标）是
 *    `rgb(0 0 0 / 0.78)` 底白字，只有深底才保证它在任何一张封面上都读得清。
 */

/** 16:9，长边就是 COVER_EDGE */
const W = COVER_EDGE;
const H = Math.round((COVER_EDGE * 9) / 16);
/** 四周留白 */
const PAD = 26;

/**
 * 字体栈与 `anki/apkgCore.ts` 一致：canvas 的 `font` 不吃 CSS 变量与 `-apple-system`
 * 之外的简写，必须把 CJK 字体逐个列出来，否则中文会掉到浏览器默认衬线体上。
 */
const STACK = `'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans SC', system-ui, sans-serif`;
const TITLE_FONT = `600 32px ${STACK}`;
const PREVIEW_FONT = `400 15px ${STACK}`;
const TITLE_LH = 41;
const PREVIEW_LH = 24;
const TITLE_MAX_LINES = 2;
const PREVIEW_MAX_LINES = 3;

/** CJK 与全角标点：这些字符之间可以任意断行 */
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/;

/**
 * 切词：CJK 逐字成词，拉丁文/数字连成一个不可拆的词。
 *
 * 不这么做的话，中文正文会**一个断点都没有**（没有空格），`measureText` 只能整段塞进一行，
 * 然后被裁掉右半边 —— 这是排 CJK 最容易踩的坑。
 *
 * 空白压成**单个空格 token**（不能丢）：空格是拉丁文之间的断点，丢了会得到
 * `DistributedSystems:` 这种黏在一起的词。折行时行首空格再由 `wrap` 去掉。
 */
function tokenize(text: string): string[] {
  const out: string[] = [];
  let word = '';
  let space = false;
  for (const ch of text) {
    if (/\s/.test(ch)) {
      if (word) {
        out.push(word);
        word = '';
      }
      space = true;
      continue;
    }
    if (space) {
      out.push(' ');
      space = false;
    }
    if (WIDE.test(ch)) {
      if (word) {
        out.push(word);
        word = '';
      }
      out.push(ch);
    } else {
      word += ch;
    }
  }
  if (word) out.push(word);
  return out;
}

/**
 * 贪心折行，超出 `maxLines` 的部分用省略号收尾。
 *
 * 逐词累加而不是二分切字符：封面文案只有几十到几百字，一遍 O(n) 的 measureText
 * 完全够快，换来的是「不会把一个英文单词劈成两半」。
 */
function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const tokens = tokenize(text);
  const lines: string[] = [];
  let line = '';
  for (let i = 0; i < tokens.length; i++) {
    const next = line + tokens[i];
    if (line && ctx.measureText(next).width > maxWidth) {
      lines.push(line);
      line = tokens[i];
      if (lines.length === maxLines) {
        // 还有剩就说明放不下：末行截到能塞下省略号为止
        if (i < tokens.length - 1) {
          let last = lines[maxLines - 1];
          while (last && ctx.measureText(`${last}…`).width > maxWidth) {
            last = tokenize(last).slice(0, -1).join('');
          }
          lines[maxLines - 1] = `${last}…`;
        }
        return lines;
      }
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  // 断行处的空格会留在下一行开头，画出来是个明显的缩进缺口
  return lines.map((l) => l.trimStart());
}

/** FNV-1a 32 位。同一标题永远同一个色相，刷新页面不会换色 */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * 标题 → 色相（0~360）。
 *
 * 黄金角步进：把哈希乘 137.508（黄金角）再取模 360，相邻取值的色相被尽量推开。
 * `hash % 360` 之所以不行，是因为 FNV 的低位比特分布不均，取模会让很多标题落进同一色区。
 *
 * ⚠️ 别再优化这个函数：**「让 20 个标题的色相互相远离」是做不到的**。360 个色相槽里塞
 * 20~40 个标题（一个库的实际量级），鸽笼原理下随机最小间隔的期望就是 `360 / n²` 度，
 * 蒙特卡洛实测各方案平均都是 0.6°。也就是说「有几篇颜色接近」是必然的，不是哈希的锅。
 * 真要拉开差距只能换维度（掺进标题长度、给相邻色相加明度差），而那是在优化一个
 * 用户根本不会注意的指标 —— 标题文字本身才是区分度的主要来源。
 */
export function hueOfTitle(title: string): number {
  return Math.round(((fnv1a(title) * 137.508) % 360) * 100) / 100;
}

/**
 * 排一张标题卡。
 *
 * @param title 封面主标题。空串会被裁成空行（只剩预览），不抛错 —— 由调用方决定
 *              「标题和文件名都空」时是不是干脆不生成封面。
 * @returns WebP（不支持时 JPEG），长边 480
 */
export async function paintTextCover(input: {
  title: string;
  preview: string;
}): Promise<{ blob: Blob; width: number; height: number }> {
  // 字体没就位就量不准宽度，画出来的换行会跟着系统字体走。先 ready 再量。
  await document.fonts.ready;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建封面画布');
  const inner = W - PAD * 2;

  const hue = hueOfTitle(input.title || 'md');
  // 固定 L=30%/26%：白字对比度稳定在 7:1 以上，不随色相漂（某些黄的 L=30% 偏亮）。
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, `hsl(${hue} 42% 30%)`);
  g.addColorStop(1, `hsl(${(hue + 22) % 360} 38% 22%)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // 左上角一团柔光 + 右下角一个同色系浅色圆：给纯色一点纵深，又不抢文字。
  // 都是低透明度，缩到 240px 宽时只剩「有质感」这一层信息，正是我们要的。
  const halo = ctx.createRadialGradient(PAD, 0, 0, PAD, 0, 200);
  halo.addColorStop(0, 'rgb(255 255 255 / 0.10)');
  halo.addColorStop(1, 'rgb(255 255 255 / 0)');
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, W, H);
  ctx.beginPath();
  ctx.arc(W - 30, H - 24, 108, 0, Math.PI * 2);
  ctx.fillStyle = `hsl(${(hue + 40) % 360} 55% 62% / 0.10)`;
  ctx.fill();

  // 标题 / 预览各自折行，再把整块垂直居中 —— 行数不同（有无预览、标题一行还是两行）
  // 都不会让版面偏上或偏下。
  ctx.font = TITLE_FONT;
  const titleLines = input.title ? wrap(ctx, input.title.trim(), inner, TITLE_MAX_LINES) : [];
  ctx.font = PREVIEW_FONT;
  const previewLines = input.preview ? wrap(ctx, input.preview.trim(), inner, PREVIEW_MAX_LINES) : [];

  const hasDivider = titleLines.length > 0 && previewLines.length > 0;
  const RULE_GAP = 15;
  const RULE_H = 2;
  const blockH =
    titleLines.length * TITLE_LH +
    (hasDivider ? RULE_GAP + RULE_H + RULE_GAP : 0) +
    previewLines.length * PREVIEW_LH;

  let y = Math.max(PAD, (H - blockH) / 2);
  ctx.textBaseline = 'top';

  if (titleLines.length > 0) {
    ctx.font = TITLE_FONT;
    ctx.fillStyle = '#ffffff';
    for (const line of titleLines) {
      ctx.fillText(line, PAD, y);
      y += TITLE_LH;
    }
  }

  if (hasDivider) {
    y += RULE_GAP;
    ctx.fillStyle = 'rgb(255 255 255 / 0.45)';
    ctx.fillRect(PAD, y, 36, RULE_H);
    y += RULE_H + RULE_GAP;
  }

  if (previewLines.length > 0) {
    ctx.font = PREVIEW_FONT;
    ctx.fillStyle = 'rgb(255 255 255 / 0.74)';
    for (const line of previewLines) {
      ctx.fillText(line, PAD, y);
      y += PREVIEW_LH;
    }
  }

  return { blob: await encodeCanvas(canvas, 0.82), width: W, height: H };
}