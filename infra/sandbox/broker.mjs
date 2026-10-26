import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { sandboxArgs, uuid } from './arguments.mjs';
export { sandboxArgs } from './arguments.mjs';

const token = process.env.SANDBOX_TOKEN;
if (!token || token.length < 32) throw new Error('SANDBOX_TOKEN must contain at least 32 characters');
const active = new Map();
const executions = new Map();
const cancelled = new Map();
const remove = async name => {
  try { await promisify(execFile)('docker', ['rm', '-f', name], { timeout: 10_000 }); }
  catch (error) { if (!/No such container/i.test(String(error.stderr))) throw error; }
};

let hostRoot;
async function projectRoot(id) {
  const root = process.env.SANDBOX_PROJECTS_DIR;
  if (!root || !path.isAbsolute(root)) throw new Error('project_mount_not_configured');
  const target = path.join(root, id);
  if (!fs.lstatSync(target).isDirectory() || fs.realpathSync(target) !== path.join(fs.realpathSync(root), id)) throw new Error('invalid_project_directory');
  if (!hostRoot) {
    if (process.env.SANDBOX_PROJECTS_HOST_DIR) hostRoot = process.env.SANDBOX_PROJECTS_HOST_DIR;
    else if (fs.existsSync('/.dockerenv')) {
      // Compose may use a relative host path. Docker reports the canonical
      // daemon-side source, so never interpret it relative to the broker CWD.
      const { stdout } = await promisify(execFile)('docker', ['inspect', '--format', '{{json .Mounts}}', process.env.HOSTNAME], { timeout: 10000 });
      const mount = JSON.parse(stdout).filter(m => m.Type === 'bind' && (root === m.Destination || root.startsWith(`${m.Destination}/`))).sort((a, b) => b.Destination.length - a.Destination.length)[0];
      if (!mount) throw new Error('project_mount_not_configured');
      hostRoot = path.join(mount.Source, path.relative(mount.Destination, root));
    } else hostRoot = fs.realpathSync(root);
  }
  return hostRoot;
}

const server = http.createServer(async (req, res) => {
  const reply = (status, body) => { if (!res.destroyed) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); } };
  if (req.url === '/health' && req.method === 'GET') return reply(200, { ok: true });
  const supplied = Buffer.from(req.headers.authorization || '');
  const expected = Buffer.from(`Bearer ${token}`);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return reply(401, { error: 'unauthorized' });
  if (!['/execute', '/cancel'].includes(req.url) || req.method !== 'POST') return reply(404, { error: 'not_found' });
  let body;
  try {
    let bytes = 0; const chunks = [];
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 32_768) throw new Error(); chunks.push(chunk); }
    body = JSON.parse(Buffer.concat(chunks).toString());
    if (!body || !uuid.test(body.executionId)) throw new Error();
    if (req.url === '/execute' && (!uuid.test(body.threadId) || (body.projectId !== undefined && !uuid.test(body.projectId)) || (body.network !== undefined && typeof body.network !== 'boolean') || typeof body.command !== 'string' || !body.command.trim() || body.command.length > 16_000)) throw new Error();
  } catch { return reply(400, { error: 'invalid_request' }); }
  for (const [id, expires] of cancelled) if (expires < Date.now()) cancelled.delete(id);
  if (req.url === '/cancel') {
    // Tombstone first, including execute requests still waiting in the network.
    cancelled.set(body.executionId, Date.now() + 300_000);
    const execution = executions.get(body.executionId);
    if (execution) { execution.cancelled = true; execution.stop?.(); await execution.done; }
    try { await remove(`wangke-exec-${body.executionId}`); return reply(200, { cancelled: true }); }
    catch { return reply(503, { error: 'sandbox_cleanup_pending' }); }
  }
  if (cancelled.has(body.executionId)) return reply(409, { error: 'execution_cancelled' });
  const scope = body.projectId ? `project:${body.projectId}` : `thread:${body.threadId}`;
  if (active.has(scope) || executions.has(body.executionId) || active.size >= 8) return reply(409, { error: 'sandbox_busy' });
  const name = `wangke-exec-${body.executionId}`;
  let resolveDone;
  const execution = { name, cancelled: false, stop: null, done: new Promise(resolve => { resolveDone = resolve; }) };
  const finish = () => { active.delete(scope); executions.delete(body.executionId); resolveDone(); };
  active.set(scope, execution); executions.set(body.executionId, execution);
  let args;
  try { args = sandboxArgs(body, body.projectId ? await projectRoot(body.projectId) : undefined); }
  catch { finish(); return reply(400, { error: 'invalid_project_workspace' }); }
  if (res.destroyed || execution.cancelled) { finish(); return reply(409, { error: 'execution_cancelled' }); }
  let stdout = ''; let stderr = ''; let size = 0; let timer;
  const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let removing;
  const stop = () => { child.kill('SIGKILL'); removing ??= remove(name).catch(() => {}); };
  execution.stop = stop;
  const disconnected = () => { if (!res.writableEnded) stop(); };
  res.on('close', disconnected);
  timer = setTimeout(stop, 130_000);
  const collect = (kind, chunk) => {
    size += chunk.length;
    if (size > 128_000) { stop(); return; }
    if (kind === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString();
  };
  child.stdout.on('data', (chunk) => collect('stdout', chunk));
  child.stderr.on('data', (chunk) => collect('stderr', chunk));
  child.on('error', () => { stderr = 'Unable to start sandbox'; });
  child.on('close', async (code) => {
    clearTimeout(timer);
    try {
      await removing;
      await remove(name);
      finish();
      reply(200, { stdout: stdout.slice(0, 60_000), stderr: stderr.slice(0, 60_000), exitCode: code ?? 137 });
    } catch { finish(); reply(503, { error: 'sandbox_cleanup_pending' }); }
  });
});
server.listen(3001, process.env.HOST || '0.0.0.0');
process.on('SIGTERM', async () => {
  server.close();
  await Promise.all([...active.values()].map(async execution => { execution.cancelled = true; execution.stop?.(); await execution.done; }));
  process.exit(0);
});
