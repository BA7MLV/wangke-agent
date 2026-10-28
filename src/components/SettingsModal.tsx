import { Suspense, lazy, useEffect, useState, type ComponentType, type LazyExoticComponent } from 'react';
import { Button, Drawer, ListBox, Modal, Spinner } from '@heroui/react';
import { useMediaQuery } from '../utils/useMobile';
import './settings-sheet.css';
import { Sym } from '../ui/icons';
import { MODAL_CONTAINER_CLASS } from '../ui/modalContainer';
import { closeSettingsAndClearHash, openSettings, useSettingsDialog, type SettingsModule } from './settingsDialogStore';
import { cloud } from '../cloud/state';
import { useTranslation } from 'react-i18next';

/**
 * 设置模块登记表：桌面左侧导航，移动端顶部横向模块栏，只渲染当前模块。
 *
 * 为什么是「一次只渲染一个」而不是全渲染 + 隐藏：
 *   - 「模型」模块会在挂载时拉能力元数据，「内容源」模块会探测 B 站登录态 ——
 *     不该在用户只是来看一眼倍速档位时就发这些请求；
 *   - 三个槽位的下拉、收藏夹的搜索框都持有受控 state，卸载即丢弃，
 *     正好符合「关掉设置就当没来过」的预期。
 */
/*
 * 每个模块按需加载：「模型」一个模块就一千多行，以前打开任何页面都会把十个模块一起打进首屏包。
 * 现在只有用户真的点进某个模块时才下载它。
 * tint 是手机上 iOS 设置式列表里图标底块的颜色。
 */
type Module = { key: SettingsModule; icon: string; tint: string; Component: LazyExoticComponent<ComponentType>; cloudOnly?: boolean };
const ALL_MODULES: Module[] = [
  { key: 'models', icon: 'neurology', tint: '#5e5ce6', Component: lazy(() => import('./settings/ModelsModule')) },
  { key: 'agent', icon: 'neurology', tint: '#0a84ff', Component: lazy(() => import('./settings/AgentModule')) },
  // Bot 与消息渠道只在连着自己服务器时存在：本机模式没有 Bot 运行时，也就没有这两屏。
  { key: 'bot', icon: 'smart_toy', tint: '#5856d6', Component: lazy(() => import('../cloud/BotSettings')), cloudOnly: true },
  { key: 'gateway', icon: 'forum', tint: '#34c759', Component: lazy(() => import('../cloud/GatewaySettings')), cloudOnly: true },
  { key: 'appearance', icon: 'style', tint: '#ff9f0a', Component: lazy(() => import('./settings/AppearanceModule')) },
  { key: 'sources', icon: 'cloud_upload', tint: '#30b0c7', Component: lazy(() => import('./settings/SourcesModule')) },
  { key: 'live', icon: 'link', tint: '#34c759', Component: lazy(() => import('./settings/LiveModule')) },
  { key: 'playback', icon: 'play_circle', tint: '#ff375f', Component: lazy(() => import('./settings/PlaybackModule')) },
  { key: 'shortcuts', icon: 'keyboard', tint: '#8e8e93', Component: lazy(() => import('./settings/ShortcutsModule')) },
  { key: 'study', icon: 'calendar_month', tint: '#ff453a', Component: lazy(() => import('./settings/StudyModule')) },
  { key: 'skills', icon: 'extension', tint: '#bf5af2', Component: lazy(() => import('./settings/SkillsModule')) },
  { key: 'data', icon: 'folder', tint: '#64d2ff', Component: lazy(() => import('./settings/DataModule')) },
];
const CloudModels = lazy(() => import('../cloud/Models'));
const MODULES = ALL_MODULES.filter((m) => !m.cloudOnly || cloud.enabled);

function ModuleFallback() {
  return <div className="settings-module-fallback"><Spinner size="sm" color="current" /></div>;
}

/** 模块 key 集合，给 `#/settings/<模块>` 深链做校验（非法值回落到入口模块） */
export const SETTINGS_MODULE_KEYS = ALL_MODULES.map((m) => m.key);

