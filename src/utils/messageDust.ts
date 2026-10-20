import { prefersReducedMotion } from './motion';

export interface MessageDust {
  play: () => void;
  dispose: () => void;
}

/** DOM capture/lifecycle adapter. Particle rendering is the actual Telegram shader. */
export async function prepareMessageDust(node: HTMLElement, signal: AbortSignal): Promise<MessageDust | undefined> {
  if (prefersReducedMotion() || signal.aborted || document.hidden) return;
  const rect = node.getBoundingClientRect();
  const scroll = node.closest('[data-testid="course-chat-messages"], [data-testid="chat-list"]');
  const clip = scroll?.getBoundingClientRect();
  const top = Math.max(rect.top, clip?.top ?? 0, 0);
  const bottom = Math.min(rect.bottom, clip?.bottom ?? innerHeight, innerHeight);
  if (rect.width < 1 || bottom <= top) return;
  const cropTop = top - rect.top;
  const height = bottom - top;
  // Native dp is Android display density. Here CSS pixels map to dp and actual
  // devicePixelRatio to density; do not flatten high-DPI text to pixelRatio=1.
  const density = Math.max(1, window.devicePixelRatio || 1);
  const captureAbort = new AbortController();
  const abortCapture = () => captureAbort.abort();
  signal.addEventListener('abort', abortCapture, { once: true });
  let timer: number | undefined;
  try {
    const captured = await Promise.race([
      Promise.all([import('html-to-image'), import('../third-party/telegram-thanos/renderer')])
        .then(async ([{ toCanvas }, { createTelegramThanosRenderer }]) => ({
          createTelegramThanosRenderer,
          snapshot: await toCanvas(node, {
            width: rect.width, height, pixelRatio: density, skipFonts: true,
            style: { margin: '0', height: `${rect.height}px`,
              transform: `translateY(-${cropTop}px)`, animation: 'none', overflow: 'hidden' },
            filter: (child) => !child.matches?.('[data-testid="chat-message-actions"], iframe, video, [data-dust-ignore]'),
            fetchRequestInit: { signal: captureAbort.signal },
          }),
        })),
      new Promise<undefined>((resolve) => {
        timer = window.setTimeout(() => { captureAbort.abort(); resolve(undefined); }, 1500);
      }),
    ]);
    if (!captured || signal.aborted || !node.isConnected || document.hidden) return;
    // Do not paint a ghost at the old position if the user scrolled during capture.
    const current = node.getBoundingClientRect();
    if (Math.abs(current.top - rect.top) > 1 || Math.abs(current.left - rect.left) > 1) return;
    const { snapshot, createTelegramThanosRenderer } = captured;
    snapshot.getContext('2d')!.getImageData(0, 0, 1, 1);
    const padding = Math.ceil(192 * density);
    const renderer = createTelegramThanosRenderer(snapshot, { density, padding });
    const canvas = renderer.canvas;
    canvas.setAttribute('aria-hidden', 'true');
    canvas.dataset.testid = 'chat-message-dust';
    canvas.dataset.renderer = 'telegram-webgl2';
    Object.assign(canvas.style, {
      position: 'fixed', left: `${rect.left - padding / density}px`, top: `${top - padding / density}px`,
      width: `${canvas.width / density}px`, height: `${canvas.height / density}px`,
      pointerEvents: 'none', zIndex: '1000',
    });
    let frame = 0;
    let deadline: number | undefined;
    let disposed = false;
    let started = false;
    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(frame);
      window.clearTimeout(deadline);
      canvas.remove();
      renderer.dispose();
      signal.removeEventListener('abort', dispose);
      document.removeEventListener('wheel', dispose, true);
      document.removeEventListener('touchmove', dispose, true);
      document.removeEventListener('visibilitychange', dispose);
      window.removeEventListener('resize', dispose);
      motionQuery.removeEventListener('change', dispose);
      canvas.removeEventListener('webglcontextlost', dispose);
    };
    signal.addEventListener('abort', dispose, { once: true });
    canvas.addEventListener('webglcontextlost', dispose);
    try {
      // Compile, upload and initialise before committing a destructive operation.
      renderer.draw(0);
    } catch (error) {
      dispose();
      throw error;
    }
    return {
      dispose,
      play: () => {
        if (started || disposed) return;
        if (signal.aborted || prefersReducedMotion() || document.hidden) { dispose(); return; }
        started = true;
        document.addEventListener('wheel', dispose, { capture: true, passive: true });
        document.addEventListener('touchmove', dispose, { capture: true, passive: true });
        document.addEventListener('visibilitychange', dispose);
        window.addEventListener('resize', dispose, { once: true });
        motionQuery.addEventListener('change', dispose, { once: true });
        // Native lifetime: time > 1.5 + .9, timeScale=1.15 (not a 1150ms tween).
        deadline = window.setTimeout(dispose, 2400 / 1.15 + 250);
        document.body.append(canvas);
        let previous = performance.now();
        const draw = (now: number) => {
          if (disposed) return;
          try {
            renderer.draw((now - previous) / 1000);
            previous = now;
            if (renderer.isDead()) { dispose(); return; }
            frame = requestAnimationFrame(draw);
          } catch {
            // Deletion has already committed: a GPU failure must not reject it.
            dispose();
          }
        };
        frame = requestAnimationFrame(draw);
      },
    };
  } catch {
    // Unsupported WebGL2, CORS, snapshot or allocation failures: delete normally.
    return;
  } finally {
    window.clearTimeout(timer);
    signal.removeEventListener('abort', abortCapture);
    captureAbort.abort();
  }
}
