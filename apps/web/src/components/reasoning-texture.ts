const clamp = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

export const REASONING_TEXTURE = {
  ascii: { mask: 90, region: 'dark', strength: 100, size: 37, spacing: 0 },
  dither: { mask: 88, strength: 100, size: 15, spacing: 0 },
} as const;

const BAYER_4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const CHARACTERS = '.:-=+*#%@';
const complexity = (intensity: number) => clamp((clamp(intensity) - 0.2) / 0.8);
const bayerThreshold = (x: number, y: number) => {
  const column = ((Math.floor(x) % 4) + 4) % 4;
  const row = ((Math.floor(y) % 4) + 4) % 4;
  return (BAYER_4[row * 4 + column] + 0.5) / 16;
};

/** Reveal stable cells from isolated marks to a weave, without resampling or popping. */
export function textureCellCoverage(x: number, y: number, coverage: number) {
  const rank = bayerThreshold(x, y);
  const fade = clamp((clamp(coverage) - rank) / 0.06 + 0.5);
  return fade * fade * (3 - 2 * fade);
}

/** Ordered quantization, per color channel. At strength 100 only two levels remain. */
export function bayerChannel(value: number, x: number, y: number, strength: number = REASONING_TEXTURE.dither.strength) {
  const levels = 2 + Math.round((1 - clamp(strength / 100)) * 6);
  const scaled = clamp(value) * (levels - 1);
  const threshold = bayerThreshold(x, y);
  return Math.min(levels - 1, Math.floor(scaled) + (scaled % 1 > threshold ? 1 : 0)) / (levels - 1);
}

/** Dark-area sampling: highlights stay empty, deeper shadows get denser glyphs. */
export function asciiCharacter(luminance: number, region: 'dark' | 'light' = REASONING_TEXTURE.ascii.region, strength: number = REASONING_TEXTURE.ascii.strength, intensity = 1) {
  if (clamp(intensity) === 0) return '';
  const sample = region === 'dark' ? 1 - clamp(luminance) : clamp(luminance);
  if (sample <= 0.5) return '';
  // The brightest shadow glyphs start as . / :; + / * arrive in the middle,
  // with # / % / @ reserved for the deepest settings. Size and grid stay fixed.
  const limit = 0.14 + complexity(intensity) * 0.86;
  const density = clamp((sample - 0.5) * (1 + clamp(strength / 100) * 3)) * limit;
  return CHARACTERS[Math.round(density * (CHARACTERS.length - 1))];
}

export function textureProfile(intensity: number, height = 36) {
  const depth = clamp(intensity);
  // Preset sizes are authored for a 180px study; scale together for the compact rail.
  const scale = Math.max(0.12, Math.min(0.24, height / 180));
  const structure = complexity(depth);
  return {
    depth,
    // A true lightness change, not opacity: it must deepen in both UI themes.
    fillColor: `color-mix(in oklab, color-mix(in oklab, var(--accent) 42%, white) ${(1 - depth) * 100}%, color-mix(in oklab, var(--accent) 88%, #10121b))`,
    opacity: Math.min(1, depth / 0.08),
    speed: depth === 0 ? 0 : 0.035 + structure * 0.025,
    ditherCoverage: depth === 0 ? 0 : 0.08 + structure * 0.92,
    asciiCoverage: depth === 0 ? 0 : 0.12 + structure * 0.88,
    pixel: REASONING_TEXTURE.dither.size * scale,
    font: REASONING_TEXTURE.ascii.size * scale,
  };
}

/** A smooth source image, not frame-random noise. The sampling grids never move. */
export function textureLuminance(x: number, y: number, intensity: number, travel: number) {
  const edge = Math.abs(y * 2 - 1) ** 1.6;
  const wave = Math.sin((x * 1.8 - travel) * Math.PI * 2 + y * 1.4);
  const weave = Math.sin((x * 6 - travel) * Math.PI * 2 + y * 5) * Math.cos(y * 7 + x * 3);
  // Added detail has zero-centered contrast, rather than darkening the whole rail.
  return clamp(0.83 - edge * 0.55 + wave * 0.1 + weave * complexity(intensity) * 0.1);
}
