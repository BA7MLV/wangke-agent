// 此文件由 scripts/gen-mdui-types.mjs 自动生成，请勿手改，改动会被覆盖。
// 数据源：@mdui 2.1.5 的 node_modules/mdui/custom-elements.json 与各组件 .d.ts
// 生成策略：
//   - 导出 MduiElementClassMap（tagName -> 元素类），供 src/ui 适配层做泛型收敛；
//     并让 HTMLElementTagNameMap 继承它，保证 createElement 拿到具体类类型。
//   - MduiElementEventMap 的事件类型优先级：组件 .d.ts 的 <ClassName>EventMap 真类型 >
//     manifest 的 event.type 字段（如 keydown: KeyboardEvent）> 退化 CustomEvent<unknown>。
//   - 不臆造事件 detail 类型。升级 mdui 后重跑脚本即可。
// （默认不写入生成时间，避免每次重跑产生无意义 diff；如需可加 --with-timestamp）

import { Avatar, Badge, BottomAppBar, Button, ButtonIcon, Card, Checkbox, Chip, CircularProgress, Collapse, CollapseItem, Dialog, Divider, Dropdown, Fab, Icon, Layout, LayoutItem, LayoutMain, LinearProgress, List, ListItem, ListSubheader, Menu, MenuItem, NavigationBar, NavigationBarItem, NavigationDrawer, NavigationRail, NavigationRailItem, Radio, RadioGroup, RangeSlider, SegmentedButton, SegmentedButtonGroup, Select, Slider, Snackbar, Switch, Tab, TabPanel, Tabs, TextField, Tooltip, TopAppBar, TopAppBarTitle } from 'mdui';

