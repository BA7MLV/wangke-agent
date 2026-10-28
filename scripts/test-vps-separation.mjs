/** Opt-in destructive tests ONLY for a newly created isolated acceptance project.
 * Never points at the normal installation or a public listener. All Docker calls
 * are real; --preloaded means local OCI digest resolution, NOT a registry test. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { atomicJSON, readJSON } from './lib/release-storage.mjs';
import { manifestIdentity } from './release-plan.mjs';

const [root, apiTag, webTag, apiNextTag, webNextTag, apiBadTag] = process.argv.slice(2);
if (!root || !/^wangke-separation-check\.[A-Za-z0-9]+$/.test(path.basename(root)) || ![apiTag, webTag, apiNextTag, webNextTag, apiBadTag].every(tag => /^wk-check-/.test(tag ?? ''))) throw new Error('isolated_acceptance_arguments_required');
const project = `wk-check-${path.basename(root).split('.').at(-1).toLowerCase()}`;
const installation = path.join(root, 'installation'), source = path.resolve(import.meta.dirname, '..');
if (fs.existsSync(installation)) throw new Error('fresh_test_installation_required');
fs.mkdirSync(path.join(installation, 'data'), { recursive: true, mode: 0o700 });
const environment = { ...process.env, COMPOSE_PROJECT_NAME: project, WANGKE_HOST_DATA_DIR: path.join(installation, 'data'), WANGKE_UID: String(process.getuid()), WANGKE_GID: String(process.getgid()) };
const command = (binary, args, options = {}) => execFileSync(binary, args, { env: environment, encoding: 'utf8', timeout: 240000, maxBuffer: 16 * 1024 * 1024, ...options }).trim();
const docker = args => command('docker', args);
const image = tag => {
  const info = JSON.parse(docker(['image', 'inspect', tag]))[0];
  const digest = info.RepoDigests.find(ref => ref.startsWith(tag.split(':')[0] + '@sha256:'));
  if (!digest) throw new Error(`preloaded_repository_digest_required:${tag}`);
  return { image: digest, size: info.Size };
};
const images = { api: image(apiTag), web: image(webTag), apiNext: image(apiNextTag), webNext: image(webNextTag), apiBad: image(apiBadTag) };
const composeFile = path.join(installation, 'compose.json');
const compose = args => docker(['compose', '--env-file', path.join(installation, '.env'), '-f', composeFile, ...(fs.existsSync(path.join(installation, 'deployment-images.json')) ? ['-f', path.join(installation, 'deployment-images.json')] : []), ...args]);
const receipt = { project, platform: 'linux/amd64', transport: 'API VPS source build; Web local static build + VPS runtime-image build; local OCI variants/load; NO registry publication/pull', images, checks: [], timings: {} };
const mark = name => { receipt.checks.push(name); atomicJSON(path.join(root, 'logs/acceptance.json'), receipt); console.log(`PASS ${name}`); };
const started = Date.now();
const productionIdentity = c => ({ id: c.Id, image: c.Image, name: c.Name, startedAt: c.State.StartedAt, restartCount: c.RestartCount });
const production = ['wangke-agent-app-1', 'wangke-agent-proxy-1'].map(name => productionIdentity(JSON.parse(docker(['inspect', name]))[0]));
const release = (args, expectFailure = false) => {
  const at = Date.now();
  try {
    const result = command(process.execPath, [path.join(source, 'scripts/release-deploy.mjs'), '--data-dir', installation, '-f', composeFile, '--preloaded', ...args]);
    if (expectFailure) throw new Error('expected_real_release_failure');
    return JSON.parse(result);
  } catch (error) { if (!expectFailure || error.message === 'expected_real_release_failure') throw error; return { failed: true }; }
  finally { receipt.timings[`${args[0]}-${Object.keys(receipt.timings).length}`] = Date.now() - at; }
};
const execAPI = script => compose(['exec', '-T', 'api', 'node', '--input-type=module', '-e', script]);
const metadata = JSON.parse(docker(['run', '--rm', '--network', 'none', '--memory', '128m', '--cpus', '.25', '--entrypoint', 'node', images.api.image, '/app/apps/api/scripts/deployment-maintenance.mjs', 'metadata']));
const commit = letter => letter.repeat(40);
const initial = { format: 1, sourceCommit: commit('a'), images: { api: { image: images.api.image, sourceCommit: commit('a') }, web: { image: images.web.image, sourceCommit: commit('a') } }, database: metadata };
const candidate = (previous, service, ref, letter) => ({ ...previous, sourceCommit: commit(letter), baselineCommit: previous.sourceCommit, baselineDigest: manifestIdentity(previous), images: { ...previous.images, [service]: { image: ref, sourceCommit: commit(letter) } } });
const config = {
  services: {
    'proof-model': { image: 'node:22-bookworm-slim', cpus: .1, mem_limit: '64m', command: ['node', '/proof.mjs'], volumes: [`${root}/proof-model.mjs:/proof.mjs:ro`] },
    api: { image: images.api.image, user: `${process.getuid()}:${process.getgid()}`, init: true, restart: 'unless-stopped', cpus: .5, mem_limit: '512m', stop_grace_period: '65s',
      environment: { NODE_ENV: 'production', PORT: '3000', HOST: '0.0.0.0', DATA_DIR: '/data', DB_PATH: '/data/db/wangke.sqlite', FILES_DIR: '/data/files', BOOTSTRAP_SECRET_FILE: '/data/config/bootstrap-secret', PUBLIC_ORIGIN: 'http://localhost', CLOUD_WORKER_DISABLED: '1', API_DRAIN_MS: '500', MODEL_API_KEY: '', MAX_FILE_BYTES: String(4 * 1024 * 1024) },
      volumes: [`${installation}/data:/data`], read_only: true, tmpfs: ['/tmp:size=128m'] },
    web: { image: images.web.image, cpus: .25, mem_limit: '128m', environment: { API_BASE_URL: '' }, volumes: ['web_assets:/srv/assets'], healthcheck: { test: ['CMD', 'wget', '-qO-', 'http://127.0.0.1:8080/config.js'], interval: '2s', timeout: '2s', retries: 30 } },
    proxy: { image: 'caddy:2.10-alpine', cpus: .25, mem_limit: '96m', ports: ['127.0.0.1::8080'], volumes: [`${source}/infra/docker/Caddyfile.local:/etc/caddy/Caddyfile:ro`] },
  }, volumes: { web_assets: {} },
};
fs.writeFileSync(path.join(root, 'proof-model.mjs'), `import http from 'node:http';http.createServer((req,res)=>{if(req.url==='/migration-hit'){console.log('migration_hit_after_corruption');res.end('recorded');return;}res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});let n=0;const tick=()=>res.write('data: '+JSON.stringify({n:++n,at:Date.now(),proof:'local-free-fixture'})+'\\n\\n');tick();const t=setInterval(tick,250);res.on('close',()=>clearInterval(t));}).listen(9000,'0.0.0.0');`);
atomicJSON(composeFile, config); fs.writeFileSync(path.join(installation, '.env'), 'ACCEPTANCE_ONLY=true\n', { mode: 0o600 });
let reader, heartbeat;
try {
  docker(['run', '--rm', '--network', 'none', '--memory', '256m', '--cpus', '.5', '--entrypoint', 'node', images.api.image, '--input-type=module', '-e', `
    import assert from 'node:assert/strict';import fs from 'node:fs';import {createRequire} from 'node:module';import {execFileSync} from 'node:child_process';
    const require=createRequire(import.meta.url);const Database=require('/app/node_modules/better-sqlite3');const db=new Database(':memory:');assert.equal(db.prepare('SELECT 42 AS n').get().n,42);db.close();
    const argon2=require('/app/node_modules/argon2');const hash=await argon2.hash('isolated-native-proof');assert.ok(await argon2.verify(hash,'isolated-native-proof'));
    for(const p of ['/app/apps/web','/app/node_modules/react','/app/node_modules/react-dom','/app/node_modules/vite','/app/node_modules/typescript'])assert.equal(fs.existsSync(p),false,p);
    assert.match(execFileSync('ffmpeg',['-version'],{encoding:'utf8'}),/ffmpeg version/);
  `]);
  docker(['run', '--rm', '--network', 'none', '--memory', '64m', '--cpus', '.25', '--entrypoint', 'sh', images.web.image, '-ec', 'test -f /srv/index.html; test ! -d /app/apps/api; test ! -d /app/node_modules; test ! -e /srv/.env; test ! -e /srv/db']);
  docker(['run', '--rm', '--network', 'none', '--memory', '64m', '--cpus', '.25', '--entrypoint', 'sh', images.web.image, '-ec', 'mkdir -p /opt/web-assets/nested /srv/assets/nested; printf old > /srv/assets/keep.js; printf replacement > /opt/web-assets/keep.js; printf nested-new > /opt/web-assets/nested/new.js; /usr/local/bin/web-entrypoint.sh true; test "$(cat /srv/assets/keep.js)" = old; test "$(cat /srv/assets/nested/new.js)" = nested-new']);
  mark('actual final Linux images: SQLite/Argon2/FFmpeg and API/Web dependency/source isolation');
  compose(['up', '-d', '--no-build', '--wait', '--wait-timeout', '120']);
  const host = compose(['port', 'proxy', '8080']); assert.match(host, /^127\.0\.0\.1:\d+$/);
  const origin = `http://${host}`;
  receipt.origin = origin; atomicJSON(path.join(root, 'logs/test-endpoint.json'), { origin, project });
  const request = (url, init = {}) => fetch(origin + url, init);
  assert.equal((await request('/api/v1/health')).status, 200);
  const page = await request('/'); assert.equal(page.status, 200);
  assert.equal(page.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.equal(page.headers.get('cross-origin-embedder-policy'), 'require-corp');
  assert.match((await request('/config.js')).headers.get('cache-control'), /no-cache/);
  assert.equal((await request('/assets/not-a-real-chunk.js')).status, 404);
  assert.equal((await request('/api/not-a-real-api')).status, 404);
  mark('real Caddy same-origin routing, isolation headers and non-SPA missing assets');
  const secret = fs.readFileSync(path.join(installation, 'data/config/bootstrap-secret'), 'utf8').trim();
  const password = crypto.randomBytes(24).toString('hex');
  assert.equal((await request('/api/v1/bootstrap/initialize', { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-secret': secret }, body: JSON.stringify({ adminPassword: password }) })).status, 201);
  const login = await request('/api/v1/auth/password/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
  assert.equal(login.status, 200); const cookie = login.headers.get('set-cookie').split(';')[0];
  const headers = { cookie, 'content-type': 'application/json' };
  const threadResponse = await request('/api/v1/threads', { method: 'POST', headers, body: JSON.stringify({ mode: 'chat', title: 'isolated-release-proof' }) });
  assert.equal(threadResponse.status, 201); const thread = await threadResponse.json();
  const upload = await request('/api/v1/files', { method: 'POST', headers: { cookie, 'content-type': 'application/octet-stream', 'x-file-name': 'acceptance.txt' }, body: Buffer.alloc(1024 * 1024, 97) });
  assert.equal(upload.status, 201); const file = await upload.json();
  const ranged = await request(`/api/v1/files/${file.id}`, { headers: { cookie, range: 'bytes=-17' } }); assert.equal(ranged.status, 206); assert.equal(await ranged.text(), 'a'.repeat(17));
  assert.equal((await request('/api/v1/files', { method: 'POST', headers: { cookie, 'content-type': 'application/octet-stream' }, body: Buffer.alloc(4 * 1024 * 1024 + 1) })).status, 413);
  assert.equal((await request('/api/v1/auth/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password, deviceName: 'isolated-contract-client' }) })).status, 201);
  mark('fresh Argon2 account, cookie/native-token HTTP contract, real upload/Range/limit');
  execAPI(`import {DatabaseStore} from './apps/api/dist/apps/api/src/storage/database.js';import {CloudConfiguration} from './apps/api/dist/apps/api/src/cloud/config.js';const s=new DatabaseStore('/data/db/wangke.sqlite');const c=new CloudConfiguration(s,'/data/config');const owner=s.db.prepare('SELECT id FROM users').get().id;c.save(owner,{...c.get(owner),providers:[{id:'local-proof',name:'Free local fixture',protocol:'openai-chat',baseUrl:'http://proof-model:9000',apiKey:'',serves:['chat'],catalogId:''}]});s.close();`);
  const sse = await request('/api/v1/cloud/models/local-proof/chat/completions', { method: 'POST', headers, body: '{"stream":true,"messages":[]}' });
  assert.equal(sse.status, 200); assert.match(sse.headers.get('content-type'), /text\/event-stream/);
  reader = sse.body.getReader(); let received = '';
  const receive = async after => {
    const deadline = Date.now() + 15000;
    for (;;) {
      const item = await Promise.race([reader.read(), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('sse_timeout')), 15000); timer.unref(); })]);
      assert.equal(item.done, false, 'same SSE connection must stay open'); received += new TextDecoder().decode(item.value);
      const times = [...received.matchAll(/"at":(\d+)/g)].map(match => Number(match[1]));
      if (times.some(at => at >= after)) return;
      if (Date.now() > deadline) throw new Error('sse_timeout');
    }
  };
  const send = nonce => request(`/api/v1/threads/${thread.id}/messages`, { method: 'POST', headers, body: JSON.stringify({ clientNonce: nonce, kind: 'text', content: nonce }) });
  await send('before-web-replace'); await receive(0);
  const initialFile = path.join(root, 'initial-manifest.json'); atomicJSON(initialFile, initial); release(['adopt', initialFile]);
  const baselineFile = path.join(installation, 'releases/last-success.json');
  const apiBefore = compose(['ps', '-q', 'api']), proxyBefore = compose(['ps', '-q', 'proxy']);
  const browserTask = crypto.randomUUID();
  execAPI(`import {DatabaseStore} from './apps/api/dist/apps/api/src/storage/database.js'; const s=new DatabaseStore('/data/db/wangke.sqlite');const owner=s.db.prepare('SELECT id FROM users').get().id;const at=new Date().toISOString();s.db.prepare('INSERT INTO cloud_tasks(id,owner_id,nonce,kind,resource,input,status,created_at,updated_at,executor) VALUES(?,?,?,?,?,?,?,?,?,?)').run(${JSON.stringify(browserTask)},owner,${JSON.stringify(browserTask)},'transcribe',${JSON.stringify(browserTask)},'{}','queued',at,at,'browser');s.close();`);
  const claim = await request('/api/v1/cloud/worker/claim', { method: 'POST', headers, body: JSON.stringify({ kinds: ['transcribe'] }) });
  assert.equal(claim.status, 200); const leased = await claim.json();
  const workerHeaders = { authorization: `Bearer ${leased.token}`, 'content-type': 'application/json' };
  heartbeat = setInterval(() => { request(`/api/v1/cloud/tasks/${browserTask}/report`, { method: 'POST', headers: workerHeaders, body: '{"progress":{"content":"acceptance heartbeat"}}' }).then(r => r.body?.cancel()).catch(() => {}); }, 5000);
  const webTarget = candidate(initial, 'web', images.webNext.image, 'b');
  const webCandidate = path.join(root, 'web-manifest.json'); atomicJSON(webCandidate, webTarget);
  atomicJSON(path.join(root, 'logs/browser-before-web.json'), { origin, project });
  if (process.env.WANGKE_BROWSER_COORDINATION === '1') {
    for (let i = 0; i < 240 && !fs.existsSync(path.join(root, 'browser-ready')); i++) await new Promise(resolve => setTimeout(resolve, 500));
    assert.ok(fs.existsSync(path.join(root, 'browser-ready')), 'old browser page must be open before replacing Web');
  }
  release(['web', webCandidate]);
  assert.equal(fs.existsSync(path.join(installation, 'releases/points')), false, 'Web-only update must not take a full data snapshot');
  assert.equal(compose(['ps', '-q', 'api']), apiBefore); assert.equal(compose(['ps', '-q', 'proxy']), proxyBefore);
  await send('after-web-replace'); await receive(Date.now());
  assert.equal((await request('/assets/wk-old-proof.js')).status, 200);
  assert.equal((await request('/assets/wk-new-proof.js')).status, 200);
  assert.equal((await request(`/api/v1/cloud/tasks/${browserTask}/report`, { method: 'POST', headers: workerHeaders, body: '{"progress":{"content":"survived web update"}}' })).status, 200);
  mark('real Web-only recreate: identical API/edge IDs, same live SSE reader, old+new chunks and active browser lease');
  if (process.env.WANGKE_BROWSER_COORDINATION === '1') {
    for (let i = 0; i < 120 && !fs.existsSync(path.join(root, 'browser-done')); i++) await new Promise(resolve => setTimeout(resolve, 500));
    assert.ok(fs.existsSync(path.join(root, 'browser-done')), 'browser continuity check must finish before API downtime');
  }
  await reader.cancel(); reader = null;
  clearInterval(heartbeat); heartbeat = null;
  const writableProject = path.join(installation, 'data/files/projects/acceptance-writer');
  fs.mkdirSync(writableProject, { recursive: true });
  const writerName = `${project}-sandbox-writer`;
  docker(['run', '-d', '--name', writerName, '--label', 'wangke.sandbox=true', '--label', `com.docker.compose.project=${project}`, '--network', 'none', '--memory', '32m', '--cpus', '.1', '--user', `${process.getuid()}:${process.getgid()}`, '--mount', `type=bind,src=${writableProject},dst=/workspace`, 'node:22-bookworm-slim', 'sh', '-c', 'while :; do echo write >> /workspace/journal.txt; sleep 0.2; done']);
  const apiTarget = candidate(webTarget, 'api', images.apiNext.image, 'c'); const apiCandidate = path.join(root, 'api-manifest.json'); atomicJSON(apiCandidate, apiTarget);
  const samples = []; let probe = true;
  const probing = (async () => { while (probe) { const at = Date.now(); try { const [ready, business] = await Promise.all([request('/api/v1/ready', { signal: AbortSignal.timeout(1500) }), request('/api/v1/cloud/tasks', { headers: { cookie }, signal: AbortSignal.timeout(1500) })]); samples.push({ at, status: ready.status, businessStatus: business.status }); await Promise.all([ready.body?.cancel(), business.body?.cancel()]); } catch { samples.push({ at, status: 0 }); } await new Promise(resolve => setTimeout(resolve, 100)); } })();
  // Run the CLI asynchronously so the real external readiness probe is not blocked.
  const { spawn } = await import('node:child_process');
  const replace = spawn(process.execPath, [path.join(source, 'scripts/release-deploy.mjs'), '--data-dir', installation, '-f', composeFile, '--preloaded', 'api', apiCandidate], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  let replacementOutput = ''; replace.stdout.on('data', x => { replacementOutput += x; }); replace.stderr.on('data', x => { replacementOutput += x; });
  const code = await new Promise(resolve => replace.on('close', resolve)); probe = false; await probing;
  assert.equal(code, 0, replacementOutput); assert.notEqual(compose(['ps', '-q', 'api']), apiBefore); assert.equal(compose(['ps', '-q', 'proxy']), proxyBefore);
  assert.equal(JSON.parse(docker(['inspect', writerName]))[0].State.Running, false, 'real writable sandbox container must stop before snapshot');
  docker(['rm', writerName]);
  const unavailable = samples.filter(s => s.status !== 200); receipt.readinessSamples = samples; receipt.timings.apiUnavailableSampleSpanMs = unavailable.length ? unavailable.at(-1).at - unavailable[0].at + 100 : 0;
  assert.equal((await request(`/api/v1/cloud/tasks/${browserTask}/report`, { method: 'POST', headers: workerHeaders, body: '{"progress":{"content":"stale"}}' })).status, 403);
  const fenced = await (await request(`/api/v1/cloud/tasks/${browserTask}`, { headers: { cookie } })).json();
  assert.equal(fenced.status, 'queued');
  assert.equal(readJSON(path.join(installation, 'releases/last-success.json')).sourceCommit, apiTarget.sourceCommit);
  const beforeStale = fs.readFileSync(baselineFile);
  release(['web', webCandidate], true);
  assert.deepEqual(fs.readFileSync(baselineFile), beforeStale, 'stale candidate must not alter successful baseline');
  assert.equal(compose(['ps', '-q', 'proxy']), proxyBefore);
  mark('real API drain/replace/staged activation, stale browser credential fenced, persistent account/files and successful baseline');
  const badTarget = candidate(apiTarget, 'api', images.apiBad.image, 'd'); const badCandidate = path.join(root, 'bad-manifest.json'); atomicJSON(badCandidate, badTarget);
  const beforeFile = fs.readFileSync(path.join(installation, `data/files/${file.id}.bin`));
  const beforeName = execAPI(`import Database from 'better-sqlite3';const db=new Database('/data/db/wangke.sqlite');console.log(db.prepare('SELECT name FROM users LIMIT 1').get().name);db.close();`);
  release(['api', badCandidate], true);
  assert.match(compose(['logs', '--no-color', 'proof-model']), /migration_hit_after_corruption/, 'fault image must actually corrupt DB/files before recovery');
  assert.equal(readJSON(path.join(installation, 'releases/transaction.json')).phase, 'rolled-back');
  assert.equal(readJSON(path.join(installation, 'releases/last-success.json')).sourceCommit, apiTarget.sourceCommit);
  assert.deepEqual(fs.readFileSync(path.join(installation, `data/files/${file.id}.bin`)), beforeFile);
  assert.equal(execAPI(`import Database from 'better-sqlite3';const db=new Database('/data/db/wangke.sqlite');console.log(db.prepare('SELECT name FROM users LIMIT 1').get().name);db.close();`), beforeName);
  assert.equal(execAPI(`import Database from 'better-sqlite3';const db=new Database('/data/db/wangke.sqlite');console.log(db.prepare("SELECT COUNT(*) n FROM sqlite_schema WHERE name='acceptance_partial_migration'").get().n);db.close();`), '0');
  assert.equal((await request('/api/v1/auth/session', { headers: { cookie } })).status, 200);
  mark('real destructive migration crash: DB AND uploaded bytes restored, previous image ready, baseline unchanged');
  release(['rollback']);
  assert.equal(readJSON(path.join(installation, 'releases/last-success.json')).images.api.image, initial.images.api.image);
  const backup = release(['snapshot']); assert.ok(backup.restorePoint);
  const laterUpload = await request('/api/v1/files', { method: 'POST', headers: { cookie, 'content-type': 'application/octet-stream', 'x-file-name': 'after-restore-point.txt' }, body: 'explicit isolated data-loss proof' });
  assert.equal(laterUpload.status, 201); const laterFile = await laterUpload.json();
  release(['restore', backup.restorePoint, '--allow-data-loss']);
  assert.equal((await request(`/api/v1/files/${laterFile.id}`, { headers: { cookie } })).status, 404);
  assert.equal(fs.existsSync(path.join(installation, `data/files/${laterFile.id}.bin`)), false);
  assert.equal((await request(`/api/v1/files/${file.id}`, { headers: { cookie } })).status, 200);
  mark('real explicit restore: after-point DB row/file discarded together, original upload/account retained');
  compose(['restart', 'api']);
  for (let i = 0; i < 60; i++) { if ((await request('/api/v1/ready')).status === 200) break; await new Promise(resolve => setTimeout(resolve, 500)); }
  assert.equal((await request(`/api/v1/files/${file.id}`, { headers: { cookie } })).status, 200);
  mark('real compatible rollback, writer-coordinated backup and persistent bind/volume restart');
  receipt.totalMs = Date.now() - started;
} finally {
  clearInterval(heartbeat);
  await reader?.cancel().catch(() => {});
  try { fs.writeFileSync(path.join(root, 'logs/test-container.log'), compose(['logs', '--no-color', '--tail', '100'])); } catch {}
  const after = production.map(before => JSON.parse(docker(['inspect', before.id]))[0]);
  assert.deepEqual(after.map(productionIdentity), production, 'production containers must not be replaced or restarted');
  receipt.productionUnchanged = true; atomicJSON(path.join(root, 'logs/acceptance.json'), receipt);
  // Keep containers until explicit caller cleanup so a separate real browser can
  // exercise PWA/old-page behavior over an SSH localhost forward. No auto-prune.
}
