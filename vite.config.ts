import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import fs from 'node:fs';
import path from 'node:path';

/**
 * dev 模式下直接以静态文件方式提供 onnxruntime-web 的 wasm/mjs。
 * 否则 vite 会给 ort 内部的动态 import 追加 ?import 并拒绝服务 public 目录文件。
 * （生产构建时这些文件已在 public/ort/ 中，会被原样拷贝到 dist）
 */
function serveOrt(): Plugin {
  const ortDir = path.resolve(__dirname, 'node_modules/onnxruntime-web/dist');
  return {
    name: 'serve-ort',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = req.url?.match(/^\/ort\/([\w.-]+\.(?:mjs|wasm))(?:\?.*)?$/);
        if (!m) return next();
        const file = path.join(ortDir, m[1]);
        if (!fs.existsSync(file)) return next();
        res.setHeader('Content-Type', m[1].endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        fs.createReadStream(file).pipe(res);
      });
    },
  };
}

/**
 * 油猴脚本必须显式声明 charset=utf-8。
 *
 * Vite 的静态中间件对 .js 只发 `Content-Type: text/javascript`（无 charset），
 * 而点「安装脚本」是用新标签页直接打开这个文件的：Chromium 会按内容**嗅探编码**，
 * 中文内容会被猜成 GBK —— 实测 document.characterSet === 'GBK'，元数据里的中文全成乱码
 * （`网课学习助手` → `缃戣瀛︿範鍔╂墜`）。油猴装出来 name/description 也就跟着乱。
 *
 * dev 与 preview 都拦下来自己发（带上 charset），生产构建由 `public/_headers` 顶上。
 */
function serveUserscript(): Plugin {
  const file = path.resolve(__dirname, 'public/wangke-bili-bridge.user.js');
  const middleware = (
    req: { url?: string },
    res: { setHeader: (k: string, v: string) => void },
    next: () => void,
  ) => {
    if ((req.url ?? '').split('?')[0] !== '/wangke-bili-bridge.user.js') return next();
    if (!fs.existsSync(file)) return next();
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    fs.createReadStream(file).pipe(res as unknown as NodeJS.WritableStream);
  };
  return {
    name: 'serve-userscript',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

export default defineConfig({
  plugins: [
    serveOrt(),
    serveUserscript(),
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: '网课学习助手',
        short_name: '网课助手',
        description: '上传网课视频，自动生成字幕、公文格式讲义，支持 AI 问答',
        theme_color: '#1677ff',
        background_color: '#ffffff',
        display: 'standalone',
        orientation: 'any',
        icons: [
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        ],
      },
      workbox: {
        // ffmpeg.wasm / onnxruntime 的 wasm 文件较大
        maximumFileSizeToCacheInBytes: 48 * 1024 * 1024,
        // 不预缓存 html：否则 SW 回放时会丢掉 Cloudflare 下发的 COOP/COEP，VAD wasm 无法用 SharedArrayBuffer
        globPatterns: ['**/*.{js,css,svg,wasm}'],
        navigateFallback: undefined,
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            // 讲义预览的朱雀仿宋分包字体：按需下载后长期缓存（离线可用）
            urlPattern: /\/fonts\/zhuque-fangsong\/.+\.woff2$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'handout-preview-fonts',
              expiration: { maxEntries: 300, maxAgeSeconds: 365 * 24 * 3600 },
            },
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: [
      {
        // 必须精确匹配：前缀别名会把 onnxruntime-web/wasm 拼成 *.mjs/wasm
        find: /^onnxruntime-web(?:\/wasm)?$/,
        replacement: path.resolve(__dirname, 'node_modules/onnxruntime-web/dist/ort.wasm.min.mjs'),
      },
    ],
  },
  server: {
    host: true,
    port: 5173,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
    host: true,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  // sql.js 供 .apkg 导出用：预打包避免首次导出时 dev 服务器中途重优化依赖导致整页刷新
  optimizeDeps: { include: ['sql.js', 'onnxruntime-web'] },
  build: { target: 'es2020', chunkSizeWarningLimit: 2000 },
});
