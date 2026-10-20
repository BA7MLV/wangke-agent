/** 阅读器级输入仲裁。书写态只使用这一套滚动，不与 UA 的直接操纵手势混用。 */
export class InkInput {
  private pen: number | null = null;
  private until = 0;
  private touches = new Set<number>();
  private blocked = new Set<number>();
  private pan: { id: number; scroll: HTMLElement; x: number; y: number; time: number; vx: number; vy: number; moving: boolean } | null = null;
  private frame = 0;
  drawing: { id: number; type: string; cancel: () => void } | null = null;

  isBlockedTouch(id: number) {
    return this.blocked.has(id);
  }

  private stopMomentum = () => {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
  };

  private blockTouches() {
    for (const id of this.touches) this.blocked.add(id);
    this.pan = null;
    if (this.drawing?.type === 'touch') this.drawing.cancel();
  }

  endPen(id: number) {
    if (this.pen !== id) return;
    this.pen = null;
    this.until = performance.now() + 250;
  }

  reset = () => {
    this.stopMomentum();
    this.drawing?.cancel();
    this.drawing = null;
    this.pen = null;
    this.until = 0;
    this.pan = null;
    this.touches.clear();
    this.blocked.clear();
  };

  /** 捕获在稳定的阅读器外壳，页面虚拟化卸载也不会中断手指拖动。 */
  attach(root: HTMLElement, finger: () => boolean): () => void {
    const scrollAt = (e: PointerEvent) => e.target instanceof Element ? e.target.closest<HTMLElement>('.mr-scroll') : null;
    const swallow = (e: PointerEvent) => { if (e.cancelable) e.preventDefault(); e.stopPropagation(); };
    const down = (e: PointerEvent) => {
      const scroll = scrollAt(e);
      if (!scroll || e.button !== 0) return;
      this.stopMomentum();
      if (e.pointerType === 'pen') {
        this.blockTouches();
        this.pen = e.pointerId;
        return;
      }
      if (e.pointerType !== 'touch') return;
      this.touches.add(e.pointerId);
      if (this.pen !== null || performance.now() < this.until || e.width > 40 || e.height > 40 || this.touches.size > 1) {
        this.blockTouches();
      }
      if (this.blocked.has(e.pointerId)) { swallow(e); return; }
      if (finger()) return;
      swallow(e);
      this.pan = { id: e.pointerId, scroll, x: e.clientX, y: e.clientY, time: e.timeStamp, vx: 0, vy: 0, moving: false };
      try { scroll.setPointerCapture(e.pointerId); } catch { /* 非活动的合成指针 */ }
    };
    const move = (e: PointerEvent) => {
      if (e.pointerType !== 'touch' || !this.touches.has(e.pointerId)) return;
      if (e.width > 40 || e.height > 40) this.blockTouches();
      if (this.blocked.has(e.pointerId)) { swallow(e); return; }
      const p = this.pan;
      if (!p || p.id !== e.pointerId) return;
      swallow(e);
      const dx = p.x - e.clientX, dy = p.y - e.clientY;
      if (!p.moving && Math.hypot(dx, dy) < 4) return;
      const dt = Math.max(8, e.timeStamp - p.time);
      p.moving = true;
      p.vx = Math.max(-2, Math.min(2, dx / dt));
      p.vy = Math.max(-2, Math.min(2, dy / dt));
      p.scroll.scrollBy({ left: dx, top: dy, behavior: 'instant' });
      p.x = e.clientX; p.y = e.clientY; p.time = e.timeStamp;
    };
    const finish = (e: PointerEvent) => {
      if (e.pointerType === 'pen') { this.endPen(e.pointerId); return; }
      if (!this.touches.has(e.pointerId)) return;
      const p = this.pan;
      const consumed = !!p || this.blocked.has(e.pointerId);
      this.touches.delete(e.pointerId);
      this.blocked.delete(e.pointerId);
      if (p?.id === e.pointerId) {
        this.pan = null;
        if (e.type === 'pointerup' && p.moving && e.timeStamp - p.time < 80 && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
          let time = performance.now();
          const tick = (now: number) => {
            const dt = Math.min(32, now - time);
            time = now;
            const x = p.scroll.scrollLeft, y = p.scroll.scrollTop;
            p.scroll.scrollBy({ left: p.vx * dt, top: p.vy * dt, behavior: 'instant' });
            if (x === p.scroll.scrollLeft) p.vx = 0;
            if (y === p.scroll.scrollTop) p.vy = 0;
            p.vx *= Math.exp(-dt / 180); p.vy *= Math.exp(-dt / 180);
            if (p.scroll.isConnected && Math.hypot(p.vx, p.vy) > 0.02) this.frame = requestAnimationFrame(tick);
            else this.frame = 0;
          };
          this.frame = requestAnimationFrame(tick);
        }
      }
      if (consumed) swallow(e);
    };
    const wheel = (e: WheelEvent) => {
      this.stopMomentum();
      if (this.pen !== null && e.target instanceof Element && e.target.closest('.mr-scroll')) e.preventDefault();
    };
    const visibility = () => { if (document.hidden) this.reset(); };
    root.addEventListener('pointerdown', down, true);
    root.addEventListener('pointermove', move, true);
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) root.addEventListener(type, finish as EventListener, true);
    root.addEventListener('wheel', wheel, { passive: false });
    window.addEventListener('blur', this.reset);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      this.reset();
      root.removeEventListener('pointerdown', down, true);
      root.removeEventListener('pointermove', move, true);
      for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) root.removeEventListener(type, finish as EventListener, true);
      root.removeEventListener('wheel', wheel);
      window.removeEventListener('blur', this.reset);
      document.removeEventListener('visibilitychange', visibility);
    };
  }
}
