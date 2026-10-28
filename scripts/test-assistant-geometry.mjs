import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ASSISTANT_DEFAULT_SIZE, ASSISTANT_RESIZE_EDGES, getAssistantLayout, resizeAssistantLayout } from '../apps/web/src/components/assistantGeometry.ts';

test('默认尺寸适中，四角展开不移动入口且不覆盖入口', () => {
  assert.deepEqual(ASSISTANT_DEFAULT_SIZE, { width: 420, height: 520 });
  const bounds = { width: 992, height: 868 };
  for (const anchor of [{ x: 0, y: 0 }, { x: 944, y: 0 }, { x: 0, y: 820 }, { x: 944, y: 820 }]) {
    const original = { ...anchor };
    const panel = getAssistantLayout(bounds, anchor, ASSISTANT_DEFAULT_SIZE);
    assert.deepEqual(anchor, original);
    assert.equal(panel.width, 420);
    assert.equal(panel.height, 520);
    assert.ok(anchor.y === 0 ? panel.y >= 60 : panel.y + panel.height <= anchor.y - 12);
  }
});

test('空间足够时使用侧向展开，不足时只缩短面板，所有位置都在安全区内', () => {
  const side = getAssistantLayout({ width: 1200, height: 868 }, { x: 900, y: 400 }, ASSISTANT_DEFAULT_SIZE);
  assert.equal(side.placement, 'left');
  assert.equal(side.height, 520);
  for (const bounds of [{ width: 992, height: 868 }, { width: 358, height: 812 }, { width: 812, height: 358 }, { width: 288, height: 708 }]) {
    for (let ix = 0; ix <= 10; ix++) for (let iy = 0; iy <= 10; iy++) {
      const anchor = { x: (bounds.width - 48) * ix / 10, y: (bounds.height - 48) * iy / 10 };
      const panel = getAssistantLayout(bounds, anchor, ASSISTANT_DEFAULT_SIZE);
      assert.ok(panel.x >= 0 && panel.y >= 0);
      assert.ok(panel.x + panel.width <= bounds.width + 0.001 && panel.y + panel.height <= bounds.height + 0.001);
      assert.ok(panel.width > 0 && panel.height > 0);
      assert.ok(panel.x + panel.width <= anchor.x || panel.x >= anchor.x + 48 || panel.y + panel.height <= anchor.y || panel.y >= anchor.y + 48, '面板不覆盖入口');
    }
  }
});

test('保留可用的展开方向和用户尺寸；旋转后的约束不会修改尺寸偏好', () => {
  const size = { width: 580, height: 650 };
  const bottom = getAssistantLayout({ width: 1200, height: 1100 }, { x: 1100, y: 300 }, size, 'bottom');
  assert.equal(bottom.placement, 'bottom');
  const small = getAssistantLayout({ width: 288, height: 708 }, { x: 240, y: 660 }, size);
  assert.equal(small.width, 288);
  assert.equal(small.height, 648);
  assert.deepEqual(size, { width: 580, height: 650 });
});

test('四边和四角只改变选中的边，对边固定', () => {
  const bounds = { width: 1280, height: 1000 }, anchor = { x: 1232, y: 952 };
  const original = getAssistantLayout(bounds, anchor, ASSISTANT_DEFAULT_SIZE);
  for (const edge of ASSISTANT_RESIZE_EDGES) {
    const resized = resizeAssistantLayout(bounds, anchor, original, edge, -40, -30);
    assert.equal(resized.width - original.width, edge.includes('w') ? 40 : edge.includes('e') ? -40 : 0);
    assert.equal(resized.height - original.height, edge.includes('n') ? 30 : edge.includes('s') ? -30 : 0);
    assert.equal(resized.x - original.x, edge.includes('w') ? -40 : 0);
    assert.equal(resized.y - original.y, edge.includes('n') ? -30 : 0);
  }
});

test('边缘缩放遵守最小尺寸、安全区与入口避让', () => {
  for (const bounds of [{ width: 1200, height: 1000 }, { width: 358, height: 812 }, { width: 812, height: 358 }, { width: 288, height: 708 }]) {
    for (const [fx, fy] of [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0.5]]) {
      const anchor = { x: (bounds.width - 48) * fx, y: (bounds.height - 48) * fy };
      const original = getAssistantLayout(bounds, anchor, ASSISTANT_DEFAULT_SIZE);
      for (const edge of ASSISTANT_RESIZE_EDGES) for (const delta of [-10000, 10000]) {
        const panel = resizeAssistantLayout(bounds, anchor, original, edge, delta, delta);
        assert.ok(panel.x >= 0 && panel.y >= 0);
        assert.ok(panel.x + panel.width <= bounds.width && panel.y + panel.height <= bounds.height);
        assert.ok(panel.width >= Math.min(320, original.width) && panel.height >= Math.min(300, original.height));
        assert.ok(panel.x + panel.width <= anchor.x || panel.x >= anchor.x + 48 || panel.y + panel.height <= anchor.y || panel.y >= anchor.y + 48, '缩放不会覆盖入口');
      }
    }
  }
});
