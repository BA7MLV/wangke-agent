/**
 * 阅读器的对外契约。
 *
 * 单独放一个文件是为了避免循环导入：`MaterialReader` 要按格式分发到各子阅读器，
 * 而子阅读器又要引用这个类型。
 */

/** 阅读器命令式句柄：问答里的「[第3页]」链接点一下就靠它跳过去 */
export interface MaterialReaderHandle {
  /** 滚动到指定单元（PDF 页号 / 文档段落号）并短暂高亮 */
  scrollToUnit: (unit: number) => void;
}

/**
 * HTML 材料的阅读视图。
 *
 * - `raw`：按**原文档**渲染（沙箱 iframe，自带 CSS 与版式），默认；
 * - `blocks`：按段落渲染（历史实现，保留作退路 —— 网页存档的导航条、窄栏小字在
 *   原样视图下确实难读）。
 *
 * 定义在这里而不是 `db.ts`：`db.ts` 被 Node 单测直接 import（type stripping），
 * 不能牵进 `materials/html.ts` 那串 DOMPurify 依赖。这里零依赖，两边都能引。
 */
export type HtmlView = 'raw' | 'blocks';
