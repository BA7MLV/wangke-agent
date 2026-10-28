// SPDX-License-Identifier: GPL-2.0-only
// Ported from Telegram Android's ThanosEffect.java. Copyright Telegram contributors.
// Modified 2026-10-20: TypeScript/WebGL2 host, explicit GPU resource ownership,
// deterministic frame stepping for tests. Shaders are upstream, unmodified.
// Source commit and distribution requirements: ./NOTICE.md.
// Full license: /public/licenses/telegram-thanos-GPL-2.0.txt.
import vertexSource from './thanos_vertex.glsl?raw';
import fragmentSource from './thanos_fragment.glsl?raw';

export const TELEGRAM_THANOS = {
  commit: '68c6775ac373f4bdb30ae9986282dd5ec0407756',
  timeScale: 1.15,
  longevity: 1.5,
  uvOffset: .6,
  scale: 1,
} as const;

export type PerformanceClass = 'high' | 'average' | 'low';

/** ThanosEffect.Animation.calcParticlesGrid(part=1), lines 1110–1144. */
export function telegramParticleGrid(width: number, height: number, density: number, quality: PerformanceClass = 'high') {
  const maxParticles = { high: 120_000, average: 60_000, low: 30_000 }[quality];
  const p = Math.max(density * .4, 1);
  let count = Math.max(10, Math.min(Math.trunc(width * height / (p * p)), maxParticles));
  const aspect = width / height;
  // The min=1 guards only apply to extreme narrow DOM strips, not native cells.
  let rows = Math.max(1, Math.round(Math.sqrt(count / aspect)));
  let columns = Math.max(1, Math.round(count / rows));
  while (columns * rows < count) {
    if (columns / rows < aspect) columns++;
    else rows++;
  }
  count = columns * rows;
  return { count, columns, rows, size: Math.max(width / columns, height / rows) };
}

export interface ThanosRenderer {
  canvas: HTMLCanvasElement;
  /** Advance by elapsed wall-clock seconds, exactly like Animation.draw(). */
  draw: (deltaSeconds: number) => void;
  isDead: () => boolean;
  dispose: () => void;
}

