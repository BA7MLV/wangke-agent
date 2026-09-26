/**
 * 同步单元的 id 构造、解析、字段归属与分片规则。
 *
 * ## 为什么单独拆一个零依赖模块
 *
 * 单元 id 是同步协议的**唯一寻址方式** —— 拉、推、冲突判定、墓碑，全部以它为键。
 * 拼错或解析歧义的后果不是报错，而是「同一条数据在两台设备上算出两个不同的键」，
 * 表现为静默重复或静默丢失。所以它必须能被单测钉住，而单测要求它零运行时依赖：
 * 这里只 `import type`，Node 剥掉类型后不需要 Dexie / zustand。
 *
 * 设计文档：docs/plans/2026-09-23-cloud-sync-design.md
 */

import type { Settings } from '../store/settings';
import type { VideoRow } from '../store/db';

// ── 单元 id ─────────────────────────────────────────────────────────────────

/** 每门课程拆出的 5 个单元。顺序即 tombstoneVideos() 要写的顺序，勿随意调整。 */
export const VIDEO_UNIT_SUFFIXES = ['meta', 'content', 'vectors', 'frames', 'cover'] as const;
export type VideoUnitSuffix = (typeof VIDEO_UNIT_SUFFIXES)[number];

/**
 * 课程单元 id：`video:<资源 id>:<后缀>`。
 *
 * 前缀仍叫 `video:`（与设计文档一致），但**语义是「一条课程资源」** ——
 * 阅读材料与视频共用同一个 id 空间（`videos.kind` 区分），材料类课程的
 * `materialBlocks` 也在 `content` 单元里。改名要动设计文档与协议两端，不值当，
 * 因此只在类型与注释上澄清（沿用 `videos` 表本身的先例）。
 */
export function videoUnit(id: string, suffix: VideoUnitSuffix): string {
  return `video:${id}:${suffix}`;
}

/** 一门课程的全部单元 id。删课程时要一次性给这 5 个都写墓碑，漏一个就会「复活」。 */
export function videoUnits(id: string): string[] {
  return VIDEO_UNIT_SUFFIXES.map((s) => videoUnit(id, s));
}

/**
 * 文件夹 / 技能单元：名字要编码。
 *
 * 名字是用户输入，可能是 `第 3 章：入门`、`a/b`、`100%`。编码保证：
 * ① 同一个名字在任何设备上算出**同一个** id（encodeURIComponent 是确定性的）；
 * ② 名字里的分隔符不会让 id 产生歧义。
 *
 * **不做归一化**（不 trim、不大小写折叠）—— 与 `migration.ts` 的「按名字合并」保持
 * 完全一致。若这里擅自归一化，同一个文件夹会在迁移包与同步之间得到两种合并结果。
 */
export function folderUnit(name: string): string {
  return `folder:${encodeURIComponent(name)}`;
}

/** 技能单元：同 folderUnit，按名字编码。内置技能恒定、不参与同步。 */
export function skillUnit(name: string): string {
  return `skill:${encodeURIComponent(name)}`;
}

/** 学习时长单元：一天一个，日期即主键（`YYYY-MM-DD`，本地时区）。 */
export function studyUnit(date: string): string {
  return `study:${date}`;
}

/** 设置是全局单例。 */
export const SETTINGS_UNIT = 'settings';

export type ParsedUnit =
  | { kind: 'video'; id: string; suffix: VideoUnitSuffix }
  | { kind: 'folder'; name: string }
  | { kind: 'skill'; name: string }
  | { kind: 'study'; date: string }
  | { kind: 'settings' };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    // `%` 后面不是合法转义（`folder:%`）会抛 URIError。返回 null 而不是让异常冒泡：
    // 单元 id 可能来自服务端，畸形 id 只该被跳过，不该让整轮同步炸掉。
    return null;
  }
}

/**
 * 解析单元 id；无法识别一律返回 `null`，**不抛异常**。
 *
 * 为什么约定 null 而不是抛：pull 到的单元列表是远端数据，一个畸形 id 不该让整轮同步
 * 失败（不变量：「同步失败绝不阻塞 UI」）。调用方把 null 计入跳过数即可。
 */
export function parseUnit(unit: string): ParsedUnit | null {
  if (typeof unit !== 'string' || unit.length === 0) return null;

  if (unit === SETTINGS_UNIT) return { kind: 'settings' };

  if (unit.startsWith('video:')) {
    // 从右侧切。用 lastIndexOf 而不是 split，这样 id 里万一出现 `:`（理论上 uuid 不会，
    // 但服务端数据不完全可信）也能正确归到 id 一侧，而不是把后缀认错。
    const last = unit.lastIndexOf(':');
    if (last <= 'video:'.length - 1) return null;
    const id = unit.slice('video:'.length, last);
    const suffix = unit.slice(last + 1);
    if (id.length === 0) return null;
    if (!(VIDEO_UNIT_SUFFIXES as readonly string[]).includes(suffix)) return null;
    return { kind: 'video', id, suffix: suffix as VideoUnitSuffix };
  }

  if (unit.startsWith('folder:')) {
    const name = safeDecode(unit.slice('folder:'.length));
    return name ? { kind: 'folder', name } : null;
  }

  if (unit.startsWith('skill:')) {
    const name = safeDecode(unit.slice('skill:'.length));
    return name ? { kind: 'skill', name } : null;
  }

  if (unit.startsWith('study:')) {
    const date = unit.slice('study:'.length);
    // 校验形状：studyDays 的主键就是 `YYYY-MM-DD`，写错形状的日期会让「同一天」匹配不上，
    // 而这类错误在同步里表现为「学习时长莫名少了一截」，很难排查，所以宁可在解析处拦住。
    return DATE_RE.test(date) ? { kind: 'study', date } : null;
  }

  return null;
}

