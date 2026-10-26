import { Suspense, lazy, useEffect } from 'react';
import { HashRouter, Route, Routes } from 'react-router-dom';
import CourseChat from './pages/CourseChat';
import { useMobileGlobals } from './utils/useMobile';
import { isModelMetaStale, refreshModelMeta } from './api/modelMeta';
import { useSettings } from './store/settings';
import { resumePendingTranscriptions } from './pipelines/transcribeQueue';
import { backfillCovers } from './pipelines/coverQueue';
import { startStudyTracking } from './store/studyTime';
import LiveShareBar from './components/LiveShareBar';
import SettingsModal from './components/SettingsModal';
import { preloadOnIdle } from './utils/preload';
import { FeedbackHost } from './ui';
import { openSettingsFromHash } from './components/settingsDialogStore';
import CloudActivity from './cloud/Activity';
import { cloud } from './cloud/state';

/*
 * 按路由拆包：首页（对话）同步加载，其余页面点进去才下载。
 * 以前七个页面和设置弹窗全部打进同一个 App chunk（约 1.4 MB / gzip 440 KB），
 * 打开首页也要等资源库、播放器、PDF 阅读器的代码一起下完。
 */
// 设置弹窗不在这里拆：各页面的「设置」按钮和它同一个文件，拆了也会被首页带回主包。
// 它最重的部分（十个设置模块）在设置 PR 里已经改成按模块懒加载。
const pages = {
  library: () => import('./pages/Library'),
  player: () => import('./pages/Player'),
  study: () => import('./pages/Study'),
  bot: () => import('./pages/BotWorkspace'),
  projects: () => import('./pages/Projects'),
  live: () => import('./pages/LiveGuest'),
  widget: () => import('./pages/WidgetPreview'),
};
const Library = lazy(pages.library);
const Player = lazy(pages.player);
const Study = lazy(pages.study);
const BotWorkspace = lazy(pages.bot);
const Projects = lazy(pages.projects);
const LiveGuest = lazy(pages.live);
const WidgetPreview = lazy(pages.widget);

export default function App() {
  useMobileGlobals();

  // 学习时长追踪：全局一份，随应用生命周期跑（可见 + 未空闲才计时，见 store/studyTime.ts）。
  // 放在 App 而不是学习页里，是因为「在线时长」本来就不该只在那个页面被统计。
  useEffect(() => startStudyTracking(), []);

  // 首屏画完后，利用空闲时间把最常去的页面预取进缓存，点击时不用等网络。
  useEffect(() => preloadOnIdle([pages.library, pages.player, pages.study]), []);

  // 启动时把上次没转完的视频接着转（刷新/关页会中断任务，但已完成段落了库，续跑不重复计费）
  useEffect(() => {
    void resumePendingTranscriptions();
  }, []);

  // 封面回填：给功能上线前导入的、以及上次生成失败的资源补封面。
  // 放在启动而不是导入路径上，是因为它天然是「补齐历史数据」的活；队列串行，
  // 不会和用户此刻正在做的事抢解码器。
  useEffect(() => {
    void backfillCovers();
  }, []);

  // 模型能力元数据（models.dev）：思考参数长什么样**完全由它决定**，所以不能只在
  // 设置页拉 —— 首次使用或缓存结构升级后，元数据缺失会让「思考深度」控件直接不出现。
  // 失败静默：离线时回退到「只知道能不能思考」，其余功能不受影响。
  //
  // 目录只补全能力；自定义接入无需先登记 models.dev 供应商。
  const catalogsKey = useSettings((s) =>
    s.providers
      .map((p) => p.catalogId)
      .filter((c) => c.trim().length > 0)
      .join('\0'),
  );
  useEffect(() => {
    if (!isModelMetaStale()) return;
    void refreshModelMeta(catalogsKey.split('\0')).catch(() => {});
  }, [catalogsKey]);

  // #/settings 与 #/settings/<module> 不是独立页面，而是「在当前页唤起设置弹窗」的入口。
  // HashRouter 不会把 hash 变化当成路由导航，所以用原生事件监听。
  useEffect(() => {
    const onHash = () => openSettingsFromHash();
    window.addEventListener('hashchange', onHash);
    onHash(); // 处理直接打开 #/settings 的冷启动场景
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  return (
    <HashRouter>
      {/* 实时共享指示条：常驻在任意页面上方（隐私不变量，见 LiveShareBar.tsx 文件头）。
          外面这层 .live-share-host 把它的高度从页面里「扣」出来 —— .page 自身写死
          var(--vvh) 满高，直接当兄弟节点会把文档撑高一条、body 多出滚动条。
          完整理由见 components/live-share-bar.css 顶部注释。 */}
      <div className="live-share-host">
        <LiveShareBar />
        <CloudActivity />
        <FeedbackHost />
        {/* 设置是全局弹窗而不是路由：挂在 App 根部一次，任何页面都能唤起，
            且唤起时不会把用户当前位置顶掉（见 components/SettingsModal.tsx）。 */}
        <SettingsModal />
        <Suspense fallback={<div className="route-fallback" aria-busy="true" />}>
        <Routes>
          <Route path="/" element={cloud.enabled ? <BotWorkspace /> : <CourseChat />} />
          <Route path="/chat" element={cloud.enabled ? <BotWorkspace /> : <CourseChat />} />
          <Route path="/course-chat" element={<CourseChat />} />
          <Route path="/bot" element={<BotWorkspace />} />
          <Route path="/projects" element={<Projects />} />
          <Route path="/projects/:projectId" element={<BotWorkspace />} />
          <Route path="/projects/:projectId/files" element={<BotWorkspace />} />
          <Route path="/library" element={<Library />} />
          <Route path="/player/:id" element={<Player />} />
          <Route path="/study" element={<Study />} />
          {/* #/settings 不是独立页面，而是唤起设置弹窗的入口（见上面的 useEffect）。
              这里仍渲染默认首页，让用户「改完设置就能接着用」。 */}
          <Route path="/settings/*" element={cloud.enabled ? <BotWorkspace /> : <CourseChat />} />
          {/* guest 镜像页：其他设备打开主机复制的链接进来。刻意不挂左侧导航 ——
              它读的是主机的内容，与本机导航的目的地不是一回事（见 LiveGuest.tsx 文件头）。 */}
          <Route path="/live" element={<LiveGuest />} />
          {/* show_widget HTML 的独立预览页；源码通过 BroadcastChannel 传递，不进 URL。 */}
          <Route path="/widget-preview" element={<WidgetPreview />} />
        </Routes>
        </Suspense>
      </div>
    </HashRouter>
  );
}