/**
 * 全局设置弹窗。挂在 App 根部一次，任何页面都能通过 openSettings() 唤起。
 *
 * **它不是一个路由**：设置是「顺手改一下」的动作，改完就该回到刚才在看的东西。
 * 做成独立页面会把用户的当前位置顶掉，还得再点一次「返回」才回来。
 * （`#/settings` 这条 hash 仍然存在，但它只是**入口**，见 SettingsRoute。）
 *
 * 版式：桌面左右排布，移动端顶部分类栏，内容区独立纵向滚动。
 *
 * 版式与配色全部由 HeroUI 组件 + Tailwind 令牌表达（没有 `settings-modal.css`）：
 * 底色/圆角/阴影来自 `Modal`，分隔与画布色读 `bg-background-secondary` /
 * `border-border`，模块列选中态读 `bg-background` + `shadow-surface`。
 *
 * ⚠️ 高度为什么由 frame 撑、而不是给 dialog 一个固定 height：
 * HeroUI 的 `.modal__container` 是 `flex flex-col items-center` +
 * `h-(--visual-viewport-height)`，子元素在竖直方向是被居中的。一旦 dialog 自己带
 * height，它就变成「视口高的居中块」，再叠上给关闭按钮预留的 padding-top，
 * 整块会被推到视口下半截并裁掉底部 —— 表现是内容明明渲染了（DOM 里查得到）
 * 却只露出最上面一条。所以高度交给 frame（它有 `flex-1` + `min-h-0`），
 * dialog 自身只留 min-height，由容器把它撑到接近视口满高。
 *
 * ⚠️ 容器的高度**不用 dvh / vh**：软键盘弹出时 dvh 会变矮，设置面板跟着跳会打断正在
 * 输入的用户。容器现在是 `h-full`，参照的是遮罩身上由 React Aria 内联写入的
 * `--visual-viewport-height`（真实像素），不是视口单位 —— 挂载首帧不会算出错值。
 *
 * （这段早先写的是「`fixed inset-0 h-auto` 由布局引擎给出真实像素」，那是旧结构下的
 * 补丁：容器当时是遮罩的兄弟节点，自己不定位就掉进文档流。结构已按 HeroUI 的期望
 * 改成嵌套，那个补丁连同它的成因一起作废，详见 `ui/modalContainer.ts`。）
 */
