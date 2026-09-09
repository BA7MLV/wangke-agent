/**
 * 复制文本到剪贴板。
 * iPad 经局域网 http://IP 访问是非安全上下文，navigator.clipboard 不存在，
 * 此时降级到 execCommand（必须在用户手势的调用栈内同步执行，故不做 await 前的异步工作）。
 */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* 授权被拒/非安全上下文兜底走 execCommand */
    }
  }
  return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText =
    'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:none;outline:none;box-shadow:none;background:transparent;opacity:0;';
  document.body.appendChild(ta);
  const prevFocus = document.activeElement as HTMLElement | null;
  ta.focus();
  ta.select();
  // iOS Safari：select() 对 readonly 域可能无效，显式设置选区更稳
  if (typeof ta.setSelectionRange === 'function') ta.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  prevFocus?.focus?.();
  return ok;
}
