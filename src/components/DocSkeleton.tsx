import '../materials/material-reader.css';

/**
 * 文档正文的**同形**骨架 —— Word / Markdown / HTML 阅读器在排版期间用它顶住版面。
 *
 * 为什么值得给它一屏骨架，而面板不值得：面板读的是本地 IndexedDB（p50 0.1ms），
 * 这里读的是 **OPFS 文件字节 + 解析**（docx-preview 重建 DOM、pdf.js 建页），
 * 几百毫秒到数秒都有可能 —— 是上一轮 `probe-loading-latency` 结论之外的真等待。
 *
 * 两个变体对应两类真内容的外壳（几何写在 material-reader.css，与真外部件同值）：
 *
 * - `page`：Word 的「白页卡片」。真实 `.mr-docx .docx-wrapper > section.docx` 恒为
 *   `background:#fff`（深浅色都是），所以骨架页也恒为白 —— 页内的灰条因此用**固定浅灰**
 *   而不是 `--background-tertiary`（后者深色下是深灰，落在白卡上会变成「白纸黑杠」）。
 * - `column`：Markdown / HTML 的 760px 正文列，无卡片、直接落在页面底色上，
 *   灰条用语义令牌（深色下自动变深）。
 *
 * 段条高度按正文行高给（`.mr-md` 是 `15px × 1.7 ≈ 26px` 一个块距），首条更宽更高当作标题。
 * 段数是猜的（16 行）—— 文档多长只有读完才知道，取舍同 `LibrarySkeleton`。
 */
export default function DocSkeleton({
  variant = 'column',
  lines = 16,
}: {
  variant?: 'page' | 'column';
  lines?: number;
}) {
  return (
    <div className={`doc-skel doc-skel--${variant}`} data-testid="doc-skeleton" aria-hidden="true">
      <div className="doc-skel__body">
        <span className="skel-bar doc-skel__title" />
        {Array.from({ length: lines }, (_, i) => (
          <span
            key={i}
            className={i % 5 === 4 ? 'skel-bar doc-skel__line doc-skel__line--short' : 'skel-bar doc-skel__line'}
          />
        ))}
      </div>
    </div>
  );
}
