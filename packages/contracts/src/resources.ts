import type { ProjectDto, ProjectFileDto } from './projects.js';

export const RESOURCE_FOLDER_COLORS = ['blue', 'green', 'yellow', 'orange', 'red', 'purple', 'gray'] as const;
export type ResourceFolderColor = (typeof RESOURCE_FOLDER_COLORS)[number];

/** A real file/directory. Project IDs remain internal, stable permission scopes. */
export interface ResourceEntry extends ProjectFileDto {
  projectId: string;
  courseId?: string;
  scope?: ProjectDto;
  missing?: boolean;
  folderId?: number;
  color?: ResourceFolderColor;
}
export interface ResourceDirectory {
  project: ProjectDto | null;
  rootId: string;
  path: string;
  folderId?: number;
  entries: ResourceEntry[];
}
