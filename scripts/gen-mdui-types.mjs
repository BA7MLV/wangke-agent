/* eslint-disable no-console */
// 生成 mdui 的 React JSX 类型与元素/事件类型。
//
// 为什么需要这个脚本：
//   mdui 自带的 `node_modules/mdui/jsx.zh-cn.d.ts` 用「全局命名空间增强」来声明 46 个
//   mdui-* 标签的 JSX 属性，但其写法是：
//     declare global { namespace React { namespace JSX { interface IntrinsicElements {...} } } }
//   在 React 19 中，JSX 命名空间已被收进模块作用域（react 模块内的 `React.JSX`），
//   这种全局增强无法注入到 JSX 运行时实际查找的命名空间里，导致每个 mdui-* 标签
//   都报 `Property 'mdui-xxx' does not exist on type 'JSX.IntrinsicElements'`。
//   本脚本把官方写法改写为 React 19 正确的形式：
//     declare module 'react' { namespace JSX { interface IntrinsicElements {...} } }
//
//   另外，custom-elements.json 缺少事件 detail 的真实类型，本脚本从各组件 .d.ts 的
//   `<ClassName>EventMap` 接口里「挖」真实事件类型；挖不到的再退化（见下方策略）。
//
// 用法：
//   node scripts/gen-mdui-types.mjs
//   node scripts/gen-mdui-types.mjs --with-timestamp   # 在文件头写入生成时间（会产生 diff，默认不写）
//
// 零第三方依赖，ESM，顶层 await。升级 mdui 后重跑本脚本即可，请勿手改产物。

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const mduiDir = join(root, 'node_modules/mdui');
const outDir = join(root, 'src/types');
mkdirSync(outDir, { recursive: true });

// 是否把生成时间写进产物（默认不写，避免每次重跑都产生无意义 diff）
const withTimestamp = process.argv.includes('--with-timestamp');

// ---------- 读取 mdui 版本 ----------
const mduiVersion = JSON.parse(readFileSync(join(mduiDir, 'package.json'), 'utf8')).version;

// ---------- 读取 Custom Elements Manifest ----------
// 产物 A 需要它把每个标签映射到元素类，产物 B 需要它生成事件表，统一在最前面解析一次。
const manifest = JSON.parse(readFileSync(join(mduiDir, 'custom-elements.json'), 'utf8'));

// 收集所有 declaration（含 tagName 的才是自定义元素）
const declarations = [];
for (const mod of manifest.modules) {
  for (const d of mod.declarations || []) {
    if (d.tagName) {
      declarations.push({
        tagName: d.tagName,
        className: d.name,
        events: (d.events || []).map((e) => ({
          name: e.name,
          typeText: e.type && e.type.text ? e.type.text : null,
        })),
      });
    }
  }
}
declarations.sort((a, b) => a.tagName.localeCompare(b.tagName));

// 标签 -> 元素类名（如 'mdui-dialog' -> 'Dialog'），供产物 A 给每个标签生成正确的 ref 类型
const tagToClassName = new Map(declarations.map((d) => [d.tagName, d.className]));

// =====================================================================
// 产物 A：src/types/mdui-jsx.d.ts
//   把官方 jsx.zh-cn.d.ts 的全局增强改写为 declare module 'react' 增强，
//   完整保留官方注释（@see 文档链接很有价值）与全部 46 个标签。
// =====================================================================

const jsxRaw = readFileSync(join(mduiDir, 'jsx.zh-cn.d.ts'), 'utf8');

// 头部：保留 `import React` / `import { JQ }` / `type HTMLElementProps`（文件内被引用），
// 丢弃官方的 `declare global { namespace React { namespace JSX {` 外壳。
const declareGlobalIdx = jsxRaw.indexOf('declare global');
const header = jsxRaw.slice(0, declareGlobalIdx);

