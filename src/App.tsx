import { useEffect } from 'react';
import { HashRouter, Route, Routes } from 'react-router-dom';
import Library from './pages/Library';
import CourseChat from './pages/CourseChat';
import Player from './pages/Player';
import Settings from './pages/Settings';
import Study from './pages/Study';
import { useMobileGlobals } from './utils/useMobile';
import { isModelMetaStale, refreshModelMeta } from './api/modelMeta';
import { resumePendingTranscriptions } from './pipelines/transcribeQueue';
import { backfillCovers } from './pipelines/coverQueue';
import { startStudyTracking } from './store/studyTime';

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
  useEffect(() => {
    if (!isModelMetaStale()) return;
    void refreshModelMeta().catch(() => {});
  }, []);

  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<Library />} />
        <Route path="/chat" element={<CourseChat />} />
        <Route path="/player/:id" element={<Player />} />
        <Route path="/study" element={<Study />} />
        <Route path="/settings" element={<Settings />} />
      </Routes>
    </HashRouter>
  );
}
