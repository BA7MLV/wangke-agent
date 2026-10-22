import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';

const token = process.env.SANDBOX_TOKEN;
if (!token || token.length < 32) throw new Error('SANDBOX_TOKEN must contain at least 32 characters');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const active = new Map();
const remove = (name) => new Promise((resolve) => execFile('docker', ['rm', '-f', name], { timeout: 10_000 }, () => resolve()));

export function sandboxArgs({ threadId, executionId, command, network = false }) {
  return ['run', '--rm', '--name', `wangke-exec-${executionId}`, '--label', 'wangke.sandbox=true',
    '--init', '--user', '1000:1000', '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
    '--read-only', '--pids-limit=128', '--memory=1g', '--memory-swap=1g', '--cpus=1',
    '--network', network ? process.env.SANDBOX_NETWORK || 'none' : 'none', '--tmpfs', '/tmp:rw,nosuid,size=256m',
    '--mount', `type=volume,source=wangke-workspace-${threadId},target=/workspace`,
    '--workdir', '/workspace', '--env', 'HOME=/workspace',
    process.env.SANDBOX_IMAGE || 'wangke-sandbox:0.1.0',
    'timeout', '--signal=KILL', '120', 'bash', '-lc', command];
}

const server = http.createServer(async (req, res) => {
  const reply = (status, body) => { if (!res.destroyed) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); } };
  if (req.url === '/health' && req.method === 'GET') return reply(200, { ok: true });
  const supplied = Buffer.from(req.headers.authorization || '');
  const expected = Buffer.from(`Bearer ${token}`);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return reply(401, { error: 'unauthorized' });
  if (req.url !== '/execute' || req.method !== 'POST') return reply(404, { error: 'not_found' });
  let body;
  try {
    let bytes = 0; const chunks = [];
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 32_768) throw new Error(); chunks.push(chunk); }
    body = JSON.parse(Buffer.concat(chunks).toString());
    if (!uuid.test(body.threadId) || !uuid.test(body.executionId) || typeof body.command !== 'string' || !body.command.trim() || body.command.length > 16_000) throw new Error();
  } catch { return reply(400, { error: 'invalid_request' }); }
  if (active.has(body.threadId) || active.size >= 8) return reply(409, { error: 'sandbox_busy' });
  const name = `wangke-exec-${body.executionId}`;
  active.set(body.threadId, name);
  let stdout = ''; let stderr = ''; let size = 0; let timer;
  const child = spawn('docker', sandboxArgs(body), { stdio: ['ignore', 'pipe', 'pipe'] });
  const stop = () => { child.kill('SIGKILL'); void remove(name); };
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
    await remove(name);
    active.delete(body.threadId);
    reply(200, { stdout: stdout.slice(0, 60_000), stderr: stderr.slice(0, 60_000), exitCode: code ?? 137 });
  });
});
server.listen(3001, process.env.HOST || '0.0.0.0');
process.on('SIGTERM', async () => { server.close(); await Promise.all([...active.values()].map(remove)); process.exit(0); });
