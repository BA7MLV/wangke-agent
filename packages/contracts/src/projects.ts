export type ProjectRole = 'read' | 'write' | 'manage';
export interface ProjectPolicy {
  shell: 'allow' | 'ask' | 'deny';
  network: 'allow' | 'deny';
}
export interface ProjectDto {
  id: string;
  name: string;
  instructions: string;
  /** Relative to FILES_DIR. Derived only from the immutable ID. */
  workspacePath: string;
  policy: ProjectPolicy;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface ProjectGrantDto { agentId: string; role: ProjectRole }
export interface ProjectDetailDto extends ProjectDto { grants: ProjectGrantDto[] }
export interface ProjectFileDto {
  name: string;
  path: string;
  kind: 'file' | 'directory';
  size: number;
  updatedAt: string;
  revision: string;
}
export interface ProjectTextDto { path: string; text: string; revision: string }
