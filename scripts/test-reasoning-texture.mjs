import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asciiCharacter, bayerChannel, REASONING_TEXTURE, textureCellCoverage, textureLuminance, textureProfile } from '../apps/web/src/components/reasoning-texture.ts';

test('presets match the requested masked ASCII and Dither style', () => {
  assert.deepEqual(REASONING_TEXTURE.ascii, { mask: 90, region: 'dark', strength: 100, size: 37, spacing: 0 });
  assert.deepEqual(REASONING_TEXTURE.dither, { mask: 88, strength: 100, size: 15, spacing: 0 });
  const { pixel, font } = textureProfile(1);
  assert.equal(pixel, 3);
  assert.equal(font, 7.4);
});

test('Bayer uses all 16 ordered thresholds, repeats every four cells and keeps endpoints', () => {
  for (let step = 0; step <= 16; step++) {
    const tile = Array.from({ length: 16 }, (_, i) => bayerChannel(step / 16, i % 4, Math.floor(i / 4)));
    assert.equal(tile.filter(Boolean).length, step);
    assert.ok(tile.every(value => value === 0 || value === 1), 'strength 100 means two color levels');
  }
  for (let y = -4; y < 4; y++) for (let x = -4; x < 4; x++) {
    assert.equal(bayerChannel(0.4, x, y), bayerChannel(0.4, x + 4, y + 4));
    assert.equal(bayerChannel(0, x, y), 0);
    assert.equal(bayerChannel(1, x, y), 1);
  }
  assert.ok(Array.from({ length: 100 }, (_, i) => bayerChannel(i / 99, 0, 0, 0)).some(value => value > 0 && value < 1));
});

test('ASCII draws dark regions only and maps deeper shadows to denser characters', () => {
  assert.equal(asciiCharacter(1), '');
  assert.equal(asciiCharacter(0.5), '');
  assert.equal(asciiCharacter(0.499), '.');
  assert.equal(asciiCharacter(0), '@');
  assert.equal(asciiCharacter(0, 'light'), '');
  assert.equal(asciiCharacter(1, 'light'), '@');
  const ramp = '.:-=+*#%@';
  const indices = Array.from({ length: 50 }, (_, i) => ramp.indexOf(asciiCharacter(0.49 - i / 100)));
  assert.ok(indices.every((value, i) => i === 0 || value >= indices[i - 1]));
});

test('six depths increase structural coverage, not the mask opacity or grid size', () => {
  const profiles = Array.from({ length: 6 }, (_, i) => textureProfile(i / 5));
  assert.equal(profiles[0].opacity, 0);
  assert.equal(profiles[0].speed, 0);
  for (let i = 1; i < profiles.length; i++) {
    assert.equal(profiles[i].opacity, 1, 'all thinking levels keep the same 88/90 masks');
    assert.ok(profiles[i].speed > profiles[i - 1].speed);
    assert.ok(profiles[i].ditherCoverage > profiles[i - 1].ditherCoverage);
    assert.ok(profiles[i].asciiCoverage > profiles[i - 1].asciiCoverage);
    assert.equal(profiles[i].pixel, profiles[0].pixel, 'depth never jitters the sampling grid');
    assert.equal(profiles[i].font, profiles[0].font);
  }
  assert.deepEqual(textureProfile(NaN), profiles[0]);
  assert.deepEqual(textureProfile(3), profiles[5]);
});

test('ASCII complexity progresses from dots to symbols to dense glyphs', () => {
  const deepest = [0.2, 0.4, 0.6, 0.8, 1].map(depth => asciiCharacter(0, 'dark', 100, depth));
  assert.deepEqual(deepest, [':', '=', '*', '#', '@']);
  assert.equal(asciiCharacter(0, 'dark', 100, 0), '');
  for (const depth of [0.2, 0.4, 0.6, 0.8, 1]) {
    assert.equal(asciiCharacter(0.8, 'dark', 100, depth), '', 'all levels still exclude highlights');
  }
});

test('fill lightness changes independently of the fixed texture masks', () => {
  const profiles = [0.2, 0.4, 0.6, 0.8, 1].map(depth => textureProfile(depth));
  assert.equal(new Set(profiles.map(profile => profile.fillColor)).size, 5);
  assert.ok(profiles.every(profile => profile.fillColor.includes('var(--accent)')));
  assert.ok(profiles[0].fillColor.includes('white) 80%'));
  assert.ok(profiles[4].fillColor.includes('white) 0%'));
  assert.ok(profiles.every(profile => profile.opacity === 1));
});

test('coverage grows monotonically on the same cells and interpolates continuously', () => {
  let previous = 0;
  for (let step = 0; step <= 100; step++) {
    const coverage = step / 100;
    let total = 0;
    for (let row = 0; row < 4; row++) for (let column = 0; column < 4; column++) {
      const alpha = textureCellCoverage(column, row, coverage);
      assert.ok(alpha >= 0 && alpha <= 1);
      assert.ok(alpha <= textureCellCoverage(column, row, coverage + 0.001));
      assert.ok(Math.abs(alpha - textureCellCoverage(column, row, coverage + 0.001)) < 0.026);
      total += alpha;
    }
    assert.ok(total >= previous);
    if (step === 0) assert.equal(total, 0);
    if (step === 100) assert.equal(total, 16);
    previous = total;
  }
});

test('actual compact-rail sampling shows dots at low depth and woven glyphs at high depth', () => {
  const glyphs = depth => {
    const { font, asciiCoverage } = textureProfile(depth);
    const result = [];
    for (let row = 0; (row + 0.5) * font < 36; row++) {
      for (let column = 0; (column + 0.5) * font * 0.65 < 300; column++) {
        if (textureCellCoverage(column + 2, row + 2, asciiCoverage) < 0.5) continue;
        const light = textureLuminance((column + 0.5) * font * 0.65 / 300, (row + 0.5) * font / 36, depth, 0);
        const glyph = asciiCharacter(light, 'dark', 100, depth);
        if (glyph) result.push(glyph);
      }
    }
    return result;
  };
  const low = glyphs(0.2), middle = glyphs(0.6), high = glyphs(1);
  assert.ok(low.length > 0 && low.every(glyph => '.:'.includes(glyph)));
  assert.ok(middle.includes('+'));
  assert.ok(high.includes('#') && high.includes('@'));
  assert.ok(low.length < middle.length && middle.length < high.length);
});

test('source image is deterministic, bounded and changes smoothly rather than randomizing', () => {
  for (const depth of [0, 0.2, 1]) for (const x of [0, 0.3, 1]) for (const y of [0, 0.5, 1]) {
    const source = textureLuminance(x, y, depth, 0.3);
    assert.equal(source, textureLuminance(x, y, depth, 0.3));
    assert.ok(source >= 0 && source <= 1);
    assert.ok(Math.abs(source - textureLuminance(x, y, depth, 0.301)) < 0.002);
  }
  assert.ok(textureLuminance(0.3, 0.5, 1, 0) > textureLuminance(0.3, 0, 1, 0), 'shadow sampling favors rail edges');
});
