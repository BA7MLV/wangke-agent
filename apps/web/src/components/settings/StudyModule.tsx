import StudyTimeCard from '../StudyTimeCard';
import { StudyDashboard } from '../StudyDashboard';

/** 「学习」模块：学习统计、热力图，以及学习时长记录设置。 */
export default function StudyModule() {
  return (
    <div className="page-study">
      <StudyDashboard />
      <StudyTimeCard />
    </div>
  );
}