// 官方把每个标签都收尾成 `} & HTMLElementProps;`，而 HTMLElementProps 把 ref 定死成了
// `Ref<HTMLElement>`。这在 React 19 下有两个问题（实测）：
//   1. 所有 mdui 元素的 ref 都拿不到具体元素类型（Dialog / TextField / …）；
//   2. mdui 部分组件在结构上**不可赋值给 HTMLElement** —— TextField 声明了
//      `autocorrect?: string`，而 lib.dom 的 `HTMLElement.autocorrect` 是 `boolean`，
//      于是 `RefObject<TextField>` 连 `Ref<HTMLElement>` 都满足不了，
//      `<mdui-text-field ref={r} />` 与 `useMduiProperty(r, ...)` 一律编译报错。
// 改为把基类 props 泛型化，并按标签注入对应元素类（见下方 body 替换）。
const headerFixed = header.replace(
  /type HTMLElementProps = React\.DetailedHTMLProps<React\.HTMLAttributes<HTMLElement>, HTMLElement>;/,
  `// 每个 mdui 标签的通用 props：继承 React 的 HTML 属性，但把 ref 换成「该标签对应元素类」的 ref。
// 用 Omit 去掉官方写法里定死的 Ref<HTMLElement>（理由见生成器注释）。
// 刻意不加 \`extends HTMLElement\` 约束：mdui 的元素类比 lib.dom 的接口更宽松（如 TextField.autocorrect
// 是 string），加上约束反而会把它们卡死。
type MduiElementProps<T> = Omit<React.DetailedHTMLProps<React.HTMLAttributes<T>, T>, 'ref'> & {
  ref?: React.Ref<T>;
};`,
);
if (headerFixed === header) {
  throw new Error(
    '未能在官方 jsx.zh-cn.d.ts 里找到 HTMLElementProps 的定义 —— mdui 可能改了类型结构，请更新本生成器',
  );
}

// 用括号配对，从 `interface IntrinsicElements {` 提取其内部 body（含全部标签定义与注释）。
const interfaceKeywordIdx = jsxRaw.indexOf('interface IntrinsicElements');
const openBraceIdx = jsxRaw.indexOf('{', interfaceKeywordIdx);
let depth = 0;
let closeBraceIdx = -1;
for (let i = openBraceIdx; i < jsxRaw.length; i++) {
  const ch = jsxRaw[i];
  if (ch === '{') depth++;
  else if (ch === '}') {
    depth--;
    if (depth === 0) {
      closeBraceIdx = i;
      break;
    }
  }
}
const interfaceBody = jsxRaw.slice(openBraceIdx + 1, closeBraceIdx);

// 把每个标签的 `} & HTMLElementProps;` 收尾替换成 `} & MduiElementProps<元素类>;`。
// 以 `} & HTMLElementProps;` 这个完整字面量作为锚点，nested 的 `}` 不会误匹配。
const missingClassNames = [];
const bodyFixed = interfaceBody.replace(
  /'([a-z][a-z0-9-]*)':\s*\{([\s\S]*?)\} & HTMLElementProps;/g,
  (whole, tag, inner) => {
    const className = tagToClassName.get(tag);
    if (!className) {
      missingClassNames.push(tag);
      return whole;
    }
    return `'${tag}': {${inner}} & MduiElementProps<${className}>;`;
  },
);
const leftover = (bodyFixed.match(/& HTMLElementProps;/g) || []).length;
if (leftover > 0 || missingClassNames.length > 0) {
  throw new Error(
    `标签替换未完全成功：残留 ${leftover} 处 HTMLElementProps，` +
      `manifest 里找不到类名的标签 [${missingClassNames.join(', ')}]`,
  );
}

