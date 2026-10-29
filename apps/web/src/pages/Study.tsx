import { PageShell } from '../ui';
import { StudyDashboard } from '../components/StudyDashboard';

/** 兼容原学习页路径；主要入口已移入设置 → 学习。 */
export default function Study() {
  return (
    <PageShell
      title="学习"
      wide
      rootClassName="page-study"
    >
      <StudyDashboard />
    </PageShell>
  );
}
