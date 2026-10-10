# 哔哩哔哩导入代理（Cloudflare Worker）

> ⚠️ 仅供个人学习使用。请遵守哔哩哔哩用户协议，勿用于批量抓取或下载付费 / 会员内容。详见项目根目录 README 的「免责声明」一节。

这个 Worker 是导入 B 站视频的**可选回退**。桌面浏览器请优先用油猴脚本（设置页「安装脚本」），从本机直连，不经过 Cloudflare。Worker 出口 IP 常被 B 站拒绝。

若仍要用 Worker，作用是把浏览器对 B 站的请求转发出去，从而绕过：

1. **CORS 限制**：`api.bilibili.com` / `bilivideo.com` 不允许浏览器跨域直连；
2. **防盗链**：B 站 CDN 会校验 `Referer`，必须伪装成来自 `https://www.bilibili.com`。

Worker 本身**不存储任何数据**，只做请求转发，源码全部可见。

## 部署步骤

1. 注册/登录 [Cloudflare](https://dash.cloudflare.com/)，进入 **Workers & Pages**；
2. 点击 **Create Worker** → 起一个名字（如 `bili-proxy`）→ **Deploy**；
3. 进入 Worker 设置 → **Edit Code**，把 `bili-proxy.js` 的全部内容粘贴进去，**Save and Deploy**；
4. 回到 Worker 概览页，复制右侧的 `*.workers.dev` 地址，例如：
   ```
   https://bili-proxy.yourname.workers.dev
   ```
5. 打开网课学习助手 → **设置 → 哔哩哔哩导入 → 代理地址**，粘贴该地址并保存。

## 可选：限制只允许你的前端访问

为了安全，建议把 Worker 里的 `ALLOWED_ORIGIN` 从 `'*'` 改成你的前端域名：

```js
const ALLOWED_ORIGIN = 'https://wangke.example.com';
```

这样别人就算知道你的 Worker 地址，也无法从别的域名调用它。

## 支持的视频清晰度

清晰度由 B 站接口按你的账号权限返回，本项目不做任何提权：

- **未登录**：B 站匿名接口通常只给 360P；
- **已登录普通账号**：可能拿到 480P / 720P（取决于视频本身）；
- **大会员账号**：可能拿到更高码率（取决于视频本身）。

> 这些差别来自 B 站自己的权限判定，不是本工具的能力。请遵守哔哩哔哩用户协议，勿用它下载会员专享内容。

登录方式：在浏览器里登录 bilibili.com，按 F12 → Application → Cookies → `https://www.bilibili.com`，把 `SESSDATA` 的值复制到网课学习助手的「设置 → 哔哩哔哩导入 → B 站 Cookie」里，格式：

```
SESSDATA=你的SESSDATA值
```

> 说明：Cookie 只保存在你本机浏览器的 localStorage 中，Worker 仅临时透传，不会上传或存储。

## 常见问题

**Q: 导入失败提示「HTTP 412」或「防盗链」？**  
A: 说明 Worker 没正确注入 Referer，检查部署代码是否完整；或 B 站 CDN 临时风控，稍后重试。

**Q: 导入失败提示「未获取到 DASH 流」？**  
A: 该视频可能是付费/地区限制/仅 APP 可播，或需要更高权限 Cookie。

**Q: 速度很慢？**  
A: Worker 免费额度有每秒请求数限制，大视频下载需要几分钟；B 站 CDN 本身也可能限速。

## 实时链路上传中继（live-relay）

> 部署一次，之后 host 与 guest 都只是打开网页连上去，Mac 上不需要常驻任何进程。

```bash
cd cloudflare-worker/live-relay
npx wrangler login     # 首次：浏览器授权你的 Cloudflare 账号
npx wrangler deploy    # 输出 https://wangke-live-relay.<你的子域>.workers.dev
```

把输出的地址（`https://` 换成 `wss://`）填进应用「设置 → 实时链路 → 中继地址」。

- 中继**不存储、不解析**任何业务数据，只按配对码转发帧；
- host 断开有 60 秒宽限，期间重连 guest 无感；房间空闲或宽限到点即回收；
- 免费额度按 DO 活跃时长计费，看视频是小时级会话——开始之前先看一眼 Cloudflare 当时的价目表；
- 真正的带宽约束是你家的上行：1080p 可看，4K 会卡。
