export interface AssistantSize { width: number; height: number }
export interface AssistantAnchor { x: number; y: number }
export type AssistantPlacement = 'top' | 'bottom' | 'left' | 'right';
export const ASSISTANT_RESIZE_EDGES = ['n', 'e', 's', 'w', 'nw', 'ne', 'sw', 'se'] as const;
export type AssistantResizeEdge = typeof ASSISTANT_RESIZE_EDGES[number];
export interface AssistantLayout extends AssistantSize, AssistantAnchor {
  placement: AssistantPlacement;
  resizeX: 'left' | 'right';
  resizeY: 'top' | 'bottom';
}

export const ASSISTANT_DEFAULT_SIZE: AssistantSize = { width: 420, height: 520 };
export const ASSISTANT_TRIGGER_SIZE = 48;
const GAP = 12;

export function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, Math.max(min, max)));
}

/** 所有坐标都在安全区内；只调整面板，不为了容纳面板而移动入口。 */
export function getAssistantLayout(
  bounds: AssistantSize, anchor: AssistantAnchor, size: AssistantSize, preferred?: AssistantPlacement,
): AssistantLayout {
  const width = Math.min(size.width, bounds.width);
  let height = Math.min(size.height, bounds.height);
  const room = {
    top: Math.max(0, anchor.y - GAP),
    bottom: Math.max(0, bounds.height - anchor.y - ASSISTANT_TRIGGER_SIZE - GAP),
    left: Math.max(0, anchor.x - GAP),
    right: Math.max(0, bounds.width - anchor.x - ASSISTANT_TRIGGER_SIZE - GAP),
  };
  const directions: AssistantPlacement[] = ['top', 'bottom', 'left', 'right'];
  if (preferred) directions.unshift(preferred);
  let placement = directions.find((direction) => room[direction] >= (direction === 'top' || direction === 'bottom' ? height : width));
  if (!placement) {
    // 窄屏且入口在中部时，没有足够的横向空间：缩短面板，仍不盖住入口。
    placement = room.top >= room.bottom ? 'top' : 'bottom';
    height = Math.min(height, room[placement]);
  }
  let x = clamp(anchor.x + ASSISTANT_TRIGGER_SIZE - width, 0, bounds.width - width);
  let y = clamp(anchor.y + ASSISTANT_TRIGGER_SIZE - height, 0, bounds.height - height);
  if (placement === 'top') y = anchor.y - GAP - height;
  if (placement === 'bottom') y = anchor.y + ASSISTANT_TRIGGER_SIZE + GAP;
  if (placement === 'left') x = anchor.x - GAP - width;
  if (placement === 'right') x = anchor.x + ASSISTANT_TRIGGER_SIZE + GAP;
  return {
    x, y, width, height, placement,
    resizeX: anchor.x + ASSISTANT_TRIGGER_SIZE / 2 >= x + width / 2 ? 'left' : 'right',
    resizeY: anchor.y + ASSISTANT_TRIGGER_SIZE / 2 >= y + height / 2 ? 'top' : 'bottom',
  };
}

/** 拖动哪条边就只移动那条边，对边固定；同时避开安全区和悬浮入口。 */
export function resizeAssistantLayout(
  bounds: AssistantSize, anchor: AssistantAnchor, original: AssistantLayout,
  edge: AssistantResizeEdge, dx: number, dy: number,
): AssistantLayout {
  const region = { left: 0, top: 0, right: bounds.width, bottom: bounds.height };
  if (original.placement === 'top') region.bottom = Math.min(region.bottom, anchor.y - GAP);
  if (original.placement === 'bottom') region.top = Math.max(region.top, anchor.y + ASSISTANT_TRIGGER_SIZE + GAP);
  if (original.placement === 'left') region.right = Math.min(region.right, anchor.x - GAP);
  if (original.placement === 'right') region.left = Math.max(region.left, anchor.x + ASSISTANT_TRIGGER_SIZE + GAP);

  let left = original.x, right = original.x + original.width;
  let top = original.y, bottom = original.y + original.height;
  if (edge.includes('w')) left = clamp(left + dx, region.left, right - Math.min(320, right - region.left));
  if (edge.includes('e')) right = clamp(right + dx, left + Math.min(320, region.right - left), region.right);
  if (edge.includes('n')) top = clamp(top + dy, region.top, bottom - Math.min(300, bottom - region.top));
  if (edge.includes('s')) bottom = clamp(bottom + dy, top + Math.min(300, region.bottom - top), region.bottom);
  return { ...original, x: left, y: top, width: right - left, height: bottom - top };
}