// ── 分片 ───────────────────────────────────────────────────────────────────

/**
 * 文本单元的分片阈值（字节，**gzip 之后**的长度）。
 *
 * 取 256KB 的原因：D1 单行上限 2MB、单条 SQL 语句上限 100KB，而客户端把载荷当
 * **绑定参数**写入（绑定参数不占那 100KB）。256KB 留了 8 倍余量，同时保证
 * 「一小时课程的字幕」这类常见单元基本不被拆分。
 */
export const PART_BYTES = 256 * 1024;

/**
 * 给定字节长度需要多少片。
 *
 * **空载荷也算 1 片**：一个空的文本单元仍然要有一行索引（否则「这条数据存在且为空」
 * 与「这条数据不存在」无法区分，而两者在同步里语义完全不同 —— 后者会触发墓碑合并）。
 */
export function partCount(byteLength: number): number {
  if (!Number.isFinite(byteLength) || byteLength < 0) {
    throw new RangeError(`partCount 需要非负有限数，收到 ${byteLength}`);
  }
  return Math.max(1, Math.ceil(byteLength / PART_BYTES));
}

// ── 字段归属：哪些跟着走、哪些是本机事实 ──────────────────────────────────────

/**
 * `videos` 行中**参与同步**的字段。
 *
 * 注意这里列的是「跨设备有意义」的字段，不是「易变」的字段 —— 曾经把这两个概念混在
 * 一起，导致误以为不可变字段（size / mimeType / duration）不需要进 meta 单元。
 * 实际上：不可变字段若不同步，B 设备上的课程就没有时长、格式、封面主色，
 * 列表与播放器都会缺信息。真正该排除的是**本机事实**，见 VIDEO_LOCAL_FIELDS。
 */
export const VIDEO_META_FIELDS = [
  'name',
  'size',
  'mimeType',
  'duration',
  'createdAt',
  'status',
  'kind',
  'materialFormat',
  'unitCount',
  'scanned',
  'empty',
  'folderId',
  'skillOverride',
  'dominantColor',
  'lastPosition',
  'finished',
  'lastUnit',
] as const;

/**
 * `videos` 行中**不进同步**的字段 —— 它们是单台设备的事实，跟着走会出错。
 *
 * - `fileDeleted`：本机 OPFS 里这份文件被删了（通常是为腾空间）。A 删了只说明 A 的
 *   磁盘上没有，B 的文件可能好端端在。同步过去会把 B 也标记成「文件已删」，
 *   于是 B 上原本能播的课程**变成播不了**，而用户完全不知道自己做错了什么。
 * - `coverState`：封面生成状态（`pending` / `done` / `skipped`），其中 `skipped` 的
 *   典型成因就是「本机文件已删，根本没法生成」。同理会污染对面。
 *   ⚠️ 这条是**暂定**：封面单元（`video:<id>:cover`）实现时要回头确认 —— B 拿到同步来的
 *   封面但 `coverState` 为空时，列表会不会显示成「待生成」。若会，就需要让
 *   coverState 参与同步，或让封面单元带一个显式的「已就绪」标记。
 *   见设计文档 §3.2 封面单元与 §3.11。
 * - `htmlView`：HTML 材料的阅读视图（原样 / 分段）。**同一份材料在不同设备上的最佳视图不同** ——
 *   手机窄屏上「原样」经常是导航条加窄栏小字，得切「分段」；桌面则相反。跟着走等于把
 *   一台设备的选择强加给另一台，用户会看到「我在 iPad 上明明切过分段了」。
 *   与 `lastUnit` 不同：那个是**读到哪了**（位置，跨设备有意义），这个是**用什么姿势读**（偏好）。
 */
export const VIDEO_LOCAL_FIELDS = ['fileDeleted', 'coverState', 'htmlView'] as const;

