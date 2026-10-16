import { PageShell } from '../ui';
import { SettingsButton } from '../components/SettingsModal';
import { useAppNav } from '../components/appNav';
import { StudyDashboard } from '../components/StudyDashboard';

/** 兼容原学习页路径；主要入口已移入设置 → 学习。 */
export default function Study() {
  const nav = useAppNav('study');
  return (
    <PageShell
      title="学习"
      wide
      rootClassName="page-study"
      rail={nav}
      railFooter={<SettingsButton variant="rail" testId="nav-rail-settings" />}
    >
      <StudyDashboard />
    </PageShell>
  );
}
