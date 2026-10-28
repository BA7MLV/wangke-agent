import { useId } from 'react';

export const FOLDER_COLORS = [
  { id: 'blue', label: '默认蓝色', hue: 198, swatch: '#50bfe8' },
  { id: 'green', label: '绿色', hue: 142, swatch: '#63bc7c' },
  { id: 'yellow', label: '黄色', hue: 46, swatch: '#e6c34e' },
  { id: 'orange', label: '橙色', hue: 27, swatch: '#e89b50' },
  { id: 'red', label: '红色', hue: 0, swatch: '#df7373' },
  { id: 'purple', label: '紫色', hue: 274, swatch: '#ad83d8' },
  { id: 'gray', label: '灰色', hue: 198, swatch: '#9ca3af' },
] as const;

/** Finder 专属的拟物文件夹，保留自绘外观，不随通用操作图标库替换。 */
export function FolderIcon({ color = 'blue' }: { color?: (typeof FOLDER_COLORS)[number]['id'] }) {
  const id = useId();
  const palette = FOLDER_COLORS.find((entry) => entry.id === color) ?? FOLDER_COLORS[0];
  return (
    <svg className="finder-folder-icon" data-folder-color={palette.id} style={{ filter: `hue-rotate(${palette.hue - 198}deg) saturate(${palette.id === 'gray' ? 0 : 1}) drop-shadow(0 2px 1px rgb(0 0 0 / 20%))` }} viewBox="0 0 120 96" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}-back`} x1="60" y1="10" x2="60" y2="88" gradientUnits="userSpaceOnUse"><stop stopColor="#48b8e8" /><stop offset=".3" stopColor="#168dc3" /><stop offset="1" stopColor="#56bce4" /></linearGradient>
        <linearGradient id={`${id}-front`} x1="60" y1="29" x2="60" y2="88" gradientUnits="userSpaceOnUse"><stop stopColor="#87ddfa" /><stop offset="1" stopColor="#50bfe8" /></linearGradient>
      </defs>
      <path d="M8 18a8 8 0 0 1 8-8h23c4 0 6 2 10 5l7 5h48a8 8 0 0 1 8 8v53a7 7 0 0 1-7 7H15a7 7 0 0 1-7-7Z" fill={`url(#${id}-back)`} />
      <rect x="12" y="25" width="96" height="55" rx="5" fill="#c5eeff" />
      <rect x="8" y="25" width="104" height="63" rx="7" fill={`url(#${id}-front)`} stroke="#39afe0" />
      <path d="M15 32h90M12 82h96" stroke="#a2e2fa" strokeLinecap="round" />
    </svg>
  );
}
