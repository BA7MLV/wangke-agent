import { useEffect, useRef } from 'react';
import { meteorPosition, meteorProfile, seedMeteors } from './reasoning-meteors';

/** Perspective light trails accelerate smoothly without React frame updates. */
export default function ReasoningMeteorTexture({ intensity, active = true }: { intensity: number; active?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const targetDepth = useRef(intensity);
  const syncDepth = useRef<(() => void) | null>(null);

  useEffect(() => {
    targetDepth.current = intensity;
    syncDepth.current?.();
  }, [intensity]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const meteors = seedMeteors(1);
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0, visible = false, hasSize = false;
    let width = 0, height = 0, travel = 0, previous = 0, lastPaint = 0;
    let depth = targetDepth.current;
    let streak = getComputedStyle(canvas).color;

    const paint = () => {
      ctx.clearRect(0, 0, width, height);
      const count = meteorProfile(depth).count;
      for (let i = 0; i < count; i++) {
        const meteor = meteors[i];
        const { x, y, tailX, tailY, alpha, thickness } = meteorPosition(meteor, depth, width, height, travel);
        if (tailX > width || Math.max(y, tailY) < 0 || Math.min(y, tailY) > height || alpha < 0.01) continue;
        const gradient = ctx.createLinearGradient(tailX, tailY, x, y);
        gradient.addColorStop(0, 'transparent');
        gradient.addColorStop(0.65, streak);
        gradient.addColorStop(1, '#fff');
        ctx.globalAlpha = meteor.brightness * alpha;
        // Taper the trail to a point rather than drawing a flat-ended stripe.
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.moveTo(tailX, tailY);
        ctx.lineTo(x, y - thickness);
        ctx.lineTo(x, y + thickness);
        ctx.closePath(); ctx.fill();
        const glow = ctx.createRadialGradient(x, y, 0, x, y, 2.5);
        glow.addColorStop(0, streak);
        glow.addColorStop(1, 'transparent');
        ctx.fillStyle = glow;
        ctx.fillRect(x - 2.5, y - 2.5, 5, 5);
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.arc(x, y, thickness * 0.75, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
    };
    const tick = (now: number) => {
      const delta = Math.min(64, now - previous);
      // A short ramp feels like accelerating, not switching to a new animation.
      depth += (targetDepth.current - depth) * (1 - Math.exp(-delta / 240));
      travel += delta / 1000 * meteorProfile(depth).speed;
      previous = now;
      if (now - lastPaint >= 1000 / 30) {
        paint();
        lastPaint = now;
      }
      frame = requestAnimationFrame(tick);
    };
    const playback = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      if (hasSize && targetDepth.current > 0 && active && visible && !document.hidden && !motion.matches) {
        previous = performance.now();
        lastPaint = 0;
        frame = requestAnimationFrame(tick);
      }
    };
    const updateDepth = () => {
      if (targetDepth.current === 0 || motion.matches || !active) {
        depth = targetDepth.current;
        paint();
      }
      playback();
    };
    syncDepth.current = updateDepth;
    const resize = () => {
      const box = canvas.getBoundingClientRect();
      if (!box.width || !box.height) { hasSize = false; playback(); return; }
      const dpr = Math.min(devicePixelRatio || 1, 1.6);
      const w = Math.round(box.width * dpr), h = Math.round(box.height * dpr);
      hasSize = true;
      width = box.width; height = box.height;
      if (w === canvas.width && h === canvas.height) { paint(); playback(); return; }
      cancelAnimationFrame(frame);
      canvas.width = w; canvas.height = h;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      paint(); playback();
    };
    const sizeObserver = new ResizeObserver(resize);
    sizeObserver.observe(canvas);
    // Theme/accent changes repaint even when reduced motion has frozen the loop.
    // Resolve CSS only on changes, never inside the animation frame.
    const paletteObserver = new MutationObserver(() => {
      streak = getComputedStyle(canvas).color;
      paint();
    });
    paletteObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
    const intersection = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      playback();
    });
    intersection.observe(canvas);
    motion.addEventListener('change', playback);
    document.addEventListener('visibilitychange', playback);
    resize();
    return () => {
      syncDepth.current = null;
      cancelAnimationFrame(frame);
      sizeObserver.disconnect(); intersection.disconnect();
      paletteObserver.disconnect();
      motion.removeEventListener('change', playback);
      document.removeEventListener('visibilitychange', playback);
    };
  }, [active]);

  return <canvas ref={canvasRef} className="reasoning-slider__meteor-canvas" data-testid="reasoning-meteor-texture" aria-hidden="true" />;
}
