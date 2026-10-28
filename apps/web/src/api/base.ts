/**
 * 后端 API 的基地址。
 *
 * 默认为空：前端和 API 同源（一体化镜像，或 web 容器把 /api 反代给 api 容器）。
 * 前后端分开部署在不同域名时，按优先级从下面两处取：
 *
 * 1. 运行时：`/config.js` 写入的 `window.__WANGKE_CONFIG__.apiBaseUrl`。
 *    web 容器启动时根据环境变量 `API_BASE_URL` 生成这个文件，同一个镜像换地址不用重新构建。
 * 2. 构建时：`VITE_API_BASE_URL`。
 *
 * 跨域时浏览器靠 Cookie 登录，后端需要在 `CORS_ORIGINS` 里放行前端域名；
 * 原生壳层（iOS / macOS）不走这里，它们用 `POST /api/v1/auth/token` 换 Bearer token。
 */
declare global {
  interface Window {
    __WANGKE_CONFIG__?: { apiBaseUrl?: string };
  }
}

function resolveBase(): string {
  const runtime = typeof window !== 'undefined' ? window.__WANGKE_CONFIG__?.apiBaseUrl : undefined;
  const value = (runtime || import.meta.env?.VITE_API_BASE_URL || '').trim();
  return value.replace(/\/+$/, '');
}

export const API_BASE_URL = resolveBase();

/** 把 `/api/v1/...` 这样的路径拼成完整地址；同源部署时原样返回。 */
export function apiUrl(path: string): string {
  return `${API_BASE_URL}${path}`;
}
