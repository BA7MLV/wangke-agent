import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ProjectFileDto, ProjectTextDto } from '../../../../packages/contracts/src/projects.js';

export class ProjectError extends Error {
  constructor(public code: string, public status = 400) { super(code); }
}
const directoryFlags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
const revision = (stat: fs.Stats) => `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
export const projectIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const textLimit = 1024 * 1024;

/** Linux uses pinned directory descriptors: a renamed parent or symlink swap
 * cannot redirect an operation outside the project. macOS development uses
 * checked paths; callers serialize sandbox access on that platform. */
export class ProjectFiles {
  readonly root: string;
  constructor(root: string) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    this.root = fs.realpathSync(root);
  }

  create(id: string) {
    this.checkId(id);
    const directory = path.join(this.root, id);
    fs.mkdirSync(directory, { mode: 0o700 });
    this.workspaceOwner(directory);
  }

  private workspaceOwner(filename: string) {
    // The installer can be invoked as root; sandbox commands still run as
    // 1000:1000. A non-root API already creates files with its own mapped UID.
    if (process.getuid?.() === 0) fs.chownSync(filename, 1000, 1000);
  }

  private checkId(id: string) {
    if (!projectIdPattern.test(id)) throw new ProjectError('project_not_found', 404);
  }

  private parts(value: string, allowRoot = false) {
    if (typeof value !== 'string' || value.length > 2048 || /[\\\u0000-\u001f\u007f]/.test(value)) throw new ProjectError('invalid_project_path');
    if (!value && allowRoot) return [];
    const parts = value.split('/');
    if (parts.some(p => !p || p === '.' || p === '..' || Buffer.byteLength(p) > 255)) throw new ProjectError('invalid_project_path');
    return parts;
  }

  private directory<T>(id: string, parts: string[], action: (directory: string) => T): T {
    this.checkId(id);
    const descriptors: number[] = [];
    try {
      let current = this.root;
      for (const part of [id, ...parts]) {
        const fd = fs.openSync(path.join(current, part), directoryFlags);
        descriptors.push(fd);
        current = process.platform === 'linux' ? `/proc/self/fd/${fd}` : path.join(current, part);
      }
      return action(current);
    } catch (error) {
      if (error instanceof ProjectError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') throw new ProjectError('project_file_not_found', 404);
      if (code === 'EEXIST') throw new ProjectError('project_file_exists', 409);
      if (code === 'ENOTEMPTY') throw new ProjectError('project_directory_not_empty', 409);
      if (['ELOOP', 'ENOTDIR', 'EACCES', 'EPERM'].includes(code ?? '')) throw new ProjectError('project_path_denied', 403);
      throw error;
    } finally { descriptors.reverse().forEach(fd => fs.closeSync(fd)); }
  }

  private parent<T>(id: string, value: string, action: (file: string) => T) {
    const parts = this.parts(value);
    const name = parts.pop()!;
    return this.directory(id, parts, directory => action(path.join(directory, name)));
  }

  private stat(file: string) {
    const stat = fs.lstatSync(file);
    if ((!stat.isFile() && !stat.isDirectory()) || (stat.isFile() && stat.nlink !== 1)) throw new ProjectError('project_path_denied', 403);
    return stat;
  }

  list(id: string, value = ''): ProjectFileDto[] {
    return this.directory(id, this.parts(value, true), directory => {
      const names = fs.readdirSync(directory);
      if (names.length > 5000) throw new ProjectError('project_directory_too_large', 413);
      const entries: ProjectFileDto[] = [];
      for (const name of names) {
        if (/[\u0000-\u001f\u007f\\]/.test(name)) continue;
        try {
          const stat = this.stat(path.join(directory, name));
          entries.push({ name, path: value ? `${value}/${name}` : name, kind: stat.isDirectory() ? 'directory' : 'file', size: stat.size, updatedAt: stat.mtime.toISOString(), revision: revision(stat) });
        } catch (error) {
          if (!(error instanceof ProjectError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      return entries.sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name));
    });
  }

  open(id: string, value: string) {
    return this.parent(id, value, file => {
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1) { fs.closeSync(fd); throw new ProjectError('project_path_denied', 403); }
      return { fd, size: stat.size, revision: revision(stat) };
    });
  }

  read(id: string, value: string): ProjectTextDto {
    const file = this.open(id, value);
    try {
      if (file.size > textLimit) throw new ProjectError('project_text_too_large', 413);
      const data = Buffer.alloc(file.size);
      fs.readSync(file.fd, data, 0, data.length, 0);
      if (data.includes(0)) throw new ProjectError('project_file_not_text');
      return { path: value, text: data.toString('utf8'), revision: file.revision };
    } finally { fs.closeSync(file.fd); }
  }

  write(id: string, value: string, text: string, expected: string | null) {
    if (typeof text !== 'string' || Buffer.byteLength(text) > textLimit || (expected !== null && typeof expected !== 'string')) throw new ProjectError('invalid_project_text');
    return this.parent(id, value, file => {
      let stat: fs.Stats | undefined;
      try { stat = this.stat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (stat?.isDirectory() || (stat ? revision(stat) !== expected : expected !== null)) throw new ProjectError('project_file_conflict', 409);
      const temporary = path.join(path.dirname(file), `.write-${crypto.randomUUID()}`);
      try {
        fs.writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 });
        this.workspaceOwner(temporary);
        fs.renameSync(temporary, file);
      } finally { fs.rmSync(temporary, { force: true }); }
      return { path: value, revision: revision(fs.statSync(file)) };
    });
  }

  mkdir(id: string, value: string) {
    this.parent(id, value, file => { fs.mkdirSync(file, { mode: 0o700 }); this.workspaceOwner(file); });
  }

  installUpload(id: string, value: string, temporary: string) {
    this.parent(id, value, file => {
      try { fs.lstatSync(file); throw new ProjectError('project_file_exists', 409); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      this.workspaceOwner(temporary);
      fs.renameSync(temporary, file);
    });
  }

  remove(id: string, value: string, expected: string) {
    this.parent(id, value, file => {
      const stat = this.stat(file);
      if (typeof expected !== 'string' || revision(stat) !== expected) throw new ProjectError('project_file_conflict', 409);
      if (stat.isDirectory()) fs.rmdirSync(file); else fs.unlinkSync(file);
    });
  }
}
