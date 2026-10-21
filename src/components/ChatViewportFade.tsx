import './chat-viewport-fade.css';

/** 只覆盖消息视区底端的一小条；不参与滚动，也不拦截选择、点击或滚轮。 */
export default function ChatViewportFade() {
  return (
    <div className="chat-viewport-fade" aria-hidden="true">
      <span /><span /><span />
    </div>
  );
}
