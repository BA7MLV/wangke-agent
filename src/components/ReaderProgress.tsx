import { readRatio } from '../materials/units';

/**
 * 阅读进度线：贴在工具条底边的一条填充线（PDF / Word / Markdown / HTML 共用）。
 *
 * 口径 = 工具条上那个「第 N / M 页/段」，**不是**滚动百分比 ——
 * 分母分子与写回 `videos.lastUnit` 的断点续读是同一组数，
 * 也就不会冒出「线到 80% 了、指示器还写着第 3 段」这种自相矛盾的画面。
 * 取值与夹取规则见 `materials/units.ts` 的 `readRatio`（那里有为什么必须 clamp 的理由）。
 *
 * 四个阅读器共用这一个组件而不是各写两行：口径一旦漂移（某个阅读器忘了传 total），
 * 一眼就能看出来，而不是四个地方各错一次。
 *
 * 刻意**不加 transition**：进度是台阶式的（IntersectionObserver 命中一段才动一次），
 * 加过渡会在两段之间拖出一段假动画，像是还在继续读。
 */

interface Props {
  /** 当前定位单元：PDF 是页，Word / Markdown / HTML 是段 */
  current: number;
  /** 单元总数；0 = 还没排版完 */
  total: number;
  /**
   * 不显示这条线（而不是画成 0%）。
   *
   * 给「这个状态下没有进度可言」用 —— md 的编辑态：段号定位不成立，
   * 报一个看不见的数比不报更糟。
   */
  hidden?: boolean;
}

export default function ReaderProgress({ current, total, hidden }: Props) {
  if (hidden) return null;
  const ratio = readRatio(current, total);
  return (
    <span
      className="mr-bar__progress"
      data-testid="reader-progress"
      // 比例本身也发出去：e2e 读渲染后的宽度不如读这个数准（子像素取整、字体加载都会让它差 0.5%）
      data-ratio={ratio}
      aria-hidden="true"
    >
      <span className="mr-bar__progress-fill" style={{ width: `${ratio * 100}%` }} />
    </span>
  );
}
