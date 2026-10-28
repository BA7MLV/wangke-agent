import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function atomicJSON(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, filename);
  const directory = fs.openSync(path.dirname(filename), 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}
export const readJSON = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
export function digest(filename) {
  const hash = crypto.createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024), fd = fs.openSync(filename, 'r');
  try { let bytes; while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, bytes)); }
  finally { fs.closeSync(fd); }
  return hash.digest('hex');
}
function syncPath(filename) {
  const fd = fs.openSync(filename, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function syncTree(directory) {
  for (const relative of files(directory)) syncPath(path.join(directory, relative));
  for (const relative of directories(directory).reverse()) syncPath(path.join(directory, relative));
  syncPath(directory);
}
function directories(root, prefix = '') {
  const result = [];
  for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) if (entry.isDirectory()) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    result.push(relative, ...directories(root, relative));
  }
  return result.sort();
}
const stamp = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
function files(directory, prefix = '') {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const filename = path.join(directory, entry.name), stat = fs.lstatSync(filename);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || stat.isFile() && stat.nlink > 1) throw new Error(`unsafe_snapshot_entry:${relative}`);
    if (stat.isDirectory()) result.push(...files(filename, relative));
    else result.push(relative);
  }
  return result.sort();
}
const safe = relative => typeof relative === 'string' && relative !== '' && !path.isAbsolute(relative) && relative.split('/').every(part => part && part !== '.' && part !== '..') && !relative.includes('\\');

/** Pre-copy without freezing writers. Only a stable before/after inode stamp is
 * reusable; the final pass runs AFTER all containers with writable mounts stop.
 * No hard links to live data or compression in the switch window. */
export function copyPass(source, destination, previous = {}) {
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  files(destination); // reject a corrupted/tampered stage before writing through it
  const index = {};
  const dirs = directories(source);
  for (const relative of dirs) fs.mkdirSync(path.join(destination, relative), { recursive: true, mode: 0o700 });
  for (const relative of files(source)) {
    const from = path.join(source, relative), to = path.join(destination, relative);
    const before = fs.statSync(from, { bigint: true });
    if (previous[relative]?.stamp === stamp(before) && fs.existsSync(to)) { index[relative] = previous[relative]; continue; }
    fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
    fs.copyFileSync(from, to, fs.constants.COPYFILE_FICLONE);
    fs.chmodSync(to, Number(before.mode & 0o777n));
    const after = fs.statSync(from, { bigint: true });
    index[relative] = { sha256: digest(to), stamp: stamp(before) === stamp(after) ? stamp(after) : null };
  }
  for (const relative of files(destination)) if (!Object.hasOwn(index, relative)) fs.unlinkSync(path.join(destination, relative));
  for (const relative of directories(destination).reverse()) if (!dirs.includes(relative)) fs.rmdirSync(path.join(destination, relative));
  return index;
}

export function verifyPoint(point) {
  const manifest = readJSON(path.join(point, 'point.json'));
  if (manifest.format !== 1 || manifest.complete !== true || !manifest.files || !manifest.database?.identity) throw new Error('invalid_restore_point');
  const actual = files(path.join(point, 'payload'));
  if (JSON.stringify(directories(path.join(point, 'payload'))) !== JSON.stringify(manifest.directories)) throw new Error('restore_point_directories_mismatch');
  if (JSON.stringify(actual) !== JSON.stringify(Object.keys(manifest.files).sort())) throw new Error('restore_point_inventory_mismatch');
  for (const relative of actual) {
    if (!safe(relative) || !/^[a-f0-9]{64}$/.test(manifest.files[relative]) || digest(path.join(point, 'payload', relative)) !== manifest.files[relative]) throw new Error(`restore_point_checksum:${relative}`);
  }
  return manifest;
}

export function sealPoint(point, database) {
  const payload = path.join(point, 'payload');
  const inventory = Object.fromEntries(files(payload).map(relative => [relative, digest(path.join(payload, relative))]));
  syncTree(payload);
  if (!inventory['data/db/wangke.sqlite'] || !inventory['.env']) throw new Error('incomplete_restore_point');
  atomicJSON(path.join(point, 'point.json'), { format: 1, complete: true, database, directories: directories(payload), files: inventory });
  return verifyPoint(point);
}

/** Validated, copy-on-restore. Retain failed/new data for forensic recovery.
 * Journal phase is saved BEFORE either rename; retries complete the swap rather
 * than trusting whichever path happens to exist after a crash. */
export function restorePoint(point, installation, transaction, save) {
  verifyPoint(point);
  if (transaction.restorePhase === 'done') return;
  const stage = path.join(installation, `restore-${transaction.id}`);
  const failed = path.join(installation, `failed-data-${transaction.id}`);
  const live = path.join(installation, 'data');
  if (transaction.restorePhase !== 'swap') {
    fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
    copyPass(path.join(point, 'payload/data'), stage);
    syncTree(stage);
    transaction.restorePhase = 'swap'; save(transaction);
  }
  if (!fs.existsSync(failed) && fs.existsSync(live)) fs.renameSync(live, failed);
  if (fs.existsSync(stage)) fs.renameSync(stage, live);
  if (!fs.existsSync(live)) throw new Error('restore_swap_incomplete');
  syncPath(installation);
  const environment = path.join(installation, '.env');
  fs.copyFileSync(path.join(point, 'payload/.env'), `${environment}.restore`);
  fs.chmodSync(`${environment}.restore`, 0o600); syncPath(`${environment}.restore`); fs.renameSync(`${environment}.restore`, environment); syncPath(installation);
  transaction.restorePhase = 'done'; save(transaction);
}

export function acquireLock(directory, recover = false) {
  const lock = path.join(directory, 'release.lock');
  try { fs.mkdirSync(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let owner;
    try { owner = readJSON(path.join(lock, 'owner.json')); } catch { throw new Error('release_lock_unknown_owner'); }
    try { process.kill(owner.pid, 0); throw new Error('release_already_running'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    if (!recover) throw new Error('stale_release_lock_use_recover');
    fs.unlinkSync(path.join(lock, 'owner.json')); fs.rmdirSync(lock); fs.mkdirSync(lock, { mode: 0o700 });
  }
  atomicJSON(path.join(lock, 'owner.json'), { pid: process.pid });
  return () => { fs.unlinkSync(path.join(lock, 'owner.json')); fs.rmdirSync(lock); };
}
