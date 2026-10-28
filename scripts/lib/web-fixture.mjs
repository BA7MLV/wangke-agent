import { preview } from 'vite';
import { fileURLToPath } from 'node:url';

/** Real separate static Web + HTTP API proxy, never API static hosting. */
export async function startWebFixture(api) {
  const server = await preview({
    root: fileURLToPath(new URL('../../apps/web', import.meta.url)),
    preview: { host: '127.0.0.1', port: 0, strictPort: false, proxy: { '/api': { target: api, changeOrigin: false } } },
  });
  return {
    origin: `http://127.0.0.1:${server.httpServer.address().port}`,
    close: () => new Promise((resolve, reject) => {
      server.httpServer.close(error => error ? reject(error) : resolve());
      server.httpServer.closeAllConnections();
    }),
  };
}
