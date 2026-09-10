/** 把 catch 到的未知错误整理成可复制、可常驻展示的文本。 */
export function formatCaughtError(e: unknown): string {
  if (e instanceof Error) {
    return e.stack ? `${e.message}\n\n${e.stack}` : e.message;
  }
  return String(e);
}
