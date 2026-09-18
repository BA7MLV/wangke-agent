import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { formatBuildTime } from './src/utils/buildInfo';

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

/**
 * pdf.js 的 CJK 字体映射表（cmaps，169 个 .bcmap）与标准字体（standard_fonts，16 个 .pfb/.ttf）
 * 合计约 2.4MB，**不进仓库也不手抄进 public/**，直接从 node_modules 供给：
 * dev / preview 用中间件直出，build 时拷进 dist。
 *
 * 为什么不用「拷进 public/」这个更直白的做法：手抄的副本会在升级 pdfjs-dist 时静默过期，
 * 现象是「换了版本后某些中文 PDF 变成空白/方块」——极难定位。从 node_modules 读则天然同步。
 *
 * 不配这两项的话：**未内嵌字体的中文 PDF 渲染不出来**（很多教材用系统字体而非内嵌字体），
 * 这类 PDF 在中文场景里占比很高，不是边角情况。
 */
function pdfjsAssets(): Plugin {
  const srcDir = path.resolve(__dirname, 'node_modules/pdfjs-dist');
  const SUBS = ['cmaps', 'standard_fonts'];
  /** 真实输出目录。**不能写死 'dist'**：`--outDir` 或将来换目录时，
   *  copy 会落到一个没人访问的地方，现象是「构建成功但 PDF 里中文全空白」。
   *  configResolved 拿到的是已解析的绝对路径。 */
  let outDir = path.resolve(__dirname, 'dist');
  const contentType = (f: string) => {
    if (f.endsWith('.ttf')) return 'font/ttf';
    if (f.endsWith('.otf')) return 'font/otf';
    return 'application/octet-stream'; // .bcmap / .pfb
  };
  const middleware = (
    req: { url?: string },
    res: { setHeader: (k: string, v: string) => void },
    next: () => void,
  ) => {
    const m = req.url?.match(/^\/pdfjs\/(cmaps|standard_fonts)\/([\w.\-]+)(?:\?.*)?$/);
    if (!m) return next();
    const file = path.join(srcDir, m[1], m[2]);
    if (!fs.existsSync(file)) return next();
    res.setHeader('Content-Type', contentType(m[2]));
    fs.createReadStream(file).pipe(res as unknown as NodeJS.WritableStream);
  };
  return {
    name: 'serve-pdfjs-assets',
    configResolved(config) {
      if (config.build.outDir) outDir = config.build.outDir;
    },
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
    closeBundle() {
      // 放在 closeBundle：这些文件走 SW 的**运行时缓存**（不是预缓存），
      // 与 vite-plugin-pwa 的 SW 生成顺序无关（且扩展名不落在 globPatterns 里，互不干扰）
      for (const sub of SUBS) {
        const from = path.join(srcDir, sub);
        if (!fs.existsSync(from)) continue;
        const to = path.join(outDir, 'pdfjs', sub);
        fs.mkdirSync(to, { recursive: true });
        // 连同 LICENSE 一起拷（Apache-2.0 / Foxit / Liberation 的许可要求）
        for (const f of fs.readdirSync(from)) {
          fs.copyFileSync(path.join(from, f), path.join(to, f));
        }
      }
    },
  };
}

/**
 * 设置页页脚要展示的构建信息：版本 / 构建时间 / commit。
 *
 * 为什么在构建期算、而不是运行时取：运行时 `new Date()` 显示的是「现在」，每次打开都在变，
 * 判断不了「这是哪个构建」—— 而那正是这个功能要回答的问题（PWA 的 autoUpdate 会在后台
 * 更新 SW 但不刷新当前页面，iPad 上「改了怎么还是老的」需要一个可核对的依据）。
 *
 * 为什么带 commit 短哈希：只有一个时间戳是**缺参照物**的，除非记得住每次构建的分钟数；
 * 有了短哈希，「页面显示 5ffa0c7 / 仓库是 abc1234」一眼就能得出「dist 是旧的」。
 *
 * 为什么版本号从 package.json 读：避免在源码里再抄一份、随版本升级静默漂移。
 */
function buildInfo() {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf8')) as {
    version?: string;
  };
  let commit = '';
  try {
    commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: __dirname,
      encoding: 'utf8',
    }).trim();
  } catch {
    // 无 .git（CI 导出源码包）或本机没装 git —— 都是正常情况。
    // 降级成不显示 commit 即可，不能因为一个页脚把构建搞挂。
  }
  return { version: pkg.version ?? '0.0.0', time: formatBuildTime(new Date()), commit };
}

export default defineConfig({
  plugins: [
    serveOrt(),
    serveUserscript(),
    pdfjsAssets(),
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
        //
        // ⚠️ 这里**刻意不加 `mjs`**（pdf.js 的 worker 是 .mjs）：
        // globPatterns 是「必须有匹配」的语义 —— workbox 遇到匹配不到的模式会**直接让构建失败**
        // （实测：`**/pdf.worker*.mjs` 在产物没写全时就报
        //   "One of the glob patterns doesn't match any files" 并中断构建）。
        // 而 worker 的文件名带内容哈希、由 Vite 在打包期才定，配置期没法确定它一定存在。
        // 改成下面的**运行时 CacheFirst**：正则匹配不到只是不缓存，绝不会让构建挂掉。
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
          {
            // pdf.js 的 CJK 字体映射表与标准字体：209 个文件、2.4MB，
            // 预缓存会拖慢首次安装（且多数用户根本不看 PDF），改为用到才下、下过长留
            urlPattern: /\/pdfjs\/(cmaps|standard_fonts)\/.+$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'pdfjs-cmaps-fonts',
              expiration: { maxEntries: 300, maxAgeSeconds: 365 * 24 * 3600 },
            },
          },
          {
            // pdf.js 的 worker（.mjs，文件名带哈希）。**离线打开 PDF 的必要条件**：
            // 不缓存它的话，离线时 worker 拉不到 → new TextLayer/getDocument 直接失败。
            // 只在真正打开过 PDF 之后才会被缓存到（首次安装不为它付体积）。
            urlPattern: /\/pdf\.worker[^/]*\.mjs$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'pdfjs-worker',
              expiration: { maxEntries: 4, maxAgeSeconds: 365 * 24 * 3600 },
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
  // sql.js 供 .apkg 导出用：预打包避免首次导出时 dev 服务器中途重优化依赖导致整页刷新。
  // pdfjs-dist 同理（材料阅读器是动态 import 的，不预打包会在首次打开 PDF 时触发依赖重优化 → 整页刷新，
  // 而那时用户正等着看文件，体验最差）。
  optimizeDeps: { include: ['sql.js', 'onnxruntime-web', 'pdfjs-dist'] },
  build: { target: 'es2020', chunkSizeWarningLimit: 2000 },
  // 注入的是**对象字面量的源码文本**（define 做的是文本替换），故须 JSON.stringify。
  // dev 下这个值同样会被替换成「配置加载时刻」—— 那是误导，所以展示侧用
  // import.meta.env.DEV 分流，不读它（见 src/utils/buildInfo.ts 的 buildInfoLabel）。
  define: {
    __BUILD_INFO__: JSON.stringify(buildInfo()),
  },
});
