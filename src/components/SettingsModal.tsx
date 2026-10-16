import { useEffect, useState, type ComponentType } from 'react';
import { Button, ListBox, Modal } from '@heroui/react';
import { Sym } from '../ui/icons';
import { MODAL_CONTAINER_CLASS } from '../ui/modalContainer';
import { closeSettingsAndClearHash, openSettings, useSettingsDialog, type SettingsModule } from './settingsDialogStore';
import ModelsModule from './settings/ModelsModule';
import AppearanceModule from './settings/AppearanceModule';
import SourcesModule from './settings/SourcesModule';
import LiveModule from './settings/LiveModule';
import PlaybackModule from './settings/PlaybackModule';
import DataModule from './settings/DataModule';

/**
 * 设置模块登记表：左侧一列模块名，右侧只渲染当前模块。
 *
 * 为什么是「一次只渲染一个」而不是全渲染 + 隐藏：
 *   - 「模型」模块会在挂载时拉能力元数据，「内容源」模块会探测 B 站登录态 ——
 *     不该在用户只是来看一眼倍速档位时就发这些请求；
 *   - 三个槽位的下拉、收藏夹的搜索框都持有受控 state，卸载即丢弃，
 *     正好符合「关掉设置就当没来过」的预期。
 */
const MODULES: { key: SettingsModule; label: string; icon: string; Component: ComponentType }[] = [
  { key: 'models', label: '模型', icon: 'neurology', Component: ModelsModule },
  { key: 'appearance', label: '外观', icon: 'style', Component: AppearanceModule },
  { key: 'sources', label: '内容源', icon: 'cloud_upload', Component: SourcesModule },
  { key: 'live', label: '实时', icon: 'link', Component: LiveModule },
  { key: 'playback', label: '播放', icon: 'play_circle', Component: PlaybackModule },
  { key: 'data', label: '数据', icon: 'folder', Component: DataModule },
];

/** 模块 key 集合，给 `#/settings/<模块>` 深链做校验（非法值回落到入口模块） */
export const SETTINGS_MODULE_KEYS = MODULES.map((m) => m.key);

/**
 * 全局设置弹窗。挂在 App 根部一次，任何页面都能通过 openSettings() 唤起。
 *
 * **它不是一个路由**：设置是「顺手改一下」的动作，改完就该回到刚才在看的东西。
 * 做成独立页面会把用户的当前位置顶掉，还得再点一次「返回」才回来。
 * （`#/settings` 这条 hash 仍然存在，但它只是**入口**，见 SettingsRoute。）
 *
 * 版式：左侧模块列 + 右侧内容区（宽屏），窄屏折叠成顶部横向标签条。
 * 这个结构取自系统设置 / macOS 偏好设置 —— 一屏能看清「一共有几类设置」，
 * 又不用为每类设置单独做一个路由。
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
  const { open, module } = useSettingsDialog();
  /** 本地副本：模块切换不应该走全局 store（那会让别的订阅者无谓地重渲染） */
  const [localModule, setLocalModule] = useState<SettingsModule>(module);

  // 每次打开都回到入口模块：设置是偶尔进的界面，记住上次停在哪反而难预期
  useEffect(() => {
    if (open) setLocalModule(module);
  }, [open, module]);

  const active = MODULES.find((m) => m.key === localModule) ?? MODULES[0];
  const ActiveContent = active.Component;

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
        <Modal.Container placement="center" className={MODAL_CONTAINER_CLASS}>
          <Modal.Dialog
            className="flex h-[calc(100%-2rem)] max-h-[calc(100%-2rem)] w-[min(64rem,calc(100%-2rem))] max-w-[min(64rem,calc(100%-2rem))] flex-col items-stretch overflow-hidden rounded-[14px] bg-background p-0 shadow-[0_12px_40px_rgb(0_0_0/0.22)] max-[760px]:h-full max-[760px]:max-h-full max-[760px]:w-full max-[760px]:max-w-full"
            data-testid="settings-modal"
          >
            <Modal.CloseTrigger aria-label="关闭设置">
              <Sym name="close" />
            </Modal.CloseTrigger>

            {/* 顶部 52px 是给关闭按钮（右上角 ×）预留的：CloseTrigger 绝对定位在容器右上角，
                不预留的话第一个模块的图标会压在 × 底下。 */}
            <div className="flex min-h-0 flex-1 pt-[52px] max-[760px]:flex-col max-[760px]:pt-12">
              {/* 模块列。窄屏变成顶部的横向标签条 —— 六列并排在 390px 上会挤成
                  「模 / 外 / 内 / 实 / 播 / 数」的单字。
                  用 ListBox 而不是一堆 <button>：选中态、键盘上下键、aria-selected
                  都由 React Aria 处理，和左侧导航栏是同一套语义与代码。 */}
              <ListBox
                className="min-h-0 shrink-0 grow-0 basis-[13.5rem] overflow-y-auto border-r border-border bg-background-secondary px-2.5 py-3.5 max-[760px]:basis-auto max-[760px]:flex-row max-[760px]:gap-1 max-[760px]:overflow-x-auto max-[760px]:overflow-y-hidden max-[760px]:border-r-0 max-[760px]:border-b max-[760px]:px-2.5 max-[760px]:py-2.5"
                aria-label="设置模块"
                selectionMode="single"
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
                    textValue={m.label}
                    /* 选中态用「白底 + 极淡投影」与左侧灰画布拉开，而不是染主色：
                       一屏只有一处该有主色，而设置弹窗里的主色属于内容区。 */
                    className="group flex min-h-[38px] cursor-pointer items-center gap-[11px] rounded-lg px-2.5 text-sm font-medium text-foreground data-[hovered=true]:bg-foreground/6 data-[selected=true]:bg-background data-[selected=true]:shadow-surface data-[focus-visible=true]:outline-2 data-[focus-visible=true]:-outline-offset-2 data-[focus-visible=true]:outline-focus max-[760px]:min-h-[34px] max-[760px]:shrink-0 max-[760px]:gap-1.5 max-[760px]:px-3 max-[760px]:text-[0.8125rem]"
                    data-testid={`settings-nav-${m.key}`}
                  >
                    <span
                      className="grid size-5 shrink-0 place-items-center text-muted group-data-[selected=true]:text-accent max-[760px]:size-4"
                      aria-hidden="true"
                    >
                      <Sym name={m.icon} />
                    </span>
                    <span className="min-w-0 truncate">{m.label}</span>
                  </ListBox.Item>
                ))}
              </ListBox>

              {/* 最后一张卡的底部留白收掉：卡片之间由 Card 的 mb-4 统一给间距，
                  不收的话内容区末尾会多出一段空白。 */}
              <div
                className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-y-contain bg-background px-5 pt-[18px] pb-6 [&>div:last-of-type]:mb-1 max-[760px]:px-3.5 max-[760px]:pt-3.5 max-[760px]:pb-5"
                data-testid={`settings-module-${localModule}`}
              >
                <ActiveContent />
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
        className="h-auto min-h-9 w-full justify-start gap-2.5 rounded-full px-2.5 text-sm font-medium text-muted data-[hovered=true]:bg-background"
        data-testid={testId}
        aria-label="设置"
        onPress={open}
      >
        <span className="grid size-5 shrink-0 place-items-center" aria-hidden="true">
          <Sym name="settings" />
        </span>
        <span>设置</span>
      </Button>
    );
  }

  return (
    <Button
      isIconOnly
      variant="ghost"
      className="size-[34px] shrink-0"
      data-testid={testId}
      aria-label="设置"
      onPress={open}
    >
      <Sym name="settings" />
    </Button>
  );
}
