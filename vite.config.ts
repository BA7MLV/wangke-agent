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

export default defineConfig({
  plugins: [
    serveOrt(),
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
