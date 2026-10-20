/** A small, offline teaching UI kit. No generated framework or third-party stylesheet is needed. */
export const WIDGET_STYLES = `
  :root {
    color-scheme: light;
    --wbw-foreground: CanvasText; --wbw-muted: GrayText;
    --wbw-surface: Canvas; --wbw-border: GrayText; --wbw-accent: Highlight;
    --wbw-accent-foreground: HighlightText; --wbw-focus: Highlight; --wbw-radius: .375rem;
    --wbw-font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif;
    --wbw-font-size: 14px; --wbw-font-size-small: 12px;
    --wbw-series-1: var(--wbw-accent);
    --wbw-series-2: color-mix(in oklch, var(--wbw-accent) 60%, var(--wbw-foreground));
    --wbw-series-3: color-mix(in oklch, var(--wbw-accent) 30%, var(--wbw-foreground));
  }
  html[data-wbw-theme="dark"] {
    color-scheme: dark;
  }
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0; padding: 4px 2px; min-width: 0;
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
  .wbw-stage svg, .wbw-stage canvas { display: block; max-width: 100%; }
  .wbw-stage text { fill: var(--wbw-foreground); font: inherit; font-size: var(--wbw-font-size-small); }
  .wbw-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  table { border-collapse: collapse; border-top: 2px solid currentColor; border-bottom: 2px solid currentColor; }
  th, td { border: 0; padding: 4px 8px; text-align: left; }
  th { border-bottom: 1px solid currentColor; }
  @media (pointer: coarse) {
    button, select, input:not([type="checkbox"]):not([type="radio"]) { min-height: 44px; }
    input, select, textarea { font-size: max(16px, var(--wbw-font-size)); }
  }
`;
