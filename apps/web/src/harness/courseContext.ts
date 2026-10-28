export const MAX_COURSE_CONTEXT = 5;

/**
 * 校验并规范化模型传入的课程上下文。
 *
 * `null` 表示参数结构无效，不能把它误当成空数组清除当前上下文；合法空数组才表示清除。
 */
export function normalizeCourseContextIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) return null;
  const ids = value.map((item) => item.trim()).filter(Boolean);
  return [...new Set(ids)].slice(0, MAX_COURSE_CONTEXT);
}

/** 决定一次正文检索使用单课、当前上下文，还是全课程库。 */
export function resolveCourseSearchScope(
  requestedCourseId: string,
  searchAll: boolean,
  contextCourseIds: string[],
): Set<string> | null {
  if (requestedCourseId) return new Set([requestedCourseId]);
  if (searchAll) return null;
  return contextCourseIds.length > 0 ? new Set(contextCourseIds) : null;
}
