/**
 * 讲义 DOCX 预览字体兜底。
 *
 * 背景：docx-preview 只输出 font-family 名（Times New Roman, 仿宋_GB2312 等），
 * 不内嵌字体；设备没装公文字体时整篇静默回退成默认字体。
 *
 * 做法：@font-face 的 font-family 声明成与 DOCX 完全一致的名字，
 * src 先 local() 列各平台系统字体别名（命中则零下载），最后回退到
 * 分包开源字体朱雀仿宋（public/fonts/zhuque-fangsong/，OFL-1.1）。
 * 楷体/黑体/宋体三端系统覆盖率高，只做 local() 别名映射，不下载字体。
 */

let injected = false;

/** 注入预览字体样式（幂等）。在 renderAsync 之前调用即可。 */
export function ensureHandoutPreviewFonts(): void {
  if (injected) return;
  injected = true;

  // 纯 local() 别名映射：让 DOCX 字体名命中各平台实际存在的系统字体。
  // 注意 Chrome 的 local() 按完整名/PostScript 名匹配，需带 Regular/PS 名变体（实测 macOS）。
  const style = document.createElement('style');
  style.id = 'handout-preview-fonts';
  style.textContent = `
@font-face { font-family: '楷体_GB2312'; font-weight: 100 900; src: local('楷体_GB2312'), local('KaiTi_GB2312'), local('KaiTi'), local('楷体'), local('Kaiti SC'), local('STKaiti'), local('STKaitiSC-Regular'), local('楷体-简'); }
@font-face { font-family: '黑体'; font-weight: 100 900; src: local('黑体'), local('SimHei'), local('Heiti SC'), local('STHeiti'), local('PingFang SC'), local('PingFangSC-Regular'), local('PingFang SC Regular'), local('Microsoft YaHei'), local('微软雅黑'); }
@font-face { font-family: '宋体'; font-weight: 100 900; src: local('宋体'), local('SimSun'), local('Songti SC'), local('Songti SC Regular'), local('STSong'), local('NSimSun'), local('新宋体'); }
`;
  document.head.append(style);

  // 仿宋_GB2312：分包 woff2 兜底（unicode-range 按真实 cmap 重算，按需下载分包）
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `${import.meta.env.BASE_URL}fonts/zhuque-fangsong/index.css`;
  document.head.append(link);
}
