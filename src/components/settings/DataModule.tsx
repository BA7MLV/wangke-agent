import StorageCard from '../StorageCard';
import MigrationCard from '../MigrationCard';
import SkillsCard from '../SkillsCard';
import ArchivedSessionsCard from './ArchivedSessionsCard';
import { buildInfoLabel } from '../../utils/buildInfo';

/**
 * 「数据」模块：存储占用、迁移包、写作技能、已归档会话。
 *
 * 这几件事的共同点是**都关于「已积累的东西」** —— 用户进这一屏的动机是
 * 「看看我攒了多少 / 搬个家 / 改一下技能 / 把收起来的对话找回来」，而不是「调一个开关」。
 * 每张卡各自是独立组件（各自管自己的加载态），这里只负责排版与页脚。
 */
export default function DataModule() {
  return (
    <>
      <StorageCard />
      <MigrationCard />
      <SkillsCard />
      {/* 放最后：这是一张「平时不看、有事才回来」的卡，压在技能下面最不打扰 */}
      <ArchivedSessionsCard />

      {/* 页脚：构建信息。用途是排障，不是装饰 —— PWA 的 autoUpdate 会在后台更新 SW
          但不刷新当前页面，iPad 上「改了怎么还是老的」时，靠这一行判断当前跑的是哪个构建
          （时间戳单独一个没有参照物，所以带上 commit 短哈希）。详见
          docs/plans/2026-09-18-build-info-design.md */}
      <div
        className="my-1 text-center text-xs text-muted"
        data-testid="build-info"
      >
        {buildInfoLabel(__BUILD_INFO__, import.meta.env.DEV)}
      </div>
    </>
  );
}
