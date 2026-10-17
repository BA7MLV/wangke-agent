import { MatrixDots, Shimmer } from './motion';

export default function ChatHistorySkeleton() {
  return (
    <div className="course-chat__history-skel t-skel" role="status" aria-label="正在加载会话">
      <div className="t-skel-skeleton is-pulsing" aria-hidden="true">
      {[55, 90, 75, 45].map((width, index) => (
        <div key={index} className="course-chat__history-skel-bar"
          style={{ width: `${width}%`, height: index === 0 ? 44 : 18, marginLeft: index === 0 ? 'auto' : 0 }} />
      ))}
      </div>
      <span className="course-chat__history-skel-status">
        <MatrixDots />
        <Shimmer text="正在加载会话…" />
      </span>
    </div>
  );
}
