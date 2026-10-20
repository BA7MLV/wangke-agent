import type { Config } from 'dompurify';

// Markdown is prose, not an alternate widget host. DOMPurify's XSS defaults
// allow CSS; a <style> nested after a paragraph can otherwise style the app.
const FORBID_TAGS = ['style', 'link', 'meta', 'base', 'script', 'iframe', 'object', 'embed', 'form', 'dialog'];
const FORBID_ATTR = ['style', 'class', 'id', 'name', 'autofocus'];
const INTERNAL_ATTR = ['data-block', 'data-state', 'data-lang', 'data-raw', 'data-display', 'data-pending', 'data-source'];

const DEFAULT_CONFIG: Config = {
  USE_PROFILES: { html: true },
  FORBID_TAGS,
  FORBID_ATTR,
  ALLOW_DATA_ATTR: false,
  ADD_ATTR: INTERNAL_ATTR,
};

/** Callers may tighten sanitization, but never reopen the main-document CSS boundary. */
export function markdownSanitizeConfig(config?: Config): Config {
  if (!config) return DEFAULT_CONFIG;
  return {
    ...config,
    USE_PROFILES: { html: true },
    ALLOW_DATA_ATTR: false,
    FORBID_TAGS: [...new Set([...FORBID_TAGS, ...(config.FORBID_TAGS ?? [])])],
    FORBID_ATTR: [...new Set([...FORBID_ATTR, ...(config.FORBID_ATTR ?? [])])],
    ADD_ATTR: [...INTERNAL_ATTR, ...(Array.isArray(config.ADD_ATTR) ? config.ADD_ATTR : [])],
  };
}
