import { workspacePath, workspaceFileReader } from './file-read.mjs';

export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function sandboxArgs({ threadId, projectId, executionId, command, network = false, filePath }, projectsHostRoot) {
  if (!uuid.test(threadId) || !uuid.test(executionId) || (projectId !== undefined && !uuid.test(projectId))) throw new Error('invalid_scope');
  if (projectId && (!projectsHostRoot?.startsWith('/') || /[,\n\r]/.test(projectsHostRoot))) throw new Error('project_mount_not_configured');
  const mount = projectId
    ? `type=bind,source=${projectsHostRoot}/${projectId},target=/workspace`
    : `type=volume,source=wangke-workspace-${threadId},target=/workspace`;
  const configuredUid = projectId ? process.env.SANDBOX_UID || '1000' : '1000';
  const configuredGid = projectId ? process.env.SANDBOX_GID || '1000' : '1000';
  if (!/^\d+$/.test(configuredUid) || !/^\d+$/.test(configuredGid)) throw new Error('invalid_sandbox_user');
  // Match ProjectFiles ownership when the installer/API itself runs as root.
  const uid = Number(configuredUid) === 0 ? '1000' : configuredUid;
  const gid = Number(configuredUid) === 0 ? '1000' : configuredGid;
  return ['run', '--rm', '--name', `wangke-exec-${executionId}`, '--label', 'wangke.sandbox=true',
    '--init', '--user', `${uid}:${gid}`, '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
    '--read-only', '--pids-limit=128', '--memory=1g', '--memory-swap=1g', '--cpus=1',
    '--network', filePath === undefined && network ? process.env.SANDBOX_NETWORK || 'none' : 'none', '--tmpfs', '/tmp:rw,nosuid,size=256m',
    '--mount', filePath === undefined ? mount : `${mount},readonly`, '--workdir', '/workspace', '--env', 'HOME=/workspace',
    process.env.SANDBOX_IMAGE || 'wangke-sandbox:0.1.0',
    'timeout', '--signal=KILL', '120', ...(filePath === undefined ? ['bash', '-lc', command] : ['python3', '-I', '-c', workspaceFileReader, workspacePath(filePath)])];
}
