# 聊天中的材料原图

主助手与课程内问答共用 `read /courses/{id}/images`，课程内可用 `current`。
支持 `offset/limit` 与材料同单位的 `range`。目录返回可直接复制的 Markdown 图片、查看链接与原文链接，图片字节不进入模型上下文。

- PDF：按需渲染整页画面，保留版式与上下文，不冒充单独提取的插图。
- Word：读取正文引用的内嵌光栅图片，预览时才解压相应资源；纯图片段落没有虚构的文字段号。
- Markdown：支持普通及引用式图片，忽略代码中的图片语法。
- HTML：内嵌/外链图片，段号与阅读器使用同一套遍历。

`![说明](#source-image/{编码课程ID}/{图片标识})` 展示图片；去掉 `!` 则为点击预览链接。
标识持久化在回答正文中，每次从本机原材料解析，不持久化临时 Blob URL。非 PDF 图片包含版本摘要，避免材料改动后旧回答指向其他图片。

## 交互与边界

- 进入视口才加载，最多两路并发，重复请求合并，卸载时释放 Blob URL。
- 支持放大、缩小、适应宽度、下载，以及有段落/页锚点时精确回到来源。
- 外链图须用户主动同意后加载，且不发送 Referer；单文件材料的相对路径不可解析。
- 不接受任意文件路径、脚本 URL、SVG data URL 或持久化 blob URL；Word 单张解压图片上限 20 MB。
- 文件删除、设备缺文件、图片改版、解码失败均显示就地提示，可重试或打开原文。
- 图片目录不是视觉输入。模型不能仅凭图片标题声称看过图像细节；细节辨读仍使用已有框选截图与视觉模型链路。
- 导出 Markdown 的引用只在拥有相同本地材料的应用内可解析；不是公开网络图片链接。

## 验证

```sh
node scripts/test-material-images.mjs
node scripts/test-resource-tools.mjs
node scripts/test-chat-sources.mjs
# 开发服务器默认 localhost:5173，可用 BASE_URL 覆盖；不需要模型 API key
node scripts/e2e-material-images.mjs
npm run build
```