// ── Material Symbols 图标：为「src/ui/symbols.ts 里列出的图标」补 JSX 类型 ──────────────
// 图标元素由 scripts/gen-material-symbols.mjs 生成（自建的自定义元素，不是第三方包），
// 所以这里只需要知道「有哪些图标」——清单唯一来源是 src/ui/symbols.ts，不可能出现「用了却没类型」。
// 新增图标：改 src/ui/symbols.ts → 先跑 gen-material-symbols.mjs → 再跑本脚本。
const symbolsEntryPath = join(root, 'src/ui/symbols.ts');
if (!existsSync(symbolsEntryPath)) {
  throw new Error(`找不到图标清单 ${symbolsEntryPath}（Material Symbols 的清单必须有）`);
}
// Node 22 原生剥类型，可以直接 import .ts（symbols.ts 刻意不引任何模块，就是为了能这样读）
const { SYMBOL_NAMES } = await import(symbolsEntryPath);
if (!Array.isArray(SYMBOL_NAMES) || SYMBOL_NAMES.length === 0) {
  throw new Error(`没能从 ${symbolsEntryPath} 读到 SYMBOL_NAMES`);
}
// 生成物必须已经存在：类型可以有延迟，运行时缺图标是静默失败，先在这里把它拦下来
const generatedSymbolsPath = join(root, 'src/ui/symbols.generated.ts');
if (!existsSync(generatedSymbolsPath)) {
  throw new Error(`缺少 ${generatedSymbolsPath} —— 请先跑 node scripts/gen-material-symbols.mjs`);
}
const symbols = SYMBOL_NAMES.map((symbolName) => ({
  symbolName,
  // 与生成器里的规则保持一致：下划线 → 连字符
  tagName: `mdui-sym-${symbolName.replace(/_/g, '-')}`,
}));

// 用括号计数重排 body 缩进，得到干净、层级正确的文本（TS 不关心缩进，但这能保证产物可读）。
function reindentBody(lines, base) {
  let level = 0;
  const out = [];
  for (const raw of lines) {
    if (raw.trim() === '') {
      out.push('');
      continue;
    }
    const opens = (raw.match(/{/g) || []).length;
    const closes = (raw.match(/}/g) || []).length;
    let indent = level - closes;
    if (indent < 0) indent = 0;
    out.push(' '.repeat(base + indent * 2) + raw.trim());
    level = indent + opens;
  }
  return out;
}

const bodyLines = bodyFixed.split('\n');
// 去掉首尾空行
while (bodyLines.length && bodyLines[0].trim() === '') bodyLines.shift();
while (bodyLines.length && bodyLines[bodyLines.length - 1].trim() === '') bodyLines.pop();
const reindentedBody = reindentBody(bodyLines, 6).join('\n');

const jsxHeaderComment = `// 此文件由 scripts/gen-mdui-types.mjs 自动生成，请勿手改，改动会被覆盖。
// 数据源：@mdui ${mduiVersion} 的 node_modules/mdui/jsx.zh-cn.d.ts，以及
//         node_modules/@mdui/icons/*.d.ts（清单取自 src/ui/icons.ts）
// 生成策略（对官方文件做了两处改写）：
//   1. declare global { namespace React { namespace JSX } } -> declare module 'react' { namespace JSX }
//      以适配 React 19（更稳妥，不依赖 UMD 全局回退）。
//   2. 每个标签的基类 props 由定死 ref 的 HTMLElementProps 换成 MduiElementProps<元素类>，
//      让 ref 拿到具体元素类型（官方写法下所有 mdui ref 都会编译报错，原因见生成器注释）。
// 另外：Material Symbols 图标是我们自己生成的自定义元素（scripts/gen-material-symbols.mjs），
//       它们不带 JSX 类型，这里按 src/ui/symbols.ts 的清单补上。
// 升级 mdui / 新增图标后重跑脚本即可，勿手改本文件。
// ${withTimestamp ? `生成时间：${new Date().toISOString()}` : '（默认不写入生成时间，避免每次重跑产生无意义 diff；如需可加 --with-timestamp）'}
`;