/** Native GLES30/31 calls mapped to WebGL2; no CPU particle approximation. */
export function createTelegramThanosRenderer(snapshot: HTMLCanvasElement, options: {
  density: number; seed?: number; padding?: number; quality?: PerformanceClass;
}): ThanosRenderer {
  const { density, seed = Math.random() * 2, padding = Math.ceil(192 * density), quality = 'high' } = options;
  if (!Number.isFinite(density) || density <= 0 || !snapshot.width || !snapshot.height) throw new Error('Invalid Thanos surface');
  const canvas = document.createElement('canvas');
  canvas.width = snapshot.width + padding * 2;
  canvas.height = snapshot.height + padding * 2;
  const gl = canvas.getContext('webgl2', {
    alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false,
    // Allows deterministic readPixels checks and frame captures after compositing.
    preserveDrawingBuffer: true,
  });
  if (!gl) throw new Error('Telegram Thanos requires WebGL2');
  const shaders: WebGLShader[] = [];
  const buffers: WebGLBuffer[] = [];
  const vaos: WebGLVertexArrayObject[] = [];
  let program: WebGLProgram | null = null;
  let texture: WebGLTexture | null = null;
  let feedback: WebGLTransformFeedback | null = null;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const vao of vaos) gl.deleteVertexArray(vao);
    for (const buffer of buffers) gl.deleteBuffer(buffer);
    for (const shader of shaders) gl.deleteShader(shader);
    gl.deleteTransformFeedback(feedback);
    gl.deleteTexture(texture);
    gl.deleteProgram(program);
    // Release the per-deletion context instead of accumulating browser contexts.
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  };
  try {
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) throw new Error('Unable to allocate Thanos shader');
      shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || 'Thanos shader compile failed');
      return shader;
    };
    program = gl.createProgram();
    if (!program) throw new Error('Unable to allocate Thanos program');
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vertexSource));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSource));
    gl.transformFeedbackVaryings(program, ['outUV', 'outPosition', 'outVelocity', 'outTime'], gl.INTERLEAVED_ATTRIBS);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'Thanos link failed');
    gl.useProgram(program);
    gl.viewport(0, 0, canvas.width, canvas.height);
    // Upstream explicitly disables blending (ThanosEffect.java:581).
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    const grid = telegramParticleGrid(snapshot.width, snapshot.height, density, quality);
    const loc = (name: string) => gl.getUniformLocation(program!, name);
    const resetLocation = loc('reset');
    const timeLocation = loc('time');
    const deltaLocation = loc('deltaTime');
    gl.uniformMatrix3fv(loc('matrix'), false, new Float32Array([
      snapshot.width, 0, 0, 0, snapshot.height, 0, padding, padding, 1,
    ]));
    gl.uniform2f(loc('rectSize'), snapshot.width, snapshot.height);
    gl.uniform2f(loc('size'), canvas.width, canvas.height);
    gl.uniform3f(loc('gridSize'), grid.columns, grid.rows, grid.size);
    gl.uniform1f(loc('particlesCount'), grid.count);
    gl.uniform1f(loc('seed'), seed);
    gl.uniform1f(loc('dp'), density);
    gl.uniform1f(loc('longevity'), TELEGRAM_THANOS.longevity);
    gl.uniform2f(loc('offset'), 0, 0);
    gl.uniform1f(loc('scale'), TELEGRAM_THANOS.scale);
    gl.uniform1f(loc('uvOffset'), TELEGRAM_THANOS.uvOffset);
    texture = gl.createTexture();
    if (!texture) throw new Error('Unable to allocate Thanos texture');
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // Android GLUtils receives a premultiplied Bitmap with top-to-bottom rows.
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, snapshot);
    gl.uniform1i(loc('tex'), 0);
    feedback = gl.createTransformFeedback();
    if (!feedback) throw new Error('Unable to allocate Thanos feedback');
    for (let i = 0; i < 2; i++) {
      const buffer = gl.createBuffer();
      const vao = gl.createVertexArray();
      if (buffer) buffers.push(buffer);
      if (vao) vaos.push(vao);
      if (!buffer || !vao) throw new Error('Unable to allocate Thanos particles');
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, grid.count * 28, gl.DYNAMIC_DRAW);
      for (const [attribute, components, offset] of [[0, 2, 0], [1, 2, 8], [2, 2, 16], [3, 1, 24]]) {
        gl.enableVertexAttribArray(attribute);
        gl.vertexAttribPointer(attribute, components, gl.FLOAT, false, 28, offset);
      }
    }
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    if (gl.getError() !== gl.NO_ERROR) throw new Error('Unable to initialise Thanos GPU state');
    let time = 0;
    let firstDraw = true;
    let currentBuffer = 0;
    const draw = (deltaSeconds: number) => {
      if (disposed || gl.isContextLost()) return;
      // Java's time is a float; preserve float rounding, not JS double accumulation.
      time = Math.fround(time + deltaSeconds * TELEGRAM_THANOS.timeScale);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform1f(resetLocation, firstDraw ? 1 : 0);
      gl.uniform1f(timeLocation, time);
      gl.uniform1f(deltaLocation, deltaSeconds * TELEGRAM_THANOS.timeScale);
      gl.bindVertexArray(vaos[currentBuffer]);
      gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, feedback);
      gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, buffers[1 - currentBuffer]);
      gl.beginTransformFeedback(gl.POINTS);
      gl.drawArrays(gl.POINTS, 0, grid.count);
      gl.endTransformFeedback();
      gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
      gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
      gl.bindVertexArray(null);
      firstDraw = false;
      currentBuffer = 1 - currentBuffer;
    };
    return { canvas, draw, isDead: () => time > TELEGRAM_THANOS.longevity + .9, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