export default function SettingsModal() {
  const { t } = useTranslation('settings');
  const { t: common } = useTranslation('common');
  const { open, module, explicit } = useSettingsDialog();
  const mobile = useMediaQuery('(max-width: 760px)');
  /** 本地副本：模块切换不应该走全局 store（那会让别的订阅者无谓地重渲染） */
  const [localModule, setLocalModule] = useState<SettingsModule>(module);
  /** 手机：是否已经「推入」某个模块（false = 停在模块列表） */
  const [pushed, setPushed] = useState(explicit);
  /** 推入 / 返回的方向，决定页面从右滑入还是从左滑回 */
  const [direction, setDirection] = useState<'forward' | 'back'>('forward');

  // 每次打开都回到入口：设置是偶尔进的界面，记住上次停在哪反而难预期
  useEffect(() => {
    if (!open) return;
    setLocalModule(module);
    setPushed(explicit);
    setDirection('forward');
  }, [open, module, explicit]);

  const active = MODULES.find((m) => m.key === localModule) ?? MODULES[0];
  const ActiveContent = cloud.enabled && localModule === 'models' ? CloudModels : active.Component;

  if (mobile) {
    const title = pushed ? t(`modules.${active.key}`) : common('settings');
    return (
      <Drawer.Root isOpen={open} onOpenChange={(next) => !next && closeSettingsAndClearHash()}>
        <Drawer.Backdrop variant="opaque" className="settings-sheet__backdrop">
          <Drawer.Content placement="bottom" className="settings-sheet__content">
            <Drawer.Dialog className="settings-sheet__dialog" data-testid="settings-modal">
              <Drawer.Handle />
              <Drawer.Header className="settings-sheet__header">
                {pushed ? (
                  <Button variant="ghost" size="sm" className="settings-sheet__back" onPress={() => { setDirection('back'); setPushed(false); }}>
                    <Sym name="chevron_left" />{common('settings')}
                  </Button>
                ) : <span aria-hidden="true" />}
                <Drawer.Heading className="settings-sheet__title">{title}</Drawer.Heading>
                <Drawer.CloseTrigger aria-label={common('closeSettings')}><Sym name="close" /></Drawer.CloseTrigger>
              </Drawer.Header>
              <Drawer.Body
                key={pushed ? localModule : 'root'}
                className="settings-sheet__page mx-0 min-h-0 flex-1 overflow-y-auto overscroll-contain px-4"
                data-direction={direction}
                data-testid={pushed ? `settings-module-${localModule}` : 'settings-root'}
              >
                {pushed ? (
                  <Suspense fallback={<ModuleFallback />}><ActiveContent /></Suspense>
                ) : (
                  <ListBox
                    aria-label={common('settingsModules')}
                    selectionMode="none"
                    className="settings-list"
                    onAction={(key) => {
                      setLocalModule(key as SettingsModule);
                      setDirection('forward');
                      setPushed(true);
                    }}
                  >
                    {MODULES.map((m) => (
                      <ListBox.Item key={m.key} id={m.key} textValue={t(`modules.${m.key}`)}
                        className="settings-list__item"
                        data-testid={`settings-nav-${m.key}`}>
                        <span className="settings-list__tile" style={{ background: m.tint }} aria-hidden="true"><Sym name={m.icon} /></span>
                        <span className="settings-list__label">{t(`modules.${m.key}`)}</span>
                        <Sym name="chevron_right" className="settings-list__chevron" />
                      </ListBox.Item>
                    ))}
                  </ListBox>
                )}
              </Drawer.Body>
            </Drawer.Dialog>
          </Drawer.Content>
        </Drawer.Backdrop>
      </Drawer.Root>
    );
  }

  return (
    <Modal.Root isOpen={open} onOpenChange={(next) => !next && closeSettingsAndClearHash()}>
      {/*
        背景遮罩：**刻意不用 variant="blur"**。设置面板是「工具面板」不是「确认对话框」，
        背景只需要压暗一点把注意力引过来，半透明黑已经足够 —— 稳定且零兼容风险。

        ⚠️ 这条原先给的理由（「backdrop 是 dialog 的父元素，毛玻璃会糊掉弹窗内容」）
        在旧结构里是说反了：当时 Container 是遮罩的兄弟节点，而 `.modal__backdrop` 带
        z-index 100000、容器没有 z-index —— 是遮罩画在面板**之上**，backdrop-filter
        才会把面板整块糊掉（「实测整块面板都是模糊的」这个观察是对的，归因错了）。
        现在容器嵌进遮罩，面板绘制在遮罩背景之上，blur 不再是坑；结论不变只是因为它
        本来也不需要毛玻璃。
      */}
      <Modal.Backdrop className="bg-[rgb(10_10_14/0.42)]">
        {/* w-full / h-full 的理由见 MODAL_CONTAINER_CLASS 的注释：少任何一条，
            对话框都会被推到屏幕外面去 —— 那不是不好看，是点不到。
            ⚠️ Container 必须写在 Backdrop **里面**：遮罩带 z-index 100000，兄弟结构下
            它画在面板之上（面板被自己那层遮罩压暗），而且遮罩上的 isDismissable /
            isKeyboardDismissDisabled 会静默失效 —— 详见 ui/modalContainer.ts。 */}
        {/* duration-* 也设置 transition-duration；禁用无关的 scrollbar-color 过渡，
            避免它取消时让 React Aria 的退出等待悬空。HeroUI 的 keyframe 动画不受影响。 */}
        <Modal.Container placement="center" className={`${MODAL_CONTAINER_CLASS} transition-none`}>
          <Modal.Dialog
            className="flex h-[calc(100%-2rem)] max-h-[calc(100%-2rem)] w-[min(64rem,calc(100%-2rem))] max-w-[min(64rem,calc(100%-2rem))] flex-col items-stretch overflow-hidden rounded-[14px] bg-background p-0 shadow-[0_12px_40px_rgb(0_0_0/0.22)] max-[760px]:h-full max-[760px]:max-h-full max-[760px]:w-full max-[760px]:max-w-full"
            data-testid="settings-modal"
          >
            <Modal.CloseTrigger className="z-10" aria-label={common('closeSettings')}>
              <Sym name="close" />
            </Modal.CloseTrigger>

            <div className="flex min-h-0 min-w-0 flex-1">
              <aside className="flex w-48 shrink-0 flex-col border-r border-border bg-background-secondary p-3">
                <h2 className="px-3 py-4 text-lg font-semibold text-balance">{common('settings')}</h2>
              {/* 纵向分类；选中态、方向键与焦点滚动交给 React Aria。 */}
              <ListBox
                className="settings-module-nav settings-module-nav--desktop"
                aria-label={common('settingsModules')}
                orientation="vertical"
                selectionMode="single"
                disallowEmptySelection
                selectedKeys={[localModule]}
                onSelectionChange={(keys) => {
                  const next = [...keys][0];
                  if (next) setLocalModule(next as SettingsModule);
                }}
              >
                {MODULES.map((m) => (
                  <ListBox.Item
                    key={m.key}
                    id={m.key}
                    textValue={t(`modules.${m.key}`)}
                    className="settings-module-nav__item"
                    data-testid={`settings-nav-${m.key}`}
                  >
                    <span className="settings-list__tile settings-list__tile--sm" style={{ background: m.tint }} aria-hidden="true">
                      <Sym name={m.icon} />
                    </span>
                    <span className="min-w-0 truncate">{t(`modules.${m.key}`)}</span>
                  </ListBox.Item>
                ))}
              </ListBox>
              </aside>

              {/* 最后一张卡的底部留白收掉：卡片之间由 Card 的 mb-4 统一给间距，
                  不收的话内容区末尾会多出一段空白。 */}
              <div
                key={localModule}
                className="settings-desktop-page min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-y-contain bg-background px-6 pt-14 pb-6 [&>div:last-of-type]:mb-1"
                data-testid={`settings-module-${localModule}`}
              >
                <Suspense fallback={<ModuleFallback />}><ActiveContent /></Suspense>
              </div>
            </div>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal.Root>
  );
}

