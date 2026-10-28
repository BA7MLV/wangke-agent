import type { ProjectDto, ProjectFileDto } from './projects.js';

/** A real file/directory. Project IDs remain internal, stable permission scopes. */
export interface ResourceEntry extends ProjectFileDto {
  projectId: string;
  courseId?: string;
  scope?: ProjectDto;
  missing?: boolean;
}
export interface ResourceDirectory {
  project: ProjectDto | null;
  rootId: string;
  path: string;
  folderId?: number;
  entries: ResourceEntry[];
}
