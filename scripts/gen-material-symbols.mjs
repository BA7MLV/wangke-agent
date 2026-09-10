/* eslint-disable no-console */
// 从 @material-symbols/svg-400 生成 Material Symbols 图标自定义元素。
//
// 为什么自己生成、而不装一个现成的图标包：MD3 要的是 **Material Symbols**，
// 而 npm 上的 Web Components 图标包（含我们原先用的 @mdui/icons）给的都是 **Material Icons**（MD2 时代那套）。
// @material-symbols/svg-400 只提供 SVG 文件，正好可以按「一个图标一个元素」的方式生成 ——
// 于是能同时拿到：不用图标字体、按需引入（tree-shake）、离线可用、以及**未选中描边 / 选中实心**的双态。
//
// 产出：src/ui/symbols.generated.ts（标签形如 <mdui-sym-arrow-back>，加 `filled` 属性切到实心）
// 清单来源：src/ui/symbols.ts
// 用法：node scripts/gen-material-symbols.mjs
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Node 22 原生剥类型，可以直接 import .ts（src/ui/symbols.ts 刻意不引任何模块，就是为了能这样读）
const { SYMBOL_NAMES, SymbolName: _unused } = await import(join(root, 'src/ui/symbols.ts'));
void _unused;
if (!Array.isArray(SYMBOL_NAMES) || SYMBOL_NAMES.length === 0) {
  throw new Error('没能从 src/ui/symbols.ts 读到 SYMBOL_NAMES');
}

const ICON_DIR = join(root, 'node_modules/@material-symbols/svg-400/outlined');

/** 读一个变体：去掉外层 <svg> 与宽高属性，只留 viewBox 与内部路径 */
function readVariant(symbolName, filled) {
  const suffix = filled ? '-fill' : '';
  const file = join(ICON_DIR, `${symbolName}${suffix}.svg`);
  if (!existsSync(file)) {
    throw new Error(
      `@material-symbols 里没有图标 "${symbolName}${suffix}"（期望 ${file}）—— 请检查 src/ui/symbols.ts 的名字拼写`,
    );
  }
  const raw = readFileSync(file, 'utf8');
  const viewBox = raw.match(/viewBox="([^"]+)"/)?.[1];
  const inner = raw
    .replace(/^[\s\S]*?<svg[^>]*>/, '')
    .replace(/<\/svg>[\s\S]*$/, '')
    .replace(/\s*\n\s*/g, '')
    .trim();
  if (!viewBox || !inner) {
    throw new Error(`无法从 ${file} 解析出 viewBox / 路径数据 —— 包结构可能变了`);
  }
  // 路径里不能出现反引号或 ${，否则会破坏下面模板字符串的转义前提
  if (inner.includes('`') || inner.includes('${')) {
    throw new Error(`${file} 的路径数据里出现了反引号或 \${，需要调整转义策略`);
  }
  return { viewBox, inner };
}

const icons = SYMBOL_NAMES.map((symbolName) => {
  const outlined = readVariant(symbolName, false);
  const filled = readVariant(symbolName, true);
  if (outlined.viewBox !== filled.viewBox) {
    throw new Error(`"${symbolName}" 的 outlined / filled 变体 viewBox 不一致，无法共用`);
  }
  return {
    symbolName,
    tagName: `mdui-sym-${symbolName.replace(/_/g, '-')}`,
    dataKey: symbolName, // 生成物里按符号名索引，标签名由它推导
    outlined: outlined.inner,
    filled: filled.inner,
    viewBox: outlined.viewBox,
  };
});

// 所有 Material Symbols 共用同一套网格（0 -960 960 960），这里断言一下：
// 万一将来出现例外，宁可报错也不要静默产出错位的图标。
const viewBoxes = [...new Set(icons.map((i) => i.viewBox))];
if (viewBoxes.length !== 1) {
  throw new Error(`Material Symbols 的 viewBox 不统一：${viewBoxes.join(' / ')}，需要改成逐图标记录`);
}

const content = `// 此文件由 scripts/gen-material-symbols.mjs 自动生成，请勿手改，改动会被覆盖。
// 数据源：@material-symbols/svg-400 的 outlined/（\`<name>.svg\` = 描边，\`<name>-fill.svg\` = 实心）
// 清单来源：src/ui/symbols.ts（新增图标改那里，再重跑本脚本）
// 生成物：每个图标一个自定义元素 <mdui-sym-xxx>，加 \`filled\` 属性切到实心变体。
//   MD3 的惯例是「未选中描边、选中实心」，于是导航栏这类地方一个标签就能表达两种状态。
// 尺寸与颜色：宿主 \`1em × 1em\`、默认 font-size 1.5rem（与 mdui 的图标组件一致，
//   于是外部照旧用 font-size 调大小）；颜色走 \`fill: currentColor\`，跟随文字色。
// 升级 @material-symbols 后重跑脚本即可；若图标被上游改名，脚本会直接报错而不是产出空图标。

const VIEW_BOX = '${viewBoxes[0]}';

const STYLE =
  ':host{display:inline-block;width:1em;height:1em;line-height:1;font-size:1.5rem;flex:none}' +
  'svg{display:block;width:100%;height:100%;fill:currentColor}';

/** [描边路径, 实心路径] */
const SYMBOLS: Record<string, [string, string]> = {
${icons.map((i) => `  '${i.dataKey}': ['${i.outlined}', '${i.filled}'],`).join('\n')}
};

/** 符号名 → 标签名：下划线换成连字符（\`keyboard_arrow_down\` → \`mdui-sym-keyboard-arrow-down\`） */
export const symbolTagName = (symbolName: string): string => 'mdui-sym-' + symbolName.replace(/_/g, '-');

function defineSymbol(symbolName: string): void {
  const tagName = symbolTagName(symbolName);
  // 组件注册是**静默失败**的重灾区：重复 define 会抛、漏 define 会渲染成空标签且不报错。
  // 这里显式跳过已注册的，避免 HMR 或多次 import 时炸掉。
  if (customElements.get(tagName)) return;
  const paths = SYMBOLS[symbolName];

  class MduiSymbol extends HTMLElement {
    static observedAttributes = ['filled'];
    #root: ShadowRoot;

    constructor() {
      super();
      this.#root = this.attachShadow({ mode: 'open' });
    }

    connectedCallback(): void {
      this.#render();
    }

    attributeChangedCallback(): void {
      this.#render();
    }

    #render(): void {
      const body = this.hasAttribute('filled') ? paths[1] : paths[0];
      this.#root.innerHTML =
        '<style>' + STYLE + '</style>' +
        '<svg viewBox="' + VIEW_BOX + '" aria-hidden="true">' + body + '</svg>';
    }
  }

  customElements.define(tagName, MduiSymbol);
}

for (const symbolName of Object.keys(SYMBOLS)) defineSymbol(symbolName);
`;

writeFileSync(join(root, 'src/ui/symbols.generated.ts'), content);
console.log(
  `[gen] 已生成 src/ui/symbols.generated.ts（${icons.length} 个 Material Symbols 图标，` +
    `含描边/实心两种变体；viewBox ${viewBoxes[0]}）`,
);
