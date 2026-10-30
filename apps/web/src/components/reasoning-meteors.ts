const clamp = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

/** Visual intensity only; the six model-request levels are unchanged. */
export function meteorProfile(intensity: number) {
  const depth = clamp(intensity);
  return {
    count: depth === 0 ? 0 : 6 + Math.round(depth * 28),
    speed: 0.12 + 0.82 * depth ** 1.8, // crossings per second
    trail: 0.025 + depth * 0.13, // exposure, in fractions of a crossing
    opacity: depth === 0 ? 0 : 0.35 + depth * 0.4,
  };
}

export function seedMeteors(intensity: number) {
  let state = 57209;
  const random = () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
  return Array.from({ length: meteorProfile(intensity).count }, (_, i) => ({
    phase: (i * 0.61803398875 + 0.14) % 1,
    lane: (random() - 0.5) * 2.6,
    speed: 0.8 + random() * 0.4,
    length: 0.7 + random() * 0.6,
    brightness: 0.35 + random() * 0.6,
  }));
}

/** Project stars away from a shared vanishing point. Travel is integrated by the
 * renderer, so changing speed never teleports a star to a different phase. */
export function meteorPosition(meteor: ReturnType<typeof seedMeteors>[number], intensity: number, width: number, height: number, travel: number) {
  const profile = meteorProfile(intensity);
  const phase = ((meteor.phase + travel * meteor.speed) % 1 + 1) % 1;
  const project = (t: number) => Math.expm1(t * 2.8) / Math.expm1(2.8);
  const head = project(phase);
  const tail = project(Math.max(0, phase - profile.trail * meteor.length));
  const originX = width * 0.035, originY = height * 0.5;
  const distance = width * 1.16;
  return {
    x: originX + head * distance,
    y: originY + head * meteor.lane * height,
    tailX: originX + tail * distance,
    tailY: originY + tail * meteor.lane * height,
    alpha: Math.max(0, Math.min(1, phase / 0.16, (1 - phase) / 0.12)),
    thickness: 0.3 + head * 0.7,
  };
}
