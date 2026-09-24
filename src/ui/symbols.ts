/**
 * 本项目用到的 **Material Symbols** 图标（MD3 的正确图标集）。
 *
 * 为什么换掉 `@mdui/icons`：那个包自述是「**Material Icons** 的所有图标」——
 * Material Icons 是 **MD2 时代**的图标集，每个图标只有一种形态（实心）。
 * MD3 用的是 **Material Symbols**（变量字体，weight / fill / grade / opsz 四个轴），
 * 最直观的差别就是「**未选中描边、选中实心**」这种双态 —— Material Icons 根本给不了，
 * 这也是之前底部导航两个图标都显实心、看着不像 Material You 的原因。
 *
 * 这里的名字是 **Material Symbols 的官方名（snake_case）**，与 `@material-symbols/svg-400/outlined/*.svg`
 * 的文件名一一对应。生成器会转成 kebab-case 的标签名：
 *   `keyboard_arrow_down` → `<mdui-sym-keyboard-arrow-down>`
 *
 * ⚠️ 新增图标：**只改本文件**，然后按顺序重跑两个生成器：
 *   1. `node scripts/gen-material-symbols.mjs`  → 产出 `src/ui/symbols.generated.ts`
 *   2. `node scripts/gen-mdui-types.mjs`        → 补出 `<mdui-sym-*>` 的 JSX 类型
 * （顺序不能反：第二个脚本要读这里来知道有哪些图标。）
 *
 * 注：`expand_more` 在 Material Symbols 里已改名为 `keyboard_arrow_down`，
 * 所以「展开/收起」用的是后者；Symbols 也只有横向的 `chevron_left/right`，没有纵向 chevron。
 */
export const SYMBOL_NAMES = [
  'add',
  'add_photo_alternate',
  'arrow_back',
  'article',
  'calendar_month',
  'chat',
  'check',
  'chevron_right',
  'close',
  'cloud_upload',
  'code',
  'comment',
  'content_copy',
  'create_new_folder',
  'crop_free',
  'delete',
  'description',
  'download',
  'drag_indicator',
  'edit',
  'error',
  // 问答面板的「技能范围」按钮。不复用 tune：那个图标在讲义面板已经代表
  // 「生成参数（模型 + 技能覆盖）」，同一图标两种含义会让人以为点开是同一类东西。
  'extension',
  'folder',
  'folder_open',
  'format_size',
  // 评论区（讨论区折叠条）。不复用 comment：那个已经被「弹幕」面板占了，
  // 两者在图例上必须能分开（弹幕是单句飘过，评论区是多轮讨论）。
  'forum',
  'graphic_eq',
  'help',
  'home',
  'image',
  'keyboard_arrow_down',
  'lightbulb',
  'link',
  'local_fire_department',
  'mic',
  'more_vert',
  'neurology',
  'open_in_full',
  'photo_camera',
  'picture_as_pdf',
  'play_circle',
  'quiz',
  'refresh',
  'send',
  'settings',
  'style',
  'subtitles',
  'swap_horiz',
  'toc',
  'tune',
  'undo',
  'upload',
  'video_library',
  'visibility',
  'warning',
  'zoom_in',
  'zoom_out',
] as const;

export type SymbolName = (typeof SYMBOL_NAMES)[number];
