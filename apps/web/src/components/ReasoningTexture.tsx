import { useEffect, useRef } from 'react';
import { asciiCharacter, bayerChannel, REASONING_TEXTURE, textureCellCoverage, textureLuminance, textureProfile } from './reasoning-texture';

/** Masked Bayer shadows with dark-sampled ASCII; no React frame updates or glow. */
export default function ReasoningTexture({ intensity, active = true }: { intensity: number; active?: boolean }) {
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
    const palette = document.createElement('canvas');
    palette.width = palette.height = 1;
    const paletteContext = palette.getContext('2d', { willReadFrequently: true });
    if (!paletteContext) return;
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0, visible = false, hasSize = false;
    let width = 0, height = 0, travel = 0, previous = 0, lastPaint = 0;
    let depth = targetDepth.current;
    let ink = '', color = [0, 0, 0];
    const updatePalette = () => {
      ink = getComputedStyle(canvas).color;
      paletteContext.clearRect(0, 0, 1, 1);
      paletteContext.fillStyle = ink;
      paletteContext.fillRect(0, 0, 1, 1);
      color = Array.from(paletteContext.getImageData(0, 0, 1, 1).data.slice(0, 3));
    };
    updatePalette();

    const paint = () => {
      ctx.clearRect(0, 0, width, height);
      if (depth === 0 || !width || !height) return;
      const { pixel, font, ditherCoverage, asciiCoverage } = textureProfile(depth, height);
      // Quantize each sampled RGB channel with the same fixed 4×4 Bayer threshold.
      for (let row = 0; row * pixel < height; row++) {
        for (let column = 0; column * pixel < width; column++) {
          // Two-by-two pixel groups grow into connected texture on a fixed grid.
          const coverage = textureCellCoverage(Math.floor(column / 2), Math.floor(row / 2), ditherCoverage);
          if (coverage === 0) continue;
          ctx.globalAlpha = (1 - REASONING_TEXTURE.dither.mask / 100) * coverage;
          const x = column * pixel, y = row * pixel;
          const light = textureLuminance((x + pixel / 2) / width, (y + pixel / 2) / height, depth, travel);
          const rgb = color.map(channel => {
            const source = (channel / 255) * (0.35 + light * 0.65) + (1 - channel / 255) * light * 0.4;
            return Math.round(bayerChannel(source, column, row) * 255);
          });
          ctx.fillStyle = `rgb(${rgb.join(' ')})`;
          // Rounded device-pixel boundaries prevent seams between adjacent blocks.
          const sx = Math.round(x * resolution) / resolution, sy = Math.round(y * resolution) / resolution;
          const ex = Math.round((x + pixel) * resolution) / resolution, ey = Math.round((y + pixel) * resolution) / resolution;
          ctx.fillRect(sx, sy, ex - sx, ey - sy);
        }
      }
      ctx.fillStyle = ink;
      ctx.font = `${font}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const cellWidth = font * 0.65, cellHeight = font;
      for (let row = 0; (row + 0.5) * cellHeight < height; row++) {
        for (let column = 0; (column + 0.5) * cellWidth < width; column++) {
          const coverage = textureCellCoverage(column + 2, row + 2, asciiCoverage);
          if (coverage === 0) continue;
          ctx.globalAlpha = (1 - REASONING_TEXTURE.ascii.mask / 100) * coverage;
          const x = (column + 0.5) * cellWidth, y = (row + 0.5) * cellHeight;
          const character = asciiCharacter(textureLuminance(x / width, y / height, depth, travel), 'dark', REASONING_TEXTURE.ascii.strength, depth);
          if (character) ctx.fillText(character, x, y);
        }
      }
      ctx.globalAlpha = 1;
    };
    const tick = (now: number) => {
      const delta = Math.min(64, now - previous);
      // A short ramp feels like accelerating, not switching to a new animation.
      depth += (targetDepth.current - depth) * (1 - Math.exp(-delta / 240));
      travel += delta / 1000 * textureProfile(depth).speed;
      previous = now;
      if (now - lastPaint >= 1000 / 20) {
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
      // Continuous dragging changes the target every pointer event. Keep an
      // already-running frame loop instead of repeatedly cancelling its next frame.
      if (targetDepth.current === 0 || !frame) playback();
    };
    syncDepth.current = updateDepth;
    let resolution = 1;
    const resize = () => {
      const box = canvas.getBoundingClientRect();
      if (!box.width || !box.height) { hasSize = false; playback(); return; }
      const dpr = Math.min(devicePixelRatio || 1, 1.6);
      resolution = dpr;
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
      updatePalette();
      paint();
    });
    paletteObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
    const intersection = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      playback();
    });
    intersection.observe(canvas);
    const updateMotion = () => { depth = targetDepth.current; paint(); playback(); };
    motion.addEventListener('change', updateMotion);
    document.addEventListener('visibilitychange', playback);
    resize();
    return () => {
      syncDepth.current = null;
      cancelAnimationFrame(frame);
      sizeObserver.disconnect(); intersection.disconnect();
      paletteObserver.disconnect();
      motion.removeEventListener('change', updateMotion);
      document.removeEventListener('visibilitychange', playback);
    };
  }, [active]);

  return <canvas ref={canvasRef} className="reasoning-slider__texture-canvas" data-testid="reasoning-texture" aria-hidden="true" />;
}