/**
 * 设置入口按钮（顶栏 / 侧栏共用）。
 *
 * 单独抽出来是因为「设置」不再是导航项：它不进 rail.items（那会让侧栏以为它是一个
 * 页面而永不高亮），但仍需要在多个地方露出同一个入口。
 */
export interface SettingsButtonProps {
  variant?: 'icon' | 'rail';
  testId?: string;
}

export function SettingsButton({ variant = 'icon', testId = 'open-settings' }: SettingsButtonProps) {
  const { t } = useTranslation('common');
  const open = () => openSettings();

  if (variant === 'rail') {
    /**
     * 视觉上要与侧栏导航项**逐个属性对齐**（见 `ui/layout.tsx` 的 `ListBox.Item`）：
     * 同一个竖列里，「设置」是导航的邻居，不是另一种控件 —— 字号 / 字重 / 高度 /
     * 图标槽 / 圆角 / 文字色 / 悬浮底色都得是同一套，只差没有选中态。
     *
     * 这份类名是**故意重复**导航项那一串的：设置不是一个「页面」，不能进
     * `ListBox`（进去就会有一个永远点不亮的选中态）；而只要它落在同一列里，
     * 两处的版式就必须一起改。改导航项时记得回来对一遍。
     */
    return (
      <Button
        variant="ghost"
        className="min-h-9 w-full justify-start gap-2.5 rounded-full px-2.5 text-sm font-medium text-muted data-[hovered=true]:bg-background"
        data-testid={testId}
        aria-label={t('settings')}
        onPress={open}
      >
        <span className="grid size-5 shrink-0 place-items-center" aria-hidden="true">
          <Sym name="settings" />
        </span>
        <span className="min-w-0 truncate">{t('settings')}</span>
      </Button>
    );
  }

  return (
    <Button
      isIconOnly
      variant="ghost"
      className="size-[34px] shrink-0"
      data-testid={testId}
      aria-label={t('settings')}
      onPress={open}
    >
      <Sym name="settings" />
    </Button>
  );
}
