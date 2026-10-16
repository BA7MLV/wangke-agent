export default function ChatHistorySkeleton() {
  return (
    <div role="status" aria-label="正在加载会话" style={{ padding: '24px 0' }}>
      {[55, 90, 75, 45].map((width, index) => (
        <div key={index} className="skel-bar" aria-hidden="true"
          style={{ width: `${width}%`, height: index === 0 ? 44 : 18, margin: '0 0 18px', marginLeft: index === 0 ? 'auto' : 0 }} />
      ))}
    </div>
  );
}
