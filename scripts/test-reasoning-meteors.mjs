import assert from 'node:assert/strict';
import { test } from 'node:test';
import { meteorProfile, seedMeteors, meteorPosition } from '../apps/web/src/components/reasoning-meteors.ts';

test('higher depth increases count, speed, trail length and brightness; off has no particles', () => {
  const profiles = Array.from({ length: 6 }, (_, i) => meteorProfile(i / 5));
  assert.equal(profiles[0].count, 0); assert.equal(profiles[0].opacity, 0);
  assert.deepEqual(seedMeteors(0), []);
  for (let i = 1; i < profiles.length; i++) for (const key of ['count', 'speed', 'trail', 'opacity']) {
    assert.ok(profiles[i][key] > profiles[i - 1][key], key);
  }
  assert.deepEqual(meteorProfile(NaN), profiles[0]);
  assert.deepEqual(meteorProfile(3), profiles[5]);
});

test('seeding is deterministic and lower levels retain the same particle identities', () => {
  const low = seedMeteors(0.2), high = seedMeteors(1);
  assert.deepEqual(seedMeteors(1), high);
  assert.deepEqual(high.slice(0, low.length), low);
  assert.ok(new Set(high.map(m => m.phase)).size === high.length);
});

test('stars accelerate away from a vanishing point with perspective-stretched trails', () => {
  const meteor = seedMeteors(1)[2];
  const start = meteorPosition(meteor, 1, 320, 36, 0);
  const end = meteorPosition(meteor, 1, 320, 36, 0.1);
  const later = meteorPosition(meteor, 1, 320, 36, 0.2);
  assert.ok(end.x > start.x);
  assert.ok(later.x - end.x > end.x - start.x, 'perspective increases forward speed');
  assert.ok(later.x - later.tailX > start.x - start.tailX, 'nearer streaks stretch longer');
  const originX = 320 * 0.035, originY = 18;
  assert.ok(Math.abs((start.y - originY) / (start.x - originX) - (start.tailY - originY) / (start.tailX - originX)) < 1e-9);
});

test('particles wrap beyond the rail and remain bounded over long runs and mobile widths', () => {
  for (const width of [180, 320, 352]) for (const meteor of seedMeteors(1)) {
    for (const seconds of [0, 1, 30, 100000]) {
      const p = meteorPosition(meteor, 1, width, 36, seconds);
      assert.ok(p.x >= 0 && p.x <= width * 1.2);
      assert.ok(p.tailX <= p.x);
      assert.ok(p.alpha >= 0 && p.alpha <= 1);
      assert.ok(Object.values(p).every(Number.isFinite));
    }
    const cycle = 1 / meteor.speed;
    const a = meteorPosition(meteor, 1, width, 36, 0);
    const b = meteorPosition(meteor, 1, width, 36, cycle);
    assert.ok(Math.abs(a.x - b.x) < 1e-9);
  }
});

test('depth changes stretch trails without teleporting the star head', () => {
  for (const meteor of seedMeteors(1)) {
    const low = meteorPosition(meteor, 0.2, 320, 36, 0.3);
    const high = meteorPosition(meteor, 1, 320, 36, 0.3);
    assert.equal(low.x, high.x); assert.equal(low.y, high.y);
    assert.ok(high.x - high.tailX >= low.x - low.tailX);
  }
});