/**
 * `videos` 行中**属于身份标识**的字段，即主键 `id`。
 *
 * 单独立一类（而不是塞进上面两张表之一）是因为它两者都不是：它不「同步」—— 它就是
 * 单元 id `video:<id>:<后缀>` 本身，寻址靠它；也不是「本机事实」—— 它是全局唯一的资源标识。
 *
 * 它仍然要写进 meta 载荷：不是为了寻址（那由单元 id 完成），而是让载荷自描述，
 * 解包时能校验 `payload.id === parseUnit(unit).id` —— 单元 id 与载荷不一致属于严重的
 * 数据错乱（说明索引与对象对不上），值得在写入前显式拦一次。
 *
 * 这个分类是被 `ALL_VIDEO_FIELDS_CLASSIFIED` 逼出来的：最初只写了「同步 / 本机事实」两类，
 * 守门员立刻报错，才发现 `id` 无处安放。留着这段记录，免得下一个人又想把两类简化回去。
 */
export const VIDEO_IDENTITY_FIELDS = ['id'] as const;

type VideoFieldCovered =
  | (typeof VIDEO_META_FIELDS)[number]
  | (typeof VIDEO_LOCAL_FIELDS)[number]
  | (typeof VIDEO_IDENTITY_FIELDS)[number];

/**
 * 编译期守门员：`VideoRow` 新增字段而没决定它要不要同步时，**这里会报错**。
 *
 * 报错信息形如「Type 'true' is not assignable to type 'false'」，指向的就是这一行 ——
 * 把新字段归入 VIDEO_META_FIELDS / VIDEO_LOCAL_FIELDS / VIDEO_IDENTITY_FIELDS 之一即可。
 *
 * 为什么放在编译期而不是单测里：`npm run build` 含 `tsc -b`，是必经关卡；
 * 而单测要人记得跑。加字段这件事本身是编辑器里的动作，编译期反馈最及时。
 */
export const ALL_VIDEO_FIELDS_CLASSIFIED: [keyof VideoRow] extends [VideoFieldCovered]
  ? true
  : false = true;

/**
 * 设置中**参与同步**的字段（白名单）。
 *
 * 用白名单而不是黑名单：黑名单意味着以后谁加了个 token 类字段，它会**静默地**
 * 跟着同步走。白名单则是「新字段默认留在本机」，泄漏需要人为动作。
 */
export const SYNC_SETTINGS_KEYS = [
  'baseUrl',
  'asrModel',
  'llmModel',
  'visionModel',
  'favorites',
  'contextWindow',
  'asrConcurrency',
  'thinkingEnabled',
  'thinkingEffort',
  'captionScale',
  'agentRounds',
  'danmakuEnabled',
  'customRates',
  'theme',
  'dynamicColor',
  'studyTrackingEnabled',
  'studyIdleMinutes',
  // HTML 材料的联网开关：与 danmakuEnabled / dynamicColor 同类的渲染偏好，不携带凭据，
  // 也不描述「这台设备怎么出网」（那是 bilibiliProxy 被排除的理由）。同步本身只在用户
  // 显式打开云同步后才发生。
  'htmlRemoteAssets',
] as const satisfies readonly (keyof Settings)[];

/**
 * 设置中**明确不参与同步**的字段。必须逐个写明理由，否则下一个人会觉得它只是被忘了。
 *
 * - `apiKey`：付费凭据。同步它等于把 Key 复制到服务端，且多设备共享一个 Key 会让
 *   用量与限流互相干扰。
 * - `bilibiliCookie`：含 `SESSDATA`，是账号登录态。泄漏等于账号被冒用。
 * - `bilibiliProxy`：指向代理部署位置，跟「当前设备怎么出网」绑定，跨设备无意义。
 * - `syncEnabled` / `syncEndpoint` / `syncToken`：**同步自身的配置必须本机独立** ——
 *   否则「关掉同步」这个动作本身要先同步过去，逻辑上成了先有鸡还是先有蛋。
 */
export const NON_SYNC_SETTINGS_KEYS = [
  'apiKey',
  'bilibiliCookie',
  'bilibiliProxy',
  'syncEnabled',
  'syncEndpoint',
  'syncToken',
] as const satisfies readonly (keyof Settings)[];

export type SyncSettingsKey = (typeof SYNC_SETTINGS_KEYS)[number];

type SettingsKeyCovered =
  | (typeof SYNC_SETTINGS_KEYS)[number]
  | (typeof NON_SYNC_SETTINGS_KEYS)[number];

/**
 * 编译期守门员：`Settings` 新增字段而没归入白名单或排除项时，**这里会报错**。
 * 与 `ALL_VIDEO_FIELDS_CLASSIFIED` 同一套思路，理由见上。
 */
export const ALL_SETTINGS_FIELDS_CLASSIFIED: [keyof Settings] extends [SettingsKeyCovered]
  ? true
  : false = true;

/**
 * 按白名单提取可同步的设置。
 *
 * **不深拷贝**：返回的是同引用，调用方（同步层）序列化后即丢弃，不做二次修改。
 */
export function pickSyncSettings(s: Settings): Pick<Settings, SyncSettingsKey> {
  const out = {} as Pick<Settings, SyncSettingsKey>;
  for (const k of SYNC_SETTINGS_KEYS) {
    (out as Record<string, unknown>)[k] = s[k];
  }
  return out;
}
