# 哔哩哔哩导入代理（Cloudflare Worker）

这个 Worker 是**网课学习助手**导入 B 站视频的必要组件，作用是把浏览器对 B 站的请求转发出去，从而绕过：

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

- **未登录**：B 站匿名接口通常只给 360P；
- **已登录普通账号**：可拿到 480P / 720P（取决于视频本身）；
- **大会员账号**：可拿到 1080P 高码率 / 4K（取决于视频本身）。

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
