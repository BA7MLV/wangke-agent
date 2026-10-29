export const workspaceFileLimit = 20 * 1024 * 1024;

export function workspacePath(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\\\u0000-\u001f\u007f]/.test(value)) throw new Error('invalid_workspace_path');
  const relative = value.startsWith('/workspace/') ? value.slice(11) : value;
  if (relative.split('/').some(part => !part || part === '.' || part === '..' || Buffer.byteLength(part) > 255)) throw new Error('invalid_workspace_path');
  return relative;
}

// Run a fixed reader, never a model-supplied command. Pin every directory and
// reject links/devices/FIFOs; Python's isolated mode ignores workspace modules.
export const workspaceFileReader = `import os, stat, sys
try:
    parts = sys.argv[1].split('/')
    fd = os.open('/workspace', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    for part in parts[:-1]:
        child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
        os.close(fd)
        fd = child
    source = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    os.close(fd)
    with os.fdopen(source, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            sys.exit(3)
        if info.st_size < 1 or info.st_size > ${workspaceFileLimit}:
            sys.exit(4)
        data = stream.read(${workspaceFileLimit + 1})
        if len(data) < 1 or len(data) > ${workspaceFileLimit}:
            sys.exit(4)
    sys.stdout.buffer.write(data)
except FileNotFoundError:
    sys.exit(2)
except OSError:
    sys.exit(3)
`;
