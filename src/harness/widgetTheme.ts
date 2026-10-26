/** Only presentation tokens cross the sandbox boundary; never copy host CSS, DOM or user data. */
export interface WidgetTheme {
  dark: boolean;
  tokens: Record<string, string>;
}

const TOKENS: Record<string, string> = {
  '--wbw-foreground': '--foreground', '--wbw-muted': '--muted',
  '--wbw-surface': '--default-soft', '--wbw-border': '--border',
  '--wbw-accent': '--accent', '--wbw-accent-foreground': '--accent-foreground',
  '--wbw-focus': '--focus', '--wbw-radius': '--radius-sm',
  '--wbw-success': '--success', '--wbw-warning': '--warning', '--wbw-danger': '--danger',
  '--wbw-series-1': '--accent', '--wbw-series-2': '--success',
  '--wbw-series-3': '--warning', '--wbw-series-4': '--danger',
};

export function readWidgetTheme(element: HTMLElement, dark: boolean): WidgetTheme {
  const style = getComputedStyle(element);
  const rootSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const tokens: Record<string, string> = {
    '--wbw-font-family': style.fontFamily,
    '--wbw-font-size': `${rootSize * .875}px`,
    '--wbw-font-size-small': `${Math.max(11, rootSize * .75)}px`,
  };
  for (const [target, source] of Object.entries(TOKENS)) {
    const value = style.getPropertyValue(source).trim();
    if (value) tokens[target] = value;
  }
  return { dark, tokens };
}

/** Includes locally scoped course palettes as well as global appearance/font settings. */
export function observeWidgetTheme(element: HTMLElement, onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    observer.observe(node, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
  }
  return () => observer.disconnect();
}
