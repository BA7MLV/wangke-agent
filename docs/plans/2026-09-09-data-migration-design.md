# 数据迁移（导出 / 导入迁移包）设计

日期：2026-09-09
状态：已确认（用户选择：换设备一次性迁移、不含视频本体、包含讲义帧）

## 背景与目标

应用数据全在浏览器本地：视频本体在 OPFS，元数据/字幕/讲义/问答/卡片/弹幕在 IndexedDB（Dexie，`wangke` 库，schema 版本 7），设置（zustand persist）在 localStorage。换设备或清站点数据会全丢。

目标：在设置页提供「导出迁移包 / 导入迁移包」，把除视频本体外的全部学习资料打包成单个文件，换设备一键还原；还原后视频处于「文件已删」状态，字幕/讲义/问答/卡片等全部可用，重新导入视频本体即可恢复播放（沿用项目已有的 `fileDeleted` 机制）。

## 打包格式

单个 `.zip`（用项目已有的 `fflate`，零新依赖）：

```
wangke-backup-2026-09-09.zip
├── manifest.json   # { format: 1, dbVersion, exportedAt, counts: {videos, segments, ...} }
├── db.json         # 全部导出的表
└── settings.json   # 设置（不含 API Key）
```

**包含的表**（`db.json` 的 key 即表名）：
`videos`、`folders`、`segments`、`frames`、`handouts`、`chats`、`chatSessions`、`danmakus`、`cards`、`skills`、`skillRefs`。

**明确排除**：
- 视频本体（OPFS）——体积太大，迁移后重新导入
- `embeddings`——派生数据，由字幕一键可重建，体积是字幕几十倍
- `files` 表——旧版 IndexedDB 视频副本，同上
- API Key——密钥不落盘，导入后自行再填

**二进制编码**：`Blob`（frames.blob、handouts.blob）与 `ArrayBuffer` 转 base64，带类型标记：

```json
 "$blob": "base64...", "type": "image/jpeg" }
 "$bin": "base64..." }
```

**设置**：`settings.json` 存 zustand persist 的字段子集（模型选择、收藏夹、字幕字号、思考档位等），`apiKey` 置空。

## UI：设置页「数据迁移」卡片

位于 StorageCard 与 SkillsCard 之间，两个按钮：

1. **导出迁移包**
   - 序列化所有表 → 打 zip（fflate `zipSync`，二进制级别 STORE 不压缩，PNG/JPEG/docx 本身已压缩过）→ 触发下载 `wangke-backup-YYYY-MM-DD.zip`
   - 导出期间按钮 loading + 行内进度文案（序列化 → 打包）

2. **导入迁移包**
   - `<input type="file" accept=".zip">` 选文件 → fflate `unzipSync` 解出 manifest
   - 先弹 Modal 确认：导出于何时、含 N 个视频 / 字幕 / 讲义 / 问答会话…；当前库已有 M 个视频
   - 勾选「同时恢复界面设置」（默认勾）
   - 确认后执行导入，完成提示各表写入条数

## 导入冲突策略

- **videos**：按 `id`（uuid）匹配。已存在 → **跳过整条**（连其子表，因本机数据可能更新且可能已有视频文件）；不存在 → 写入，且置 `fileDeleted: 1`、清 `lastPosition`
- **子表**（segments/frames/handouts/chats/chatSessions/danmakus/cards）：只跟随新 video 写入；自增主键用 `bulkAdd` 交浏览器分配，`videoId` 关联不变；`chatSessions`/`chats` 的 `sessionId` 链建立 旧id→新id 映射重挂
- **folders**：按名字合并；视频的 `folderId` 经 旧id→新id 映射重挂（未分类的视频无 folderId，自然跳过）
- **skills/skillRefs**：按 `name` 匹配跳过已有同名技能（内置技能永远跳过）；skillRefs 经 旧skillId→新skillId 映射重挂
- **settings**：仅在勾选时 `settings.update()` 覆盖（apiKey 保持本机现值）

## 兼容性

- `manifest.format` 当前为 1；导入端遇到更高 format 直接报错「迁移包由更新版本导出」
- `dbVersion` 仅作提示信息；Dexie 宽松写入，高版本新增字段自然兼容，缺字段取 undefined（各读取点已判空，参照 `sectionsJson`/`cues` 先例）

## 错误处理

- zip 损坏 / 非迁移包（缺 manifest）→ message.error 明确提示
- 导入中途失败 → 已写入部分保留并提示（视频级粒度跳过，不会出现半个视频；Dexie 无跨表事务需求——冲突已按表序规避）
- base64 解码失败 → 跳过该条并计入警告数，最终提示

## 体量估算

1 小时网课 ≈ 字幕 ~1MB + 讲义帧 10–30MB + 讲义 docx 1–5MB + 聊天/弹幕/卡片 <1MB → zip 约 10–35MB。桌面与 iPad Safari 均可承受（fflate 全程内存操作，<100MB 无压力）。

## 测试

`scripts/test-migration.mjs`（node + fflate，仿 test-apkg.mjs 风格）：
- 构造含全部表/二进制字段的 fixture → 导出 → 解压校验 manifest 与往返一致（Blob type/字节、ArrayBuffer 字节级相等）
- 导入到「已有部分重叠数据」的库：验证已有视频被跳过、新视频 fileDeleted=1、sessionId/folderId 重挂正确
- e2e 冒烟补一条（可选）：设置页两按钮可见

## 不做（YAGNI）

- 不做增量/差异导出、不做加密（密钥与内容敏感度低，且不含 API Key）
- 不做云端同步（用户明确一次性迁移场景）
- 不导 embeddings（可重建）
- 不分卷（单文件 35MB 内无压力）
