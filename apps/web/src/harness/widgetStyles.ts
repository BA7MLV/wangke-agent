/** A small, offline teaching UI kit. No generated framework or third-party stylesheet is needed. */
export const WIDGET_STYLES = `
  :root {
    color-scheme: light;
    --wbw-foreground: CanvasText; --wbw-muted: GrayText;
    --wbw-surface: Canvas; --wbw-border: GrayText; --wbw-accent: Highlight;
    --wbw-accent-foreground: HighlightText; --wbw-focus: Highlight; --wbw-radius: .5rem;
    --wbw-font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif;
    --wbw-font-size: 14px; --wbw-font-size-small: 12px;
    --wbw-series-1: var(--wbw-accent);
    --wbw-series-2: color-mix(in oklch, var(--wbw-accent) 60%, var(--wbw-foreground));
    --wbw-series-3: color-mix(in oklch, var(--wbw-accent) 30%, var(--wbw-foreground));
    --wbw-success: var(--wbw-foreground); --wbw-warning: var(--wbw-foreground); --wbw-danger: var(--wbw-foreground);
    --wbw-series-4: var(--wbw-danger);
  }
  html[data-wbw-theme="dark"] {
    color-scheme: dark;
  }
  *, *::before, *::after { box-sizing: border-box; }
  @supports (corner-shape: superellipse(1.25)) {
    :where(*, *::before, *::after) { corner-shape: superellipse(1.25); }
    input[type="radio"] { corner-shape: round; }
  }
  html { --wbw-available-height: 560px; }
  body {
    margin: 0; padding: 4px; min-width: 0;
    font-family: var(--wbw-font-family);
    font-size: var(--wbw-font-size); font-weight: 400; line-height: 1.5;
    color: var(--wbw-foreground); background: transparent; overflow-wrap: anywhere;
    -webkit-font-smoothing: antialiased;
  }
  h1, h2, h3, h4, h5, h6 { font-weight: 500; margin: 0 0 8px; text-wrap: balance; }
  h1 { font-size: calc(var(--wbw-font-size) + 4px); }
  h2 { font-size: calc(var(--wbw-font-size) + 2px); }
  h3, h4, h5, h6 { font-size: var(--wbw-font-size); }
  b, strong, th { font-weight: 500; }
  input, select, textarea, button { font: inherit; color: inherit; max-width: 100%; }
  button {
    cursor: pointer; padding: 4px 12px; border-radius: var(--wbw-radius);
    border: 1px solid var(--wbw-border); background: var(--wbw-surface);
  }
  button:disabled { cursor: default; opacity: .6; }
  input:not([type="range"]):not([type="checkbox"]):not([type="radio"]), select, textarea {
    padding: 4px 8px; border-radius: var(--wbw-radius); min-width: 0;
    border: 1px solid var(--wbw-border); background: var(--wbw-surface);
  }
  input[type="range"] { width: 100%; min-width: 0; accent-color: var(--wbw-accent); }
  input[type="checkbox"], input[type="radio"] { accent-color: var(--wbw-accent); }
  :focus-visible { outline: 2px solid var(--wbw-focus); outline-offset: 2px; }
  .wbw-controls { display: flex; flex-wrap: wrap; align-items: end; gap: 8px 16px; margin-block: 8px; }
  .wbw-field { display: grid; flex: 1 1 max(160px, calc(50% - 8px)); min-width: 0; gap: 4px; }
  .wbw-field-header { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
  .wbw-value, output { font-variant-numeric: tabular-nums; }
  .wbw-muted { color: var(--wbw-muted); }
  .wbw-small { font-size: var(--wbw-font-size-small); }
  .wbw-primary, button[aria-pressed="true"] { background: var(--wbw-foreground); color: var(--wbw-surface); }
  .wbw-stage { width: 100%; min-width: 0; }
  svg, img, canvas { max-width: 100%; height: auto; }
  .wbw-image-placeholder {
    display: inline-flex; align-items: center; justify-content: center; padding: 12px;
    min-height: 64px; max-width: 100%; border-radius: var(--wbw-radius);
    background: var(--wbw-surface); color: var(--wbw-muted); font-size: var(--wbw-font-size-small);
  }
  .wbw-stage svg, .wbw-stage canvas {
    display: block; max-width: 100%; max-height: var(--wbw-available-height);
    width: auto; height: auto; margin-inline: auto; object-fit: contain;
  }
  .wbw-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr)); gap: 16px; }
  .wbw-grid > *, .wbw-controls > * { min-width: 0; }
  .wbw-stage text { fill: var(--wbw-foreground); font: inherit; font-size: var(--wbw-font-size-small); }
  .wbw-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  table { border-collapse: collapse; border-top: 2px solid currentColor; border-bottom: 2px solid currentColor; }
  th, td { border: 0; padding: 4px 8px; text-align: left; }
  th { border-bottom: 1px solid currentColor; }
  .wbw-options { display: grid; gap: 8px; border: 0; padding: 0; margin: 8px 0; min-width: 0; }
  .wbw-options legend, .wbw-segmented legend { margin-bottom: 4px; font-weight: 500; }
  .wbw-choice { display: flex; align-items: center; gap: 8px; min-height: 44px; padding: 8px 12px; border: 1px solid var(--wbw-border); border-radius: var(--wbw-radius); cursor: pointer; }
  .wbw-choice:has(:checked) { border-color: var(--wbw-accent); background: color-mix(in oklch, var(--wbw-accent) 12%, transparent); }
  .wbw-choice:has(:disabled) { cursor: default; opacity: .6; }
  .wbw-segmented { display: flex; flex-wrap: wrap; gap: 4px; border: 0; padding: 0; margin: 8px 0; min-width: 0; }
  .wbw-segmented .wbw-choice { flex: 1 1 auto; }
  .wbw-table { max-width: 100%; overflow-x: auto; }
  .wbw-table table { width: 100%; }
  .wbw-num { text-align: end; font-variant-numeric: tabular-nums; }
  .wbw-badge { display: inline-flex; align-items: center; padding: 4px 8px; border-radius: var(--wbw-radius); background: var(--wbw-surface); font-size: var(--wbw-font-size-small); }
  .wbw-badge[data-tone="success"] { color: var(--wbw-success); }
  .wbw-badge[data-tone="warning"] { color: var(--wbw-warning); }
  .wbw-badge[data-tone="error"], .wbw-error { color: var(--wbw-danger); }
  .wbw-error { margin: 0; font-size: var(--wbw-font-size-small); }
  [aria-invalid="true"] { border-color: var(--wbw-danger); }
  .wbw-legend { display: flex; flex-wrap: wrap; gap: 8px 16px; margin-block: 8px; }
  .wbw-legend > span { display: inline-flex; align-items: center; gap: 8px; }
  .wbw-swatch { display: inline-block; width: 1.5em; border-top: 3px solid var(--series-color, var(--wbw-series-1)); }
  @media (pointer: coarse) {
    button, select, input:not([type="checkbox"]):not([type="radio"]) { min-height: 44px; }
    input, select, textarea { font-size: max(16px, var(--wbw-font-size)); }
  }
`;