// 事件名 -> 事件类型 的映射。供 addEventListener 等场景做类型收敛时使用。
export interface MduiElementEventMap {
  'mdui-avatar': {

  };
  'mdui-badge': {

  };
  'mdui-bottom-app-bar': {
    'show': CustomEvent<void>;
    'shown': CustomEvent<void>;
    'hide': CustomEvent<void>;
    'hidden': CustomEvent<void>;
  };
  'mdui-button': {
    'focus': FocusEvent;
    'blur': FocusEvent;
    'invalid': CustomEvent<void>;
    'keydown': KeyboardEvent;
  };
  'mdui-button-icon': {
    'focus': FocusEvent;
    'blur': FocusEvent;
    'change': CustomEvent<void>;
    'invalid': CustomEvent<void>;
    'keydown': KeyboardEvent;
  };
  'mdui-card': {
    'focus': FocusEvent;
    'blur': FocusEvent;
    'keydown': KeyboardEvent;
  };
  'mdui-checkbox': {
    'focus': FocusEvent;
    'blur': FocusEvent;
    'change': CustomEvent<void>;
    'input': Event;
    'invalid': CustomEvent<void>;
    'keydown': KeyboardEvent;
  };
  'mdui-chip': {
    'focus': FocusEvent;
    'blur': FocusEvent;
    'invalid': CustomEvent<void>;
    'change': CustomEvent<void>;
    'delete': CustomEvent<void>;
    'keydown': KeyboardEvent;
  };
  'mdui-circular-progress': {

  };
  'mdui-collapse': {
    'change': CustomEvent<void>;
  };
  'mdui-collapse-item': {
    'open': CustomEvent<void>;
    'opened': CustomEvent<void>;
    'close': CustomEvent<void>;
    'closed': CustomEvent<void>;
  };
  'mdui-dialog': {
    'open': CustomEvent<void>;
    'opened': CustomEvent<void>;
    'close': CustomEvent<void>;
    'closed': CustomEvent<void>;
    'overlay-click': CustomEvent<void>;
  };
  'mdui-divider': {

  };
  'mdui-dropdown': {
    'open': CustomEvent<void>;
    'opened': CustomEvent<void>;
    'close': CustomEvent<void>;
    'closed': CustomEvent<void>;
  };
  'mdui-fab': {
    'focus': FocusEvent;
    'blur': FocusEvent;
    'invalid': CustomEvent<void>;
    'keydown': KeyboardEvent;
  };
  'mdui-icon': {

  };
  'mdui-layout': {

  };
  'mdui-layout-item': {

  };
  'mdui-layout-main': {

  };
  'mdui-linear-progress': {

  };
  'mdui-list': {

  };
  'mdui-list-item': {
    'focus': FocusEvent;
    'blur': FocusEvent;
    'keydown': KeyboardEvent;
  };
  'mdui-list-subheader': {

  };
  'mdui-menu': {
    'change': CustomEvent<void>;
  };
  'mdui-menu-item': {
    'focus': FocusEvent;
    'blur': FocusEvent;
    'submenu-open': CustomEvent<void>;
    'submenu-opened': CustomEvent<void>;
    'submenu-close': CustomEvent<void>;
    'submenu-closed': CustomEvent<void>;
    'keydown': KeyboardEvent;
  };
  'mdui-navigation-bar': {
    'change': CustomEvent<void>;
    'show': CustomEvent<void>;
    'shown': CustomEvent<void>;
    'hide': CustomEvent<void>;
    'hidden': CustomEvent<void>;
  };
  'mdui-navigation-bar-item': {
    'focus': FocusEvent;
    'blur': FocusEvent;
    'keydown': KeyboardEvent;
  };
  'mdui-navigation-drawer': {
    'open': CustomEvent<void>;
    'opened': CustomEvent<void>;
    'close': CustomEvent<void>;
    'closed': CustomEvent<void>;
    'overlay-click': CustomEvent<void>;
  };
  'mdui-navigation-rail': {
    'change': CustomEvent<void>;
  };
  'mdui-navigation-rail-item': {
    'focus': FocusEvent;
    'blur': FocusEvent;
    'keydown': KeyboardEvent;
  };
  'mdui-radio': {
    'focus': FocusEvent;
    'blur': FocusEvent;
    'change': CustomEvent<void>;
    'keydown': KeyboardEvent;
  };
  'mdui-radio-group': {
    'change': CustomEvent<void>;
    'input': CustomEvent<void>;
    'invalid': CustomEvent<void>;
  };
  'mdui-range-slider': {
    'focus': FocusEvent;
    'blur': FocusEvent;
    'change': CustomEvent<void>;
    'input': Event;
    'invalid': CustomEvent<void>;
    'keydown': KeyboardEvent;
  };
  'mdui-segmented-button': {
    'focus': FocusEvent;
    'blur': FocusEvent;
    'invalid': CustomEvent<void>;
    'keydown': KeyboardEvent;
  };
  'mdui-segmented-button-group': {
    'change': CustomEvent<void>;
    'invalid': CustomEvent<void>;
  };
  'mdui-select': {
    'focus': FocusEvent;
    'blur': FocusEvent;
    'change': CustomEvent<void>;
    'invalid': CustomEvent<void>;
    'clear': CustomEvent<void>;
    'keydown': KeyboardEvent;
  };
  'mdui-slider': {
    'focus': FocusEvent;
    'blur': FocusEvent;
    'change': CustomEvent<void>;
    'input': Event;
    'invalid': CustomEvent<void>;
    'keydown': KeyboardEvent;
  };
  'mdui-snackbar': {
    'open': CustomEvent<void>;
    'opened': CustomEvent<void>;
    'close': CustomEvent<void>;
    'closed': CustomEvent<void>;
    'action-click': CustomEvent<void>;
  };
  'mdui-switch': {
    'focus': FocusEvent;
    'blur': FocusEvent;
    'change': CustomEvent<void>;
    'input': Event;
    'invalid': CustomEvent<void>;
    'keydown': KeyboardEvent;
  };
  'mdui-tab': {
    'focus': FocusEvent;
    'blur': FocusEvent;
    'keydown': KeyboardEvent;
  };
  'mdui-tab-panel': {

  };
  'mdui-tabs': {
    'change': CustomEvent<void>;
  };
  'mdui-text-field': {
    'focus': FocusEvent;
    'blur': FocusEvent;
    'change': CustomEvent<void>;
    'input': CustomEvent<void>;
    'invalid': CustomEvent<void>;
    'clear': CustomEvent<void>;
    'keydown': KeyboardEvent;
  };
  'mdui-tooltip': {
    'open': CustomEvent<void>;
    'opened': CustomEvent<void>;
    'close': CustomEvent<void>;
    'closed': CustomEvent<void>;
  };
  'mdui-top-app-bar': {
    'show': CustomEvent<void>;
    'shown': CustomEvent<void>;
    'hide': CustomEvent<void>;
    'hidden': CustomEvent<void>;
  };
  'mdui-top-app-bar-title': {

  };
}

