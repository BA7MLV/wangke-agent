// Cloudflare Worker：哔哩哔哩请求代理
// 解决浏览器直连 B 站的 CORS 限制与 CDN 防盗链（Referer 校验）。
//
// 部署：
//   1. 注册 Cloudflare 账号 → Workers → Create Worker
//   2. 把本文件内容粘贴到编辑器 → Deploy
//   3. 记下分配到的地址（如 https://bili-proxy.yourname.workers.dev）
//   4. 在网课学习助手「设置 → 哔哩哔哩导入 → 代理地址」填入该地址
//
// 协议：
//   GET  /?url=<encodeURIComponent(目标地址)>
//   头   X-Bili-Cookie: <用户可选 Cookie>（代理会透传为对 bilibili 的 Cookie）
//
// 安全说明：
//   - 建议部署后只允许你自己的前端域名访问（改 ALLOWED_ORIGIN）。
//   - 本 Worker 只做请求转发，不存储任何数据。

const ALLOWED_ORIGIN = '*'; // 上线建议改成你的前端域名，如 'https://wangke.example.com'

// 允许代理的目标域名白名单（防止被用来刷别的站）
const ALLOWED_HOSTS = new Set([
  'api.bilibili.com',
  'www.bilibili.com',
  'b23.tv',
  'upos-sz-mirror08.bilivideo.com',
  'upos-sz-mirrorcos.bilivideo.com',
  'upos-sz-mirrorali.bilivideo.com',
  'upos-sz-mirrorhw.bilivideo.com',
  'upos-sz-mirrorbsa.bilivideo.com',
  'upos-sz-mirrorbos.bilivideo.com',
  'upos-sz-mirrorcosov.bilivideo.com',
  'upos-sz-mirrorhwov.bilivideo.com',
  'upos-sz-mirror08ov.bilivideo.com',
]);

addEventListener('fetch', (event) => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  // CORS 预检
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(),
    });
  }

  if (request.method !== 'GET') {
    return jsonError('仅支持 GET', 405);
  }

  const urlParam = new URL(request.url).searchParams.get('url');
  if (!urlParam) {
    return jsonError('缺少 url 参数', 400);
  }

  let target;
  try {
    target = new URL(urlParam);
  } catch {
    return jsonError('url 参数不是合法 URL', 400);
  }

  if (!ALLOWED_HOSTS.has(target.hostname)) {
    return jsonError(`目标域名 ${target.hostname} 不在白名单`, 403);
  }

  // 构造转发请求：注入 B 站所需 Referer / User-Agent，透传用户 Cookie
  const headers = new Headers();
  headers.set('Referer', 'https://www.bilibili.com');
  headers.set('User-Agent', request.headers.get('User-Agent') ?? 'Mozilla/5.0 (compatible; BiliProxy/1.0)');
  headers.set('Accept', '*/*');
  headers.set('Accept-Language', 'zh-CN,zh;q=0.9');

  const cookie = request.headers.get('X-Bili-Cookie');
  if (cookie) {
    headers.set('Cookie', cookie);
  }

  const init = {
    method: 'GET',
    headers,
    redirect: 'follow',
  };

  let resp;
  try {
    resp = await fetch(target.toString(), init);
  } catch (e) {
    return jsonError(`转发失败：${e.message}`, 502);
  }

  // 把响应体流式回传，并补上 CORS 头
  const respHeaders = new Headers(resp.headers);
  setCorsHeaders(respHeaders);
  // 删除可能导致问题的头
  respHeaders.delete('Content-Security-Policy');
  respHeaders.delete('X-Frame-Options');

  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers: respHeaders,
  });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Bili-Cookie',
    'Access-Control-Max-Age': '86400',
  };
}

function setCorsHeaders(headers) {
  const c = corsHeaders();
  for (const [k, v] of Object.entries(c)) headers.set(k, v);
}

function jsonError(message, status) {
  return new Response(JSON.stringify({ code: -1, message }), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(),
    },
  });
}
