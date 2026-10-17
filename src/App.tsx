import { useEffect } from 'react';
import { HashRouter, Route, Routes } from 'react-router-dom';
import Library from './pages/Library';
import CourseChat from './pages/CourseChat';
import Player from './pages/Player';
import Study from './pages/Study';
import { useMobileGlobals } from './utils/useMobile';
import { isModelMetaStale, refreshModelMeta } from './api/modelMeta';
import { useSettings } from './store/settings';
import { resumePendingTranscriptions } from './pipelines/transcribeQueue';
import { backfillCovers } from './pipelines/coverQueue';
import { startStudyTracking } from './store/studyTime';
import LiveShareBar from './components/LiveShareBar';
import LiveGuest from './pages/LiveGuest';
import SettingsModal from './components/SettingsModal';
import { FeedbackHost } from './ui';
import { openSettingsFromHash } from './components/settingsDialogStore';

export default function App() {
  useMobileGlobals();

  // 学习时长追踪：全局一份，随应用生命周期跑（可见 + 未空闲才计时，见 store/studyTime.ts）。
  // 放在 App 而不是学习页里，是因为「在线时长」本来就不该只在那个页面被统计。
  useEffect(() => startStudyTracking(), []);

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
  // 拉哪些家由本机登记的 `catalogId` 决定（多供应商下每家的能力表分开存），
  // 所以依赖放在这串 key 上：用户去设置里改了供应商的能力数据源，重启后要重新拉。
  const catalogsKey = useSettings((s) =>
    s.providers
      .map((p) => p.catalogId)
      .filter((c) => c.trim().length > 0)
      .join('\0'),
  );
  useEffect(() => {
    if (!catalogsKey || !isModelMetaStale(catalogsKey.split('\0'))) return;
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
        <FeedbackHost />
        {/* 设置是全局弹窗而不是路由：挂在 App 根部一次，任何页面都能唤起，
            且唤起时不会把用户当前位置顶掉（见 components/SettingsModal.tsx）。 */}
        <SettingsModal />
        <Routes>
          {/* 对话页是默认首页：打开应用直接进入课程助手 */}
          <Route path="/" element={<CourseChat />} />
          <Route path="/chat" element={<CourseChat />} />
          <Route path="/library" element={<Library />} />
          <Route path="/player/:id" element={<Player />} />
          <Route path="/study" element={<Study />} />
          {/* #/settings 不是独立页面，而是唤起设置弹窗的入口（见上面的 useEffect）。
              这里仍渲染默认首页，让用户「改完设置就能接着用」。 */}
          <Route path="/settings/*" element={<CourseChat />} />
          {/* guest 镜像页：其他设备打开主机复制的链接进来。刻意不挂左侧导航 ——
              它读的是主机的内容，与本机导航的目的地不是一回事（见 LiveGuest.tsx 文件头）。 */}
          <Route path="/live" element={<LiveGuest />} />
        </Routes>
      </div>
    </HashRouter>
  );
}
