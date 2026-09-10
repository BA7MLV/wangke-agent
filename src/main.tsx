import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { useSettings } from './store/settings';
import { applyTheme } from './ui/theme';
// MD3 的参考字体是 Roboto。只自托管**拉丁/数字子集**（latin，约 15KB/字重，离线可用）：
// 中文交给系统字体（PingFang SC / 微软雅黑），因为思源黑体全量要好几 MB，中文应用引 Web 字体不划算，
// 且平台自带的中文字形更符合各系统习惯。字重只用 400（正文）+ 500（标题，MD3 typescale 用 Medium）。
import '@fontsource/roboto/latin-400.css';
import '@fontsource/roboto/latin-500.css';
// mdui 的样式 / 组件注册 / 语言包（这一条 import 就是副作用本身）。
// 放在应用自己的样式之前，让 theme.css 保持在最后一层
import { mduiLocaleReady } from './ui/mdui';
import './theme.css';
import './transitions.css';
import './handout-doc.css';

// 申请持久化存储，防止浏览器在空间紧张时清除 IndexedDB 中的视频/字幕数据
navigator.storage?.persist?.().catch(() => {});

// 首帧之前就把主题挂到 <html> 上，避免深色用户先看到一下白底。
// zustand 的 persist 是同步读 localStorage 的，所以这里能直接拿到用户设置。
applyTheme(useSettings.getState().theme);

const root = ReactDOM.createRoot(document.getElementById('root')!);

/** 主题切换时同步 <html> 上的主题类（深浅的实际配色全在 CSS 令牌里，这里只负责挂类名） */
function Root() {
  const theme = useSettings((s) => s.theme);
  React.useEffect(() => {
    applyTheme(theme);
  }, [theme]);
  return <App />;
}

function render() {
  root.render(
    <React.StrictMode>
      <Root />
    </React.StrictMode>,
  );
}

// 等 mdui 语言包就绪再渲染首帧，避免 mdui 组件先闪一下英文文案。
// 语言包是静态 import 的，这个 promise 在微任务里就 resolve；失败也已内部兜住，不会阻塞启动。
mduiLocaleReady.finally(render);
