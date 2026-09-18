/**
 * 构建信息（版本 / 构建时间 / commit）的纯逻辑。
 *
 * ⚠️ 这个模块是 **Node 与浏览器双环境**的：vite.config.ts 在构建期用它格式化时间，
 * Settings 页在渲染期用它拼文案。所以它只做字符串与日期运算 ——
 * 不碰 import.meta.env、DOM、process（碰了构建配置在加载时就会炸）。
 * dev/prod 的分流判断留在调用方，见 Settings.tsx 里的 import.meta.env.DEV。
 */

export interface BuildInfo {
  /** package.json 的 version */
  version: string;
  /** 构建机本地时间，`YYYY-MM-DD HH:mm`。dev 下是 vite 配置加载的时刻，调用方不展示 */
  time: string;
  /** git 短哈希；取不到时为空串（CI 导出源码包 / 本机没装 git） */
  commit: string;
}

/**
 * 构建时间 → `YYYY-MM-DD HH:mm`（本地时区）。
 *
 * 为什么手写补零而不用 dayjs：vite.config.ts 要 import 本模块，而 dayjs 是运行时依赖，
 * 为一个补零把它拉进构建配置的依赖图不划算 —— 这是四行代码的事。
 *
 * 为什么存本地时间而不存 UTC：这是个**事件时刻**（这次构建发生在何时），
 * 构建者与观看者是同一个人。按观看者时区重算，只会在 iPad 时区设错时显示一个
 * 让人困惑的时间。完整取舍见 docs/plans/2026-09-18-build-info-design.md。
 */
export function formatBuildTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 页脚文案。
 *
 * 三段里缺谁少谁都能降级：注入值被清掉时至少留下版本号 ——
 * 页脚整行空白比少一段信息更让人怀疑「这功能是不是坏了」。
 *
 * @param info  构建期注入的 `__BUILD_INFO__`
 * @param isDev 开发模式（调用方传 import.meta.env.DEV）
 */
export function buildInfoLabel(info: BuildInfo | null | undefined, isDev: boolean): string {
  const rawVersion = info?.version?.trim();
  // 兜底走「未知版本」而不是 `vunknown`：后者像个真的版本号，反而更难看出是注入丢了
  const version = rawVersion ? `v${rawVersion}` : '未知版本';
  // dev 下不展示注入的 time：那是 vite 配置加载的时刻，不是「构建」，显示出来是误导
  if (isDev) return `${version} · 开发模式`;
  const segments = [version];
  const time = info?.time?.trim();
  if (time) segments.push(time);
  const commit = info?.commit?.trim();
  if (commit) segments.push(commit);
  return segments.join(' · ');
}