// 所有 mdui 自定义元素的 tagName 联合类型
export type MduiTag = keyof MduiElementEventMap;

// 某个 mdui 元素上支持的事件名
export type MduiEventName<T extends MduiTag> = keyof MduiElementEventMap[T] & string;

// tagName -> 元素类 的映射。适配层用它把泛型标签收敛成具体元素类型：
//   MduiElementClassMap['mdui-dialog'] === Dialog
export interface MduiElementClassMap {
  'mdui-avatar': Avatar;
  'mdui-badge': Badge;
  'mdui-bottom-app-bar': BottomAppBar;
  'mdui-button': Button;
  'mdui-button-icon': ButtonIcon;
  'mdui-card': Card;
  'mdui-checkbox': Checkbox;
  'mdui-chip': Chip;
  'mdui-circular-progress': CircularProgress;
  'mdui-collapse': Collapse;
  'mdui-collapse-item': CollapseItem;
  'mdui-dialog': Dialog;
  'mdui-divider': Divider;
  'mdui-dropdown': Dropdown;
  'mdui-fab': Fab;
  'mdui-icon': Icon;
  'mdui-layout': Layout;
  'mdui-layout-item': LayoutItem;
  'mdui-layout-main': LayoutMain;
  'mdui-linear-progress': LinearProgress;
  'mdui-list': List;
  'mdui-list-item': ListItem;
  'mdui-list-subheader': ListSubheader;
  'mdui-menu': Menu;
  'mdui-menu-item': MenuItem;
  'mdui-navigation-bar': NavigationBar;
  'mdui-navigation-bar-item': NavigationBarItem;
  'mdui-navigation-drawer': NavigationDrawer;
  'mdui-navigation-rail': NavigationRail;
  'mdui-navigation-rail-item': NavigationRailItem;
  'mdui-radio': Radio;
  'mdui-radio-group': RadioGroup;
  'mdui-range-slider': RangeSlider;
  'mdui-segmented-button': SegmentedButton;
  'mdui-segmented-button-group': SegmentedButtonGroup;
  'mdui-select': Select;
  'mdui-slider': Slider;
  'mdui-snackbar': Snackbar;
  'mdui-switch': Switch;
  'mdui-tab': Tab;
  'mdui-tab-panel': TabPanel;
  'mdui-tabs': Tabs;
  'mdui-text-field': TextField;
  'mdui-tooltip': Tooltip;
  'mdui-top-app-bar': TopAppBar;
  'mdui-top-app-bar-title': TopAppBarTitle;
}

// 全局增强 HTMLElementTagNameMap：让 document.createElement('mdui-dialog') 等拿到具体元素类类型。
// 说明：mdui 各组件 .d.ts 自身也会 declare global { interface HTMLElementTagNameMap } 注册同样的映射，
// 这里用「同一来源（'mdui' 导出的元素类）」再补一遍，类型一致，不会触发重复标识符冲突。
//
// 单独导出 MduiElementClassMap 是为了让 src/ui 适配层能在泛型里用 HTMLElementTagNameMap 做不到的事：
//   HTMLElementTagNameMap[MduiTag] 无法通过类型检查（TS 不知道 MduiTag 是它的键），
//   而 MduiElementClassMap[MduiTag] 可以。
declare global {
  interface HTMLElementTagNameMap extends MduiElementClassMap {}
}
