#!/usr/bin/env python3
"""
把全库 CSS/TSX 里的 mdui 令牌替换成 HeroUI 语义令牌。

为什么要做：
  mdui 的设计令牌（--mdui-color-* / --mdui-shape-* / --mdui-motion-* /
  --mdui-typescale-*）是把 mdui 的设计语言钉死在代码里的东西。只要还有一处
  `rgb(var(--mdui-color-on-surface-variant))`，样式就没法脱离 mdui 而存在 ——
  theme.css 里那层「兼容层」就得永久留着，而兼容层里的值是 mdui 的色板，
  深浅两套都要手工同步一遍。

两类替换形态：
  ① 颜色：mdui 存的是 RGB 三元组，用法是 `rgb(var(--mdui-color-x))`。
     HeroUI 存的是完整颜色值（oklch），用法就是裸 `var(--foreground)`。
     所以要连 rgb() 包装一起拆掉。
  ② 形状 / 动效 / 字阶：本来��是裸 var()，直接换名或换成字面量。
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / 'src'

# ── ① 颜色：mdui 角色 → HeroUI 语义令牌 ────────────────────────────────────
# 对应关系按「用途」而非按名字配：mdui 的 surface-container-high 是
# 「比背景高一档的灰」，HeroUI 里对应的是 --default-soft（浅一档的着色面）。
COLOR_MAP = {
    'primary': 'accent',
    'on-primary': 'accent-foreground',
    'primary-container': 'accent-soft',
    'on-primary-container': 'accent-soft-foreground',
    'secondary-container': 'default-soft',
    'on-secondary-container': 'default-soft-foreground',
    'tertiary': 'muted',
    'tertiary-container': 'warning-soft',
    'on-tertiary-container': 'warning-soft-foreground',
    'error': 'danger',
    'on-error': 'danger-foreground',
    'error-container': 'danger-soft',
    'on-error-container': 'danger-soft-foreground',
    'on-surface': 'foreground',
    'on-surface-variant': 'muted',
    'outline': 'border',
    'outline-variant': 'border-secondary',
    'surface': 'background',
    'surface-container-lowest': 'background',
    'surface-container-low': 'background-secondary',
    'surface-container': 'background-tertiary',
    'surface-container-high': 'default-soft',
    'surface-container-highest': 'default',
    'background': 'background-secondary',
    'on-background': 'foreground',
    'inverse-surface': 'background-inverse',
    'inverse-on-surface': 'background-inverse',
}

# ── ② 形状：直接换 HeroUI 的圆角令牌 ──────────────────────────────────────
SHAPE_MAP = {
    'extra-small': '--radius-xs',
    'small': '--radius-sm',
    'medium': '--radius',
    'large': '--radius-lg',
    'extra-large': '--radius-2xl',
    'full': '--radius-full',
}

# ② 动效：HeroUI 没有对应令牌，换成设计意图一致的字面量。
#   standard 曲线取 MD3 的 emphasized decelerate，与 HeroUI 按钮的过渡一致。
MOTION_MAP = {
    'duration-short': 'var(--duration-quick)',
    'duration-short2': 'var(--duration-quick)',
    'duration-short3': 'var(--duration-slow)',
    'duration-medium': 'var(--duration-slow)',
    'duration-medium2': 'var(--duration-slow)',
    'duration-long': 'var(--duration-slow)',
    'easing-standard': 'var(--ease-out)',
    'easing-linear': 'linear',
}

# ② 字阶：直接写字面值（字阶不是主题的一部分，深浅色都一样）
TYPESCALE_MAP = {
    'body-small-size': '0.75rem',
    'body-medium-size': '0.875rem',
    'body-large-size': '1rem',
    'label-small-size': '0.6875rem',
    'label-medium-size': '0.75rem',
    'label-large-size': '0.875rem',
    'label-medium-line-height': '1.33',
    'title-small-size': '0.875rem',
    'title-small-weight': '500',
    'title-medium-size': '1rem',
    'title-medium-weight': '600',
    'title-medium-tracking': 'normal',
    'title-large-size': '1.375rem',
    'title-large-weight': '400',
    'body-small-weight': '400',
    'body-medium-weight': '400',
    'body-large-weight': '400',
    'label-small-weight': '500',
    'label-medium-weight': '500',
    'label-large-weight': '500',
}


def replace_mdui(text: str) -> tuple[str, int]:
    """返回 (新文本, 替换处数)。"""
    n = 0

    # ① 颜色：连 rgb() / rgba() 包装一起吃掉
    def color_sub(m: re.Match) -> str:
        nonlocal n
        n += 1
        name = m.group(1)
        token = COLOR_MAP.get(name)
        if token is None:
            return m.group(0)
        return f'var(--{token})'

    text = re.sub(
        r'\brgba?\(\s*var\(\s*--mdui-color-([a-z0-9-]+)\s*(?:,\s*[\d.]+\s*)?\)\s*\)',
        color_sub,
        text,
    )

    # 颜色也可能是裸 var()（少数写在 border-color 之类的地方）
    def bare_color_sub(m: re.Match) -> str:
        nonlocal n
        n += 1
        token = COLOR_MAP.get(m.group(1))
        return f'var(--{token})' if token else m.group(0)

    text = re.sub(r'var\(\s*--mdui-color-([a-z0-9-]+)\s*\)', bare_color_sub, text)

    # ② 形状
    def shape_sub(m: re.Match) -> str:
        nonlocal n
        n += 1
        return f'var({SHAPE_MAP[m.group(1)]})'

    text = re.sub(r'var\(\s*--mdui-shape-corner-([a-z-]+)\s*\)', shape_sub, text)

    # ② 动效
    def motion_sub(m: re.Match) -> str:
        nonlocal n
        n += 1
        return MOTION_MAP[m.group(1)]

    text = re.sub(r'var\(\s*--mdui-motion-([a-z0-9-]+)\s*\)', motion_sub, text)

    # ② 字阶
    def type_sub(m: re.Match) -> str:
        nonlocal n
        n += 1
        return TYPESCALE_MAP[m.group(1)]

    text = re.sub(r'var\(\s*--mdui-typescale-([a-z0-9-]+)\s*\)', type_sub, text)

    # mdui 的 state layer 叠色强度 → color-mix 的百分比
    text = re.sub(r'var\(\s*--mdui-state-layer-hover\s*\)', '0.08', text)

    return text, n


def main() -> int:
    total = 0
    changed: list[tuple[str, int]] = []
    for path in sorted(ROOT.rglob('*')):
        if path.suffix not in {'.css', '.ts', '.tsx'}:
            continue
        # theme.css 是令牌定义处本身，单独手工改（不能被替换器改坏）
        if path.name == 'theme.css':
            continue
        src = path.read_text(encoding='utf-8')
        if '--mdui-' not in src:
            continue
        out, count = replace_mdui(src)
        if count:
            path.write_text(out, encoding='utf-8')
            changed.append((str(path.relative_to(ROOT)), count))
            total += count

    for name, count in changed:
        print(f'{count:4d}  {name}')
    print(f'\n共替换 {total} 处，涉及 {len(changed)} 个文件')
    return 0


if __name__ == '__main__':
    sys.exit(main())