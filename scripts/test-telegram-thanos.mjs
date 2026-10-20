// Reference GLES host translation derived from Telegram ThanosEffect.java,
// GPL-2.0-only. Modified 2026-10-20 for deterministic browser pixel comparison.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';

const sources = {};
for (const [file, expected] of [
  ['thanos_vertex.glsl', 'd592871acc68a4494085a955fc34ef876f234287'],
  ['thanos_fragment.glsl', '0e9afc1d977429b85277b88021e9d3b54f97be23'],
]) {
  // Upstream files have no final newline; retain all other bytes, including spaces.
  const source = (await readFile(new URL(`../src/third-party/telegram-thanos/${file}`, import.meta.url), 'utf8')).replace(/\n$/, '');
  const bytes = Buffer.from(source);
  const hash = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  assert.equal(hash, expected, `${file} must match the pinned upstream Git blob`);
  sources[file] = source;
}
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
  await page.goto(process.env.BASE_URL || 'http://localhost:5173');
  const results = await page.evaluate(async (sources) => {
    const { createTelegramThanosRenderer, telegramParticleGrid } = await import('/src/third-party/telegram-thanos/renderer.ts');
    const check = (ok, reason) => { if (!ok) throw new Error(reason); };
    const report = [];
    // Independent reference host: literal mappings of Java draw() / grid code,
    // using hash-verified upstream GLSL, not the production host's helpers.
    function reference(bitmap, density, seed, padding) {
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width + 2 * padding;
      canvas.height = bitmap.height + 2 * padding;
      const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true,
        antialias: false, preserveDrawingBuffer: true, depth: false, stencil: false });
      check(gl, 'WebGL2 required for reference comparison');
      const program = gl.createProgram();
      for (const [type, text] of [[gl.VERTEX_SHADER, sources['thanos_vertex.glsl']], [gl.FRAGMENT_SHADER, sources['thanos_fragment.glsl']]]) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, text); gl.compileShader(shader);
        check(gl.getShaderParameter(shader, gl.COMPILE_STATUS), gl.getShaderInfoLog(shader));
        gl.attachShader(program, shader);
      }
      gl.transformFeedbackVaryings(program, ['outUV', 'outPosition', 'outVelocity', 'outTime'], gl.INTERLEAVED_ATTRIBS);
      gl.linkProgram(program);
      check(gl.getProgramParameter(program, gl.LINK_STATUS), gl.getProgramInfoLog(program));
      gl.useProgram(program); gl.viewport(0, 0, canvas.width, canvas.height);
      gl.disable(gl.BLEND); gl.clearColor(0, 0, 0, 0);
      const p = Math.max(density * .4, 1);
      let count = Math.max(10, Math.min(Math.trunc(bitmap.width * bitmap.height / (p * p)), 120000));
      const aspect = bitmap.width / bitmap.height;
      let rows = Math.round(Math.sqrt(count / aspect));
      let columns = Math.round(count / rows);
      while (columns * rows < count) { if (columns / rows < aspect) columns++; else rows++; }
      count = columns * rows;
      const size = Math.max(bitmap.width / columns, bitmap.height / rows);
      const buffers = [gl.createBuffer(), gl.createBuffer()];
      for (const buffer of buffers) {
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, count * 28, gl.DYNAMIC_DRAW);
      }
      const texture = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texture);
      for (const [key, value] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
        [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, key, value);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
      let time = 0, index = 0, first = true;
      const loc = (key) => gl.getUniformLocation(program, key);
      return { canvas, gl, grid: { count, columns, rows, size }, draw(dt) {
        time = Math.fround(time + dt * 1.15);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.uniformMatrix3fv(loc('matrix'), false, new Float32Array([bitmap.width, 0, 0, 0, bitmap.height, 0, padding, padding, 1]));
        gl.uniform1f(loc('reset'), first ? 1 : 0);
        gl.uniform1f(loc('time'), time); gl.uniform1f(loc('deltaTime'), dt * 1.15);
        gl.uniform1f(loc('particlesCount'), count); gl.uniform3f(loc('gridSize'), columns, rows, size);
        gl.uniform2f(loc('offset'), 0, 0); gl.uniform1f(loc('scale'), 1); gl.uniform1f(loc('uvOffset'), .6);
        gl.uniform2f(loc('rectSize'), bitmap.width, bitmap.height); gl.uniform1f(loc('seed'), seed);
        gl.uniform1f(loc('dp'), density); gl.uniform1f(loc('longevity'), 1.5);
        gl.uniform2f(loc('size'), canvas.width, canvas.height); gl.uniform1i(loc('tex'), 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffers[index]);
        for (const [a, n, offset] of [[0, 2, 0], [1, 2, 8], [2, 2, 16], [3, 1, 24]]) {
          gl.enableVertexAttribArray(a); gl.vertexAttribPointer(a, n, gl.FLOAT, false, 28, offset);
        }
        gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, buffers[1 - index]);
        gl.beginTransformFeedback(gl.POINTS); gl.drawArrays(gl.POINTS, 0, count); gl.endTransformFeedback();
        gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
        index = 1 - index; first = false;
        check(gl.getError() === gl.NO_ERROR, 'Reference GL error');
      } };
    }
    const read = (canvas) => {
      const gl = canvas.getContext('webgl2');
      const pixels = new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      check(gl.getError() === gl.NO_ERROR, 'Production GL error');
      return pixels;
    };
    for (const density of [1, 2]) {
      for (const fps of [60, 120]) {
        const bitmap = document.createElement('canvas');
        bitmap.width = 144 * density; bitmap.height = 96 * density;
        const ctx = bitmap.getContext('2d');
        ctx.scale(density, density);
        ctx.fillStyle = '#e63829'; ctx.fillRect(0, 0, 72, 60);
        ctx.fillStyle = '#2485fa'; ctx.fillRect(72, 0, 72, 60);
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 66, 144, 30);
        ctx.fillStyle = '#111'; ctx.font = '14px sans-serif'; ctx.fillText('Telegram 图片文字', 3, 86);
        const seed = .314159, padding = 128 * density;
        const original = reference(bitmap, density, seed, padding);
        const production = createTelegramThanosRenderer(bitmap, { density, seed, padding });
        check(JSON.stringify(telegramParticleGrid(bitmap.width, bitmap.height, density)) === JSON.stringify(original.grid), 'Grid differs from native reference');
        const checkpoints = new Set([0, Math.round(fps * .1), Math.round(fps * .3), Math.round(fps * .6), fps, Math.round(fps * 1.5), Math.round(fps * 2.1)]);
        for (let frame = 0; frame <= Math.round(fps * 2.1); frame++) {
          original.draw(frame === 0 ? 0 : 1 / fps);
          production.draw(frame === 0 ? 0 : 1 / fps);
          if (!checkpoints.has(frame)) continue;
          const a = read(original.canvas), b = read(production.canvas);
          let differingBytes = 0, visiblePixels = 0;
          for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) differingBytes++;
          for (let i = 3; i < b.length; i += 4) if (b[i]) visiblePixels++;
          check(differingBytes === 0, `Pixel mismatch: density=${density}, fps=${fps}, frame=${frame}, bytes=${differingBytes}`);
          if (frame === 0) check(visiblePixels > 1000, 'Blank output would falsely pass a pixel comparison');
          if (frame === Math.round(fps * 2.1)) check(visiblePixels === 0 && production.isDead(), 'Native lifetime/cleanup differs');
          report.push({ density, fps, ms: Math.round(frame / fps * 1000), differingBytes, visiblePixels });
          if (density === 1 && fps === 60 && frame === 36) {
            // Hold this exact frame for a side-by-side screenshot, not a RAF race.
            const panel = document.createElement('div');
            panel.id = 'thanos-comparison';
            panel.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#e7e7e7;padding:24px;display:flex;gap:20px;align-items:flex-start;font:16px sans-serif;color:#111';
            for (const [label, canvas] of [['Telegram GLSL + reference host · 600ms', original.canvas], ['Application WebGL2 port · 600ms', production.canvas]]) {
              const column = document.createElement('div');
              column.append(document.createTextNode(label));
              const copy = document.createElement('canvas');
              copy.width = canvas.width; copy.height = canvas.height;
              copy.getContext('2d').drawImage(canvas, 0, 0);
              copy.style.display = 'block'; column.append(copy); panel.append(column);
            }
            document.body.append(panel);
          }
        }
        production.dispose();
        original.gl.getExtension('WEBGL_lose_context').loseContext();
      }
    }
    return report;
  }, sources);
  await page.locator('#thanos-comparison').screenshot({ path: 'e2e-shots/telegram-thanos-compare.png' });
  console.table(results);
  console.log('Pinned upstream shader hashes and 28 deterministic reference frames: byte-identical RGBA output. This is a same-browser reference comparison, not an Android screenshot comparison.');
} finally { await browser.close(); }
