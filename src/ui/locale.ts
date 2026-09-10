/**
 * mdui 组件内部文案的本地化。
 *
 * 为什么需要这一步：mdui 的文案（对话框按钮、文本框校验提示等）走 @lit/localize，
 * 源码语言是 en-us。必须先调用 loadLocale() 把语言包注册进去，之后 setLocale() 才可用——
 * 否则 setLocale 会直接抛 `You must call loadLocale first to set up the localized template.`
 *
 * 只支持简体中文，因而语言包走静态 import（约 10KB），避免首次渲染时多一次动态分包往返。
 *
 * ⚠️ 本模块必须在「任何 mdui 组件被注册/渲染之前」执行，所以它是 src/ui/mdui.ts 的第一条 import。
 */
import { loadLocale } from 'mdui/functions/loadLocale.js';
import { setLocale } from 'mdui/functions/setLocale.js';
import * as zhCn from 'mdui/locales/zh-cn.js';

loadLocale(() => Promise.resolve(zhCn));

/** 语言包切换完成（失败也会 resolve，只是组件文案回退英文——不应该因此阻塞应用启动） */
export const mduiLocaleReady: Promise<void> = setLocale('zh-cn').catch((err: unknown) => {
  console.error('[mdui] 切换到简体中文失败，组件内部文案将回退为英文：', err);
});