const mduiJsxContent = `${jsxHeaderComment}
${headerFixed.trimEnd()}

/** 图标元素的 props：尺寸/颜色都由宿主 CSS 控制，这里只多一个「切实心」的开关。
 *  用 HTMLElement 而不是某个具体类——图标元素没有对外暴露的类，也没有需要强类型的属性。 */
type MduiSymbolProps = Omit<React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>, 'ref'> & {
  ref?: React.Ref<HTMLElement>;
  /** 传了就渲染实心变体（MD3 惯例：未选中描边、选中实心） */
  filled?: boolean;
};

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
${reindentedBody}

      /* ── Material Symbols 图标：清单来自 src/ui/symbols.ts ──
         标签由 scripts/gen-material-symbols.mjs 生成；新增图标后两个脚本按顺序重跑 */
${symbols.map((i) => `      '${i.tagName}': MduiSymbolProps;`).join('\n')}
    }
  }
}
`;

writeFileSync(join(outDir, 'mdui-jsx.d.ts'), mduiJsxContent);
console.log(
  `[gen] 已生成 src/types/mdui-jsx.d.ts（@mdui ${mduiVersion}：${declarations.length} 个组件标签 + ` +
    `${symbols.length} 个 Material Symbols 图标标签）`,
);

// =====================================================================
// 产物 B：src/types/mdui-elements.d.ts
//   1) 从 custom-elements.json 生成 tagName -> 元素类的映射，并做全局增强补上
//      HTMLElementTagNameMap（mdui 各组件 .d.ts 其实也会各自注册，这里再用同一类型
//      补一遍以保证「即使未 import 'mdui' 也能拿到具体元素类类型」，类型一致不产生冲突）。
//   2) 从 custom-elements.json 的 events 生成事件映射 MduiElementEventMap。
//      事件 detail 类型在 manifest 里缺失，处理优先级（并在文件中注释说明）：
//        a. 能从这个组件的 .d.ts 的 <ClassName>EventMap 接口里挖到类型 -> 用挖到的真类型；
//        b. manifest 的 event 带 type 字段（如 keydown -> KeyboardEvent）-> 用该真类型；
//        c. 都挖不到 -> 退化用 CustomEvent<unknown>（不臆造 detail 类型）。
// =====================================================================

// （manifest 与 declarations 已在文件开头解析 —— 产物 A 也需要它们）

// 递归列出 node_modules/mdui/components 下所有 .d.ts，用于按类名定位 EventMap。
function listComponentDts() {
  const result = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (name.endsWith('.d.ts')) result.push(p);
    }
  };
  walk(join(mduiDir, 'components'));
  return result;
}
const componentDtsFiles = listComponentDts();

// 按类名找到声明该 class 的 .d.ts 文件
function findClassFile(className) {
  for (const file of componentDtsFiles) {
    const content = readFileSync(file, 'utf8');
    if (new RegExp(`export declare class ${className}\\b`).test(content)) return file;
  }
  return null;
}

