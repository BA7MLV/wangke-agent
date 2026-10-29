import type { ResourceEntry } from '@wangke/contracts/resources';
import { FOLDER_SPRING_OPEN_MS } from '../ui/interactionTiming';

export const RESOURCE_DRAG_TYPE = 'application/x-resource-entry';

/** Reject no-ops and moving a directory into itself or any of its descendants. */
export function canDropResourceInto(source: ResourceEntry, projectId: string, path: string): boolean {
  if (!source.path || source.scope || source.missing) return false;
  if (source.projectId !== projectId) return true;
  if (source.path === (path ? `${path}/${source.name}` : source.name)) return false;
  return source.kind !== 'directory' || (path !== source.path && !path.startsWith(`${source.path}/`));
}

/** Repeated dragover events must not postpone opening the same folder forever. */
export function createFolderSpringLoader() {
  let target: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = (key?: string) => {
    if (key !== undefined && target !== key) return;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    target = null;
  };
  return {
    cancel,
    schedule(key: string, open: () => void) {
      if (target === key) return;
      cancel();
      target = key;
      timer = setTimeout(() => {
        cancel();
        open();
      }, FOLDER_SPRING_OPEN_MS);
    },
  };
}
