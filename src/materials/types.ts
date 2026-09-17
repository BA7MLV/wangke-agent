/**
 * 阅读器的对外契约。
 *
 * 单独放一个文件是为了避免循环导入：`MaterialReader` 要按格式分发到 `PdfReader` / `DocxReader`，
 * 而那两个组件又要引用这个类型。
 */

/** 阅读器命令式句柄：问答里的「[第3页]」链接点一下就靠它跳过去 */
export interface MaterialReaderHandle {
  /** 滚动到指定单元（PDF 页号 / Word 段落号）并短暂高亮 */
  scrollToUnit: (unit: number) => void;
}