// 从某个 .d.ts 里挖出 <ClassName>EventMap 接口中每个事件名 -> 事件类型
function digEventMap(className, file) {
  const map = {};
  if (!file) return map;
  const content = readFileSync(file, 'utf8');
  const re = new RegExp(`export interface ${className}EventMap\\s*\\{([\\s\\S]*?)\\n\\}`);
  const mm = content.match(re);
  if (!mm) return map;
  const body = mm[1];
  const evRe = /['"]?([a-zA-Z][\w-]*)['"]?\s*:\s*([^;]+);/g;
  let m;
  while ((m = evRe.exec(body))) {
    map[m[1]] = m[2].trim();
  }
  return map;
}

// 为每个 tag 计算事件类型
const eventMaps = {}; // tagName -> { eventName: typeString }
let dugCount = 0;
let manifestTypeCount = 0;
let unknownCount = 0;

for (const decl of declarations) {
  const file = findClassFile(decl.className);
  const dug = digEventMap(decl.className, file);
  const entry = {};
  for (const ev of decl.events) {
    if (dug[ev.name]) {
      entry[ev.name] = dug[ev.name];
      dugCount++;
    } else if (ev.typeText) {
      entry[ev.name] = ev.typeText;
      manifestTypeCount++;
    } else {
      entry[ev.name] = 'CustomEvent<unknown>';
      unknownCount++;
    }
  }
  eventMaps[decl.tagName] = entry;
}

// 组装 MduiElementEventMap（按 tag 排序，事件按 manifest 顺序）
const eventMapLines = declarations.map((decl) => {
  const entries = decl.events
    .map((ev) => `    '${ev.name}': ${eventMaps[decl.tagName][ev.name]};`)
    .join('\n');
  return `  '${decl.tagName}': {\n${entries}\n  };`;
});
const totalEvents = declarations.reduce((a, d) => a + d.events.length, 0);

const elementsHeaderComment = `// 此文件由 scripts/gen-mdui-types.mjs 自动生成，请勿手改，改动会被覆盖。
// 数据源：@mdui ${mduiVersion} 的 node_modules/mdui/custom-elements.json 与各组件 .d.ts
// 生成策略：
//   - 导出 MduiElementClassMap（tagName -> 元素类），供 src/ui 适配层做泛型收敛；
//     并让 HTMLElementTagNameMap 继承它，保证 createElement 拿到具体类类型。
//   - MduiElementEventMap 的事件类型优先级：组件 .d.ts 的 <ClassName>EventMap 真类型 >
//     manifest 的 event.type 字段（如 keydown: KeyboardEvent）> 退化 CustomEvent<unknown>。
//   - 不臆造事件 detail 类型。升级 mdui 后重跑脚本即可。
// ${withTimestamp ? `生成时间：${new Date().toISOString()}` : '（默认不写入生成时间，避免每次重跑产生无意义 diff；如需可加 --with-timestamp）'}
`;

const classNames = declarations.map((d) => d.className).join(', ');

const mduiElementsContent = `${elementsHeaderComment}
import { ${classNames} } from 'mdui';

// 事件名 -> 事件类型 的映射。供 addEventListener 等场景做类型收敛时使用。
export interface MduiElementEventMap {
${eventMapLines.join('\n')}
}

// 所有 mdui 自定义元素的 tagName 联合类型
export type MduiTag = keyof MduiElementEventMap;

// 某个 mdui 元素上支持的事件名
export type MduiEventName<T extends MduiTag> = keyof MduiElementEventMap[T] & string;

// tagName -> 元素类 的映射。适配层用它把泛型标签收敛成具体元素类型：
//   MduiElementClassMap['mdui-dialog'] === Dialog
export interface MduiElementClassMap {
${declarations.map((d) => `  '${d.tagName}': ${d.className};`).join('\n')}
}

// 全局增强 HTMLElementTagNameMap：让 document.createElement('mdui-dialog') 等拿到具体元素类类型。
// 说明：mdui 各组件 .d.ts 自身也会 declare global { interface HTMLElementTagNameMap } 注册同样的映射，
// 这里用「同一来源（'mdui' 导出的元素类）」再补一遍，类型一致，不会触发重复标识符冲突。
//
// 单独导出 MduiElementClassMap 是为了让 src/ui 适配层能在泛型里用 HTMLElementTagNameMap 做不到的事：
//   HTMLElementTagNameMap[MduiTag] 无法通过类型检查（TS 不知道 MduiTag 是它的键），
//   而 MduiElementClassMap[MduiTag] 可以。
declare global {
  interface HTMLElementTagNameMap extends MduiElementClassMap {}
}
`;

writeFileSync(join(outDir, 'mdui-elements.d.ts'), mduiElementsContent);
console.log(
  `[gen] 已生成 src/types/mdui-elements.d.ts：` +
    `标签 ${declarations.length} 个，事件共 ${totalEvents} 条` +
    `（挖到真类型 ${dugCount} 条，manifest type ${manifestTypeCount} 条，退化 unknown ${unknownCount} 条）`,
);
